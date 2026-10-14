// Word timings straight from Supertonic: the vector estimator's text cross-attention walks the
// characters in order, so a monotonic path through it says which character sounds in each latent frame.
// Benchmarked against Whisper word timestamps: ~50 ms mean error vs ~220 ms for length-based estimates.

/** Cross-attention layers (blocks 9 and 15) whose heads track the text most sharply. */
export const ALIGNMENT_OUTPUTS = [9, 15].map((block) => `/vector_estimator/vector_field/main_blocks.${block}/attn/Softmax_output_0`)

/** Characters the path may advance per latent frame (~70 ms). */
const MAX_JUMP = 3

function readVarint(bytes: Uint8Array, offset: number) {
  let value = 0
  let shift = 0
  let pos = offset
  for (;;) {
    const byte = bytes[pos++]
    value += (byte & 0x7f) * 2 ** shift
    if (byte < 0x80) return { value, next: pos }
    shift += 7
  }
}

function varint(value: number) {
  const out: number[] = []
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80)
    value = Math.floor(value / 0x80)
  }
  out.push(value)
  return out
}

/**
 * Appends float tensors to the graph outputs of a serialized ONNX model (ModelProto.graph = 7,
 * GraphProto.output = 12), so the stock Hugging Face file can expose internal attention maps.
 */
export function exposeOutputs(model: Uint8Array, names: string[]) {
  const encoder = new TextEncoder()
  let pos = 0
  while (pos < model.length) {
    const start = pos
    const tag = readVarint(model, pos)
    pos = tag.next
    const wire = tag.value & 7
    if (wire === 0) pos = readVarint(model, pos).next
    else if (wire === 1) pos += 8
    else if (wire === 5) pos += 4
    else if (wire === 2) {
      const length = readVarint(model, pos)
      const bodyStart = length.next
      const bodyEnd = bodyStart + length.value
      if (tag.value >> 3 === 7) {
        const extra: number[] = []
        for (const name of names) {
          const nameBytes = [...encoder.encode(name)]
          // ValueInfoProto { name, type: TypeProto { tensor_type { elem_type: FLOAT } } }
          const info = [0x0a, ...varint(nameBytes.length), ...nameBytes, 0x12, 0x04, 0x0a, 0x02, 0x08, 0x01]
          extra.push(0x62, ...varint(info.length), ...info)
        }
        const header = [...varint(tag.value), ...varint(length.value + extra.length)]
        const out = new Uint8Array(model.length + header.length - (bodyStart - start) + extra.length)
        out.set(model.subarray(0, start), 0)
        out.set(header, start)
        out.set(model.subarray(bodyStart, bodyEnd), start + header.length)
        out.set(extra, start + header.length + length.value)
        out.set(model.subarray(bodyEnd), start + header.length + length.value + extra.length)
        return out
      }
      pos = bodyEnd
    } else throw new Error(`Unsupported protobuf wire type ${wire}`)
  }
  throw new Error("ONNX graph not found")
}

/**
 * Accumulates one attention map ([heads..., frames, chars]) over the text content columns
 * [from, to), renormalized per frame and weighted by how sharply each head focuses.
 */
export function accumulateAttention(acc: Float32Array, data: Float32Array, dims: readonly number[], from: number, to: number) {
  const frames = dims[dims.length - 2]
  const chars = dims[dims.length - 1]
  const width = to - from
  const heads = data.length / (frames * chars)
  const sums = new Float32Array(frames)
  for (let head = 0; head < heads; head++) {
    const base = head * frames * chars
    let sharpness = 0
    for (let t = 0; t < frames; t++) {
      const row = base + t * chars + from
      let sum = 0
      let max = 0
      for (let j = 0; j < width; j++) {
        const value = data[row + j]
        sum += value
        if (value > max) max = value
      }
      sums[t] = sum + 1e-9
      sharpness += max / sums[t]
    }
    const weight = sharpness / frames
    for (let t = 0; t < frames; t++) {
      const row = base + t * chars + from
      const scale = weight / sums[t]
      for (let j = 0; j < width; j++) acc[t * width + j] += data[row + j] * scale
    }
  }
}

