// Players, not connections. One browser tab opens several icecast connections (Safari: a probe plus the main one per start, then a new pair
// at every re-open), and the old ones linger for minutes behind Cloudflare / the front. The client sends a per-tab `pid` on the stream URL;
// the front appends it to the User-Agent it forwards to icecast ("<UA> pid=<id>"), and icecast listclients shows it.
// Connections of the watchdog's stream probe carry this User-Agent and do not count as listeners.
export const MONITOR_UA = 'agent-radio-monitor'

export interface IcecastClient {
  id: string
  userAgent: string
  // seconds since the connection was opened
  connected: number
}

// the front appends " pid=<id>" at the end (the last match wins: a client cannot hide behind a forged one in its own UA)
const PID_RE = /(?:^|\s)pid=([a-z0-9]{6,32})\s*$/

export function pidOf(userAgent: string): string | null {
  return PID_RE.exec(userAgent)?.[1] ?? null
}

export function isMonitor(c: IcecastClient): boolean {
  return c.userAgent.includes(MONITOR_UA)
}

// A pid-less connection (an old cached client, a native app, another player) falls back to the User-Agent: one UA = one player.
function playerKey(c: IcecastClient): string {
  const pid = pidOf(c.userAgent)
  return pid ? `pid:${pid}` : `ua:${c.userAgent}`
}

// distinct players among the connections (the watchdog's monitor excluded)
export function countPlayers(clients: IcecastClient[]): number {
  return new Set(clients.filter((c) => !isMonitor(c)).map(playerKey)).size
}

// The same start opens up to two connections within seconds of each other (Safari's probe); an older one is a ghost only beyond this.
export const START_PAIR_S = 15
// the newest connection must be at least this old (it is established) before the older ones are killed
export const GHOST_MIN_NEWEST_S = 5

// Ghost connections to kill: for a player (by pid only) every connection older than its newest one by more than START_PAIR_S.
export function ghostIds(clients: IcecastClient[]): string[] {
  const byPid = new Map<string, IcecastClient[]>()
  for (const c of clients) {
    const pid = isMonitor(c) ? null : pidOf(c.userAgent)
    if (pid) byPid.set(pid, [...(byPid.get(pid) ?? []), c])
  }
  const ids: string[] = []
  for (const list of byPid.values()) {
    const newest = Math.min(...list.map((c) => c.connected))
    if (newest < GHOST_MIN_NEWEST_S) continue
    for (const c of list) if (c.connected - newest > START_PAIR_S) ids.push(c.id)
  }
  return ids
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

// icecast 2.4 /admin/listclients?mount=: <listener><IP/><UserAgent/><Connected/><ID/></listener>
export function parseListClients(xml: string): IcecastClient[] {
  const out: IcecastClient[] = []
  for (const m of xml.matchAll(/<listener>([\s\S]*?)<\/listener>/g)) {
    const body = m[1] ?? ''
    const field = (n: string) => new RegExp(`<${n}>([^<]*)</${n}>`, 'i').exec(body)?.[1] ?? ''
    out.push({ id: field('ID'), userAgent: unescapeXml(field('UserAgent')), connected: Number(field('Connected')) || 0 })
  }
  return out
}
