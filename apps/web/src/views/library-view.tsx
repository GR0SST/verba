import { BookOpen, Play, Plus } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Progress } from "@workspace/ui/components/progress"
import { BookCover } from "@/components/book-cover"
import { bookDuration, bookProgress, percent, readProgress, statusLabel, useLibrary } from "@/lib/library"
import { formatDuration, formatTime } from "@/lib/text"
import type { Book } from "@/lib/types"

function BookCard({ book, onOpen }: { book: Book; onOpen: () => void }) {
  const { progress, queue, active } = useLibrary()
  const ratio = bookProgress(book, progress[book.id])
  const duration = bookDuration(book)
  const generating = queue.includes(book.id)
  const read = readProgress(book)

  return (
    <button className="book-card" onClick={onOpen} type="button">
      <BookCover book={book} read={read} />
      <span className="mt-3 block min-w-0">
        <span className="block truncate text-start text-sm font-[510] text-foreground">{book.title}</span>
        <span className="mt-1 block truncate text-start text-xs text-muted-foreground">{book.author || `${book.chapters.length} chapters`}</span>
      </span>
      <span className="mt-3 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[9px] text-muted-foreground">{statusLabel(book, ratio, { queued: generating, generating: active === book.id })}</span>
        <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{read > 0 ? `Read ${percent(read)}%` : duration ? formatDuration(duration) : "Draft"}</span>
      </span>
      {generating && <Progress aria-label={`${book.title} generation progress`} className="mt-2" value={ratio * 100} />}
    </button>
  )
}

export function LibraryView({ query, onOpen, onPlay, onAdd }: { query: string; onOpen: (id: string) => void; onPlay: (id: string) => void; onAdd: () => void }) {
  const { books, loaded } = useLibrary()
  const needle = query.trim().toLowerCase()
  const visible = needle ? books.filter((book) => `${book.title} ${book.author}`.toLowerCase().includes(needle)) : books
  const total = books.reduce((sum, book) => sum + bookDuration(book), 0)
  const last = books.find((book) => book.position && book.chapters[book.position.chapter]?.audio)

  if (loaded && books.length === 0) {
    return (
      <div className="library-view">
        <div className="empty-state">
          <span className="empty-state-icon"><BookOpen aria-hidden="true" /></span>
          <h1 className="text-2xl font-[510] tracking-[-0.03em]">Your library is empty</h1>
          <p className="max-w-sm text-sm text-pretty text-muted-foreground">Import an EPUB, DOCX, Markdown or plain-text file. Verba narrates it on your device with Supertonic and adds word-synced captions.</p>
          <Button className="mt-2" onClick={onAdd}><Plus aria-hidden="true" data-icon="inline-start" />Import book</Button>
        </div>
      </div>
    )
  }

  const lastChapter = last?.position && last.chapters[last.position.chapter]
  const lastDuration = lastChapter?.audio?.duration ?? 0

  return (
    <div className="library-view">
      <div className="library-heading">
        <div>
          <div className="section-kicker">{books.length} {books.length === 1 ? "book" : "books"}{total > 0 && ` · ${formatDuration(total)}`}</div>
          <h1 className="mt-1 text-[clamp(2rem,4vw,3rem)] leading-none font-[510] tracking-[-0.045em]">Library</h1>
        </div>
      </div>

      <section className="mt-8" aria-labelledby="books-heading">
        <h2 className="sr-only" id="books-heading">All books</h2>
        {visible.length ? (
          <div className="books-grid">{visible.map((book) => <BookCard book={book} key={book.id} onOpen={() => onOpen(book.id)} />)}</div>
        ) : (
          <p className="text-sm text-muted-foreground">No books match “{query}”.</p>
        )}
      </section>

      {last?.position && lastChapter && (
        <section className="continue-section" aria-labelledby="continue-heading">
          <div className="flex items-end justify-between gap-4">
            <div><div className="section-kicker">Last played</div><h2 className="mt-1 text-xl font-[510] tracking-[-0.025em]" id="continue-heading">Continue</h2></div>
            <span className="font-mono text-[10px] text-muted-foreground">Chapter {last.position.chapter + 1} of {last.chapters.length}</span>
          </div>
          <button className="continue-card" onClick={() => onPlay(last.id)} type="button">
            <BookCover book={last} compact read={readProgress(last)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-start text-sm font-[510]">{last.title}</span>
              <span className="mt-1 block truncate text-start text-xs text-muted-foreground">{lastChapter.title} · {formatTime(Math.max(0, lastDuration - last.position.time))} left</span>
              <Progress aria-label="Chapter listening progress" className="mt-3" value={lastDuration ? (last.position.time / lastDuration) * 100 : 0} />
            </span>
            <span className="continue-play"><Play aria-hidden="true" fill="currentColor" /></span>
          </button>
        </section>
      )}
    </div>
  )
}
