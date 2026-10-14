import type { SupertonicLang } from "@/tts/voices"
import type { Cue, WordTiming } from "./types"

const MAX_SEGMENT = 200
const ABBREVIATIONS = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Inc|Ltd|Co|т\.е|т\.д|т\.п|г|гг|им|ул|стр|рис)\.|\b[A-ZА-ЯЁ]\.)$/u

function splitSentences(paragraph: string) {
  const sentences: string[] = []
  let current = ""
  for (const piece of paragraph.split(/(?<=[.!?…])\s+/u)) {
    current = current ? `${current} ${piece}` : piece
    if (!ABBREVIATIONS.test(current)) {
      sentences.push(current)
      current = ""
    }
  }
  if (current) sentences.push(current)
  return sentences
}

function splitLong(sentence: string): string[] {
  if (sentence.length <= MAX_SEGMENT) return [sentence]
  const window = sentence.slice(0, MAX_SEGMENT)
  let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "), window.lastIndexOf(" - "))
  if (cut < MAX_SEGMENT * 0.4) cut = window.lastIndexOf(" ")
  if (cut <= 0) cut = MAX_SEGMENT
  return [sentence.slice(0, cut + 1).trim(), ...splitLong(sentence.slice(cut + 1).trim())]
}

/** Splits chapter text into caption-sized passages, never breaking a sentence unless it is too long. */
export function segmentText(text: string) {
  const segments: string[] = []
  for (const paragraph of text.split(/\n\s*\n+|\r?\n(?=\s*[-—–]\s)/u)) {
    const clean = paragraph.replace(/\s+/g, " ").trim()
    if (!clean || !/[\p{L}\p{N}]/u.test(clean)) continue
    let current = ""
    for (const sentence of splitSentences(clean).flatMap(splitLong)) {
      if (current && current.length + sentence.length + 1 > MAX_SEGMENT) {
        segments.push(current)
        current = sentence
      } else {
        current = current ? `${current} ${sentence}` : sentence
      }
    }
    if (current) segments.push(current)
  }
  return segments
}

export function detectLanguage(text: string): SupertonicLang {
  const sample = text.slice(0, 20000)
  const count = (pattern: RegExp) => sample.match(pattern)?.length ?? 0
  const scripts: Array<[SupertonicLang, number]> = [
    ["ko", count(/[가-힯]/g)],
    ["ja", count(/[぀-ヿ]/g)],
    ["ar", count(/[؀-ۿ]/g)],
    ["hi", count(/[ऀ-ॿ]/g)],
    ["el", count(/[Ͱ-Ͽ]/g)],
  ]
  const cyrillic = count(/[Ѐ-ӿ]/g)
  const latin = count(/[a-z]/gi)
  const [script, scriptCount] = scripts.sort((a, b) => b[1] - a[1])[0]
  if (scriptCount > Math.max(cyrillic, latin)) return script
  if (cyrillic > latin) return count(/[іїєґ]/gi) > cyrillic * 0.01 ? "uk" : "ru"
  return "en"
}

/** Spreads a passage's duration over its words, weighted by length and trailing punctuation. */
export function estimateWordTimings(text: string, start: number, duration: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const weights = words.map((word) => {
    const letters = word.replace(/[^\p{L}\p{N}]/gu, "").length
    const pause = /[.!?…]["»”)]*$/u.test(word) ? 4 : /[,;:—–-]["»”)]*$/u.test(word) ? 2 : 0
    return Math.max(1, letters) + 1.5 + pause
  })
  const lead = Math.min(0.12, duration * 0.04)
  const usable = Math.max(0.01, duration - lead * 2)
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let cursor = start + lead
  return words.map((word, index) => {
    const length = (weights[index] / total) * usable
    const timing = { text: word, start: cursor, end: cursor + length }
    cursor += length
    return timing
  })
}

/** Word timings for a narrated passage: measured ones when the audio has them, estimated otherwise. */
export function cueWordTimings(text: string, cue: Cue): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean)
  const starts = cue.words
  if (!starts || starts.length !== words.length) return estimateWordTimings(text, cue.start, cue.end - cue.start)
  return words.map((word, index) => ({ text: word, start: cue.start + starts[index], end: index + 1 < words.length ? cue.start + starts[index + 1] : cue.end }))
}

export function formatTime(value: number) {
  if (!Number.isFinite(value)) return "00:00"
  const total = Math.floor(value)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mmss = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
  return hours ? `${hours}:${mmss}` : mmss
}

export function formatDuration(seconds: number) {
  const minutes = Math.round(seconds / 60)
  if (minutes < 1) return `${Math.max(1, Math.round(seconds))}s`
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}
