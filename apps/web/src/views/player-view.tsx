import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Captions, ChevronLeft, Ellipsis, Pause, Play, RotateCcw, RotateCw, Volume1, Volume2, VolumeX } from "lucide-react"

import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { Slider } from "@workspace/ui/components/slider"
import { Switch } from "@workspace/ui/components/switch"
import { ToggleGroup, ToggleGroupItem } from "@workspace/ui/components/toggle-group"
import { cn } from "@workspace/ui/lib/utils"
import { OptionSelect } from "@/components/option-select"
import { api, type MediaKind } from "@/lib/api"
import { library } from "@/lib/library"
import { pickMedia, useMedia } from "@/lib/media"
import { cueWordTimings, formatTime } from "@/lib/text"
import type { Book, Cue, WordTiming } from "@/lib/types"

type BackgroundMode = "parkour" | "soft" | "clean"

const PREFS_KEY = "verba.player"
type CaptionSize = "s" | "m" | "l"
type CaptionMotion = "bounce" | "pop" | "fade"
type CaptionColor = "auto" | "lime" | "pink" | "cyan" | "violet"
type PlayerPrefs = {
  volume: number
  ambientVolume: number
  ambientEnabled: boolean
  background: BackgroundMode
  /** Chosen media ids (built-in or uploaded); a deleted one falls back to the built-in. */
  backgroundMedia?: string
  ambientMedia?: string
  captionWords: number
  captionSize: CaptionSize
  captionMotion: CaptionMotion
  captionColor: CaptionColor
  rate: number
}

const RATES = [0.8, 1, 1.15, 1.3, 1.5, 2]

const TOGGLE_GROUP = "grid w-full grid-cols-3"
const TOGGLE_ITEM = "h-8 min-w-0 border-white/10 px-2 text-[11px] text-white/65 hover:bg-white/10 hover:text-white aria-pressed:border-primary/70 aria-pressed:bg-primary aria-pressed:text-primary-foreground hover:aria-pressed:bg-primary hover:aria-pressed:text-primary-foreground"

const CAPTION_COLORS: CaptionColor[] = ["auto", "lime", "pink", "cyan", "violet"]
const ROTATING_COLORS: CaptionColor[] = ["lime", "pink", "cyan", "violet"]

function readPrefs(): PlayerPrefs {
  const defaults: PlayerPrefs = {
    volume: 0.9,
    ambientVolume: 0.25,
    ambientEnabled: true,
    background: "parkour",
    captionWords: 3,
    captionSize: "m",
    captionMotion: "bounce",
    captionColor: "auto",
    rate: 1,
  }
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") }
  } catch {
    return defaults
  }
}

function findCue(cues: Cue[], time: number) {
  let low = 0
  let high = cues.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (cues[mid].start <= time) {
      found = mid
      low = mid + 1
    } else high = mid - 1
  }
  return found
}

