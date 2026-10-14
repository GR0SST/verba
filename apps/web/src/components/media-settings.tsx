import { useRef, useState } from "react"
import { Clapperboard, Image, LoaderCircle, Music, Trash2, Upload, Video } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { useConfirm } from "@/components/confirm-dialog"
import type { MediaKind } from "@/lib/api"
import { media, useMedia, type MediaItem } from "@/lib/media"

const GROUPS: Array<{ kind: MediaKind; title: string; hint: string; accept: string }> = [
  { kind: "background", title: "Backgrounds", hint: "Videos loop muted behind the captions; images stay still.", accept: "video/*,image/*" },
  { kind: "ambient", title: "Ambient sounds", hint: "Loops quietly under the narration.", accept: "audio/*" },
]

const formatSize = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`)

function MediaRow({ item }: { item: MediaItem }) {
  const confirm = useConfirm()
  const Icon = item.kind === "ambient" ? Music : item.type.startsWith("image/") ? Image : Video
  const remove = async () => {
    const ok = await confirm({ title: `Delete “${item.name}”?`, description: "The file is removed from the server. Players using it switch back to the built-in one.", confirmLabel: "Delete", destructive: true })
    if (ok) await media.remove(item.id)
  }
  return (
    <div className="media-row">
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-[13px]">{item.name}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{item.builtin ? "Built-in" : formatSize(item.size ?? 0)}</span>
      {!item.builtin && <Button aria-label={`Delete ${item.name}`} onClick={() => void remove()} size="icon-xs" variant="ghost"><Trash2 aria-hidden="true" /></Button>}
    </div>
  )
}

function MediaGroup({ kind, title, hint, accept, items }: (typeof GROUPS)[number] & { items: MediaItem[] }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string>()
  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    setUploading(true)
    setError(undefined)
    try {
      for (const file of files) await media.upload(kind, file)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }
  return (
    <div className="bg-background px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-[510]">{title}</div>
          <div className="text-xs text-muted-foreground">{hint}</div>
        </div>
        <Button disabled={uploading} onClick={() => inputRef.current?.click()} size="sm" variant="outline">
          {uploading ? <LoaderCircle aria-hidden="true" className="animate-spin" data-icon="inline-start" /> : <Upload aria-hidden="true" data-icon="inline-start" />}
          {uploading ? "Uploading…" : "Upload"}
        </Button>
        <input accept={accept} className="hidden" multiple onChange={(event) => void upload(event.target.files)} ref={inputRef} type="file" />
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-3 grid gap-1">{items.map((item) => <MediaRow item={item} key={item.id} />)}</div>
    </div>
  )
}

/** Uploading and deleting player backgrounds and ambient tracks; which one plays is picked in the player. */
export function MediaSettings() {
  const items = useMedia()
  return (
    <section className="settings-card" aria-labelledby="media-heading">
      <div className="flex items-start gap-3">
        <span className="settings-card-icon"><Clapperboard aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-[510] tracking-[-0.02em]" id="media-heading">Player media</h2>
          <p className="mt-1 text-[13px] text-pretty text-muted-foreground">Your own backgrounds and ambient sounds for the player. They’re stored on the server, so every device can use them; choose one in the player’s settings.</p>
        </div>
      </div>
      <div className="settings-card-body">
        {GROUPS.map((group) => <MediaGroup key={group.kind} {...group} items={items.filter((item) => item.kind === group.kind)} />)}
      </div>
    </section>
  )
}
