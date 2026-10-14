import { expect, test } from "bun:test"
import { normalizeSpoken, stressProblems } from "./enhance"
test("latin accent inside cyrillic", () => {
  const out = normalizeSpoken("Гла́ва вторá. Доро́га.")
  expect(out).toBe("Гла́ва втора́. Доро́га.".normalize("NFC"))
  expect(stressProblems(out, "ru")).toEqual([])
  expect(stressProblems("Глава втора", "ru")).toEqual(["Глава", "втора"])
  expect(stressProblems("ещё мёд", "ru")).toEqual([])
  expect(stressProblems("Liu Cixin сказа́л", "ru")).toEqual([])
})
test("mixed script flagged", () => {
  expect(stressProblems("втoра́", "ru")).toEqual(["втoра́".normalize("NFC")])
})

import { guardSpoken } from "./enhance"

test("guard reverts words the model rewrote", () => {
  const nfc = (t: string) => t.normalize("NFC")
  expect(guardSpoken("эти бунтовщики были как стая", nfc("э́ти бунта́рщики бы́ли как ста́я"))).toBe(nfc("э́ти бунтовщики бы́ли как ста́я"))
  expect(guardSpoken("Жуань сидела за письменным столом", nfc("Жуа́нь сиде́ла за писа́тельным столо́м"))).toBe(nfc("Жуа́нь сиде́ла за письменным столо́м"))
  expect(guardSpoken("И как только его тонкая шея", nfc("И как то́нкая его́ ше́я"))).toBe(nfc("И как только его то́нкая ше́я"))
})

test("guard keeps legitimate expansions and removals", () => {
  const nfc = (t: string) => t.normalize("NFC")
  expect(guardSpoken("Китай, 1967 год", nfc("Кита́й, ты́сяча девятьсо́т шестьдеся́т седьмо́й год"))).toBe(nfc("Кита́й, ты́сяча девятьсо́т шестьдеся́т седьмо́й год"))
  expect(guardSpoken("японских ружей 38-го калибра", nfc("япо́нских руже́й три́дцать восьмо́го кали́бра"))).toBe(nfc("япо́нских руже́й три́дцать восьмо́го кали́бра"))
  expect(guardSpoken("на ул. Ленина", nfc("на у́лице Ле́нина"))).toBe(nfc("на у́лице Ле́нина"))
  expect(guardSpoken("三体 Copyright © 2006 by 刘慈欣", "")).toBe("")
  expect(guardSpoken("Он шёл домой.", "")).toBe("Он шёл домой.")
})

test("guard allows acronym expansion and drops boilerplate the model skipped", () => {
  const nfc = (t: string) => t.normalize("NFC")
  expect(guardSpoken("полковник пехоты США прилетел", nfc("полко́вник пехо́ты сэ-шэ-а́ прилете́л"))).toBe(nfc("полко́вник пехо́ты сэ-шэ-а́ прилете́л"))
  expect(guardSpoken("Подробнее см. на сайте https://example.com", "")).toBe("")
  expect(guardSpoken("Перевод с английского Н. Петровой. 16+", "")).toBe("")
})

test("unstressed particles are not flagged", () => {
  expect(stressProblems("что́-нибудь когда́-либо", "ru")).toEqual([])
  expect(stressProblems("ли́бо", "ru")).toEqual([])
  expect(stressProblems("либо", "ru")).toEqual(["либо"])
})
