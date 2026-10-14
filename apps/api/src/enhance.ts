import type { CodexService } from "./codex"

const BATCH_CHARS = 2400
const BATCH_MAX = 24
const PARALLEL = 8
const MAX_REPAIRS = 2
const RATE_LIMIT_DELAYS = [15_000, 45_000]
const STRESS = "́"

const INSTRUCTIONS = `You prepare book text for a text-to-speech engine. You receive a JSON array of passages from one chapter, in reading order, and return {"passages": [...]} with exactly the same number of items, in the same order. Each output item is the spoken form of the input item at the same index.

Your job is mechanical. You are NOT an editor.
- Copy every ordinary word exactly as written: same letters, same endings, same word order. Never replace a word with a synonym, never "fix" grammar, style or spelling, never drop or add words. The only change allowed inside an ordinary word is inserting the stress mark (and writing ё where the word is pronounced with ё). An automatic checker compares your output with the input word by word and discards any other change.
- Expand everything a narrator reads differently from how it is written: numbers, dates, years, times, ordinals ("38-го"), Roman numerals, money, percentages, units, abbreviations (г., ул., т.е., т.д., др., им., стр., и т.п.), initials and acronyms. Use words in the grammatically correct case and gender for the context ("в 2006 г." → "в две ты́сячи шесто́м году́", "до 18.30" → "до восемна́дцати тридцати́"). Every number word you write gets its stress mark too.
- Acronyms: spell letter-by-letter ones with letter names joined by hyphens, stress on the last letter ("СССР" → "эс-эс-эс-э́р", "ФСБ" → "эф-эс-бэ́", "США" → "сэ-шэ-а́", "МГУ" → "эм-гэ-у́"); write ones read as a word as a lowercase word ("НАТО" → "на́то", "вуз" → "вуз", "ООН" → "оо́н"). A whole word written in capitals for emphasis or in a heading ("ГЛАВА", "СТОЙ") is an ordinary word: keep its case and just mark it.
- Remove what a narrator would never read aloud: footnote markers ([1], *, ¹), page numbers, URLs, e-mail addresses, ISBN, copyright and licence notices, publisher boilerplate, and text in scripts that do not belong to the book's language (e.g. Chinese characters in a Russian book). If a foreign-script name is the only way something is named, transliterate it instead of dropping it. When removing a URL or address leaves a dangling preposition or phrase ("пишите на"), remove that too so the sentence still reads naturally.
- Short Latin-script words and phrases inside Russian or Ukrainian text (names, brands, "Good morning") are transliterated into Cyrillic the way a narrator pronounces them, with stress marks ("Good morning" → "гуд мо́рнинг", "Google" → "Гугл", "iPhone" → "айфо́н"). Do not translate them.
- If a whole passage is boilerplate (copyright page, "все права защищены", publisher info, credits like "Перевод с английского Н. Петровой", "Редактор", "Художник обложки", age ratings like "16+", print run, УДК/ББК, "Подробнее на сайте …"), return "" for it. Story text, chapter titles, epigraphs and dedications are never boilerplate.
- Keep punctuation, dialogue dashes and quotes as they are. Replace "…" with "...".

Russian and Ukrainian stress (the most important part):
- Put COMBINING ACUTE ACCENT U+0301 directly after the stressed vowel of every word with two or more vowels. Exactly one mark per word. Monosyllables get none. Words with ё are already stressed: write ё, no mark.
- Short everyday words need marks as much as rare ones, and they are where mistakes slip in: и́ли, вме́сте, ме́жду, и́зредка, да́же, то́же, о́чень, сно́ва, по́сле, о́коло, его́, её, она́, они́, оно́, была́, бы́ли, кото́рый. Number words are traps too: полу́тора, тридцати́, сорока́, девяно́ста, ста, двухсо́т, пятисо́т, восьми́десяти, оди́ннадцати, четырёх. Check every word, including the last ones in a long passage.
- Stress is lexical. Recall how a native speaker says each word form; never default to the last syllable or to the stem of another form. Typical traps, all of which must be right: па́дала, полете́ли, ви́дела, не́когда, фла́ги, вы́стрелы, Августо́вской, о́пытными, ожесточённой, по́ровну, звони́т, кварта́л, обеспе́чение, облегчи́ть, краси́вее, то́рты, ба́нты, жалюзи́, ку́хонный, щаве́ль, тво́рог/творо́г, до́говор/догово́р by context, за́мок / замо́к and мука́ / му́ка by meaning, его́ (pronoun), до́ма (at home) / дома́ (buildings).
- Feminine past tense keeps the stem stress of the verb (проши́ла, ви́дела, па́дала, кри́кнула, положи́ла); only short verbs move it to the ending (была́, взяла́, дала́, жила́, начала́, поняла́, спала́). Do not guess an ending stress for longer verbs.
- Use only the combining acute after a Cyrillic vowel, never a precomposed Latin letter (á), "+" or apostrophes.
- Transliterated foreign names: mark them the way Russian narrators say them (Ма́о, Тяньаньмэ́нь, Вэньцзе́, Э́ванс); one-syllable parts of Chinese names (Шэ, Лэй, Цзе, Чэн) get no mark. When such a name is declined, the stress stays on the name's own syllable, never on the Russian ending: Чэ́на, Ва́ну, Вэ́я, Лэ́ем, Мя́о.
- Compound and hyphenated words get one mark per part that has two or more vowels (се́веро-за́падный, фи́зик-теоре́тик); the particles -нибудь and -либо stay unmarked (что́-нибудь, когда́-либо).
- Other languages: no stress marks.

Output plain text only inside the JSON strings: no markdown, no comments.`