/** Breaks a passage into captions of at most `maxWords`, never carrying a sentence end into the next phrase. */
function paginate(words: WordTiming[], maxWords: number) {
  const pages: WordTiming[][] = []
  let page: WordTiming[] = []
  let chars = 0
  for (const word of words) {
    const previous = page[page.length - 1]
    const sentenceEnd = previous && /[.!?…;:]["»”)]*$/u.test(previous.text)
    const pause = previous && /[,—–-]["»”)]*$/u.test(previous.text) && page.length >= Math.min(2, maxWords)
    const tooLong = chars + word.text.length > 8 * maxWords + 6
    if (page.length && (page.length >= maxWords || sentenceEnd || pause || tooLong)) {
      pages.push(page)
      page = []
      chars = 0
    }
    page.push(word)
    chars += word.text.length + 1
  }
  if (page.length) pages.push(page)
  return pages
}

export function PlayerView({ book, initialChapter, onBack }: { book: Book; initialChapter?: number; onBack: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const narrationRef = useRef<HTMLAudioElement>(null)
  const ambientRef = useRef<HTMLAudioElement>(null)
  const hideTimerRef = useRef<number | undefined>(undefined)
  const overlayOpenRef = useRef(false)
  const autoplayRef = useRef(false)

  const resuming = initialChapter === undefined && !!book.position && !!book.chapters[book.position.chapter]?.audio
  const startChapter = initialChapter ?? (resuming && book.position ? book.position.chapter : Math.max(0, book.chapters.findIndex((chapter) => chapter.audio)))
  const resumeAt = resuming && book.position ? book.position.time : 0
  const resumeAtRef = useRef(resumeAt)
  const [chapterIndex, setChapterIndex] = useState(startChapter)
  const [isPlaying, setIsPlaying] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [time, setTime] = useState(resumeAt)
  const [prefs, setPrefs] = useState(readPrefs)
  const mediaItems = useMedia()
  const backgroundItem = pickMedia(mediaItems, "background", prefs.backgroundMedia)
  const ambientItem = pickMedia(mediaItems, "ambient", prefs.ambientMedia)
  const mediaOptions = (kind: MediaKind) => mediaItems.filter((item) => item.kind === kind).map((item) => ({ value: item.id, label: item.name }))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chaptersOpen, setChaptersOpen] = useState(false)
  const [captionsOpen, setCaptionsOpen] = useState(false)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const lastVolumeRef = useRef(0.9)

  const chapter = book.chapters[chapterIndex]
  const cues = chapter?.audio?.cues ?? []
  const duration = chapter?.audio?.duration ?? 0
  const cueIndex = findCue(cues, time)
  const cue = cues[cueIndex]
  // Captions follow what was actually narrated, minus the stress marks that only guide the TTS.
  const segment = (chapter?.audio?.spoken ? chapter.spoken?.[cueIndex] : chapter?.segments[cueIndex])?.replaceAll("\u0301", "")
  const audioUrl = chapter?.audio ? api.audioUrl(book.id, chapterIndex, chapter.audio.version) : undefined
  const pages = useMemo(() => (cue && segment ? paginate(cueWordTimings(segment, cue), prefs.captionWords) : []), [cue, segment, prefs.captionWords])
  const pageIndex = Math.max(0, pages.findLastIndex((page) => page[0].start <= time))
  const words = pages[pageIndex] ?? []
  // The last word that has started stays lit through pauses, so the highlight never flickers off mid-phrase.
  const activeWord = words.findLastIndex((word) => word.start <= time)
  const captionColor = prefs.captionColor === "auto" ? ROTATING_COLORS[cueIndex % ROTATING_COLORS.length] : prefs.captionColor

  const updatePrefs = (patch: Partial<PlayerPrefs>) =>
    setPrefs((current) => {
      const next = { ...current, ...patch }
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {
        // Preferences are a convenience; ignore storage failures.
      }
      return next
    })

  // Smooth clock for word highlighting (timeupdate only fires ~4×/s).
  useEffect(() => {
    if (!isPlaying) return
    let frame = 0
    const tick = () => {
      if (narrationRef.current) setTime(narrationRef.current.currentTime)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [isPlaying])

  useEffect(() => {
    if (narrationRef.current) {
      narrationRef.current.volume = prefs.volume
      narrationRef.current.playbackRate = prefs.rate
    }
    if (ambientRef.current) ambientRef.current.volume = prefs.ambientEnabled ? prefs.volume * prefs.ambientVolume : 0
  }, [prefs.ambientEnabled, prefs.ambientVolume, prefs.volume, prefs.rate])

  // Switching background or ambient reloads the element, which stops it; resume if the book is playing.
  useEffect(() => {
    if (narrationRef.current?.paused === false) void videoRef.current?.play().catch(() => undefined)
  }, [backgroundItem.url])
  useEffect(() => {
    if (narrationRef.current?.paused === false && prefs.ambientEnabled) void ambientRef.current?.play().catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new track should trigger this
  }, [ambientItem.url])

  const savePosition = useCallback(() => {
    const narration = narrationRef.current
    // Skip until the audio is loaded, or a mount/unmount would overwrite the saved position with 0.
    if (!narration?.currentSrc || narration.readyState === 0 || !Number.isFinite(narration.currentTime)) return
    library.savePosition(book.id, chapterIndex, narration.currentTime)
  }, [book.id, chapterIndex])

  useEffect(() => {
    if (!isPlaying) return
    const interval = window.setInterval(savePosition, 5000)
    return () => window.clearInterval(interval)
  }, [isPlaying, savePosition])

  useEffect(() => () => {
    window.clearTimeout(hideTimerRef.current)
    savePosition()
  }, [savePosition])

  const scheduleControlsHide = useCallback(() => {
    window.clearTimeout(hideTimerRef.current)
    setControlsVisible(true)
    if (narrationRef.current && !narrationRef.current.paused && !overlayOpenRef.current) {
      hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), 2200)
    }
  }, [])

  const play = async () => {
    const narration = narrationRef.current
    if (!narration) return
    await narration.play()
    void videoRef.current?.play().catch(() => undefined)
    if (prefs.ambientEnabled) void ambientRef.current?.play().catch(() => undefined)
  }

  const pauseAll = () => {
    narrationRef.current?.pause()
    videoRef.current?.pause()
    ambientRef.current?.pause()
  }

  const togglePlayback = async () => {
    if (narrationRef.current?.paused) await play()
    else pauseAll()
    scheduleControlsHide()
  }

  const seek = (next: number | readonly number[]) => {
    const value = typeof next === "number" ? next : next[0]
    if (narrationRef.current) narrationRef.current.currentTime = value
    setTime(value)
    scheduleControlsHide()
  }

  const jump = (delta: number) => seek(Math.max(0, Math.min(duration, (narrationRef.current?.currentTime ?? time) + delta)))

  const goToChapter = (index: number, autoplay: boolean) => {
    savePosition()
    autoplayRef.current = autoplay
    resumeAtRef.current = 0
    setTime(0)
    setChapterIndex(index)
  }

  // Lock-screen / headset controls on phones.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapter?.title ?? book.title,
      artist: book.author,
      album: book.title,
      artwork: book.coverType ? [{ src: api.coverUrl(book), type: book.coverType }] : [],
    })
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => void play()],
      ["pause", pauseAll],
      ["seekbackward", () => jump(-15)],
      ["seekforward", () => jump(15)],
      ["previoustrack", () => {
        const previous = book.chapters.findLastIndex((item, index) => index < chapterIndex && item.audio)
        if (previous >= 0) goToChapter(previous, true)
      }],
      ["nexttrack", () => {
        const next = book.chapters.findIndex((item, index) => index > chapterIndex && item.audio)
        if (next >= 0) goToChapter(next, true)
      }],
    ]
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler)
      } catch {
        // Unsupported action on this browser.
      }
    }
  })

  const handleEnded = () => {
    const next = book.chapters.findIndex((item, index) => index > chapterIndex && item.audio)
    if (next >= 0) goToChapter(next, true)
    else {
      pauseAll()
      library.savePosition(book.id, chapterIndex, 0)
    }
  }

  const setVolume = (volume: number) => {
    if (volume > 0) lastVolumeRef.current = volume
    updatePrefs({ volume })
  }

  const cycleRate = () => {
    const rate = RATES[(RATES.indexOf(prefs.rate) + 1) % RATES.length] ?? 1
    updatePrefs({ rate })
    scheduleControlsHide()
  }

  const setOverlay = (kind: "settings" | "chapters" | "captions" | "volume", open: boolean) => {
    overlayOpenRef.current = open
    window.clearTimeout(hideTimerRef.current)
    setControlsVisible(true)
    if (kind === "settings") setSettingsOpen(open)
    else if (kind === "captions") setCaptionsOpen(open)
    else if (kind === "volume") setVolumeOpen(open)
    else setChaptersOpen(open)
    if (!open) scheduleControlsHide()
  }

  const toggleAmbient = (enabled: boolean) => {
    updatePrefs({ ambientEnabled: enabled })
    const ambient = ambientRef.current
    if (!ambient) return
    if (!enabled) ambient.pause()
    else if (narrationRef.current && !narrationRef.current.paused) void ambient.play().catch(() => undefined)
  }

  return (
    <aside className="immersive-player" aria-label={`${book.title} player`}>
      <div className={cn("phone-frame", `phone-frame-bg-${prefs.background}`, !controlsVisible && "player-idle")} onClick={scheduleControlsHide} onMouseMove={scheduleControlsHide} onPointerDown={scheduleControlsHide}>
        {backgroundItem.type.startsWith("image/") ? (
          <img alt="" aria-hidden="true" className="phone-video" src={backgroundItem.url} />
        ) : (
          <video aria-hidden="true" className="phone-video" loop muted playsInline preload="auto" ref={videoRef} src={backgroundItem.url} />
        )}
        <audio aria-hidden="true" loop preload="auto" ref={ambientRef} src={ambientItem.url} />
        <audio
          onEnded={handleEnded}
          onLoadedMetadata={(event) => {
            const narration = event.currentTarget
            narration.volume = prefs.volume
            narration.playbackRate = prefs.rate
            if (resumeAtRef.current > 0 && resumeAtRef.current < narration.duration - 1) narration.currentTime = resumeAtRef.current
            if (autoplayRef.current) {
              autoplayRef.current = false
              void play()
            }
          }}
          onPause={() => {
            window.clearTimeout(hideTimerRef.current)
            setIsPlaying(false)
            setControlsVisible(true)
            videoRef.current?.pause()
            ambientRef.current?.pause()
            savePosition()
          }}
          onPlay={() => {
            setIsPlaying(true)
            scheduleControlsHide()
          }}
          onTimeUpdate={(event) => !isPlaying && setTime(event.currentTarget.currentTime)}
          preload="auto"
          ref={narrationRef}
          src={audioUrl}
        />
        <div className="video-scrim" aria-hidden="true" />

        <div className="player-top-chrome">
          <button aria-label="Back" className="player-icon-button" onClick={() => { pauseAll(); onBack() }} type="button"><ChevronLeft aria-hidden="true" /></button>
          <Popover open={chaptersOpen} onOpenChange={(open) => setOverlay("chapters", open)}>
            <PopoverTrigger className="player-title-button">
              <span className="block truncate text-[11px] font-[510] text-white">{book.title}</span>
              <span className="mt-0.5 block truncate font-mono text-[7px] tracking-[0.08em] text-white/60 uppercase">Chapter {chapterIndex + 1} · {chapter?.title}</span>
            </PopoverTrigger>
            <PopoverContent align="center" className="player-popover chapter-popover" side="bottom" sideOffset={8}>
              <PopoverHeader><PopoverTitle>Chapters</PopoverTitle></PopoverHeader>
              <div className="chapter-list">
                {book.chapters.map((item, index) => (
                  <button aria-current={index === chapterIndex ? "true" : undefined} className="chapter-option" disabled={!item.audio} key={index} onClick={() => { goToChapter(index, true); setOverlay("chapters", false) }} type="button">
                    <span className="chapter-number">{(index + 1).toString().padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1 truncate text-start">{item.title}</span>
                    <span className="chapter-time">{item.audio ? formatTime(item.audio.duration) : "—"}</span>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Popover open={captionsOpen} onOpenChange={(open) => setOverlay("captions", open)}>
            <PopoverTrigger aria-label="Caption settings" className="player-icon-button"><Captions aria-hidden="true" /></PopoverTrigger>
            <PopoverContent align="end" className="player-popover player-settings" side="bottom" sideOffset={8}>
              <PopoverHeader><PopoverTitle>Captions</PopoverTitle></PopoverHeader>
              <fieldset className="settings-group">
                <legend>Words on screen</legend>
                <ToggleGroup aria-label="Words on screen" className={cn(TOGGLE_GROUP, "grid-cols-4")} onValueChange={(value) => value[0] && updatePrefs({ captionWords: Number(value[0]) })} spacing={1} value={[String(prefs.captionWords)]} variant="outline">
                  {[1, 2, 3, 4].map((count) => <ToggleGroupItem className={TOGGLE_ITEM} key={count} value={String(count)}>{count}</ToggleGroupItem>)}
                </ToggleGroup>
              </fieldset>
              <fieldset className="settings-group">
                <legend>Size</legend>
                <ToggleGroup aria-label="Caption size" className={TOGGLE_GROUP} onValueChange={(value) => value[0] && updatePrefs({ captionSize: value[0] as CaptionSize })} spacing={1} value={[prefs.captionSize]} variant="outline">
                  <ToggleGroupItem className={TOGGLE_ITEM} value="s">Small</ToggleGroupItem>
                  <ToggleGroupItem className={TOGGLE_ITEM} value="m">Medium</ToggleGroupItem>
                  <ToggleGroupItem className={TOGGLE_ITEM} value="l">Large</ToggleGroupItem>
                </ToggleGroup>
              </fieldset>
              <fieldset className="settings-group">
                <legend>Animation</legend>
                <ToggleGroup aria-label="Caption animation" className={TOGGLE_GROUP} onValueChange={(value) => value[0] && updatePrefs({ captionMotion: value[0] as CaptionMotion })} spacing={1} value={[prefs.captionMotion]} variant="outline">
                  <ToggleGroupItem className={TOGGLE_ITEM} value="bounce">Bounce</ToggleGroupItem>
                  <ToggleGroupItem className={TOGGLE_ITEM} value="pop">Pop</ToggleGroupItem>
                  <ToggleGroupItem className={TOGGLE_ITEM} value="fade">Fade</ToggleGroupItem>
                </ToggleGroup>
              </fieldset>
              <fieldset className="settings-group">
                <legend>Highlight</legend>
                <div className="caption-swatches" role="radiogroup" aria-label="Highlight color">
                  {CAPTION_COLORS.map((color) => (
                    <button aria-checked={prefs.captionColor === color} aria-label={color === "auto" ? "Rotate colors" : color} className={`caption-swatch caption-swatch-${color}`} key={color} onClick={() => updatePrefs({ captionColor: color })} role="radio" type="button" />
                  ))}
                </div>
              </fieldset>
            </PopoverContent>
          </Popover>
          <Popover open={settingsOpen} onOpenChange={(open) => setOverlay("settings", open)}>
            <PopoverTrigger aria-label="Player settings" className="player-icon-button"><Ellipsis aria-hidden="true" /></PopoverTrigger>
            <PopoverContent align="end" className="player-popover player-settings" side="bottom" sideOffset={8}>
              <PopoverHeader><PopoverTitle>Player settings</PopoverTitle></PopoverHeader>
              <fieldset className="settings-group">
                <legend>Background</legend>
                <OptionSelect variant="player" label="Background media" onChange={(backgroundMedia) => updatePrefs({ backgroundMedia })} options={mediaOptions("background")} value={backgroundItem.id} />
                <ToggleGroup aria-label="Background" className={TOGGLE_GROUP} onValueChange={(value) => value[0] && updatePrefs({ background: value[0] as BackgroundMode })} spacing={1} value={[prefs.background]} variant="outline">
                  <ToggleGroupItem className={TOGGLE_ITEM} value="parkour">Sharp</ToggleGroupItem>
                  <ToggleGroupItem className={TOGGLE_ITEM} value="soft">Soft</ToggleGroupItem>
                  <ToggleGroupItem className={TOGGLE_ITEM} value="clean">Off</ToggleGroupItem>
                </ToggleGroup>
              </fieldset>
              <div className="settings-row">
                <label htmlFor="ambient-switch">Ambient music</label>
                <Switch checked={prefs.ambientEnabled} id="ambient-switch" onCheckedChange={toggleAmbient} />
              </div>
              <OptionSelect variant="player" disabled={!prefs.ambientEnabled} label="Ambient sound" onChange={(ambientMedia) => updatePrefs({ ambientMedia })} options={mediaOptions("ambient")} value={ambientItem.id} />
              <div className={cn("settings-volume", !prefs.ambientEnabled && "settings-volume-disabled")}>
                <div className="settings-volume-label"><label htmlFor="ambient-volume">Ambient volume</label><span>{Math.round(prefs.ambientVolume * 100)}%</span></div>
                <Slider aria-label="Ambient volume" disabled={!prefs.ambientEnabled} id="ambient-volume" max={1} min={0} onValueChange={(value) => updatePrefs({ ambientVolume: typeof value === "number" ? value : value[0] })} step={0.01} value={prefs.ambientVolume} />
              </div>
            </PopoverContent>
          </Popover>
        </div>

        {words.length > 0 && (
          <div aria-live="off" className={`caption-layer caption-size-${prefs.captionSize} caption-motion-${prefs.captionMotion} caption-color-${captionColor}`} key={`${chapterIndex}-${cueIndex}-${pageIndex}`}>
            {words.map((word, index) => (
              <span className="caption-word" key={index} style={{ animationDelay: `${index * 55}ms` }}>
                <span className={cn("caption-word-inner", index === activeWord && "caption-word-active", index < activeWord && "caption-word-spoken")}>{word.text}</span>
              </span>
            ))}
          </div>
        )}

        <div className="player-bottom-chrome">
          <div className="flex items-center justify-between font-mono text-[8px] text-white/65 tabular-nums"><span>{formatTime(time)}</span><span>{formatTime(duration)}</span></div>
          <Slider aria-label="Playback position" max={duration || 1} min={0} onValueChange={seek} step={0.1} value={Math.min(time, duration || 1)} />
          <div className="player-controls">
            <Popover open={volumeOpen} onOpenChange={(open) => setOverlay("volume", open)}>
              <PopoverTrigger aria-label={`Volume ${Math.round(prefs.volume * 100)}%`} className="player-icon-button player-ghost-button">
                {prefs.volume === 0 ? <VolumeX aria-hidden="true" /> : prefs.volume < 0.5 ? <Volume1 aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
              </PopoverTrigger>
              <PopoverContent align="start" className="player-popover player-volume-popover" side="top" sideOffset={10}>
                <div className="settings-volume-label"><label htmlFor="master-volume">Volume</label><span>{Math.round(prefs.volume * 100)}%</span></div>
                <div className="flex items-center gap-3">
                  <button aria-label={prefs.volume === 0 ? "Unmute" : "Mute"} className="player-icon-button size-8 shrink-0" onClick={() => updatePrefs({ volume: prefs.volume === 0 ? lastVolumeRef.current : 0 })} type="button">
                    {prefs.volume === 0 ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
                  </button>
                  <Slider aria-label="Volume" id="master-volume" max={1} min={0} onValueChange={(value) => setVolume(typeof value === "number" ? value : value[0])} step={0.01} value={prefs.volume} />
                </div>
              </PopoverContent>
            </Popover>
            <button aria-label="Back 10 seconds" className="player-icon-button player-skip-button" onClick={() => jump(-10)} type="button"><RotateCcw aria-hidden="true" /><span>10</span></button>
            <button aria-label={isPlaying ? "Pause" : "Play"} className="player-primary-button" disabled={!audioUrl} onClick={() => void togglePlayback()} type="button">{isPlaying ? <Pause aria-hidden="true" fill="currentColor" /> : <Play aria-hidden="true" fill="currentColor" />}</button>
            <button aria-label="Forward 10 seconds" className="player-icon-button player-skip-button" onClick={() => jump(10)} type="button"><RotateCw aria-hidden="true" /><span>10</span></button>
            <button aria-label={`Playback speed ${prefs.rate}×, change`} className="player-icon-button player-ghost-button player-rate-button" onClick={cycleRate} type="button">{prefs.rate}×</button>
          </div>
        </div>
      </div>
    </aside>
  )
}
