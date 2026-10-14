// Streams PCM into an Ogg Opus file via WebCodecs. Ogg Opus plays natively in
// Chrome, Firefox and Safari 18.4+ (incl. iOS), at ~15 MB per hour of speech.

const OPUS_RATE = 48000
const BITRATE = 32000
const DEFAULT_PRE_SKIP = 312
const PACKETS_PER_PAGE = 50

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i << 24
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1
    table[i] = crc >>> 0
  }
  return table
})()

function oggCrc(bytes: Uint8Array) {
  let crc = 0
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0
  return crc
}

function oggPage(packets: Uint8Array[], granule: bigint, serial: number, sequence: number, headerType: number) {
  const lacing: number[] = []
  for (const packet of packets) {
    let size = packet.length
    while (size >= 255) {
      lacing.push(255)
      size -= 255
    }
    lacing.push(size)
  }
  const bodySize = packets.reduce((sum, packet) => sum + packet.length, 0)
  const page = new Uint8Array(27 + lacing.length + bodySize)
  const view = new DataView(page.buffer)
  page.set([0x4f, 0x67, 0x67, 0x53]) // "OggS"
  view.setUint8(5, headerType)
  view.setBigInt64(6, granule, true)
  view.setUint32(14, serial, true)
  view.setUint32(18, sequence, true)
  view.setUint8(26, lacing.length)
  page.set(lacing, 27)
  let offset = 27 + lacing.length
  for (const packet of packets) {
    page.set(packet, offset)
    offset += packet.length
  }
  view.setUint32(22, oggCrc(page), true)
  return page
}

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0))

function opusHead(preSkip: number, inputRate: number) {
  const head = new Uint8Array(19)
  const view = new DataView(head.buffer)
  head.set(ascii("OpusHead"))
  view.setUint8(8, 1)
  view.setUint8(9, 1)
  view.setUint16(10, preSkip, true)
  view.setUint32(12, inputRate, true)
  return head
}

function opusTags() {
  const vendor = ascii("Verba")
  const tags = new Uint8Array(8 + 4 + vendor.length + 4)
  tags.set(ascii("OpusTags"))
  new DataView(tags.buffer).setUint32(8, vendor.length, true)
  tags.set(vendor, 12)
  return tags
}

async function resample(samples: Float32Array, fromRate: number) {
  if (fromRate === OPUS_RATE) return samples
  const length = Math.max(1, Math.round((samples.length * OPUS_RATE) / fromRate))
  const context = new OfflineAudioContext(1, length, OPUS_RATE)
  const buffer = context.createBuffer(1, samples.length, fromRate)
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  source.start()
  return (await context.startRendering()).getChannelData(0)
}

export async function isOpusSupported() {
  if (typeof AudioEncoder === "undefined" || typeof OfflineAudioContext === "undefined") return false
  const { supported } = await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: 1, bitrate: BITRATE })
  return !!supported
}

/** Incremental encoder: push PCM passage by passage, then `finish()` for the .opus Blob. */
export class OggOpusWriter {
  private readonly encoder: AudioEncoder
  private readonly packets: Array<{ data: Uint8Array; samples: number }> = []
  private preSkip = DEFAULT_PRE_SKIP
  private written = 0
  private error: unknown
  private readonly inputRate: number

  constructor(inputRate: number) {
    this.inputRate = inputRate
    this.encoder = new AudioEncoder({
      output: (chunk, metadata) => {
        const description = metadata?.decoderConfig?.description
        if (description) {
          const bytes = ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength) : new Uint8Array(description)
          if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 8)) === "OpusHead") this.preSkip = bytes[10] | (bytes[11] << 8)
        }
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        this.packets.push({ data, samples: chunk.duration ? Math.round((chunk.duration * OPUS_RATE) / 1e6) : 960 })
      },
      error: (error) => {
        this.error = error
      },
    })
    this.encoder.configure({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: 1, bitrate: BITRATE, opus: { application: "voip", frameDuration: 20000 } } as AudioEncoderConfig)
  }

  async push(samples: Float32Array) {
    if (this.error) throw this.error
    const pcm = await resample(samples, this.inputRate)
    const data = new AudioData({
      format: "f32-planar",
      sampleRate: OPUS_RATE,
      numberOfFrames: pcm.length,
      numberOfChannels: 1,
      timestamp: Math.round((this.written * 1e6) / OPUS_RATE),
      data: pcm as Float32Array<ArrayBuffer>,
    })
    this.encoder.encode(data)
    data.close()
    this.written += pcm.length
  }

  pushSilence(seconds: number) {
    return this.push(new Float32Array(Math.round(seconds * this.inputRate)))
  }

  async finish() {
    await this.encoder.flush()
    this.encoder.close()
    if (this.error) throw this.error

    const serial = (Math.random() * 0xffffffff) >>> 0
    const pages: Uint8Array[] = [oggPage([opusHead(this.preSkip, this.inputRate)], 0n, serial, 0, 0x02), oggPage([opusTags()], 0n, serial, 1, 0)]
    const end = BigInt(this.preSkip + this.written)
    let granule = 0n
    for (let i = 0; i < this.packets.length; i += PACKETS_PER_PAGE) {
      const batch = this.packets.slice(i, i + PACKETS_PER_PAGE)
      for (const packet of batch) granule += BigInt(packet.samples)
      const last = i + PACKETS_PER_PAGE >= this.packets.length
      pages.push(oggPage(batch.map((packet) => packet.data), last && end < granule ? end : granule, serial, pages.length, last ? 0x04 : 0))
    }
    return new Blob(pages as BlobPart[], { type: "audio/ogg; codecs=opus" })
  }
}
