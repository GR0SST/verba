import { useSyncExternalStore } from "react"

import { ttsEngine } from "@/tts/client"
import { api, UnauthorizedError, type BookPatch } from "./api"
import { importBookFile } from "./importers"
import { isOpusSupported, OggOpusWriter } from "./opus"
import { detectLanguage, segmentText } from "./text"
import type { Book, Cue } from "./types"

/** Silence inserted between passages; the model output itself has almost no tail. */
const SEGMENT_GAP = 0.32
const CHAPTER_GAP = 0.8
const REFRESH_INTERVAL = 15000

type Progress = { chars: number; total: number }
type LibraryState = {
  books: Book[]
  loaded: boolean
  authRequired: boolean
  loadError?: string
  progress: Record<string, Progress>
  queue: string[]
  /** Book currently being synthesized on this device. */
  active?: string
  /** Chapter of `active` currently being narrated. */
  activeChapter?: number
}

let state: LibraryState = { books: [], loaded: false, authRequired: false, progress: {}, queue: [] }
const listeners = new Set<() => void>()
const cancelRequested = new Set<string>()
let refreshTimer: number | undefined
let running = false
/** Books queued for specific chapters only; absent = the whole book. */
const chapterFilter = new Map<string, Set<number>>()

function setState(patch: Partial<LibraryState>) {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

function sortBooks(books: Book[]) {
  return [...books].sort((a, b) => (b.lastPlayedAt ?? b.createdAt) - (a.lastPlayedAt ?? a.createdAt))
}

function setLocal(book: Book) {
  setState({ books: sortBooks([...state.books.filter((item) => item.id !== book.id), book]) })
}

/** Optimistic local update, then the server's merged copy wins. */
async function patchBook(id: string, patch: BookPatch) {
  const book = findBook(id)
  if (book) setLocal({ ...book, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? undefined])) })
  const saved = await api.patchBook(id, patch)
  setLocal(saved)
  return saved
}

