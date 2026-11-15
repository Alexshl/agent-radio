// Russian-locale formatting: 24-hour times, dd.mm.yyyy dates, a space as the thousands separator.
const pad = (n: number) => String(n).padStart(2, '0')

// speech rate: "1,25×" (decimal comma, as in the Russian interface)
export const fmtRate = (v: number) => `${String(Math.round(v * 100) / 100).replace('.', ',')}×`

// signed dB for the mix sliders: "+4 dB", "−8 dB", "0 dB" (real minus sign)
export const fmtDb = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} dB`

export const fmtTime = (iso: string) => {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

// 'Сегодня 09:41' / 'Вчера 22:10' / '06.11.2026'
export function fmtWhen(iso: string | null, labels: { today: string; yesterday: string; never: string }): string {
  if (!iso) return labels.never
  const d = new Date(iso)
  const now = new Date()
  const y = new Date(now.getTime() - 86400_000)
  if (dayKey(d) === dayKey(now)) return `${labels.today} ${fmtTime(iso)}`
  if (dayKey(d) === dayKey(y)) return `${labels.yesterday} ${fmtTime(iso)}`
  return fmtDate(iso)
}

// '09:41' today, 'Вчера', else the date: for narrow time columns
export function fmtShortWhen(iso: string, labels: { today: string; yesterday: string }): string {
  const d = new Date(iso)
  const now = new Date()
  if (dayKey(d) === dayKey(now)) return fmtTime(iso)
  if (dayKey(d) === dayKey(new Date(now.getTime() - 86400_000))) return labels.yesterday
  return fmtDate(iso)
}

// Inside a sentence: 'сегодня в 14:15' / 'вчера в 22:10' / '06.11.2026'
export function fmtWhenInline(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (dayKey(d) === dayKey(now)) return `сегодня в ${fmtTime(iso)}`
  if (dayKey(d) === dayKey(new Date(now.getTime() - 86400_000))) return `вчера в ${fmtTime(iso)}`
  return fmtDate(iso)
}

export { dayKey }

export const fmtDuration = (sec: number) => {
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${pad(s % 60)}`
}

export const fmtNumber = (n: number) => n.toLocaleString('ru-RU')

export function fmtTotal(sec: number): string {
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} мин`
  return `${Math.floor(m / 60)} ч ${pad(m % 60)} мин`
}

export function fmtBytes(n: number): string {
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} ГБ`
  if (n > 1024 ** 2) return `${Math.round(n / 1024 ** 2)} МБ`
  return `${Math.round(n / 1024)} КБ`
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'

export { plural } from '../i18n/plural'
