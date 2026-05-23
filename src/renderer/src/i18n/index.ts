import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import en from "./messages/en.json"
import zhCN from "./messages/zh-CN.json"

export const locales = ["en", "zh-CN"] as const
export type Locale = (typeof locales)[number]
export const defaultLocale: Locale = "en"

// `translation` is i18next's default namespace; flat keys like "app.title"
// are looked up against the JSON tree under this namespace.
void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  lng: defaultLocale,
  fallbackLng: defaultLocale,
  interpolation: { escapeValue: false },
})

export default i18n
