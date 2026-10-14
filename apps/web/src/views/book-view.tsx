import { useEffect, useState } from "react"
import { AudioLines, ChevronLeft, Cpu, LoaderCircle, Play, RotateCcw, Square, Trash2, Volume2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Progress } from "@workspace/ui/components/progress"
import { Slider } from "@workspace/ui/components/slider"
import { Switch } from "@workspace/ui/components/switch"
import { BookCover } from "@/components/book-cover"
import { OptionSelect } from "@/components/option-select"
import { api, type AiStatus } from "@/lib/api"
import { useConfirm } from "@/components/confirm-dialog"
import { bookDuration, bookProgress, library, percent, readProgress, statusLabel, useEngineState, useLibrary } from "@/lib/library"
import { previewText, useVoicePreview } from "@/lib/preview"
import { formatDuration, formatTime } from "@/lib/text"
import type { Book } from "@/lib/types"
import { SUPERTONIC_LANGS, SUPERTONIC_VOICES, type SupertonicLang, type SupertonicVoice } from "@/tts/voices"

const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" })
const VOICE_NAMES: Record<SupertonicVoice, string> = {
  F1: "Female 1", F2: "Female 2", F3: "Female 3", F4: "Female 4", F5: "Female 5",
  M1: "Male 1", M2: "Male 2", M3: "Male 3", M4: "Male 4", M5: "Male 5",
}
const LANGUAGE_OPTIONS = SUPERTONIC_LANGS.map((value: SupertonicLang) => ({ value, label: LANGUAGE_NAMES.of(value) ?? value }))
const VOICE_OPTIONS = SUPERTONIC_VOICES.map((value: SupertonicVoice) => ({ value, label: VOICE_NAMES[value] }))

function EngineStatus() {
  const engine = useEngineState()
  if (engine.status === "idle") return <span>Supertonic 3 · runs on this device (~400 MB model, cached after the first download)</span>
  if (engine.status === "error") return <span className="text-destructive">Model failed to load: {engine.message}</span>
  if (engine.status === "ready") return <span>Supertonic 3 · {engine.backend === "webgpu" ? "WebGPU" : "WebAssembly (CPU)"}</span>
  const percent = engine.total ? Math.min(100, (engine.loaded / engine.total) * 100) : 0
  const size = engine.total > 1000 ? ` · ${(engine.loaded / 1e6).toFixed(0)} / ${(engine.total / 1e6).toFixed(0)} MB` : ""
  return (
    <span className="grid w-full gap-2">
      <span>{engine.label}{size}</span>
      <Progress aria-label="Model download progress" value={percent} />
    </span>
  )
}

