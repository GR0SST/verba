import { Database } from "bun:sqlite"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"

import { CodexService } from "./codex"
import { enhanceSegments } from "./enhance"

const PORT = Number(process.env.PORT ?? 8787)
const DATA_DIR = path.resolve(process.env.VERBA_DATA_DIR ?? path.join(import.meta.dir, "../data"))
/** Optional shared secret. Unset = open access (fine on a home LAN, not on the internet). */
const TOKEN = process.env.VERBA_TOKEN
const WEB_DIST = path.resolve(import.meta.dir, "../../web/dist")
const MAX_AUDIO_BYTES = 200 * 1024 * 1024
const MAX_COVER_BYTES = 10 * 1024 * 1024
const MAX_MEDIA_BYTES = 500 * 1024 * 1024

mkdirSync(path.join(DATA_DIR, "books"), { recursive: true })
mkdirSync(path.join(DATA_DIR, "media"), { recursive: true })
const db = new Database(path.join(DATA_DIR, "verba.sqlite"), { create: true })
db.run("PRAGMA journal_mode = WAL")
db.run("CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)")
// User-uploaded player backgrounds (video/image) and ambient tracks (audio).
db.run("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL)")

db.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
const getSetting = (key: string) => db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value
const setSetting = (key: string, value: string) => db.query("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2").run(key, value)

const codex = new CodexService(DATA_DIR)
// Benchmarked on Russian fiction: Sol (low effort) places stress marks far more accurately than Luna, and faster.
const DEFAULT_MODEL = "gpt-6-sol"
// Medium reasoning fixes most remaining stress errors (переводи́ла, not переводила́) at ~1.6× the time.
const DEFAULT_EFFORT = "medium"
const enhancing = new Map<string, Promise<string[]>>()

type Row = { data: string }
const selectAll = db.query<Row, []>("SELECT data FROM books ORDER BY updated_at DESC")
const selectOne = db.query<Row, [string]>("SELECT data FROM books WHERE id = ?")
const upsert = db.query("INSERT INTO books (id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = ?2, updated_at = ?3")
const remove = db.query("DELETE FROM books WHERE id = ?")

/** Top-level book fields clients may PATCH; chapters and position have their own endpoints. */
const BOOK_FIELDS = ["title", "author", "language", "voice", "speed", "steps", "enhance", "status", "error", "coverType", "coverVersion"]
const ID = /^[A-Za-z0-9-]{8,64}$/
const bookDir = (id: string) => path.join(DATA_DIR, "books", id)
const audioPath = (id: string, chapter: number) => path.join(bookDir(id), `${chapter}.opus`)
const coverPath = (id: string) => path.join(bookDir(id), "cover")
const mediaPath = (id: string) => path.join(DATA_DIR, "media", id)

type MediaRow = { id: string; kind: string; name: string; type: string; size: number; created_at: number }
const MEDIA_TYPES: Record<string, RegExp> = { background: /^(video|image)\//, ambient: /^audio\// }
const listMedia = db.query<MediaRow, []>("SELECT * FROM media ORDER BY created_at")
const getMedia = db.query<MediaRow, [string]>("SELECT * FROM media WHERE id = ?")
const insertMedia = db.query("INSERT INTO media (id, kind, name, type, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
const deleteMedia = db.query("DELETE FROM media WHERE id = ?")
const mediaJson = ({ created_at, ...row }: MediaRow) => ({ ...row, createdAt: created_at })

const json = (body: unknown, init?: ResponseInit, request?: Request) => {
  const text = JSON.stringify(body)
  const gzip = text.length > 2048 && /\bgzip\b/.test(request?.headers.get("accept-encoding") ?? "")
  return new Response(gzip ? Bun.gzipSync(text) : text, {
    ...init,
    headers: { "content-type": "application/json", ...(gzip ? { "content-encoding": "gzip", vary: "accept-encoding" } : {}), ...init?.headers },
  })
}
const error = (status: number, message: string) => json({ error: message }, { status })

function authorized(request: Request) {
  if (!TOKEN) return true
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)verba_token=([^;]+)/)?.[1]
  return bearer === TOKEN || (cookie !== undefined && decodeURIComponent(cookie) === TOKEN)
}

