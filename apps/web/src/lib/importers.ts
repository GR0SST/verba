import JSZip from "jszip"

export type ImportedBook = {
  title: string
  author: string
  cover?: Blob
  chapters: Array<{ title: string; text: string }>
}

const BLOCK_TAGS = new Set(["P", "DIV", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "SECTION", "ARTICLE", "PRE", "DD", "DT"])
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "HEAD", "NAV", "SUP", "RT"])
const FOOTNOTE_MARK = /\[\d{1,4}\]|\{\d{1,4}\}/g
const CHAPTER_HEADING = /^(?:#{1,2}\s+.+|(?:глава|часть|chapter|part|prologue|epilogue|пролог|эпилог)(?![\p{L}]).{0,80})$/iu

function htmlToText(markup: string) {
  const parser = new DOMParser()
  let doc = parser.parseFromString(markup, "application/xhtml+xml")
  if (doc.getElementsByTagName("parsererror").length) doc = parser.parseFromString(markup, "text/html")
  const body = doc.body ?? doc.documentElement
  const parts: string[] = []
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "")
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const tag = (node as Element).tagName.toUpperCase()
    if (SKIP_TAGS.has(tag)) return
    if (tag === "BR") parts.push("\n")
    const block = BLOCK_TAGS.has(tag)
    if (block) parts.push("\n\n")
    node.childNodes.forEach(walk)
    if (block) parts.push("\n\n")
  }
  walk(body)
  const heading = body.querySelector("h1, h2, h3")?.textContent?.replace(FOOTNOTE_MARK, "").replace(/\s+/g, " ").trim()
  const text = parts.join("").replace(FOOTNOTE_MARK, "").replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  return { text, heading }
}

function resolvePath(base: string, href: string) {
  const parts = (base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "").concat(decodeURIComponent(href.split("#")[0])).split("/")
  const stack: string[] = []
  for (const part of parts) {
    if (part === "..") stack.pop()
    else if (part && part !== ".") stack.push(part)
  }
  return stack.join("/")
}

async function parseEpub(file: File): Promise<ImportedBook> {
  const zip = await JSZip.loadAsync(file)
  const read = (path: string) => zip.file(path)?.async("string")
  const xml = (markup: string) => new DOMParser().parseFromString(markup, "application/xml")

  const container = await read("META-INF/container.xml")
  const opfPath = container && xml(container).querySelector("rootfile")?.getAttribute("full-path")
  const opfMarkup = opfPath && (await read(opfPath))
  if (!opfPath || !opfMarkup) throw new Error("Invalid EPUB: package document not found")
  const opf = xml(opfMarkup)

  const meta = (name: string) => opf.getElementsByTagNameNS("*", name)[0]?.textContent?.trim()
  const manifest = new Map<string, { href: string; type: string; properties: string }>()
  for (const item of Array.from(opf.getElementsByTagNameNS("*", "item"))) {
    manifest.set(item.getAttribute("id") ?? "", {
      href: resolvePath(opfPath, item.getAttribute("href") ?? ""),
      type: item.getAttribute("media-type") ?? "",
      properties: item.getAttribute("properties") ?? "",
    })
  }

  // Table of contents labels (EPUB 3 nav first, then EPUB 2 NCX).
  const labels = new Map<string, string>()
  const navItem = [...manifest.values()].find((item) => item.properties.includes("nav"))
  const navMarkup = navItem && (await read(navItem.href))
  if (navItem && navMarkup) {
    for (const link of Array.from(xml(navMarkup).getElementsByTagNameNS("*", "a"))) {
      const label = link.textContent?.replace(/\s+/g, " ").trim()
      const href = link.getAttribute("href")
      if (label && href) {
        const path = resolvePath(navItem.href, href)
        if (!labels.has(path)) labels.set(path, label)
      }
    }
  }
  const ncxItem = [...manifest.values()].find((item) => item.type === "application/x-dtbncx+xml")
  const ncxMarkup = ncxItem && (await read(ncxItem.href))
  if (ncxItem && ncxMarkup) {
    for (const point of Array.from(xml(ncxMarkup).getElementsByTagNameNS("*", "navPoint"))) {
      const label = point.getElementsByTagNameNS("*", "text")[0]?.textContent?.trim()
      const src = point.getElementsByTagNameNS("*", "content")[0]?.getAttribute("src")
      if (label && src) {
        const path = resolvePath(ncxItem.href, src)
        if (!labels.has(path)) labels.set(path, label)
      }
    }
  }

  const chapters: ImportedBook["chapters"] = []
  for (const ref of Array.from(opf.getElementsByTagNameNS("*", "itemref"))) {
    const item = manifest.get(ref.getAttribute("idref") ?? "")
    if (!item || !/html|xml/.test(item.type)) continue
    const markup = await read(item.href)
    if (!markup) continue
    const { text, heading } = htmlToText(markup)
    if (text.replace(/\s/g, "").length < 40) continue
    chapters.push({ title: labels.get(item.href)?.replace(FOOTNOTE_MARK, "") ?? heading ?? `Chapter ${chapters.length + 1}`, text })
  }

  const coverId = opf.querySelector('meta[name="cover"]')?.getAttribute("content")
  const coverItem = (coverId && manifest.get(coverId)) || [...manifest.values()].find((item) => item.properties.includes("cover-image"))
  const coverData = coverItem && coverItem.type.startsWith("image/") ? await zip.file(coverItem.href)?.async("blob") : undefined

  return {
    title: meta("title") || file.name.replace(/\.[^.]+$/, ""),
    author: meta("creator") || "",
    cover: coverData ? new Blob([coverData], { type: coverItem?.type }) : undefined,
    chapters,
  }
}

