// Pure helpers of the admin tab "Учи язык".

// bulk regeneration progress, 0..100 (failed ones count as processed)
export function bulkPercent(p: { total: number; done: number; failed: number }): number {
  if (p.total <= 0) return 0
  return Math.min(100, Math.round(((p.done + p.failed) / p.total) * 100))
}

// the placeholders as chips: sections are shown as written in the template
export function placeholderChip(name: string): string {
  return name.startsWith('#') || name.startsWith('^') ? `{{${name.split(' ')[0]}}}` : `{{${name}}}`
}

// the pages of the song list glued together, no track twice
export function mergeSongs<T extends { trackId: string }>(pages: T[][]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const p of pages)
    for (const s of p) {
      if (seen.has(s.trackId)) continue
      seen.add(s.trackId)
      out.push(s)
    }
  return out
}

// notes of a song: 'ru, uk'
export const noteLangs = (notes: { lang: string }[]) => notes.map((n) => n.lang).join(', ')
