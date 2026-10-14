import { useEffect, useRef, useState } from "react"

import { ttsEngine } from "@/tts/client"
import type { SynthesisOptions } from "@/tts/supertonic"
import type { Book } from "./types"

/**
 * A representative passage to audition the voice on: real prose from the next chapter to be generated
 * (the AI-prepared version when one exists, so stress marks are heard), long enough to judge pace
 * and intonation. Headings and lists are skipped by looking further into the book.
 */
export function previewText(book: Book) {
  const next = Math.max(0, book.chapters.findIndex((chapter) => !chapter.audio))
  let fallback = ""
  for (const chapter of [...book.chapters.slice(next), ...book.chapters.slice(0, next)]) {
    for (const [index, segment] of chapter.segments.entries()) {
      const text = chapter.spoken?.[index] || segment
      if (text.length >= 80 && /[.!?…]["»”)]*$/u.test(text)) return text
      if (text.length > fallback.length) fallback = text
    }
  }
  return fallback
}

function toWav(samples: Float32Array, sampleRate: number) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const ascii = (offset: number, text: string) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)))
  ascii(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true))
  return new Blob([view], { type: "audio/wav" })
}

export type PreviewState = "idle" | "preparing" | "playing"

/** Synthesizes one passage with the given settings and plays it; calling `stop` cancels either phase. */
export function useVoicePreview() {
  const [state, setState] = useState<PreviewState>("idle")
  const [error, setError] = useState<string>()
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined)
  const runRef = useRef(0)

  const stop = () => {
    runRef.current++
    audioRef.current?.pause()
    if (audioRef.current) URL.revokeObjectURL(audioRef.current.src)
    audioRef.current = undefined
    setState("idle")
  }

  useEffect(() => stop, [])

  const play = async (text: string, options: SynthesisOptions) => {
    stop()
    const run = runRef.current
    setError(undefined)
    setState("preparing")
    try {
      const { sampleRate } = await ttsEngine.load()
      const { samples } = await ttsEngine.synthesize(text, options)
      if (run !== runRef.current) return
      const audio = new Audio(URL.createObjectURL(toWav(samples, sampleRate)))
      audioRef.current = audio
      audio.onended = () => run === runRef.current && stop()
      await audio.play()
      setState("playing")
    } catch (cause) {
      if (run !== runRef.current) return
      setState("idle")
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return { state, error, play, stop }
}