/** Serves a file with HTTP Range support — iOS Safari refuses to play audio without it. */
async function serveFile(request: Request, filePath: string, type?: string, cache = "private, max-age=31536000, immutable") {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return error(404, "Not found")
  const size = file.size
  const headers: Record<string, string> = { "accept-ranges": "bytes", "cache-control": cache, "content-type": type ?? file.type }
  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/)
  if (!range) return new Response(file, { headers: { ...headers, "content-length": String(size) } })
  let start = range[1] ? Number(range[1]) : size - Number(range[2])
  let end = range[1] && range[2] ? Number(range[2]) : size - 1
  start = Math.max(0, start)
  end = Math.min(size - 1, end)
  if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } })
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
  })
}

async function readLimited(request: Request, limit: number) {
  const length = Number(request.headers.get("content-length") ?? 0)
  if (length > limit) return undefined
  const body = await request.arrayBuffer()
  return body.byteLength > limit ? undefined : body
}

function getBook(id: string) {
  const row = selectOne.get(id)
  return row ? (JSON.parse(row.data) as Record<string, unknown>) : undefined
}

function saveBook(book: Record<string, unknown>) {
  upsert.run(book.id as string, JSON.stringify(book), Date.now())
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean).slice(1) // drop "api"
  const method = request.method

  if (parts[0] === "session") {
    if (method === "GET") return json({ authorized: authorized(request), protected: !!TOKEN })
    if (method === "POST") {
      const { token } = (await request.json().catch(() => ({}))) as { token?: string }
      if (TOKEN && token !== TOKEN) return error(401, "Wrong access code")
      const cookie = `verba_token=${encodeURIComponent(token ?? "")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
      return json({ authorized: true }, { headers: { "set-cookie": cookie } })
    }
  }

  if (!authorized(request)) return error(401, "Unauthorized")

  if (parts[0] === "ai") {
    if (parts[1] === undefined && method === "GET") {
      const status = await codex.status()
      const saved = getSetting("ai.model")
      const model = saved && status.models.some((item) => item.id === saved) ? saved : status.models.find((item) => item.id === DEFAULT_MODEL)?.id ?? status.models[0]?.id ?? saved ?? DEFAULT_MODEL
      return json({ ...status, model, effort: getSetting("ai.effort") ?? DEFAULT_EFFORT })
    }
    if (parts[1] === "login" && method === "POST") return json(await codex.login())
    if (parts[1] === "logout" && method === "POST") {
      await codex.logout()
      return json({ ok: true })
    }
    if (parts[1] === "settings" && method === "PUT") {
      const { model, effort } = (await request.json().catch(() => ({}))) as { model?: string; effort?: string }
      if (model !== undefined && !/^[\w.\-]{1,80}$/.test(model)) return error(400, "Invalid model")
      if (effort !== undefined && !["low", "medium"].includes(effort)) return error(400, "Invalid effort")
      if (model) setSetting("ai.model", model)
      if (effort) setSetting("ai.effort", effort)
      return json({ ok: true })
    }
    return error(404, "Not found")
  }

  if (parts[0] === "media") {
    if (parts.length === 1 && method === "GET") return json(listMedia.all().map(mediaJson))
    if (parts.length === 1 && method === "POST") {
      const kind = url.searchParams.get("kind") ?? ""
      const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
      if (!MEDIA_TYPES[kind]?.test(type)) return error(415, kind === "ambient" ? "Ambient sounds must be audio files" : "Backgrounds must be videos or images")
      const body = await readLimited(request, MAX_MEDIA_BYTES)
      if (!body) return error(413, "File too large (max 500 MB)")
      const name = (url.searchParams.get("name") ?? "").trim().slice(0, 120) || "Untitled"
      const row: MediaRow = { id: crypto.randomUUID(), kind, name, type, size: body.byteLength, created_at: Date.now() }
      await Bun.write(mediaPath(row.id), body)
      insertMedia.run(row.id, row.kind, row.name, row.type, row.size, row.created_at)
      return json(mediaJson(row))
    }
    const row = parts.length === 2 && ID.test(parts[1]) ? getMedia.get(parts[1]) : undefined
    if (!row) return error(404, "Not found")
    if (method === "GET") return serveFile(request, mediaPath(row.id), row.type)
    if (method === "DELETE") {
      deleteMedia.run(row.id)
      rmSync(mediaPath(row.id), { force: true })
      return json({ ok: true })
    }
  }

  if (parts[0] !== "books") return error(404, "Not found")
  if (parts.length === 1 && method === "GET") return json(selectAll.all().map((row) => JSON.parse(row.data)), undefined, request)

  const id = parts[1]
  if (!id || !ID.test(id)) return error(400, "Invalid book id")

  if (parts.length === 2) {
    if (method === "GET") {
      const found = getBook(id)
      return found ? json(found, undefined, request) : error(404, "Not found")
    }
    if (method === "PUT") {
      const book = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined
      if (!book || book.id !== id || !Array.isArray(book.chapters)) return error(400, "Invalid book")
      // Create-only: edits go through PATCH so a stale device can't overwrite newer chapters.
      if (getBook(id)) return error(409, "Book already exists")
      saveBook(book)
      return json({ ok: true })
    }
    if (method === "DELETE") {
      remove.run(id)
      rmSync(bookDir(id), { recursive: true, force: true })
      return json({ ok: true })
    }
  }

  const book = getBook(id)
  if (!book) return error(404, "Not found")

  // Listening progress is patched separately so a phone and a desktop never clobber each other's book edits.
  type Chapter = Record<string, unknown> & { audio?: unknown }
  const chapters = () => book.chapters as Chapter[]

  // Field-level edits: several devices edit the same book, so nothing here rewrites what wasn't sent.
  if (parts.length === 2 && method === "PATCH") {
    const patch = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined
    if (!patch || typeof patch !== "object") return error(400, "Invalid patch")
    const next: Record<string, unknown> = { ...book }
    for (const key of BOOK_FIELDS) {
      if (!(key in patch)) continue
      if (patch[key] === null) delete next[key]
      else next[key] = patch[key]
    }
    saveBook(next)
    return json(next, undefined, request)
  }

  if (parts[2] === "chapters" && method === "PATCH") {
    const chapter = Number(parts[3])
    const patch = (await request.json().catch(() => undefined)) as { audio?: unknown } | undefined
    if (!Number.isInteger(chapter) || !chapters()[chapter] || !patch || typeof patch.audio !== "object" || patch.audio === null) return error(400, "Invalid chapter patch")
    const next = { ...book, chapters: chapters().map((item, index) => (index === chapter ? { ...item, audio: patch.audio } : item)) }
    saveBook(next)
    return json(next, undefined, request)
  }

  if (parts[2] === "position" && method === "PATCH") {
    const { chapter, time } = (await request.json().catch(() => ({}))) as { chapter?: number; time?: number }
    if (!Number.isInteger(chapter) || typeof time !== "number" || !Number.isFinite(time)) return error(400, "Invalid position")
    saveBook({ ...book, position: { chapter, time }, lastPlayedAt: Date.now() })
    return json({ ok: true })
  }

  // Rewrites one chapter into its spoken form (numbers, abbreviations, stress marks, junk removed) via Codex.
  if (parts[2] === "enhance" && method === "POST") {
    const chapter = Number(parts[3])
    const chapters = book.chapters as Array<{ segments: string[]; spoken?: string[] }>
    if (!Number.isInteger(chapter) || !chapters[chapter]) return error(400, "Invalid chapter")
    const status = await codex.status()
    if (!status.connected) return error(409, "Connect ChatGPT in Settings first")
    const model = getSetting("ai.model") ?? DEFAULT_MODEL
    const key = `${id}:${chapter}`
    let job = enhancing.get(key)
    if (!job) {
      job = enhanceSegments(codex, { model, effort: getSetting("ai.effort") ?? DEFAULT_EFFORT }, String(book.language ?? "en"), chapters[chapter].segments)
      enhancing.set(key, job)
      void job.finally(() => enhancing.delete(key)).catch(() => undefined)
    }
    const spoken = await job
    const latest = getBook(id)
    if (latest) {
      const latestChapters = latest.chapters as Array<Record<string, unknown>>
      latestChapters[chapter] = { ...latestChapters[chapter], spoken, spokenModel: model }
      saveBook(latest)
    }
    return json({ spoken, model })
  }

  if (parts[2] === "cover") {
    if (method === "GET") return serveFile(request, coverPath(id), typeof book.coverType === "string" ? book.coverType : "image/jpeg")
    if (method === "PUT") {
      const body = await readLimited(request, MAX_COVER_BYTES)
      if (!body) return error(413, "Cover too large")
      mkdirSync(bookDir(id), { recursive: true })
      await Bun.write(coverPath(id), body)
      return json({ ok: true })
    }
  }

  if (parts[2] === "audio") {
    if (parts.length === 3 && method === "DELETE") {
      for (let index = 0; index < chapters().length; index++) rmSync(audioPath(id, index), { force: true })
      const next: Record<string, unknown> = { ...book, chapters: chapters().map(({ audio: _audio, ...item }) => item), status: "draft" }
      delete next.position
      saveBook(next)
      return json(next, undefined, request)
    }
    const chapter = Number(parts[3])
    if (!Number.isInteger(chapter) || chapter < 0 || chapter >= (book.chapters as unknown[]).length) return error(400, "Invalid chapter")
    if (method === "GET") return serveFile(request, audioPath(id, chapter), "audio/ogg")
    if (method === "DELETE") {
      rmSync(audioPath(id, chapter), { force: true })
      const next: Record<string, unknown> = { ...book, chapters: chapters().map((item, index) => (index === chapter ? (({ audio: _audio, ...rest }) => rest)(item) : item)), status: "draft" }
      if ((book.position as { chapter?: number } | undefined)?.chapter === chapter) delete next.position
      saveBook(next)
      return json(next, undefined, request)
    }
    if (method === "PUT") {
      const body = await readLimited(request, MAX_AUDIO_BYTES)
      if (!body) return error(413, "Audio too large")
      mkdirSync(bookDir(id), { recursive: true })
      await Bun.write(audioPath(id, chapter), body)
      return json({ ok: true })
    }
  }

  return error(404, "Not found")
}

/** In production the API also serves the built web app (SPA fallback to index.html). */
async function handleStatic(request: Request, url: URL) {
  const relative = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "")
  const filePath = path.join(WEB_DIST, relative)
  if (filePath.startsWith(WEB_DIST + path.sep) && (await Bun.file(filePath).exists())) {
    // Hashed bundles are immutable; media (video, ambient track) needs Range for iOS.
    return serveFile(request, filePath, undefined, relative.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600")
  }
  const index = Bun.file(path.join(WEB_DIST, "index.html"))
  return (await index.exists()) ? new Response(index) : new Response("Web app is not built. Run `bun run build`.", { status: 404 })
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  maxRequestBodySize: Math.max(MAX_AUDIO_BYTES, MAX_MEDIA_BYTES),
  // Chapter enhancement holds the request open while the model works.
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, url)
      return await handleStatic(request, url)
    } catch (cause) {
      console.error(cause)
      return error(500, "Internal error")
    }
  },
})

console.log(`Verba API on http://localhost:${server.port} · data in ${DATA_DIR}${TOKEN ? " · access code required" : ""}`)
