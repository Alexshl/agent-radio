// LRCLIB (https://lrclib.net): free synced / plain lyrics by artist, title, album and duration. One request at a time, 15 s each.
export const LRCLIB_URL = 'https://lrclib.net/api'
const USER_AGENT = 'agent-radio (+https://github.com/Alexshl/agent-radio)'
const TIMEOUT_MS = 15_000
const DURATION_TOLERANCE_SEC = 2

export interface LrcLibQuery {
  artist: string
  title: string
  album: string
  durationSec: number
}

export type LrcLibResult =
  | { status: 'found'; plain: string | null; synced: string | null }
  | { status: 'instrumental' }
  | { status: 'not_found' }

interface Item {
  trackName?: string
  artistName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

export class LrcLibClient {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private fetchImpl: typeof fetch = fetch) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  private async getJson(path: string, params: Record<string, string>): Promise<unknown | null> {
    const url = `${LRCLIB_URL}${path}?${new URLSearchParams(params)}`
    const res = await this.fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`lrclib answered ${res.status}`)
    return res.json()
  }

  private durationOk(item: Item, q: LrcLibQuery): boolean {
    if (!q.durationSec || typeof item.duration !== 'number') return true
    return Math.abs(item.duration - q.durationSec) <= DURATION_TOLERANCE_SEC
  }

  private result(item: Item): LrcLibResult | null {
    if (item.instrumental) return { status: 'instrumental' }
    const plain = item.plainLyrics?.trim() || null
    const synced = item.syncedLyrics?.trim() || null
    return plain || synced ? { status: 'found', plain, synced } : null
  }

  // A network / server error throws (the caller retries it later); "no such song" is a result.
  find(q: LrcLibQuery): Promise<LrcLibResult> {
    return this.serial(async () => {
      const got = (await this.getJson('/get', {
        artist_name: q.artist,
        track_name: q.title,
        album_name: q.album,
        duration: String(Math.round(q.durationSec)),
      })) as Item | null
      if (got && this.durationOk(got, q)) {
        const r = this.result(got)
        if (r) return r
      }
      const list = (await this.getJson('/search', { artist_name: q.artist, track_name: q.title })) as Item[] | null
      const items = (Array.isArray(list) ? list : []).filter(
        (i) =>
          this.durationOk(i, q) && norm(i.trackName ?? '') === norm(q.title) && (!q.artist || norm(i.artistName ?? '') === norm(q.artist)),
      )
      // synced lyrics first, then the closest duration
      items.sort(
        (a, b) =>
          Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics) ||
          Math.abs((a.duration ?? 0) - q.durationSec) - Math.abs((b.duration ?? 0) - q.durationSec),
      )
      for (const i of items) {
        const r = this.result(i)
        if (r) return r
      }
      return { status: 'not_found' }
    })
  }
}
