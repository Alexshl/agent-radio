// UI language: an explicit choice (localStorage), otherwise Ukrainian.
export type Lang = 'uk' | 'ru' | 'en' | 'lv' | 'et' | 'lt' | 'de' | 'sv'

export const LANGS: readonly Lang[] = ['uk', 'ru', 'en', 'lv', 'et', 'lt', 'de', 'sv']
export const DEFAULT_LANG: Lang = 'uk'
export const LANG_STORAGE_KEY = 'agent-radio.ui-lang'

// each language in its own name (the same in every interface language)
export const LANG_NAMES: Record<Lang, string> = {
  uk: 'Українська',
  ru: 'Русский',
  en: 'English',
  lv: 'Latviešu',
  et: 'Eesti',
  lt: 'Lietuvių',
  de: 'Deutsch',
  sv: 'Svenska',
}

// BCP 47 locales for Intl
export const LOCALES: Record<Lang, string> = {
  uk: 'uk-UA',
  ru: 'ru-RU',
  en: 'en-US',
  lv: 'lv-LV',
  et: 'et-EE',
  lt: 'lt-LT',
  de: 'de-DE',
  sv: 'sv-SE',
}

// pure choice: the saved value if valid, else the default (the browser language is deliberately not consulted)
export function pickLang(stored: string | null | undefined): Lang {
  return LANGS.find((l) => l === stored) ?? DEFAULT_LANG
}

export function readStoredLang(): string | null {
  try {
    return localStorage.getItem(LANG_STORAGE_KEY)
  } catch {
    return null
  }
}

export const detectLang = (): Lang => pickLang(readStoredLang())

// chosen once at startup; a language change reloads the page
export const LANG: Lang = detectLang()

export function setLang(lang: Lang): void {
  if (lang === LANG) return
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang)
  } catch {
    // storage unavailable: the choice just won't persist
  }
  location.reload()
}