async function parseDocx(file: File): Promise<ImportedBook> {
  const zip = await JSZip.loadAsync(file)
  const markup = await zip.file("word/document.xml")?.async("string")
  if (!markup) throw new Error("Invalid DOCX: document.xml not found")
  const doc = new DOMParser().parseFromString(markup, "application/xml")
  const core = await zip.file("docProps/core.xml")?.async("string")
  const coreDoc = core ? new DOMParser().parseFromString(core, "application/xml") : undefined

  const chapters: ImportedBook["chapters"] = []
  let current = { title: "", lines: [] as string[] }
  const flush = () => {
    const text = current.lines.join("\n\n").trim()
    if (text) chapters.push({ title: current.title || `Chapter ${chapters.length + 1}`, text })
  }
  for (const paragraph of Array.from(doc.getElementsByTagNameNS("*", "p"))) {
    const text = Array.from(paragraph.getElementsByTagNameNS("*", "t")).map((node) => node.textContent).join("").trim()
    if (!text) continue
    const style = paragraph.getElementsByTagNameNS("*", "pStyle")[0]?.getAttribute("w:val") ?? ""
    if (/^(heading|заголовок)\s?[12]$/i.test(style) || /^Title$/i.test(style)) {
      flush()
      current = { title: text, lines: [text] }
    } else {
      current.lines.push(text)
    }
  }
  flush()
  return {
    title: coreDoc?.getElementsByTagNameNS("*", "title")[0]?.textContent?.trim() || file.name.replace(/\.[^.]+$/, ""),
    author: coreDoc?.getElementsByTagNameNS("*", "creator")[0]?.textContent?.trim() || "",
    chapters,
  }
}

function stripMarkdown(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/[*_~`]+/g, "")
}

async function parsePlainText(file: File, markdown: boolean): Promise<ImportedBook> {
  const raw = (await file.text()).replace(/\r\n?/g, "\n")
  const chapters: ImportedBook["chapters"] = []
  let current = { title: "", lines: [] as string[] }
  const flush = () => {
    const body = current.lines.join("\n").trim()
    const text = markdown ? stripMarkdown(body) : body
    if (text.replace(/\s/g, "").length) chapters.push({ title: current.title || `Chapter ${chapters.length + 1}`, text })
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed && trimmed.length < 90 && CHAPTER_HEADING.test(trimmed)) {
      flush()
      const title = trimmed.replace(/^#+\s*/, "")
      current = { title, lines: [title + "."] }
    } else {
      current.lines.push(line)
    }
  }
  flush()
  const title = markdown ? raw.match(/^#\s+(.+)$/m)?.[1]?.trim() : undefined
  return { title: title || file.name.replace(/\.[^.]+$/, ""), author: "", chapters }
}

export const ACCEPTED_FILES = ".epub,.txt,.md,.markdown,.docx"

export async function importBookFile(file: File): Promise<ImportedBook> {
  const extension = file.name.split(".").pop()?.toLowerCase()
  const book =
    extension === "epub" ? await parseEpub(file)
    : extension === "docx" ? await parseDocx(file)
    : extension === "md" || extension === "markdown" ? await parsePlainText(file, true)
    : await parsePlainText(file, false)
  if (book.chapters.length === 0) throw new Error("No readable text found in this file")
  return book
}
