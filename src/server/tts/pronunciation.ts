// Pronunciation dictionary: pure matching + per-engine stress rendering (no db here, see pronunciation-store.ts).
//
// Canonical syntax (what users and the dictionary store): `+` BEFORE the stressed vowel, e.g. `закомм+итил` (Silero's native syntax).
// Per engine at synthesis time:
//   silero (ru), f5 (ru, RUAccent)  -> kept as is: `+` before the vowel
//   styletts2 (uk)                  -> vowel + U+0301 (combining acute AFTER the vowel; the sidecar maps `+` to the same symbol in place,
//                                      so a `+` before the vowel would stress the wrong thing there)
//   piper, azure, openai, gemini    -> marks removed (plain text)

import { SUMMARY_LANGS } from '../lang'

export interface PronEntry {
  // one of SUMMARY_LANGS | *
  lang: string
  match: string
  replacement: string
  // 'user' entries win over 'global' ones with the same lang + match
  scope: 'global' | 'user'
}

export type StressTarget = 'plus-before' | 'acute-after' | 'plain'

// Cyrillic + Latin vowels, including the diacritic ones of lv/et/lt/de/sv (ā ē ī ū ō õ ä ö ü å ė į ų ą ę) and common accented forms
const VOWELS = 'аеёиоуыэюяіїєАЕЁИОУЫЭЮЯІЇЄaeiouyAEIOUYāēīūōõäöüåėįųąęĀĒĪŪŌÕÄÖÜÅĖĮŲĄĘáàâéèêíìîóòôúùûÿÁÀÂÉÈÊÍÌÎÓÒÔÚÙÛŸ'
// `+` right before a vowel letter is a stress mark ("C++", "2+2" are left alone)
const MARK = new RegExp(`\\+(?=[${VOWELS}])`, 'g')
const MARKED_VOWEL = new RegExp(`\\+([${VOWELS}])`, 'g')

export function renderStress(text: string, target: StressTarget): string {
  if (target === 'plus-before') return text
  if (target === 'acute-after') return text.replace(MARKED_VOWEL, '$1́')
  return text.replace(MARK, '')
}

// Which stress syntax the chosen engine takes. `voice` is the provider-specific id ('silero/kseniya', 'styletts2/…').
export function stressTarget(provider: string, voice: string | null): StressTarget {
  if (provider !== 'local') return 'plain'
  const engine = (voice ?? '').split('/')[0]
  if (engine === 'silero' || engine === 'f5') return 'plus-before'
  if (engine === 'styletts2') return 'acute-after'
  return 'plain'
}

const WORD = '[\\p{L}\\p{N}_]'
const PUA_OPEN = '\u{E000}'
const PUA_CLOSE = '\u{E001}'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface Compiled {
  re: RegExp
  replacement: string
  stem: boolean
}

function compile(e: PronEntry): Compiled | null {
  let m = e.match.trim()
  const stem = m.endsWith('*')
  if (stem) m = m.slice(0, -1).trim()
  if (!m) return null
  const body = m.split(/\s+/).map(escapeRe).join('\\s+')
  // Unicode-aware whole-word boundaries (JS \b only knows ASCII); a stem swallows the rest of the word
  const re = new RegExp(`(?<!${WORD})(${body})${stem ? `(${WORD}*)` : `(?!${WORD})`}`, 'giu')
  return { re, replacement: e.replacement.trim(), stem }
}

// Entries that apply to `lang`: user ones override global ones with the same lang + match; longer matches go first, then user, then a
// specific language before '*'.
export function effectiveEntries(entries: PronEntry[], lang: string): PronEntry[] {
  const byKey = new Map<string, PronEntry>()
  for (const e of entries) {
    if (e.lang !== '*' && e.lang !== lang) continue
    const key = `${e.lang}|${e.match.trim().toLowerCase()}`
    const prev = byKey.get(key)
    if (!prev || (prev.scope === 'global' && e.scope === 'user')) byKey.set(key, e)
  }
  const rank = (e: PronEntry) => (e.scope === 'user' ? 0 : 2) + (e.lang === '*' ? 1 : 0)
  return [...byKey.values()].sort((a, b) => b.match.length - a.match.length || rank(a) - rank(b))
}

// Replaces the dictionary words in `text` (single pass: a replacement is never matched again). The result keeps `+` stress marks;
// run renderStress() on it for the chosen engine.
export function applyPronunciations(text: string, entries: PronEntry[], lang: string): string {
  const done: string[] = []
  let out = text
  for (const e of effectiveEntries(entries, lang)) {
    const c = compile(e)
    if (!c) continue
    out = out.replace(c.re, (_all, _w: string, suffix?: string) => {
      const rep = c.stem && c.replacement.endsWith('*') ? c.replacement.slice(0, -1) + (suffix ?? '') : c.replacement
      done.push(rep)
      return `${PUA_OPEN}${String.fromCharCode(0xe100 + done.length - 1)}${PUA_CLOSE}`
    })
  }
  if (!done.length) return text
  return out.replace(new RegExp(`${PUA_OPEN}(.)${PUA_CLOSE}`, 'gu'), (_a, ch: string) => done[ch.charCodeAt(0) - 0xe100] ?? '')
}

// Text -> text for one engine.
export function prepareSpeech(text: string, entries: PronEntry[], lang: string, target: StressTarget): string {
  return renderStress(applyPronunciations(text, entries, lang), target)
}

export const PRON_LANGS = [...SUMMARY_LANGS, '*'] as const
