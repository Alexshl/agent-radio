import { countPlayers, ghostIds, type IcecastClient, MONITOR_UA, parseListClients } from './players'

// Listener counts from the icecast admin stats (public JSON, internal network only).
export interface IcecastApi {
  // listeners of the mount; 0 when the mount is not live, null when icecast cannot be reached
  listeners(stationId: string): Promise<number | null>
  // mount is live
  isUp(stationId: string): Promise<boolean | null>
  // ICY title of what plays now (relay metadata / track tags), null when unknown
  title?(stationId: string): Promise<string | null>
  // closes ghost connections of a mount (older connections of a player that reconnected); returns how many were killed
  reapGhosts?(stationId: string): Promise<number>
}

interface IcecastSource {
  listenurl?: string
  listeners?: number
  title?: string
  yp_currently_playing?: string
}

export { MONITOR_UA }

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

  // connections of a mount (admin listclients); null when unknown
  private async clients(stationId: string): Promise<IcecastClient[] | null> {
    if (!this.admin) return null
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/admin/listclients?mount=/${stationId}`, {
        headers: { Authorization: this.auth() },
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return null
      return parseListClients(await res.text())
    } catch {
      return null
    }
  }

  private auth(): string {
    return `Basic ${Buffer.from(`${this.admin?.user}:${this.admin?.password}`).toString('base64')}`
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

  // distinct players (see players.ts), not connections; without admin credentials the raw connection count
  async listeners(stationId: string): Promise<number | null> {
    const m = await this.mount(stationId)
    if (m === undefined) return null
    const n = m?.listeners ?? 0
    if (n === 0) return 0
    const clients = await this.clients(stationId)
    return clients ? countPlayers(clients) : n
  }

  // Kills the ghost connections of a mount (older connections of a player that has a newer one, see ghostIds); returns how many.
  async reapGhosts(stationId: string): Promise<number> {
    const clients = await this.clients(stationId)
    if (!clients) return 0
    let killed = 0
    for (const id of ghostIds(clients)) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/admin/killclient?mount=/${stationId}&id=${encodeURIComponent(id)}`, {
          headers: { Authorization: this.auth() },
          signal: AbortSignal.timeout(5_000),
        })
        if (res.ok) killed++
      } catch {
        // the next sweep tries again
      }
    }
    return killed
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
