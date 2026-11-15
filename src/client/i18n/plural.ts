// Russian plural forms: 1 слушатель, 2-4 слушателя, 5-20 слушателей, 21 слушатель, 22 слушателя ... (11-14 are always "many").
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n)
  const m10 = abs % 10
  const m100 = abs % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
