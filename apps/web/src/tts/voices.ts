export const SUPERTONIC_LANGS = [
  "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi", "hr", "hu",
  "id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi",
] as const
export type SupertonicLang = (typeof SUPERTONIC_LANGS)[number]

export const SUPERTONIC_VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"] as const
export type SupertonicVoice = (typeof SUPERTONIC_VOICES)[number]
