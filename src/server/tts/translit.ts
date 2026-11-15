// Voices that silently drop words in Latin script (silero, Piper ru/uk) get them in Cyrillic: a rough English-ish phonetic transliteration,
// ru -> Russian letters, uk -> Ukrainian letters. Bad pronunciation is fine, silently dropped words are not. Applied to every text that goes
// to such a voice (after the pronunciation dictionary); punctuation, digits and Cyrillic stay as they are.
import type { ProviderId } from './voices'

// Which voices drop Latin: provider (+ local engine) and the voice languages. Cloud voices (azure, openai, gemini) read Latin themselves.
// Extend here.
export const DROPS_LATIN: { provider: ProviderId; engine?: string; langs: string[] }[] = [
  { provider: 'piper', langs: ['ru', 'uk'] },
  { provider: 'local', engine: 'silero', langs: ['ru', 'uk'] },
]

// the Cyrillic language to write in for a voice, or null when the voice reads Latin itself. `voiceLang` is the language of the voice.
export function latinTarget(provider: ProviderId, voiceId: string | null, voiceLang: string): 'ru' | 'uk' | null {
  const engine = provider === 'local' ? (voiceId ?? '').split('/')[0] : undefined
  const hit = DROPS_LATIN.find((d) => d.provider === provider && (!d.engine || d.engine === engine) && d.langs.includes(voiceLang))
  return hit ? (voiceLang === 'uk' ? 'uk' : 'ru') : null
}

type Lang = 'ru' | 'uk'
const VOWELS = 'aeiou'

const DIGRAPHS: Record<Lang, [string, string][]> = {
  ru: [
    ['tch', 'ч'],
    ['sch', 'ш'],
    ['sh', 'ш'],
    ['ch', 'ч'],
    ['ph', 'ф'],
    ['ee', 'и'],
    ['oo', 'у'],
    ['ea', 'и'],
    ['ou', 'ау'],
    ['ow', 'ау'],
    ['ai', 'эй'],
    ['ay', 'эй'],
    ['ck', 'к'],
    ['qu', 'кв'],
    ['kh', 'х'],
    ['zh', 'ж'],
    ['ng', 'нг'],
    ['ya', 'я'],
    ['yu', 'ю'],
    ['yo', 'ё'],
    ['ye', 'е'],
  ],
  uk: [
    ['tch', 'ч'],
    ['sch', 'ш'],
    ['sh', 'ш'],
    ['ch', 'ч'],
    ['ph', 'ф'],
    ['ee', 'і'],
    ['oo', 'у'],
    ['ea', 'і'],
    ['ou', 'ау'],
    ['ow', 'ау'],
    ['ai', 'ей'],
    ['ay', 'ей'],
    ['ck', 'к'],
    ['qu', 'кв'],
    ['kh', 'х'],
    ['zh', 'ж'],
    ['ng', 'нг'],
    ['ya', 'я'],
    ['yu', 'ю'],
    ['yo', 'йо'],
    ['ye', 'є'],
  ],
}
const SINGLE: Record<Lang, Record<string, string>> = {
  ru: {
    a: 'а',
    b: 'б',
    c: 'к',
    d: 'д',
    e: 'е',
    f: 'ф',
    g: 'г',
    h: 'х',
    i: 'и',
    j: 'дж',
    k: 'к',
    l: 'л',
    m: 'м',
    n: 'н',
    o: 'о',
    p: 'п',
    q: 'к',
    r: 'р',
    s: 'с',
    t: 'т',
    u: 'у',
    v: 'в',
    w: 'в',
    x: 'кс',
    y: 'и',
    z: 'з',
  },
  uk: {
    a: 'а',
    b: 'б',
    c: 'к',
    d: 'д',
    e: 'е',
    f: 'ф',
    g: 'г',
    h: 'х',
    i: 'і',
    j: 'дж',
    k: 'к',
    l: 'л',
    m: 'м',
    n: 'н',
    o: 'о',
    p: 'п',
    q: 'к',
    r: 'р',
    s: 'с',
    t: 'т',
    u: 'у',
    v: 'в',
    w: 'в',
    x: 'кс',
    y: 'и',
    z: 'з',
  },
}
// letters with a diacritic (é, ü, ...) lose it first
const fold = (s: string) => s.replace(/[\u00c0-\u024f]+/g, (seg) => seg.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))

function word(w: string, lang: Lang): string {
  const lw = w.toLowerCase()
  let out = ''
  let i = 0
  while (i < lw.length) {
    const ch = lw[i] as string
    // "th" is "з" at the start of a word (the, this) and "т" inside (github)
    if (lw.startsWith('th', i)) {
      out += i === 0 ? 'з' : 'т'
      i += 2
      continue
    }
    const d = DIGRAPHS[lang].find(([k]) => lw.startsWith(k, i))
    if (d) {
      out += d[1]
      i += d[0].length
      continue
    }
    if (ch === 'c' && 'eiy'.includes(lw[i + 1] ?? '-')) out += 'с'
    else if (ch === 'y' && i > 0 && VOWELS.includes(lw[i - 1] as string)) out += 'й'
    else if (ch === 'y' && i === lw.length - 1 && i > 0) out += lang === 'uk' ? 'і' : 'и'
    else out += SINGLE[lang][ch] ?? ''
    i++
  }
  if (w.length > 1 && w === w.toUpperCase()) return out.toUpperCase()
  return w[0] === w[0]?.toUpperCase() ? out.charAt(0).toUpperCase() + out.slice(1) : out
}

export const hasLatin = (s: string) => /[A-Za-z]/.test(s)

export function latinToCyrillic(text: string, lang: Lang = 'ru'): string {
  return fold(text).replace(/[A-Za-z]+(?:['’][A-Za-z]+)*/g, (w) => word(w.replace(/['’]/g, ''), lang))
}
