// Locale-aware formatting through Intl with the active UI language: 24-hour times everywhere except en, numeric
// dates in the locale's own order (dd.mm.yyyy in uk/ru), "Nov 6, 2026" in en. Words (units, "today at") live in the table below so this module never imports the dictionaries.
import { LANG, LOCALES } from '../i18n/lang'

const LOCALE = LOCALES[LANG]
const pad = (n: number) => String(n).padStart(2, '0')

const WORDS = {
  uk: { min: 'хв', h: 'год', gb: 'ГБ', mb: 'МБ', kb: 'КБ', todayAt: 'сьогодні о', yesterdayAt: 'вчора о' },
  ru: { min: 'мин', h: 'ч', gb: 'ГБ', mb: 'МБ', kb: 'КБ', todayAt: 'сегодня в', yesterdayAt: 'вчера в' },
  en: { min: 'min', h: 'h', gb: 'GB', mb: 'MB', kb: 'KB', todayAt: 'today at', yesterdayAt: 'yesterday at' },
  lv: { min: 'min', h: 'h', gb: 'GB', mb: 'MB', kb: 'KB', todayAt: 'šodien plkst.', yesterdayAt: 'vakar plkst.' },
  et: { min: 'min', h: 'h', gb: 'GB', mb: 'MB', kb: 'KB', todayAt: 'täna kell', yesterdayAt: 'eile kell' },
  lt: { min: 'min.', h: 'val.', gb: 'GB', mb: 'MB', kb: 'KB', todayAt: 'šiandien', yesterdayAt: 'vakar' },
  de: { min: 'Min.', h: 'Std.', gb: 'GB', mb: 'MB', kb: 'KB', todayAt: 'heute um', yesterdayAt: 'gestern um' },
  sv: { min: 'min', h: 'tim', gb: 'GB', mb: 'MB', kb: 'kB', todayAt: 'i dag kl.', yesterdayAt: 'i går kl.' },
}[LANG]

const numberFmt = new Intl.NumberFormat(LOCALE)
const rateFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 })
const oneDecimalFmt = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: LANG === 'en' ? 'h12' : 'h23' })
const dateFmt = new Intl.DateTimeFormat(
  LOCALE,
  LANG === 'en' ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: '2-digit', month: '2-digit', year: 'numeric' },
)

// speech rate: "1,25×" (decimal comma in most languages, "1.25×" in en)
export const fmtRate = (v: number) => `${rateFmt.format(Math.round(v * 100) / 100)}×`

// signed dB for the mix sliders: "+4 dB", "−8 dB", "0 dB" (real minus sign)
export const fmtDb = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} dB`

export const fmtTime = (iso: string) => timeFmt.format(new Date(iso))

export const fmtDate = (iso: string) => dateFmt.format(new Date(iso))

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

// 'Сегодня 09:41' / 'Вчера 22:10' / '06.11.2026' (labels come from the dictionary)
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
  if (dayKey(d) === dayKey(now)) return `${WORDS.todayAt} ${fmtTime(iso)}`
  if (dayKey(d) === dayKey(new Date(now.getTime() - 86400_000))) return `${WORDS.yesterdayAt} ${fmtTime(iso)}`
  return fmtDate(iso)
}

export { dayKey }

export const fmtDuration = (sec: number) => {
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${pad(s % 60)}`
}

export const fmtNumber = (n: number) => numberFmt.format(n)

export function fmtTotal(sec: number): string {
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} ${WORDS.min}`
  return `${Math.floor(m / 60)} ${WORDS.h} ${pad(m % 60)} ${WORDS.min}`
}

export function fmtBytes(n: number): string {
  if (n > 1024 ** 3) return `${oneDecimalFmt.format(n / 1024 ** 3)} ${WORDS.gb}`
  if (n > 1024 ** 2) return `${Math.round(n / 1024 ** 2)} ${WORDS.mb}`
  return `${Math.round(n / 1024)} ${WORDS.kb}`
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'

export { plural } from '../i18n/plural'