function useAiStatus() {
  const [status, setStatus] = useState<AiStatus>()
  useEffect(() => {
    let cancelled = false
    void api.aiStatus().then((next) => !cancelled && setStatus(next)).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  return status
}

export function BookView({ book, onBack, onPlay, onOpenSettings }: { book: Book; onBack: () => void; onPlay: (chapter?: number) => void; onOpenSettings: () => void }) {
  const ai = useAiStatus()
  const aiModel = ai?.models.find((model) => model.id === ai.model)?.name ?? ai?.model
  const { progress, queue, active, activeChapter } = useLibrary()
  const confirm = useConfirm()
  const [speed, setSpeed] = useState(book.speed)
  const [steps, setSteps] = useState(book.steps)
  const preview = useVoicePreview()
  const sample = previewText(book)
  const busy = queue.includes(book.id)
  // WebGPU, Cache Storage and WebCodecs need a secure context (localhost or HTTPS); a phone on plain LAN HTTP only listens.
  const canGenerate = window.isSecureContext
  const ratio = bookProgress(book, progress[book.id])
  const read = readProgress(book)
  const duration = bookDuration(book)
  const readyChapters = book.chapters.filter((chapter) => chapter.audio).length
  const segments = book.chapters.reduce((sum, chapter) => sum + chapter.segments.length, 0)
  const words = book.chapters.reduce((sum, chapter) => sum + chapter.segments.join(" ").split(/\s+/).length, 0)

  const updateVoice = async (patch: Partial<Pick<Book, "language" | "voice" | "speed" | "steps">>) => {
    const ok = readyChapters === 0 || (await confirm({
      title: "Change narration?",
      description: `${readyChapters} generated ${readyChapters === 1 ? "chapter" : "chapters"} will be deleted and need to be generated again with the new settings.`,
      confirmLabel: "Change and delete audio",
      destructive: true,
    }))
    if (ok) void library.update(book.id, patch)
    else {
      setSpeed(book.speed)
      setSteps(book.steps)
    }
  }

  const remove = async () => {
    const ok = await confirm({ title: `Delete “${book.title}”?`, description: "The book, its generated audio and listening progress will be removed from the server.", confirmLabel: "Delete book", destructive: true })
    if (ok) {
      void library.remove(book.id)
      onBack()
    }
  }

  const deleteChapter = async (index: number, regenerate: boolean) => {
    const title = book.chapters[index].title
    const ok = await confirm(regenerate
      ? { title: "Regenerate chapter?", description: `“${title}” will be narrated again with the current voice settings. The existing audio is replaced.`, confirmLabel: "Regenerate" }
      : { title: "Delete chapter audio?", description: `The generated audio for “${title}” will be deleted. The text stays, so you can generate it again later.`, confirmLabel: "Delete audio", destructive: true })
    if (!ok) return
    await library.deleteChapterAudio(book.id, index)
    if (regenerate) library.generate(book.id, index)
  }

  return (
    <div className="library-view">
      <button className="back-link" onClick={onBack} type="button"><ChevronLeft aria-hidden="true" />Library</button>

      <div className="book-hero">
        <BookCover book={book} className="book-hero-cover" read={read} />
        <div className="min-w-0 flex-1">
          <div className="section-kicker">{book.chapters.length} chapters · {words.toLocaleString("en")} words{duration > 0 && ` · ${formatDuration(duration)}`}</div>
          <input aria-label="Title" className="book-title-input" defaultValue={book.title} key={`t-${book.id}`} onBlur={(event) => event.target.value.trim() && event.target.value !== book.title && void library.update(book.id, { title: event.target.value.trim() })} />
          <input aria-label="Author" className="book-author-input" defaultValue={book.author} key={`a-${book.id}`} onBlur={(event) => event.target.value !== book.author && void library.update(book.id, { author: event.target.value.trim() })} placeholder="Author" />

          <div className="mt-6 flex flex-wrap items-center gap-2">
            {readyChapters > 0 && <Button onClick={() => onPlay()}><Play aria-hidden="true" data-icon="inline-start" fill="currentColor" />{book.position ? "Resume" : "Play"}</Button>}
            {busy ? (
              <Button onClick={() => library.cancel(book.id)} variant="outline"><Square aria-hidden="true" data-icon="inline-start" />Stop generating</Button>
            ) : book.status !== "ready" && canGenerate && (
              <Button onClick={() => library.generate(book.id)} variant={readyChapters ? "outline" : "default"}><AudioLines aria-hidden="true" data-icon="inline-start" />{ratio > 0 ? "Continue generating" : "Generate audiobook"}</Button>
            )}
            <Button aria-label="Delete book" className="ms-auto" onClick={() => void remove()} size="icon" variant="ghost"><Trash2 aria-hidden="true" /></Button>
          </div>

          <div className="book-meters">
            <div className="book-meter">
              <div className="book-meter-label"><span>{statusLabel(book, ratio, { queued: busy, generating: active === book.id })}</span><span>{readyChapters} / {book.chapters.length} chapters</span></div>
              <Progress aria-label="Voice generated" value={ratio * 100} />
            </div>
            <div className="book-meter book-meter-read">
              <div className="book-meter-label"><span>Read {percent(read)}%</span><span>{book.position ? `Chapter ${book.position.chapter + 1}` : "Not started"}</span></div>
              <Progress aria-label="Read" value={read * 100} />
            </div>
          </div>
          {!canGenerate && book.status !== "ready" && <p className="mt-3 text-xs text-pretty text-muted-foreground">Audio is generated on your computer: open Verba there via localhost to continue. Chapters appear here as soon as they’re ready.</p>}
          {book.status === "error" && <p className="mt-3 text-xs text-destructive">{book.error}</p>}
          {canGenerate && <div className="engine-status"><Cpu aria-hidden="true" /><EngineStatus /></div>}
        </div>
      </div>

      <section className="voice-panel" aria-labelledby="voice-heading">
        <div className="voice-panel-heading">
          <h2 className="section-kicker" id="voice-heading">Narration</h2>
          {canGenerate && sample && (
            <Button
              aria-label={preview.state === "idle" ? "Preview voice" : "Stop preview"}
              className="-my-1.5"
              // Uses the sliders' current values, so speed and quality can be auditioned before they're applied.
              onClick={() => (preview.state === "idle" ? void preview.play(sample, { lang: book.language, voice: book.voice, speed, steps }) : preview.stop())}
              size="xs"
              title={preview.state === "idle" ? "Hear a passage with these settings" : undefined}
              variant="ghost"
            >
              {preview.state === "idle" ? <Volume2 aria-hidden="true" data-icon="inline-start" /> : preview.state === "preparing" ? <LoaderCircle aria-hidden="true" className="animate-spin" data-icon="inline-start" /> : <Square aria-hidden="true" data-icon="inline-start" />}
              {preview.state === "idle" ? "Preview" : "Stop"}
            </Button>
          )}
        </div>
        {preview.error && <p className="mt-2 text-xs text-destructive">Preview failed: {preview.error}</p>}
        <div className="voice-grid">
          <div className="field">
            <label htmlFor="book-language">Language</label>
            <OptionSelect disabled={busy} id="book-language" onChange={(language) => void updateVoice({ language })} options={LANGUAGE_OPTIONS} value={book.language} />
          </div>
          <div className="field">
            <label htmlFor="book-voice">Voice</label>
            <OptionSelect disabled={busy} id="book-voice" onChange={(voice) => void updateVoice({ voice })} options={VOICE_OPTIONS} value={book.voice} />
          </div>
          <div className="field">
            <span className="flex justify-between"><label htmlFor="speed">Speed</label><span className="font-mono tabular-nums">{speed.toFixed(2)}×</span></span>
            <Slider disabled={busy} id="speed" max={1.5} min={0.8} onValueChange={(value) => setSpeed(typeof value === "number" ? value : value[0])} onValueCommitted={() => speed !== book.speed && void updateVoice({ speed })} step={0.05} value={speed} />
          </div>
          <div className="field">
            <span className="flex justify-between"><label htmlFor="steps">Quality</label><span className="font-mono tabular-nums">{steps} steps</span></span>
            <Slider disabled={busy} id="steps" max={16} min={2} onValueChange={(value) => setSteps(typeof value === "number" ? value : value[0])} onValueCommitted={() => steps !== book.steps && void updateVoice({ steps })} step={1} value={steps} />
          </div>
        </div>
        <div className="enhance-row">
          <div className="min-w-0 flex-1">
            <label className="text-[13px] font-[510] text-foreground" htmlFor="enhance-switch">Enhance text with AI</label>
            <p className="mt-0.5 text-xs text-pretty text-muted-foreground">
              {ai?.connected
                ? <>{aiModel} prepares each chapter before narration: numbers and abbreviations spelled out, stress marks, footnotes and copyright notices removed. Applies to chapters generated from now on.</>
                : <>Connect ChatGPT in <button className="text-foreground underline underline-offset-2" onClick={onOpenSettings} type="button">Settings</button> to spell out numbers, add stress marks and remove junk before narration.</>}
            </p>
          </div>
          <Switch checked={!!book.enhance && !!ai?.connected} disabled={busy || !ai?.connected} id="enhance-switch" onCheckedChange={(checked) => void library.update(book.id, { enhance: checked })} />
        </div>
      </section>

      <section className="mt-10" aria-labelledby="chapters-heading">
        <div className="flex items-end justify-between">
          <h2 className="section-kicker" id="chapters-heading">Chapters</h2>
          <span className="font-mono text-[10px] text-muted-foreground">{segments} passages</span>
        </div>
        <ol className="chapter-table">
          {book.chapters.map((chapter, index) => (
            <li key={index}>
              <div className="chapter-row">
                <button className="chapter-row-main" disabled={!chapter.audio} onClick={() => onPlay(index)} type="button">
                  <span className="chapter-number">{(index + 1).toString().padStart(2, "0")}</span>
                  <span className="min-w-0 flex-1 truncate text-start">{chapter.title}</span>
                  {chapter.spoken && <span className="chapter-ai" title={`Prepared by ${chapter.spokenModel ?? "AI"}`}>AI</span>}
                  <span className="chapter-time">{chapter.audio ? formatTime(chapter.audio.duration) : `${chapter.segments.length} passages`}</span>
                  {chapter.audio && <Play aria-hidden="true" className="chapter-play" fill="currentColor" />}
                </button>
                {!chapter.audio && canGenerate && (
                  <span className="chapter-actions">
                    {active === book.id && activeChapter === index ? (
                      <span className="chapter-status"><LoaderCircle aria-hidden="true" className="animate-spin" />Generating</span>
                    ) : library.isChapterQueued(book.id, index) ? (
                      <span className="chapter-status">Queued</span>
                    ) : (
                      <button aria-label={`Generate ${chapter.title}`} className="chapter-action chapter-action-generate" onClick={() => library.generate(book.id, index)} title="Generate this chapter" type="button"><AudioLines aria-hidden="true" /></button>
                    )}
                  </span>
                )}
                {chapter.audio && canGenerate && (
                  <span className="chapter-actions">
                    <button aria-label={`Regenerate ${chapter.title}`} className="chapter-action" disabled={busy} onClick={() => void deleteChapter(index, true)} title="Regenerate" type="button"><RotateCcw aria-hidden="true" /></button>
                    <button aria-label={`Delete audio for ${chapter.title}`} className="chapter-action chapter-action-danger" disabled={busy} onClick={() => void deleteChapter(index, false)} title="Delete audio" type="button"><Trash2 aria-hidden="true" /></button>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
