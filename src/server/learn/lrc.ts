// LRC lyrics ("[01:23.45]text"): lines with their start time in seconds.
export interface LrcLine {
  t: number
  text: string
}

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

// The offset tag ([offset:+500], ms) moves the lyrics earlier when positive: a line is shown at time - offset.
export function parseLrc(src: string): LrcLine[] {
  let offset = 0
  const out: LrcLine[] = []
  for (const raw of src.split(/\r?\n/)) {
    const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw)
    if (off) {
      offset = Number(off[1]) / 1000
      continue
    }
    const stamps = [...raw.matchAll(STAMP)]
    if (!stamps.length) continue
    // word-level stamps (<00:01.00>) inside the text are dropped
    const text = raw
      .replace(STAMP, '')
      .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
      .trim()
    if (!text) continue
    for (const m of stamps) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0
      out.push({ t: Number(m[1]) * 60 + Number(m[2]) + frac, text })
    }
  }
  const lines = out.map((l) => ({ t: Math.max(0, Math.round((l.t - offset) * 1000) / 1000), text: l.text }))
  return lines.sort((a, b) => a.t - b.t)
}

export const plainLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
