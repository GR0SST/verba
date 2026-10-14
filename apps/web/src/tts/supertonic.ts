// Supertonic 3 inference (ported from supertone-inc/supertonic web/helper.js),
// rewritten around typed arrays so long books don't thrash the GC.
import * as ort from "onnxruntime-web/webgpu"

import { ALIGNMENT_OUTPUTS, accumulateAttention, exposeOutputs, wordStarts } from "./alignment"
import type { SupertonicLang, SupertonicVoice } from "./voices"

export type { SupertonicLang, SupertonicVoice } from "./voices"

const MODEL_FILES = [
  { key: "dp", file: "onnx/duration_predictor.onnx", label: "Duration predictor" },
  { key: "textEnc", file: "onnx/text_encoder.onnx", label: "Text encoder" },
  { key: "vectorEst", file: "onnx/vector_estimator.onnx", label: "Vector estimator" },
  { key: "vocoder", file: "onnx/vocoder.onnx", label: "Vocoder" },
] as const

type ModelKey = (typeof MODEL_FILES)[number]["key"]

type TtsConfig = {
  ae: { sample_rate: number; base_chunk_size: number }
  ttl: { chunk_compress_factor: number; latent_dim: number }
}

type VoiceStyleJson = {
  style_ttl: { dims: number[]; data: unknown }
  style_dp: { dims: number[]; data: unknown }
}

export type LoadProgress = { label: string; loaded: number; total: number }

// Node placement warnings (shape ops on CPU) are expected and flood the console.
ort.env.logLevel = "error"

const CACHE_NAME = "supertonic-3-v1"

