import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import en from "./messages/en.json"
import zhCN from "./messages/zh-CN.json"

export const locales = ["en", "zh-CN"] as const
export type Locale = (typeof locales)[number]
export const defaultLocale: Locale = "en"

/**
 * Pick a supported locale from whatever the OS / Chromium reports.
 * Chinese variants (zh-CN, zh-TW, zh-HK, zh-SG, zh) all map to zh-CN
 * for now since we only ship simplified strings; everything else falls
 * back to English. Future locales should add explicit branches here.
 */
export function detectLocale(): Locale {
  if (typeof navigator === "undefined") return defaultLocale
  const candidates = [navigator.language, ...(navigator.languages ?? [])]
  for (const raw of candidates) {
    if (!raw) continue
    const lower = raw.toLowerCase()
    if (lower.startsWith("zh")) return "zh-CN"
    if (lower.startsWith("en")) return "en"
  }
  return defaultLocale
}

// `translation` is i18next's default namespace; flat keys like "app.title"
// are looked up against the JSON tree under this namespace.
void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  lng: detectLocale(),
  fallbackLng: defaultLocale,
  interpolation: { escapeValue: false },
})

export default i18n
