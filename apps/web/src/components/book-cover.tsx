import { cn } from "@workspace/ui/lib/utils"
import { api } from "@/lib/api"
import type { Book } from "@/lib/types"

const PALETTES = [
  ["#e7e3d6", "#0b0c0d"],
  ["#d9e1da", "#13291a"],
  ["#18213d", "#eef0ff"],
  ["#d8cfb3", "#171510"],
  ["#2a1c1f", "#ffd9cf"],
  ["#1d2b2a", "#d4fff3"],
  ["#ece2f4", "#2b1838"],
  ["#e4f222", "#08090a"],
]

function hash(value: string) {
  let result = 0
  for (let i = 0; i < value.length; i++) result = (result * 31 + value.charCodeAt(i)) | 0
  return Math.abs(result)
}

export function BookCover({ book, compact = false, className, read = 0 }: { book: Pick<Book, "id" | "title" | "author" | "coverType" | "coverVersion">; compact?: boolean; className?: string; read?: number }) {
  const url = book.coverType ? api.coverUrl(book) : undefined
  const [background, foreground] = PALETTES[hash(book.id) % PALETTES.length]
  const initial = Array.from(book.title.trim())[0]?.toUpperCase() ?? "V"

  return (
    <div
      aria-hidden="true"
      className={cn("library-cover", compact && "library-cover-compact", className)}
      style={url ? undefined : { background, color: foreground }}
    >
      {url ? (
        <img alt="" className="library-cover-image" decoding="async" loading="lazy" src={url} />
      ) : (
        <>
          {book.author && <span className="cover-eyebrow">{book.author}</span>}
          <strong className="cover-title">{book.title}</strong>
          <span className="cover-letter">{initial}</span>
        </>
      )}
      {read > 0 && <span className="cover-read"><span style={{ width: `${Math.max(2, read * 100)}%` }} /></span>}
    </div>
  )
}
