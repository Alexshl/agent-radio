// Listener counts from the icecast admin stats (public JSON, internal network only).
export interface IcecastApi {
  // listeners of the mount; 0 when the mount is not live, null when icecast cannot be reached
  listeners(stationId: string): Promise<number | null>
  // mount is live
  isUp(stationId: string): Promise<boolean | null>
  // ICY title of what plays now (relay metadata / track tags), null when unknown
  title?(stationId: string): Promise<string | null>
}

interface IcecastSource {
  listenurl?: string
  listeners?: number
  title?: string
  yp_currently_playing?: string
}

// Connections of the watchdog's stream probe carry this User-Agent and do not count as listeners.
export const MONITOR_UA = 'agent-radio-monitor'

// The engine appends the broadcast minute to the title (" [14:32]", a lag marker for the listener, see radio.liq); the UI does not show it.
export function cleanTitle(raw: string | undefined | null): string | null {
  const t = (raw ?? '').replace(/\s*\[\d\d:\d\d\]$/, '').trim()
  return t && t !== 'agent-radio' ? t : null
}

export class IcecastStats implements IcecastApi {
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
    // admin credentials (listclients); without them the monitor probes are counted
    private admin: { user: string; password: string } | null = null,
  ) {}

  // monitor connections of a mount (admin listclients); null when unknown
  private async monitors(stationId: string): Promise<number | null> {
    if (!this.admin) return null
    try {
      const auth = Buffer.from(`${this.admin.user}:${this.admin.password}`).toString('base64')
      const res = await this.fetchImpl(`${this.baseUrl}/admin/listclients?mount=/${stationId}`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return null
      const xml = await res.text()
      return (xml.match(/<UserAgent>[^<]*agent-radio-monitor[^<]*<\/UserAgent>/gi) ?? []).length
    } catch {
      return null
    }
  }

  private async mount(stationId: string): Promise<IcecastSource | null | undefined> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/status-json.xsl`, { signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return undefined
      const stats = (await res.json()) as { icestats?: { source?: IcecastSource | IcecastSource[] } }
      const src = stats.icestats?.source
      const all = src === undefined ? [] : Array.isArray(src) ? src : [src]
      return all.find((s) => s.listenurl?.endsWith(`/${stationId}`)) ?? null
    } catch {
      return undefined
    }
  }

  async listeners(stationId: string): Promise<number | null> {
    const m = await this.mount(stationId)
    if (m === undefined) return null
    const n = m?.listeners ?? 0
    if (n === 0) return 0
    return Math.max(0, n - ((await this.monitors(stationId)) ?? 0))
  }

  async isUp(stationId: string): Promise<boolean | null> {
    const m = await this.mount(stationId)
    return m === undefined ? null : m !== null
  }

  async title(stationId: string): Promise<string | null> {
    const m = await this.mount(stationId)
    return cleanTitle(m?.title)
  }
}
