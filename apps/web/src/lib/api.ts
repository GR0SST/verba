import type { Book, ChapterAudio } from "./types"

type Nullable<T> = { [K in keyof T]?: T[K] | null }
export type BookPatch = Nullable<Pick<Book, "title" | "author" | "language" | "voice" | "speed" | "steps" | "enhance" | "status" | "error" | "coverType" | "coverVersion">>

export class UnauthorizedError extends Error {
  constructor() {
    super("Access code required")
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init)
  if (response.status === 401) throw new UnauthorizedError()
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Server error ${response.status}`)
  }
  return (await response.json()) as T
}

const sendJson = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

export type AiStatus = {
  available: boolean
  connected: boolean
  email?: string
  plan?: string
  loginPending: boolean
  models: Array<{ id: string; name: string }>
  model: string
  effort: "low" | "medium"
  error?: string
}
export type MediaKind = "background" | "ambient"
/** A user-uploaded player background (video or image) or ambient track. */
export type UploadedMedia = { id: string; kind: MediaKind; name: string; type: string; size: number; createdAt: number }

export type AiLogin = { type: "chatgpt"; authUrl: string } | { type: "chatgptDeviceCode"; verificationUrl: string; userCode: string }

export const api = {
  aiStatus: () => request<AiStatus>("/ai"),
  aiLogin: () => request<AiLogin>("/ai/login", { method: "POST" }),
  aiLogout: () => request("/ai/logout", { method: "POST" }),
  aiSettings: (settings: { model?: string; effort?: "low" | "medium" }) => request("/ai/settings", sendJson("PUT", settings)),
  enhanceChapter: (id: string, chapter: number) => request<{ spoken: string[]; model: string }>(`/books/${id}/enhance/${chapter}`, { method: "POST" }),
  session: () => request<{ authorized: boolean; protected: boolean }>("/session"),
  login: (token: string) => request<{ authorized: boolean }>("/session", sendJson("POST", { token })),
  listBooks: () => request<Book[]>("/books"),
  putBook: (book: Book) => request(`/books/${book.id}`, sendJson("PUT", book)),
  deleteBook: (id: string) => request(`/books/${id}`, { method: "DELETE" }),
  savePosition: (id: string, chapter: number, time: number) => request(`/books/${id}/position`, { ...sendJson("PATCH", { chapter, time }), keepalive: true }),
  putCover: (id: string, blob: Blob) => request(`/books/${id}/cover`, { method: "PUT", body: blob }),
  putAudio: (id: string, chapter: number, blob: Blob) => request(`/books/${id}/audio/${chapter}`, { method: "PUT", body: blob }),
  /** Only the sent fields change on the server; `null` removes a field. Returns the server's book. */
  patchBook: (id: string, patch: BookPatch) => request<Book>(`/books/${id}`, sendJson("PATCH", patch)),
  setChapterAudio: (id: string, chapter: number, audio: ChapterAudio) => request<Book>(`/books/${id}/chapters/${chapter}`, sendJson("PATCH", { audio })),
  deleteChapterAudio: (id: string, chapter: number) => request<Book>(`/books/${id}/audio/${chapter}`, { method: "DELETE" }),
  deleteAudio: (id: string) => request<Book>(`/books/${id}/audio`, { method: "DELETE" }),
  listMedia: () => request<UploadedMedia[]>("/media"),
  uploadMedia: (kind: MediaKind, file: File) => request<UploadedMedia>(`/media?kind=${kind}&name=${encodeURIComponent(file.name.replace(/\.[^.]+$/, ""))}`, { method: "POST", headers: { "content-type": file.type }, body: file }),
  deleteMedia: (id: string) => request(`/media/${id}`, { method: "DELETE" }),
  mediaUrl: (id: string) => `/api/media/${id}`,
  coverUrl: (book: Pick<Book, "id" | "coverVersion">) => `/api/books/${book.id}/cover?v=${book.coverVersion ?? 0}`,
  audioUrl: (id: string, chapter: number, version: number) => `/api/books/${id}/audio/${chapter}?v=${version}`,
}