const SCHEMA = {
  type: "object",
  properties: { passages: { type: "array", items: { type: "string" } } },
  required: ["passages"],
  additionalProperties: false,
}

// Models sometimes write a Latin look-alike with an accent ("á") inside a Cyrillic word; NFC also
// composes Latin "a" + U+0301 into "á". Map them back to Cyrillic vowel + combining accent.
const LATIN_STRESSED: Record<string, string> = { á: "а", é: "е", ó: "о", Á: "А", É: "Е", Ó: "О", ý: "у", Ý: "У" }
const LATIN_LOOKALIKE: Record<string, string> = { a: "а", e: "е", o: "о", c: "с", p: "р", x: "х", y: "у", A: "А", E: "Е", O: "О", C: "С", P: "Р", X: "Х" }

export function normalizeSpoken(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\p{L}\u0301]+/gu, (word) => {
      if (!/\p{Script=Cyrillic}/u.test(word) || !/[A-Za-z]/.test(word)) return word
      return Array.from(word.normalize("NFC"))
        .map((char) => (LATIN_STRESSED[char] ? LATIN_STRESSED[char] + STRESS : LATIN_LOOKALIKE[char] ?? char))
        .join("")
    })
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
}

const VOWELS: Record<string, RegExp> = { ru: /[аеёиоуыэюя]/giu, uk: /[аеєиіїоуюя]/giu }

/** Words that need a stress mark but have none or several (validator from Ringmind). */
export function stressProblems(text: string, lang: string) {
  const vowels = VOWELS[lang]
  if (!vowels) return []
  const problems: string[] = []
  const nfc = text.normalize("NFC")
  for (const { 0: word, index } of nfc.matchAll(/[\p{L}́]+/gu)) {
    if (!/\p{Script=Cyrillic}/u.test(word)) continue
    // Unstressed particles: что́-нибудь, когда́-либо.
    if (nfc[index - 1] === "-" && /^(нибудь|либо)$/i.test(word)) continue
    // A Latin letter inside a Cyrillic word is a look-alike typo the TTS would mispronounce.
    if (/[A-Za-zÀ-ɏ]/.test(word)) {
      problems.push(word)
      continue
    }
    const vowelCount = word.match(vowels)?.length ?? 0
    const marks = word.split(STRESS).length - 1
    if (lang === "ru" && /ё/i.test(word)) {
      if (marks > 0) problems.push(word)
    } else if (vowelCount > 1 && marks !== 1) problems.push(word)
    else if (marks > 1) problems.push(word)
  }
  return problems
}

function batches(segments: string[]) {
  const result: Array<{ start: number; items: string[] }> = []
  let current: { start: number; items: string[] } = { start: 0, items: [] }
  let chars = 0
  segments.forEach((segment, index) => {
    if (current.items.length && (chars + segment.length > BATCH_CHARS || current.items.length >= BATCH_MAX)) {
      result.push(current)
      current = { start: index, items: [] }
      chars = 0
    }
    current.items.push(segment)
    chars += segment.length
  })
  if (current.items.length) result.push(current)
  return result
}

type Token = { start: number; end: number; text: string; key: string }

const tokenKey = (word: string) => word.normalize("NFD").replace(/́/g, "").normalize("NFC").toLowerCase().replaceAll("ё", "е")

function tokenize(text: string): Token[] {
  return Array.from(text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu), (match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
    text: match[0],
    key: tokenKey(match[0]),
  }))
}

/** Longest common subsequence of word keys → aligned index pairs. */
function align(a: Token[], b: Token[]) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i].key === b[j].key ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const pairs: Array<[number, number]> = []
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i].key === b[j].key) pairs.push([i++, j++])
    else if (table[i + 1][j] >= table[i][j + 1]) i++
    else j++
  }
  return pairs
}

