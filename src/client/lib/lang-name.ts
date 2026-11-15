import { LANG, LANG_NAMES } from '../i18n'
import { LOCALES } from '../i18n/lang'

let names: Intl.DisplayNames | null | undefined

// "lv" -> "латышский" in the language of the interface (a song can be in any language, not only the 8 of the interface)
export function langName(code: string | null | undefined): string {
  if (!code) return ''
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([LOCALES[LANG]], { type: 'language' })
    } catch {
      names = null
    }
  }
  try {
    const n = names?.of(code)
    if (n && n !== code) return n
  } catch {
    // not a language code
  }
  return (LANG_NAMES as Record<string, string>)[code] ?? code
}
