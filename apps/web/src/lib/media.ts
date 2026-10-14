import { useEffect, useSyncExternalStore } from "react"

import { api, type MediaKind } from "./api"

export type MediaItem = { id: string; kind: MediaKind; name: string; type: string; url: string; size?: number; builtin?: boolean }

/** Bundled with the app (apps/web/public); always available and can't be deleted. */
const BUILTIN: MediaItem[] = [
  { id: "builtin-parkour", kind: "background", name: "Minecraft parkour", type: "video/mp4", url: "/minecraft-parkour.mp4", builtin: true },
  { id: "builtin-ambient", kind: "ambient", name: "Ambient", type: "audio/mpeg", url: "/ambient-background.mp3", builtin: true },
]

let items: MediaItem[] = BUILTIN
let loading: Promise<void> | undefined
const listeners = new Set<() => void>()

function emit(next: MediaItem[]) {
  items = next
  listeners.forEach((listener) => listener())
}

async function refresh() {
  const uploaded = await api.listMedia()
  emit([...BUILTIN, ...uploaded.map((item) => ({ ...item, url: api.mediaUrl(item.id) }))])
}

export const media = {
  refresh,
  async upload(kind: MediaKind, file: File) {
    const item = await api.uploadMedia(kind, file)
    emit([...items, { ...item, url: api.mediaUrl(item.id) }])
    return item
  },
  async remove(id: string) {
    await api.deleteMedia(id)
    emit(items.filter((item) => item.id !== id))
  },
}

/** All backgrounds and ambient tracks (built-in first); fetches the uploaded ones once per session. */
export function useMedia() {
  useEffect(() => {
    loading ??= refresh().catch(() => {
      loading = undefined
    })
  }, [])
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => items,
  )
}

/** The chosen item of a kind, falling back to the built-in one when it was deleted. */
export const pickMedia = (list: MediaItem[], kind: MediaKind, id?: string) =>
  list.find((item) => item.kind === kind && item.id === id) ?? list.find((item) => item.kind === kind && item.builtin)!