/** Most likely non-decreasing frame → character path (Viterbi over log attention). */
function monotonicPath(acc: Float32Array, frames: number, chars: number) {
  const logp = new Float32Array(acc.length)
  for (let t = 0; t < frames; t++) {
    let sum = 0
    for (let j = 0; j < chars; j++) sum += acc[t * chars + j]
    for (let j = 0; j < chars; j++) logp[t * chars + j] = Math.log(acc[t * chars + j] / (sum + 1e-9) + 1e-6)
  }
  let score = new Float32Array(chars).fill(-Infinity)
  for (let j = 0; j < Math.min(MAX_JUMP, chars); j++) score[j] = logp[j]
  const back = new Uint8Array(frames * chars)
  for (let t = 1; t < frames; t++) {
    const next = new Float32Array(chars)
    for (let j = 0; j < chars; j++) {
      let best = -Infinity
      let step = 0
      for (let k = 0; k <= MAX_JUMP && k <= j; k++) {
        if (score[j - k] > best) {
          best = score[j - k]
          step = k
        }
      }
      next[j] = best + logp[t * chars + j]
      back[t * chars + j] = step
    }
    score = next
  }
  let j = 0
  for (let i = 1; i < chars; i++) if (score[i] > score[j]) j = i
  const path = new Int32Array(frames)
  for (let t = frames - 1; t >= 0; t--) {
    path[t] = j
    if (t > 0) j -= back[t * chars + j]
  }
  return path
}

/** Letters and digits only, without accents or case, so source text and model input can be matched. */
const letterKeys = (text: string) => Array.from(text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase())

/**
 * Start time (seconds) of every whitespace-separated word of `text`, given the accumulated attention
 * over the model's input characters `content` and the latent frame length.
 */
export function wordStarts(text: string, content: string[], acc: Float32Array, frames: number, frameSeconds: number) {
  const chars = content.length
  const path = monotonicPath(acc, frames, chars)
  const charStart = new Float64Array(chars).fill(NaN)
  path.forEach((char, frame) => {
    if (Number.isNaN(charStart[char])) charStart[char] = frame * frameSeconds
  })
  // Characters the path jumped over start between their neighbours.
  for (let i = 0; i < chars; i++) {
    if (!Number.isNaN(charStart[i])) continue
    let next = i + 1
    while (next < chars && Number.isNaN(charStart[next])) next++
    const before = i > 0 ? charStart[i - 1] : 0
    const after = next < chars ? charStart[next] : frames * frameSeconds
    charStart[i] = before + (after - before) / (next - i + 1)
  }

  // Match the source words' letters against the model input (preprocessing may add or drop symbols).
  const modelLetters: Array<{ key: string; time: number }> = []
  content.forEach((char, index) => {
    for (const key of letterKeys(char)) if (/[\p{L}\p{N}]/u.test(key)) modelLetters.push({ key, time: charStart[index] })
  })
  const words = text.split(/\s+/).filter(Boolean)
  const sourceLetters: Array<{ key: string; word: number }> = []
  words.forEach((word, index) => {
    for (const key of letterKeys(word)) if (/[\p{L}\p{N}]/u.test(key)) sourceLetters.push({ key, word: index })
  })
  const n = sourceLetters.length
  const m = modelLetters.length
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let k = m - 1; k >= 0; k--) {
      table[i][k] = sourceLetters[i].key === modelLetters[k].key ? table[i + 1][k + 1] + 1 : Math.max(table[i + 1][k], table[i][k + 1])
    }
  }
  const starts: Array<number | undefined> = new Array(words.length).fill(undefined)
  for (let i = 0, k = 0; i < n && k < m; ) {
    if (sourceLetters[i].key === modelLetters[k].key) {
      starts[sourceLetters[i].word] ??= modelLetters[k].time
      i++
      k++
    } else if (table[i + 1][k] >= table[i][k + 1]) i++
    else k++
  }

  // Words without letters (dashes) or without a match sit between their neighbours.
  const result: number[] = []
  for (let i = 0; i < words.length; i++) {
    if (starts[i] !== undefined) {
      result.push(starts[i]!)
      continue
    }
    let next = i + 1
    while (next < words.length && starts[next] === undefined) next++
    const before = result[i - 1] ?? 0
    const after = starts[next] ?? frames * frameSeconds
    result.push(before + (after - before) / (next - i + 1))
  }
  // Never let the highlight jump back.
  for (let i = 1; i < result.length; i++) result[i] = Math.max(result[i], result[i - 1])
  return result.map((value) => Math.round(value * 100) / 100)
}
