import { de } from './de'
import { en } from './en'
import { et } from './et'
import { LANG } from './lang'
import { lt } from './lt'
import { lv } from './lv'
import { type Strings, ru } from './ru'
import { sv } from './sv'
import { uk } from './uk'

export { LANG, LANGS, LANG_NAMES, setLang } from './lang'
export type { Lang } from './lang'

const DICTS: Record<typeof LANG, Strings> = { uk, ru, en, lv, et, lt, de, sv }

// The active dictionary, chosen once at startup (see lang.ts).
export const S: Strings = DICTS[LANG]

if (typeof document !== 'undefined') document.documentElement.lang = LANG

export function errorText(code: string | undefined, fallback?: string): string {
  return (code && S.common.errors[code]) || fallback || S.common.error
}