const findBook = (id: string) => state.books.find((book) => book.id === id)
const charsOf = (segments: string[]) => segments.reduce((sum, segment) => sum + segment.length, 0)
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`)

export function bookProgress(book: Book, progress?: Progress) {
  if (progress) return progress.total ? progress.chars / progress.total : 0
  const total = book.chapters.reduce((sum, chapter) => sum + charsOf(chapter.segments), 0)
  const done = book.chapters.reduce((sum, chapter) => sum + (chapter.audio ? charsOf(chapter.segments) : 0), 0)
  return total ? done / total : 0
}

/** Share of the book's text already listened to, from the saved position. */
export function readProgress(book: Book) {
  const position = book.position
  if (!position) return 0
  const total = book.chapters.reduce((sum, chapter) => sum + charsOf(chapter.segments), 0)
  if (!total) return 0
  let read = book.chapters.slice(0, position.chapter).reduce((sum, chapter) => sum + charsOf(chapter.segments), 0)
  const current = book.chapters[position.chapter]
  if (current?.audio?.duration) read += charsOf(current.segments) * Math.min(1, position.time / current.audio.duration)
  return Math.min(1, read / total)
}

export const percent = (ratio: number) => (ratio > 0 && ratio < 0.1 ? (ratio * 100).toFixed(1) : Math.floor(ratio * 100).toString())


export function statusLabel(book: Book, progress: number, { queued, generating }: { queued: boolean; generating: boolean }) {
  if (generating) return `Generating ${percent(progress)}%`
  if (queued) return "Queued"
  if (book.status === "error") return "Generation failed"
  if (book.status === "ready") return "Voiced 100%"
  return progress > 0 ? `Voiced ${percent(progress)}%` : "Not voiced"
}

export const bookDuration = (book: Book) => book.chapters.reduce((sum, chapter) => sum + (chapter.audio?.duration ?? 0), 0)

async function generateBook(id: string) {
  const { sampleRate } = await ttsEngine.load()
  const opus = await isOpusSupported()
  if (!opus) throw new Error("This browser cannot encode Opus (WebCodecs). Generate in Chrome or Edge.")
  let book = findBook(id)
  if (!book) return
  if (book.status === "error") book = await patchBook(id, { status: "draft", error: null })

  const total = book.chapters.reduce((sum, chapter) => sum + charsOf(chapter.segments), 0)
  let chars = book.chapters.reduce((sum, chapter) => sum + (chapter.audio ? charsOf(chapter.segments) : 0), 0)
  setState({ active: id, progress: { ...state.progress, [id]: { chars, total } } })
  if (cancelRequested.has(id)) return

  // With AI enhancement on, the next chapter is prepared by the LLM while the current one is narrated.
  const prepared = new Map<number, Promise<string[]>>()
  const only = chapterFilter.get(id)
  const wanted = (index: number) => !only || only.has(index)
  const prepare = (index: number) => {
    const chapter = book?.chapters[index]
    if (index < 0 || !wanted(index) || !book?.enhance || !chapter || chapter.audio || chapter.spoken) return
    if (!prepared.has(index)) {
      const job = api.enhanceChapter(id, index).then(({ spoken, model }) => {
        const latest = findBook(id)
        if (latest) setLocal({ ...latest, chapters: latest.chapters.map((item, i) => (i === index ? { ...item, spoken, spokenModel: model } : item)) })
        return spoken
      })
      job.catch(() => undefined)
      prepared.set(index, job)
    }
  }

  // Chapters can be added to a chapter-only run while it works, so sweep until none is left.
  for (let pass = 0; pass < 10 && book.chapters.some((chapter, index) => !chapter.audio && wanted(index)); pass++)
  for (let index = 0; index < book.chapters.length; index++) {
    if (book.chapters[index].audio || !wanted(index)) continue
    setState({ activeChapter: index })
    prepare(index)
    const spoken: string[] | undefined = prepared.has(index) ? await prepared.get(index) : book.chapters[index].spoken
    prepare(book.chapters.findIndex((item, i) => i > index && !item.audio && wanted(i)))
    book = findBook(id) ?? book
    const chapter = book.chapters[index]
    const texts = spoken ?? chapter.segments
    const writer = new OggOpusWriter(sampleRate)
    const cues: Cue[] = []
    let time = 0
    for (const [position, segment] of texts.entries()) {
      if (cancelRequested.has(id)) return
      // Progress is measured on the original text so it stays comparable with/without AI.
      const original = chapter.segments[position]?.length ?? 0
      if (!segment.trim()) {
        cues.push({ start: time, end: time })
        chars += original
        continue
      }
      const options = { lang: book.language, voice: book.voice, steps: book.steps, speed: book.speed }
      const { samples, words } = await ttsEngine.synthesize(segment, options)
      const duration = samples.length / sampleRate
      cues.push(words ? { start: time, end: time + duration, words } : { start: time, end: time + duration })
      await writer.push(samples)
      await writer.pushSilence(SEGMENT_GAP)
      time += duration + SEGMENT_GAP
      chars += original
      setState({ progress: { ...state.progress, [id]: { chars, total } } })
    }
    await writer.pushSilence(CHAPTER_GAP - SEGMENT_GAP)
    time += CHAPTER_GAP - SEGMENT_GAP
    const blob = await writer.finish()
    if (cancelRequested.has(id)) return
    await api.putAudio(id, index, blob)
    book = await api.setChapterAudio(id, index, { duration: time, cues, version: Date.now(), spoken: !!spoken })
    setLocal(book)
  }
  await patchBook(id, { status: book.chapters.every((chapter) => chapter.audio) ? "ready" : "draft" })
}

async function drainQueue() {
  if (running) return
  running = true
  while (state.queue.length) {
    const id = state.queue[0]
    try {
      await generateBook(id)
    } catch (error) {
      const book = findBook(id)
      if (book) await patchBook(id, { status: "error", error: error instanceof Error ? error.message : String(error) }).catch(() => undefined)
    }
    cancelRequested.delete(id)
    const { [id]: _done, ...progress } = state.progress
    void _done
    chapterFilter.delete(id)
    setState({ active: undefined, activeChapter: undefined, queue: state.queue.filter((item) => item !== id), progress })
  }
  running = false
}

async function load() {
  try {
    const remote = await api.listBooks()
    // Never let a poll overwrite the book this device is writing chapters into.
    const books = remote.map((book) => (book.id === state.active ? (findBook(book.id) ?? book) : book))
    setState({ books: sortBooks(books), loaded: true, authRequired: false, loadError: undefined })
  } catch (error) {
    if (error instanceof UnauthorizedError) setState({ authRequired: true, loaded: true })
    else setState({ loaded: true, loadError: error instanceof Error ? error.message : String(error) })
  }
}

export const library = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getState: () => state,

  /** Loads the library and keeps it in sync with other devices (e.g. a desktop generating while a phone listens). */
  async init() {
    if (refreshTimer !== undefined) return
    await load()
    refreshTimer = window.setInterval(() => document.visibilityState === "visible" && void load(), REFRESH_INTERVAL)
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void load())
  },

  refresh: load,

  async login(token: string) {
    await api.login(token)
    await load()
  },

  async importFile(file: File) {
    const imported = await importBookFile(file)
    const chapters = imported.chapters
      .map((chapter) => ({ title: chapter.title, segments: segmentText(chapter.text) }))
      .filter((chapter) => chapter.segments.length > 0)
    if (chapters.length === 0) throw new Error("No readable text found in this file")
    const book: Book = {
      id: newId(),
      title: imported.title,
      author: imported.author,
      language: detectLanguage(imported.chapters.map((chapter) => chapter.text).join("\n").slice(0, 20000)),
      voice: "F1",
      speed: 1.05,
      steps: 8,
      chapters,
      status: "draft",
      createdAt: Date.now(),
    }
    await api.putBook(book)
    setLocal(book)
    if (imported.cover) {
      await api.putCover(book.id, imported.cover)
      return patchBook(book.id, { coverType: imported.cover.type || "image/jpeg", coverVersion: Date.now() })
    }
    return book
  },

  async update(id: string, patch: Partial<Pick<Book, "title" | "author" | "language" | "voice" | "speed" | "steps" | "enhance">>) {
    const book = findBook(id)
    if (!book) return
    const voiceChanged = (["language", "voice", "speed", "steps"] as const).some((key) => key in patch && patch[key] !== book[key])
    if (voiceChanged && state.queue.includes(id)) return
    if (voiceChanged && book.chapters.some((chapter) => chapter.audio)) setLocal(await api.deleteAudio(id))
    await patchBook(id, patch)
  },

  async deleteChapterAudio(id: string, index: number) {
    const book = findBook(id)
    if (!book?.chapters[index]?.audio || state.queue.includes(id)) return
    setLocal(await api.deleteChapterAudio(id, index))
  },

  savePosition(id: string, chapter: number, time: number) {
    const book = findBook(id)
    if (!book) return
    setLocal({ ...book, position: { chapter, time }, lastPlayedAt: Date.now() })
    void api.savePosition(id, chapter, time).catch(() => undefined)
  },

  async remove(id: string) {
    if (state.queue.includes(id)) library.cancel(id)
    await api.deleteBook(id)
    setState({ books: state.books.filter((book) => book.id !== id) })
  },

  /** Queues the whole book, or only `chapter` (added to an already queued chapter-only run). */
  generate(id: string, chapter?: number) {
    const filter = chapterFilter.get(id)
    if (state.queue.includes(id)) {
      // Extending a chapter-only run; a whole-book run already covers every chapter.
      if (filter && chapter !== undefined) filter.add(chapter)
      else if (filter) chapterFilter.delete(id)
      setState({})
      return
    }
    if (chapter !== undefined) chapterFilter.set(id, new Set([chapter]))
    else chapterFilter.delete(id)
    cancelRequested.delete(id)
    const book = findBook(id)
    const total = book ? book.chapters.reduce((sum, chapter) => sum + charsOf(chapter.segments), 0) : 0
    const chars = book ? bookProgress(book) * total : 0
    setState({ queue: [...state.queue, id], progress: { ...state.progress, [id]: { chars, total } } })
    void drainQueue()
  },

  /** Whether `chapter` will be narrated by the current queue. */
  isChapterQueued(id: string, chapter: number) {
    if (!state.queue.includes(id)) return false
    const filter = chapterFilter.get(id)
    return !filter || filter.has(chapter)
  },

  cancel(id: string) {
    chapterFilter.delete(id)
    if (state.queue[0] === id) {
      cancelRequested.add(id)
      return
    }
    const { [id]: _removed, ...progress } = state.progress
    void _removed
    setState({ queue: state.queue.filter((item) => item !== id), progress })
  },
}

export function useLibrary() {
  return useSyncExternalStore(library.subscribe, library.getState)
}

export function useEngineState() {
  return useSyncExternalStore(ttsEngine.subscribe, ttsEngine.getState)
}
