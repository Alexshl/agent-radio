// Summary languages (users.lang / voice_prefs): the language agents write their spoken summary in. Same codes as the UI languages.
export const SUMMARY_LANGS = ['uk', 'ru', 'en', 'lv', 'et', 'lt', 'de', 'sv'] as const
export type SummaryLang = (typeof SUMMARY_LANGS)[number]
