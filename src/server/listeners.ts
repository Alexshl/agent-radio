// "Recent listener" grace. Players drop for a few seconds when the stream path restarts; during that window an agent must still
// count the radio as listened to, and a message must be held, not skipped. lastListenerSeenAt is kept in the db (survives an app restart).
import { eq } from 'drizzle-orm'
import type { Db } from './db/client'
import { stations } from './db/schema'
import type { IcecastApi } from './icecast'
import { emitLive } from './live'

export const LISTENER_GRACE_MS = 180_000

export interface ListenerState {
  // current listeners; null when icecast cannot be reached
  listeners: number | null
  // listeners > 0, or somebody was seen within the grace window
  recentlyListening: boolean
  lastSeenAt: number | null
}

export class ListenerTracker {
  constructor(
    private db: Db,
    private icecast: Pick<IcecastApi, 'listeners' | 'reapGhosts'>,
    private now: () => number = () => Date.now(),
    private graceMs = LISTENER_GRACE_MS,
  ) {}

  lastSeenAt(stationId: string): number | null {
    return this.db.select({ t: stations.lastListenerSeenAt }).from(stations).where(eq(stations.id, stationId)).get()?.t ?? null
  }

  recentlyAt(stationId: string, listeners: number | null): boolean {
    if ((listeners ?? 0) > 0) return true
    const seen = this.lastSeenAt(stationId)
    return seen !== null && this.now() - seen <= this.graceMs
  }

  private lastCount = new Map<string, number | null>()

  // asks icecast and records the sighting
  async observe(stationId: string): Promise<ListenerState> {
    const listeners = await this.icecast.listeners(stationId)
    // the listener count (or the stream coming / going) changed: the open pages refetch the live state
    if (this.lastCount.has(stationId) && this.lastCount.get(stationId) !== listeners) {
      const owner = this.db.select({ userId: stations.userId }).from(stations).where(eq(stations.id, stationId)).get()
      if (owner) emitLive(owner.userId, 'live')
    }
    this.lastCount.set(stationId, listeners)
    if ((listeners ?? 0) > 0) this.db.update(stations).set({ lastListenerSeenAt: this.now() }).where(eq(stations.id, stationId)).run()
    return { listeners, recentlyListening: this.recentlyAt(stationId, listeners), lastSeenAt: this.lastSeenAt(stationId) }
  }

  // every station: keeps lastListenerSeenAt fresh even when nobody calls the API
  async observeAll() {
    for (const st of this.db.select({ id: stations.id }).from(stations).all()) {
      await this.icecast.reapGhosts?.(st.id).catch(() => 0)
      await this.observe(st.id)
    }
  }
}
