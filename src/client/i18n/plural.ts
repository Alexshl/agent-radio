// Slavic plural forms (ru, uk): 1 слушатель, 2-4 слушателя, 5-20 слушателей, 21 слушатель, 22 слушателя ... (11-14 are always "many").
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n)
  const m10 = abs % 10
  const m100 = abs % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

// Ukrainian uses the same one/few/many rule as Russian.
export const pluralUk = plural

// English, Estonian, German, Swedish: one / other.
export function pluralEn(n: number, one: string, other: string): string {
  return Math.abs(n) === 1 ? one : other
}
export const pluralEt = pluralEn
export const pluralDe = pluralEn
export const pluralSv = pluralEn

const lvRules = new Intl.PluralRules('lv')
const ltRules = new Intl.PluralRules('lt')

// Latvian (CLDR zero/one/other): 1, 21, 31 ... -> one; 0, 10-20, 30 ... -> zero; the rest (2-9, 22-29 ...) -> other.
// 1 ieraksts, 2 ieraksti, 10 ierakstu, 21 ieraksts.
export function pluralLv(n: number, one: string, other: string, zero: string): string {
  const c = lvRules.select(Math.abs(n))
  return c === 'one' ? one : c === 'zero' ? zero : other
}

// Lithuanian (integers): 1, 21 ... -> one; 2-9, 22-29 ... -> few; 0, 10-20, 30 ... -> many.
// 1 failas, 2 failai, 10 failų.
export function pluralLt(n: number, one: string, few: string, many: string): string {
  const c = ltRules.select(Math.abs(n))
  return c === 'one' ? one : c === 'few' ? few : many
}
