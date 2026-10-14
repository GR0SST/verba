import type { SupertonicLang, SupertonicVoice } from "@/tts/voices"

export type WordTiming = { text: string; start: number; end: number }

/**
 * Timing of one synthesized passage (same index as `Chapter.segments`). `words` holds each word's start
 * relative to `start`, measured from the model's attention; older audio has none and captions estimate.
 */
export type Cue = { start: number; end: number; words?: number[] }

/** `version` busts the HTTP cache when a chapter is regenerated. */
export type ChapterAudio = { duration: number; cues: Cue[]; version: number; /** Narrated from `Chapter.spoken`. */ spoken?: boolean }

export type Chapter = {
  title: string
  /** Text split into passages small enough for one Supertonic call / one caption. */
  segments: string[]
  /** AI-prepared spoken form of `segments` (same length, "" = skipped): expanded numbers, stress marks, junk removed. */
  spoken?: string[]
  spokenModel?: string
  audio?: ChapterAudio
}

/** Persisted status; "generating" is local to the device running the model. */
export type BookStatus = "draft" | "ready" | "error"

export type Book = {
  id: string
  title: string
  author: string
  coverType?: string
  coverVersion?: number
  language: SupertonicLang
  voice: SupertonicVoice
  speed: number
  steps: number
  /** Run chapters through the LLM before narration. */
  enhance?: boolean
  chapters: Chapter[]
  status: BookStatus
  error?: string
  createdAt: number
  lastPlayedAt?: number
  position?: { chapter: number; time: number }
}