async function fetchCached(url: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  let cache: Cache | undefined
  try {
    cache = await caches.open(CACHE_NAME)
    const hit = await cache.match(url)
    if (hit) {
      const buffer = await hit.arrayBuffer()
      onProgress?.(buffer.byteLength, buffer.byteLength)
      return buffer
    }
  } catch {
    cache = undefined
  }

  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Failed to download ${url}: ${response.status}`)
  const total = Number(response.headers.get("content-length")) || 0
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    loaded += value.byteLength
    onProgress?.(loaded, total || loaded)
  }
  const bytes = new Uint8Array(loaded)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  try {
    await cache?.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream" } }))
  } catch {
    // Quota exceeded — the model still works, it just downloads again next time.
  }
  return bytes.buffer
}

function preprocessText(input: string, lang: SupertonicLang) {
  let text = input.normalize("NFKD")
  text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, "")
  const replacements: Record<string, string> = {
    "–": "-", "‑": "-", "—": "-", "_": " ", "“": '"', "”": '"', "‘": "'", "’": "'",
    "«": '"', "»": '"', "„": '"', "´": "'", "`": "'", "[": " ", "]": " ", "|": " ", "/": " ", "#": " ", "→": " ", "←": " ",
  }
  for (const [from, to] of Object.entries(replacements)) text = text.replaceAll(from, to)
  text = text.replace(/[♥☆♡©\\*]/g, "")
  text = text.replaceAll("@", " at ").replaceAll("e.g.,", "for example,").replaceAll("i.e.,", "that is,")
  text = text.replace(/ ([,.!?;:'])/g, "$1")
  text = text.replace(/"{2,}/g, '"').replace(/'{2,}/g, "'")
  text = text.replace(/\s+/g, " ").trim()
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += "."
  return `<${lang}>${text}</${lang}>`
}

function gaussian() {
  const u1 = Math.max(0.0001, Math.random())
  const u2 = Math.random()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

export type SynthesisOptions = { lang: SupertonicLang; voice: SupertonicVoice; steps: number; speed: number }

/** Mono PCM plus the start time (s) of every whitespace-separated word of the input, when alignment is available. */
export type Synthesis = { samples: Float32Array; words?: number[] }

export class Supertonic {
  readonly sampleRate: number
  private readonly styles = new Map<SupertonicVoice, { ttl: ort.Tensor; dp: ort.Tensor }>()

  private readonly baseUrl: string
  private readonly cfg: TtsConfig
  private readonly indexer: number[]
  private readonly sessions: Record<ModelKey, ort.InferenceSession>
  readonly backend: "webgpu" | "wasm"
  /** The vector estimator exposes its text attention, so word timings can be measured. */
  private readonly aligned: boolean

  private constructor(baseUrl: string, cfg: TtsConfig, indexer: number[], sessions: Record<ModelKey, ort.InferenceSession>, backend: "webgpu" | "wasm") {
    this.baseUrl = baseUrl
    this.cfg = cfg
    this.indexer = indexer
    this.sessions = sessions
    this.backend = backend
    this.sampleRate = cfg.ae.sample_rate
    this.aligned = ALIGNMENT_OUTPUTS.every((name) => sessions.vectorEst.outputNames.includes(name))
  }

  static async load(baseUrl: string, onProgress?: (progress: LoadProgress) => void) {
    const root = baseUrl.replace(/\/$/, "")
    const cfg = (await (await fetch(`${root}/onnx/tts.json`)).json()) as TtsConfig
    const indexer = (await (await fetch(`${root}/onnx/unicode_indexer.json`)).json()) as number[]

    const buffers = {} as Record<ModelKey, ArrayBuffer>
    for (const model of MODEL_FILES) {
      buffers[model.key] = await fetchCached(`${root}/${model.file}`, (loaded, total) =>
        onProgress?.({ label: `Downloading ${model.label}`, loaded, total }),
      )
    }

    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    const hasWebGpu = !!gpu && !!(await gpu.requestAdapter().catch(() => null))
    const backends: Array<"webgpu" | "wasm"> = hasWebGpu ? ["webgpu", "wasm"] : ["wasm"]

    let lastError: unknown
    for (const backend of backends) {
      try {
        const sessions = {} as Record<ModelKey, ort.InferenceSession>
        for (const [index, model] of MODEL_FILES.entries()) {
          onProgress?.({ label: `Initializing ${model.label} (${backend})`, loaded: index, total: MODEL_FILES.length })
          const options: ort.InferenceSession.SessionOptions = { executionProviders: [backend], graphOptimizationLevel: "all" }
          const bytes = new Uint8Array(buffers[model.key])
          sessions[model.key] =
            model.key === "vectorEst"
              ? // Narration must not depend on alignment: fall back to the stock graph if the patched one fails.
                await ort.InferenceSession.create(exposeOutputs(bytes, ALIGNMENT_OUTPUTS), options).catch(() => ort.InferenceSession.create(bytes, options))
              : await ort.InferenceSession.create(bytes, options)
        }
        return new Supertonic(root, cfg, indexer, sessions, backend)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Failed to initialize Supertonic")
  }

  private async style(voice: SupertonicVoice) {
    const cached = this.styles.get(voice)
    if (cached) return cached
    const json = (await (await fetch(`${this.baseUrl}/voice_styles/${voice}.json`)).json()) as VoiceStyleJson
    const toTensor = (part: VoiceStyleJson["style_ttl"]) =>
      new ort.Tensor("float32", Float32Array.from((part.data as unknown[]).flat(Infinity) as number[]), part.dims)
    const style = { ttl: toTensor(json.style_ttl), dp: toTensor(json.style_dp) }
    this.styles.set(voice, style)
    return style
  }

  /** Synthesizes one short passage (≤ ~300 chars) and returns mono PCM at `sampleRate` with word timings. */
  async synthesize(text: string, { lang, voice, steps, speed }: SynthesisOptions): Promise<Synthesis> {
    const style = await this.style(voice)
    const processed = Array.from(preprocessText(text, lang))
    const length = processed.length
    const ids = new BigInt64Array(length)
    for (let i = 0; i < length; i++) {
      const value = this.indexer[processed[i].charCodeAt(0)]
      ids[i] = BigInt(value === undefined || value < 0 ? 0 : value)
    }
    const textIds = new ort.Tensor("int64", ids, [1, length])
    const textMask = new ort.Tensor("float32", new Float32Array(length).fill(1), [1, 1, length])

    const { duration } = await this.sessions.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask })
    const seconds = (duration.data as Float32Array)[0] / speed

    const { text_emb: textEmb } = await this.sessions.textEnc.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask })

    const chunkSize = this.cfg.ae.base_chunk_size * this.cfg.ttl.chunk_compress_factor
    const latentDim = this.cfg.ttl.latent_dim * this.cfg.ttl.chunk_compress_factor
    const wavLength = Math.floor(seconds * this.sampleRate)
    const latentLength = Math.max(1, Math.ceil(wavLength / chunkSize))
    let latent = new Float32Array(latentDim * latentLength)
    for (let i = 0; i < latent.length; i++) latent[i] = gaussian()
    const latentMask = new ort.Tensor("float32", new Float32Array(latentLength).fill(1), [1, 1, latentLength])
    const totalStep = new ort.Tensor("float32", new Float32Array([steps]), [1])

    // Attention is sharpest in the middle steps; reading it back only there keeps the GPU→CPU traffic small.
    const contentStart = processed.indexOf(">") + 1
    const contentEnd = processed.lastIndexOf("<")
    const attention = this.aligned && contentEnd > contentStart ? new Float32Array(latentLength * (contentEnd - contentStart)) : undefined
    const alignStep = (step: number) => steps < 4 || (step >= 1 && step <= steps - 2)

    for (let step = 0; step < steps; step++) {
      const fetches = attention && alignStep(step) ? ["denoised_latent", ...ALIGNMENT_OUTPUTS] : ["denoised_latent"]
      const feeds = {
        noisy_latent: new ort.Tensor("float32", latent, [1, latentDim, latentLength]),
        text_emb: textEmb,
        style_ttl: style.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new ort.Tensor("float32", new Float32Array([step]), [1]),
        total_step: totalStep,
      }
      const result = await this.sessions.vectorEst.run(feeds, fetches)
      latent = new Float32Array(result.denoised_latent.data as Float32Array)
      if (attention && fetches.length > 1) {
        for (const name of ALIGNMENT_OUTPUTS) accumulateAttention(attention, result[name].data as Float32Array, result[name].dims, contentStart, contentEnd)
      }
    }

    const { wav_tts: wav } = await this.sessions.vocoder.run({ latent: new ort.Tensor("float32", latent, [1, latentDim, latentLength]) })
    const samples = (wav.data as Float32Array).slice(0, Math.min(wav.data.length, wavLength))
    let words: number[] | undefined
    try {
      if (attention) words = wordStarts(text, processed.slice(contentStart, contentEnd), attention, latentLength, chunkSize / this.sampleRate)
    } catch {
      // Captions fall back to estimated timings.
    }
    return { samples, words }
  }
}