/** Original text the model is allowed to rewrite: numbers, abbreviations, symbols, foreign scripts, footnotes. */
function isRewritable(text: string) {
  return (
    /\p{N}/u.test(text) ||
    /[^\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]/u.test(text) ||
    /[©®™§№%$€£¥#*@&+=<>|\\/[\]{}^~]/u.test(text) ||
    /(^|[\s(«"„])\p{L}{1,5}\.(?=\s*(?:[\p{Ll}\p{N},;:)»"]|$))/u.test(text) || // г. ул. т.е. др.
    /(^|[\s(«"„])\p{Lu}\.(?=\s*\p{Lu})/u.test(text) || // initials
    /(^|[^\p{L}])\p{Lu}{2,}(?![\p{L}])/u.test(text) // acronyms: СССР, ФСБ
  )
}

const BOILERPLATE =
  /©|copyright|isbn|all rights reserved|права защищены|издательств|издание|ооо\s|ltd\b|литрес|litres|https?:\/\/|www\.|\S@\S+\.\p{L}|перевод с |переводчик|редактор|корректор|художник обложки|тираж|удк|ббк|подписано в печать|(^|\s)\d{1,2}\+(\s|$)/iu

/**
 * Keeps the model honest: words it merely re-typed must match the original letter for letter
 * (only stress marks / ё may differ). It may only rewrite spans that contain something to expand
 * or remove; any other change (synonyms, "fixed" grammar, dropped words) is reverted.
 */
export function guardSpoken(original: string, output: string) {
  if (!output.trim()) return BOILERPLATE.test(original) || !/\p{Script=Cyrillic}|\p{Script=Latin}/u.test(original) ? "" : original
  const source = tokenize(original)
  const target = tokenize(output)
  const pairs = align(source, target)
  let result = ""
  let sourceEnd = 0
  let targetEnd = 0
  let si = 0
  let ti = 0
  for (const [i, j] of [...pairs, [source.length, target.length] as [number, number]]) {
    const sourceGap = original.slice(sourceEnd, i < source.length ? source[i].start : original.length)
    const targetGap = output.slice(targetEnd, j < target.length ? target[j].start : output.length)
    const changedWords = i > si || j > ti
    result += !changedWords || isRewritable(sourceGap) ? targetGap : sourceGap
    if (i < source.length) {
      result += target[j].text
      sourceEnd = source[i].end
      targetEnd = target[j].end
    }
    si = i + 1
    ti = j + 1
  }
  return result.replace(/\s+/g, " ").trim()
}

export type EnhanceOptions = { model: string; effort?: string }

/** Codex retries 429s itself but gives up quickly; with parallel batches a longer pause usually clears the limit. */
async function completeWithBackoff(codex: CodexService, model: string, prompt: string, effort?: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await codex.complete(model, INSTRUCTIONS, prompt, SCHEMA, effort)
    } catch (error) {
      if (attempt >= RATE_LIMIT_DELAYS.length || !/429|too many requests|rate limit/i.test(String(error))) throw error
      await Bun.sleep(RATE_LIMIT_DELAYS[attempt])
    }
  }
}

async function requestPassages(codex: CodexService, { model, effort }: EnhanceOptions, lang: string, items: string[], feedback: string) {
  const prompt = `Language: ${lang}\n${feedback}Passages:\n${JSON.stringify(items)}`
  const raw = await completeWithBackoff(codex, model, prompt, effort)
  const passages = (JSON.parse(raw) as { passages?: unknown }).passages
  if (!Array.isArray(passages) || passages.length !== items.length || passages.some((item) => typeof item !== "string")) {
    throw new CountMismatch(`Expected ${items.length} passages, got ${Array.isArray(passages) ? passages.length : "none"}`)
  }
  return (passages as string[]).map((item, index) => guardSpoken(items[index], normalizeSpoken(item)))
}

class CountMismatch extends Error {}

async function enhanceBatch(codex: CodexService, options: EnhanceOptions, lang: string, items: string[]): Promise<string[]> {
  let output: string[] | undefined
  for (let attempt = 0; !output; attempt++) {
    try {
      output = await requestPassages(codex, options, lang, items, "")
    } catch (error) {
      // Models occasionally merge or drop a passage in long batches; halve until each call is reliable.
      if (error instanceof CountMismatch && items.length > 1) {
        const middle = Math.ceil(items.length / 2)
        return [...(await enhanceBatch(codex, options, lang, items.slice(0, middle))), ...(await enhanceBatch(codex, options, lang, items.slice(middle)))]
      }
      if (attempt === 1) throw error
    }
  }
  // Resend only the passages the validator flagged, naming the exact words; keep whichever version is cleaner.
  for (let round = 0; round < MAX_REPAIRS; round++) {
    const problems = output.map((item) => stressProblems(item, lang))
    const flagged = problems.flatMap((words, index) => (words.length ? [index] : []))
    if (!flagged.length) break
    const words = [...new Set(flagged.flatMap((index) => problems[index]))].slice(0, 40)
    const feedback = `A previous answer for these passages had a missing, extra or misplaced stress mark in: ${words.join(", ")}. Mark every word correctly this time.\n`
    const repaired = await requestPassages(codex, options, lang, flagged.map((index) => items[index]), feedback).catch(() => undefined)
    if (!repaired) break
    flagged.forEach((index, k) => {
      if (stressProblems(repaired[k], lang).length < problems[index].length) output![index] = repaired[k]
    })
  }
  return output
}

/** Returns the spoken form of every passage (same length; "" = skip). */
export async function enhanceSegments(codex: CodexService, options: EnhanceOptions, lang: string, segments: string[]) {
  const output = new Array<string>(segments.length)
  const queue = batches(segments)
  let next = 0
  const worker = async () => {
    while (next < queue.length) {
      const batch = queue[next++]
      const result = await enhanceBatch(codex, options, lang, batch.items)
      result.forEach((item, index) => (output[batch.start + index] = item))
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker))
  return output
}
