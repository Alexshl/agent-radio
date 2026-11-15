import { describe, expect, it } from 'vitest'
import { de } from './de'
import { en } from './en'
import { et } from './et'
import { DEFAULT_LANG, LANGS, pickLang } from './lang'
import { lt } from './lt'
import { lv } from './lv'
import { plural, pluralDe, pluralEn, pluralEt, pluralLt, pluralLv, pluralSv, pluralUk } from './plural'
import { ru } from './ru'
import { sv } from './sv'
import { uk } from './uk'

// flatten to "path" -> leaf kind; functions are reduced to their arity, arrays to their length
function shape(o: unknown, prefix = ''): Record<string, string> {
  if (typeof o === 'function') return { [prefix]: `fn/${o.length}` }
  if (Array.isArray(o)) return { [prefix]: `array/${o.length}` }
  if (o && typeof o === 'object') {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(o)) Object.assign(out, shape(v, prefix ? `${prefix}.${k}` : k))
    return out
  }
  return { [prefix]: typeof o }
}

describe('dictionaries', () => {
  for (const [name, dict] of [
    ['uk', uk],
    ['en', en],
    ['lv', lv],
    ['et', et],
    ['lt', lt],
    ['de', de],
    ['sv', sv],
  ] as const) {
    it(`${name} has the same keys, function arity and array length as ru`, () => {
      expect(shape(dict)).toEqual(shape(ru))
    })
  }

  it('no Cyrillic outside uk and ru; no Russian-only letters in uk', () => {
    const walk = (o: unknown, path: string, bad: RegExp): string[] => {
      if (typeof o === 'string') return bad.test(o) ? [path] : []
      if (o && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => walk(v, `${path}.${k}`, bad))
      return []
    }
    for (const [name, dict] of [
      ['en', en],
      ['lv', lv],
      ['et', et],
      ['lt', lt],
      ['de', de],
      ['sv', sv],
    ] as const)
      expect(walk(dict, name, /[\u0400-\u04FF]/)).toEqual([])
    expect(walk(uk, 'uk', /[ыэъёЫЭЪЁ]/)).toEqual([])
  })

  it('every language in LANGS has a dictionary of its own', () => {
    expect(LANGS).toHaveLength(8)
    expect(new Set([ru, uk, en, lv, et, lt, de, sv]).size).toBe(8)
  })

  it('function strings render with the language rules', () => {
    expect(uk.library.shown(2, 22)).toContain('22 треків')
    expect(en.library.shown(1, 1)).toBe('1 of 1 track')
    expect(en.radio.liveListeners(2)).toBe('On air · 2 listeners')
    expect(uk.radio.liveListeners(22)).toBe('В ефірі · 22 слухачі')
    expect(lv.radio.liveListeners(21)).toBe('Ēterā · 21 klausītājs')
    expect(lt.radio.liveListeners(10)).toBe('Eteryje · 10 klausytojų')
  })
})

describe('plural rules', () => {
  it('uk: one / few / many like ru', () => {
    const f = (n: number) => pluralUk(n, 'one', 'few', 'many')
    for (const [n, form] of [
      [1, 'one'],
      [2, 'few'],
      [4, 'few'],
      [5, 'many'],
      [11, 'many'],
      [12, 'many'],
      [14, 'many'],
      [21, 'one'],
      [22, 'few'],
      [25, 'many'],
      [101, 'one'],
      [111, 'many'],
      [0, 'many'],
    ] as const)
      expect(f(n)).toBe(form)
    expect(pluralUk).toBe(plural)
  })
  it('en: one / other', () => {
    expect(pluralEn(1, 'track', 'tracks')).toBe('track')
    for (const n of [0, 2, 5, 11, 21, 101]) expect(pluralEn(n, 'track', 'tracks')).toBe('tracks')
  })
})

describe('plural rules, other languages', () => {
  it('lv: one for 1/21/101, zero-form for 0/10-20/30, other for 2-9/22', () => {
    const f = (n: number) => pluralLv(n, 'one', 'other', 'zero')
    for (const [n, form] of [
      [1, 'one'],
      [21, 'one'],
      [101, 'one'],
      [11, 'zero'],
      [0, 'zero'],
      [10, 'zero'],
      [20, 'zero'],
      [30, 'zero'],
      [2, 'other'],
      [9, 'other'],
      [22, 'other'],
    ] as const)
      expect(f(n)).toBe(form)
  })
  it('lt: one / few / many', () => {
    const f = (n: number) => pluralLt(n, 'one', 'few', 'many')
    for (const [n, form] of [
      [1, 'one'],
      [21, 'one'],
      [2, 'few'],
      [9, 'few'],
      [22, 'few'],
      [0, 'many'],
      [10, 'many'],
      [11, 'many'],
      [19, 'many'],
      [20, 'many'],
      [30, 'many'],
    ] as const)
      expect(f(n)).toBe(form)
  })
  it('et, de, sv: one / other', () => {
    for (const fn of [pluralEt, pluralDe, pluralSv]) {
      expect(fn(1, 'a', 'b')).toBe('a')
      for (const n of [0, 2, 11, 21]) expect(fn(n, 'a', 'b')).toBe('b')
    }
  })
})

describe('language choice', () => {
  it('a saved valid choice wins', () => {
    expect(pickLang('en')).toBe('en')
    expect(pickLang('ru')).toBe('ru')
    expect(pickLang('uk')).toBe('uk')
    for (const l of LANGS) expect(pickLang(l)).toBe(l)
  })
  it('anything else falls back to uk (no browser language lookup)', () => {
    expect(DEFAULT_LANG).toBe('uk')
    expect(pickLang(null)).toBe('uk')
    expect(pickLang(undefined)).toBe('uk')
    expect(pickLang('fr')).toBe('uk')
    expect(pickLang('')).toBe('uk')
  })
})
