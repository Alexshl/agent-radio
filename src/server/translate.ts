// Messages arrive in any language, the voice reads only the listener's language well: a text in another language is translated into
// `user.lang` before the voice. A cheap script check decides first; the model is asked only when the text may be foreign.
import { z } from 'zod'
import type { FullDeps } from './deps'

export type NeedsTranslation = 'no' | 'yes' | 'maybe'

const CYRILLIC_TARGETS = new Set(['ru', 'uk'])
export const TRANSLATE_TIMEOUT_MS = 8000

const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0

export function needsTranslation(text: string, targetLang: string): NeedsTranslation {
  const letters = count(text, /\p{L}/gu)
  if (letters === 0) return 'no'
  if (text.trim().split(/\s+/).length < 3) return 'no'
  const cyr = count(text, /[Ѐ-ӿ]/g)
  const latin = count(text, /[A-Za-zÀ-ɏ]/g)
  if (CYRILLIC_TARGETS.has(targetLang)) {
    if (cyr === 0 && latin === 0) return 'maybe' // another script (CJK, Greek, ...)
    if (latin > cyr) return 'yes'
    if (targetLang === 'ru') return /[іїєґ]/i.test(text) ? 'yes' : 'no'
    if (/[ыэъё]/i.test(text)) return 'yes'
    return /[іїєґ]/i.test(text) ? 'no' : 'maybe' // Cyrillic with no marker letters: Ukrainian or Russian, ask
  }
  // a Latin-script target: Cyrillic text is surely foreign, the rest only the model can tell
  return cyr > latin ? 'yes' : 'maybe'
}

const answerSchema = z.object({ lang: z.string().max(20), text: z.string().min(1).max(4000) })

const LANG_NAME: Record<string, string> = {
  uk: 'Ukrainian',
  ru: 'Russian',
  en: 'English',
  lv: 'Latvian',
  et: 'Estonian',
  lt: 'Lithuanian',
  de: 'German',
  sv: 'Swedish',
}

// The text to speak and whether it is a translation (null = the original is spoken). Never throws.
export async function translateForSpeech(deps: FullDeps, text: string, targetLang: string): Promise<string | null> {
  if (needsTranslation(text, targetLang) === 'no') return null
  try {
    const llm = deps.llm
    if (!llm.configured()) return null
    const target = LANG_NAME[targetLang] ?? targetLang
    const system =
      `You prepare short messages to be read aloud by a voice that speaks ${target} (code "${targetLang}"). ` +
      `Detect the language of the message. If it is not ${target}, translate it faithfully into ${target}, short and natural for speech; ` +
      `keep names, code identifiers and numbers; add nothing. If it is already ${target}, return it unchanged. ` +
      `Answer {"lang": "<ISO 639-1 code of the original>", "text": "<${target} text>"}.`
    const r = await llm.chatJson(system, text, answerSchema, { timeoutMs: TRANSLATE_TIMEOUT_MS, maxTokens: 1024 })
    const out = r.data.text.trim()
    if (r.data.lang.toLowerCase().slice(0, 2) === targetLang || !out || out === text.trim()) return null
    return out
  } catch (e) {
    console.error('translate failed:', e instanceof Error ? e.message : e)
    return null
  }
}
