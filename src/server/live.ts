// In-process event bus for the live updates of the web app (Server-Sent Events, /api/app/events). Events are small invalidation hints:
// the browser refetches the matching queries. Every event belongs to one user and only reaches that user's open pages.
//
//   messages  a message was created / its status changed (queued, waiting, aired, skipped, failed, replay)
//   station   source, levels or settings of the station / user changed
//   learn     learn-mode play state changed (intro / playing / done), notes ready, skip flags
//   live      listeners count / now-playing changed
export const LIVE_TOPICS = ['messages', 'station', 'learn', 'live'] as const
export type LiveTopic = (typeof LIVE_TOPICS)[number]

export const MAX_LIVE_CONNECTIONS_PER_USER = 10

type Listener = (topic: LiveTopic) => void

export class LiveBus {
  private subs = new Map<string, Set<Listener>>()

  // Returns the unsubscribe function, or null when the user already has MAX_LIVE_CONNECTIONS_PER_USER open connections.
  subscribe(userId: string, fn: Listener): (() => void) | null {
    let set = this.subs.get(userId)
    if (!set) {
      set = new Set()
      this.subs.set(userId, set)
    }
    if (set.size >= MAX_LIVE_CONNECTIONS_PER_USER) return null
    set.add(fn)
    return () => {
      const cur = this.subs.get(userId)
      if (!cur) return
      cur.delete(fn)
      if (cur.size === 0) this.subs.delete(userId)
    }
  }

  emit(userId: string, ...topics: LiveTopic[]) {
    const set = this.subs.get(userId)
    if (!set) return
    for (const fn of [...set]) {
      for (const t of topics) {
        try {
          fn(t)
        } catch {
          // a broken connection must not stop the others (it unsubscribes itself when its stream closes)
        }
      }
    }
  }

  count(userId: string): number {
    return this.subs.get(userId)?.size ?? 0
  }
}

export const liveBus = new LiveBus()
export const emitLive = (userId: string, ...topics: LiveTopic[]) => liveBus.emit(userId, ...topics)
