import { useEffect, useRef, useState } from "react"
import { Clock3, Library, LoaderCircle, Plus, Search, Settings, X } from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@workspace/ui/components/tooltip"
import { ConfirmProvider } from "@/components/confirm-dialog"
import { ACCEPTED_FILES } from "@/lib/importers"
import { bookDuration, library, useLibrary } from "@/lib/library"
import { formatDuration } from "@/lib/text"
import { BookView } from "@/views/book-view"
import { LibraryView } from "@/views/library-view"
import { PlayerView } from "@/views/player-view"
import { SettingsView } from "@/views/settings-view"

type Route = { view: "library" } | { view: "settings" } | { view: "book"; id: string } | { view: "player"; id: string; chapter?: number }

function Logo() {
  return (
    <div className="flex items-center gap-2.5" aria-label="Verba">
      <div className="logo-mark" aria-hidden="true"><span /><span /><span /><span /></div>
      <span className="text-[15px] font-[510] tracking-[-0.02em]">Verba</span>
    </div>
  )
}

function AccessGate() {
  const [code, setCode] = useState("")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await library.login(code)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="access-gate">
      <form className="access-card" onSubmit={(event) => void submit(event)}>
        <Logo />
        <label className="field mt-6" htmlFor="access-code">
          <span>Access code</span>
          <input autoComplete="current-password" autoFocus id="access-code" onChange={(event) => setCode(event.target.value)} type="password" value={code} />
        </label>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <Button className="mt-4 w-full" disabled={busy || !code} type="submit">Open library</Button>
      </form>
    </main>
  )
}

export function App() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const { books, authRequired, loadError } = useLibrary()
  const [route, setRoute] = useState<Route>({ view: "library" })
  const [query, setQuery] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string>()

  useEffect(() => {
    void library.init()
  }, [])

  const book = route.view === "book" || route.view === "player" ? books.find((item) => item.id === route.id) : undefined
  const total = books.reduce((sum, item) => sum + bookDuration(item), 0)

  useEffect(() => {
    document.title = book ? `${book.title} — Verba` : "Verba — Audiobook Studio"
  }, [book])

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  const addBook = () => fileInputRef.current?.click()

  const importFiles = async (files: File[]) => {
    if (!files.length) return
    setImporting(true)
    setImportError(undefined)
    let lastId: string | undefined
    for (const file of files) {
      try {
        lastId = (await library.importFile(file)).id
      } catch (error) {
        setImportError(`${file.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    setImporting(false)
    if (lastId && files.length === 1) setRoute({ view: "book", id: lastId })
  }

  if (authRequired) return <AccessGate />

  if (route.view === "player" && book) {
    return (
      <TooltipProvider>
        <main className="player-page">
          <PlayerView book={book} initialChapter={route.chapter} key={`${book.id}-${route.chapter ?? "resume"}`} onBack={() => setRoute({ view: "book", id: book.id })} />
        </main>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      <ConfirmProvider>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="app-shell">
        <header className="topbar">
          <button className="rounded-md" onClick={() => setRoute({ view: "library" })} type="button"><Logo /></button>
          {total > 0 && <Badge className="ms-6 hidden sm:inline-flex" variant="outline"><Clock3 aria-hidden="true" />{formatDuration(total)}</Badge>}
          <div className="ms-auto flex items-center gap-1.5">
            {searchOpen ? (
              <div className="search-field">
                <Search aria-hidden="true" />
                <input aria-label="Search library" onChange={(event) => { setQuery(event.target.value); setRoute({ view: "library" }) }} onKeyDown={(event) => event.key === "Escape" && (setQuery(""), setSearchOpen(false))} placeholder="Search books" ref={searchRef} value={query} />
                <button aria-label="Close search" onClick={() => { setQuery(""); setSearchOpen(false) }} type="button"><X aria-hidden="true" /></button>
              </div>
            ) : (
              books.length > 0 && <Tooltip><TooltipTrigger render={<Button aria-label="Search" onClick={() => setSearchOpen(true)} size="icon" variant="ghost" />}><Search aria-hidden="true" /></TooltipTrigger><TooltipContent>Search library</TooltipContent></Tooltip>
            )}
            <Button className="hidden sm:inline-flex" disabled={importing} onClick={addBook}>
              {importing ? <LoaderCircle aria-hidden="true" className="animate-spin" data-icon="inline-start" /> : <Plus aria-hidden="true" data-icon="inline-start" />}
              {importing ? "Importing…" : "Add book"}
            </Button>
          </div>
        </header>
        <aside className="app-sidebar" aria-label="Primary navigation">
          <nav className="flex flex-col gap-1">
            <button className={route.view === "settings" ? "side-button" : "side-button side-button-active"} onClick={() => setRoute({ view: "library" })} type="button"><Library aria-hidden="true" /><span>Books</span></button>
          </nav>
          <div className="mt-auto">
            <button className={route.view === "settings" ? "side-button side-button-active" : "side-button"} onClick={() => setRoute({ view: "settings" })} type="button"><Settings aria-hidden="true" /><span>Settings</span></button>
          </div>
        </aside>
        <main className="workspace" id="main-content">
          {loadError && (
            <div className="import-error" role="alert">
              <span className="min-w-0 flex-1">Can’t reach the Verba server: {loadError}</span>
              <button className="!w-auto px-2" onClick={() => void library.refresh()} type="button">Retry</button>
            </div>
          )}
          {importError && (
            <div className="import-error" role="alert">
              <span className="min-w-0 flex-1">{importError}</span>
              <button aria-label="Dismiss" onClick={() => setImportError(undefined)} type="button"><X aria-hidden="true" /></button>
            </div>
          )}
          {route.view === "book" && book ? (
            <BookView book={book} onBack={() => setRoute({ view: "library" })} onOpenSettings={() => setRoute({ view: "settings" })} onPlay={(chapter) => setRoute({ view: "player", id: book.id, chapter })} />
          ) : route.view === "settings" ? (
            <SettingsView />
          ) : (
            <LibraryView onAdd={addBook} onOpen={(id) => setRoute({ view: "book", id })} onPlay={(id) => setRoute({ view: "player", id })} query={query} />
          )}
        </main>
        <input accept={ACCEPTED_FILES} className="sr-only" multiple onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.target.value = "" }} ref={fileInputRef} tabIndex={-1} type="file" />
        <nav className="bottom-nav" aria-label="Mobile navigation">
          <button className={route.view === "settings" ? undefined : "bottom-nav-active"} onClick={() => setRoute({ view: "library" })} type="button"><Library aria-hidden="true" /><span>Books</span></button>
          <button className="bottom-nav-add" disabled={importing} onClick={addBook} type="button"><Plus aria-hidden="true" /><span>Add</span></button>
          <button className={route.view === "settings" ? "bottom-nav-active" : undefined} onClick={() => setRoute({ view: "settings" })} type="button"><Settings aria-hidden="true" /><span>Settings</span></button>
        </nav>
      </div>
      </ConfirmProvider>
    </TooltipProvider>
  )
}
