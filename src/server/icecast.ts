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

export class IcecastStats implements IcecastApi {
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

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
    return m === undefined ? null : (m?.listeners ?? 0)
  }

  async isUp(stationId: string): Promise<boolean | null> {
    const m = await this.mount(stationId)
    return m === undefined ? null : m !== null
  }

  async title(stationId: string): Promise<string | null> {
    const m = await this.mount(stationId)
    return m?.title?.trim() || null
  }
}
