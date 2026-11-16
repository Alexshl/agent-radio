// Delivery of a message to the air, from "ready to play" to "played": hold while the listener is reconnecting, push to the engine,
// confirm that the engine started / finished the clip, push again once when it did not start.
//
//   waiting  -> held (clip ready) until somebody listens again; expires after HOLD_MS -> skipped (expired)
//   onair    -> pushed to the engine, not started yet (re-pushed once after START_TIMEOUT_MS) -> failed (not_started)
//   playing  -> the engine started it
//   aired    -> played to the end (startedAt / endedAt)
import { basename, join } from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from './db/client'
import { messages, stations } from './db/schema'
import type { FullDeps } from './deps'
import type { EngineMsgState } from './engine/client'
import { emitLive } from './live'
import { introActive } from './learn/plays'
import { LISTENER_GRACE_MS } from './listeners'
import { stationById } from './stations'

export const HOLD_MS = LISTENER_GRACE_MS
export const START_TIMEOUT_MS = 30_000
// the engine forgets a clip it never heard of (restart): push again after this
const LOST_AFTER_MS = 3_000

export type MessageRow = typeof messages.$inferSelect
type Part = Pick<FullDeps, 'db' | 'config' | 'engine' | 'icecast' | 'listeners' | 'airing'>

export type DeliveryStatus = 'waiting' | 'queued' | 'on_air_queued' | 'playing' | 'played' | 'skipped' | 'failed'

const PUBLIC_STATUS: Record<string, DeliveryStatus> = {
  waiting: 'waiting',
  queued: 'queued',
  onair: 'on_air_queued',
  playing: 'playing',
  aired: 'played',
  skipped: 'skipped',
  failed: 'failed',
}

export function deliveryView(m: MessageRow) {
  return {
    id: m.id,
    status: PUBLIC_STATUS[m.status] ?? 'failed',
    reason: m.reason,
    attempts: m.attempts,
    createdAt: m.createdAt,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
  }
}

export function messageById(db: Db, id: string): MessageRow | undefined {
  return db.select().from(messages).where(eq(messages.id, id)).get()
}

export function patchMessage(db: Db, id: string, v: Partial<typeof messages.$inferInsert>) {
  db.update(messages).set(v).where(eq(messages.id, id)).run()
  const owner = db.select({ userId: messages.userId }).from(messages).where(eq(messages.id, id)).get()
  if (owner) emitLive(owner.userId, 'messages')
}

export class Delivery {
  private busy = false

  constructor(
    private deps: Part,
    private now: () => number = () => Date.now(),
  ) {}

  private clipFile(m: MessageRow) {
    return join(this.deps.config.engineSharedDir, 'clips', basename(m.clipPath ?? ''))
  }

  // hands the clip to the engine (voice queue or the track queue of an uploaded file); throws when the engine refuses
  async push(m: MessageRow) {
    const { db, engine, airing } = this.deps
    const st = stationById(db, this.stationOf(m))
    if (!st) throw new Error('no station')
    // a waiting message is claimed first: the 2 s tick and a say that offers it must not both push it
    const held = m.status === 'waiting'
    if (held) {
      const claim = db
        .update(messages)
        .set({ status: 'onair', pushedAt: this.now() })
        .where(and(eq(messages.id, m.id), eq(messages.status, 'waiting')))
        .run()
      if (claim.changes === 0) return
    }
    try {
      if (m.type === 'audio') await engine.pushTrack(st.id, this.clipFile(m), m.id)
      else await engine.push(st.id, this.clipFile(m), m.id)
    } catch (e) {
      if (held) patchMessage(db, m.id, { status: 'waiting', pushedAt: null })
      throw e
    }
    if (m.type === 'audio' && m.attempts === 0) airing.start(st.id, m.text, (m.durationSec ?? 0) + 10)
    patchMessage(db, m.id, { status: 'onair', pushedAt: this.now(), attempts: m.attempts + 1, reason: null })
  }

  private stationOf(m: MessageRow): string {
    // the station of the message's user (one station per user)
    return this.deps.db.select({ id: stations.id }).from(stations).where(eq(stations.userId, m.userId)).get()?.id ?? ''
  }

  // A clip is ready: on air when somebody listens now, held while the listener is within the grace window, otherwise skipped.
  // Returns the resulting status. A push error is thrown (the caller decides what the agent sees).
  async offer(id: string, stationId: string): Promise<'onair' | 'waiting' | 'skipped'> {
    const { db } = this.deps
    const m = messageById(db, id)
    if (!m) return 'skipped'
    const ls = await this.deps.listeners.observe(stationId)
    // learn mode: a spoken song intro is on air, the message waits for it (the 2 s tick pushes it afterwards)
    if ((ls.listeners ?? 0) > 0 && !introActive(db, stationId, this.now())) {
      await this.push(m)
      return 'onair'
    }
    if (this.now() - Date.parse(m.createdAt) < HOLD_MS) {
      patchMessage(db, id, { status: 'waiting', reason: null })
      return 'waiting'
    }
    patchMessage(db, id, { status: 'skipped', reason: 'nobody_listening' })
    return 'skipped'
  }

  // one pass over the open messages (the app runs it every 2 s)
  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      await this.run()
    } finally {
      this.busy = false
    }
  }

  private async run() {
    const { db, engine, listeners, airing } = this.deps
    const open = db
      .select()
      .from(messages)
      .where(inArray(messages.status, ['waiting', 'onair', 'playing']))
      .all()
    if (!open.length) return
    const now = this.now()
    let states: Map<string, EngineMsgState> | null = null
    if (open.some((m) => m.status !== 'waiting')) {
      try {
        states = new Map((await engine.msgStates()).map((s) => [s.id, s]))
      } catch {
        states = null
      }
    }
    const heard = new Map<string, boolean>()
    const hasListener = async (stationId: string) => {
      if (!heard.has(stationId)) heard.set(stationId, ((await listeners.observe(stationId)).listeners ?? 0) > 0)
      return heard.get(stationId) as boolean
    }
    for (const m of open) {
      const stationId = this.stationOf(m)
      try {
        if (m.status === 'waiting') {
          if (!m.clipPath) {
            patchMessage(db, m.id, { status: 'failed', reason: 'push_failed' })
          } else if (now - Date.parse(m.createdAt) >= HOLD_MS) {
            patchMessage(db, m.id, { status: 'skipped', reason: 'expired' })
          } else if ((await hasListener(stationId)) && !introActive(db, stationId, now)) {
            await this.push(m)
          }
          continue
        }
        if (!states) continue
        const s = states.get(m.id)
        if (s?.state === 'done') {
          patchMessage(db, m.id, {
            status: 'aired',
            startedAt: s.started ? Math.round(s.started * 1000) : (m.startedAt ?? now),
            endedAt: s.ended ? Math.round(s.ended * 1000) : now,
          })
        } else if (s?.state === 'playing') {
          const started = Math.round(s.started * 1000)
          // the engine never reported the end (a lost event): after the clip's length plus a minute it has surely finished
          const limit = ((m.durationSec ?? 120) + 60) * 1000
          if (now - started > limit) patchMessage(db, m.id, { status: 'aired', startedAt: started, endedAt: started + limit - 60_000 })
          else if (m.status !== 'playing') patchMessage(db, m.id, { status: 'playing', startedAt: started })
        } else if (m.status === 'playing') {
          // it was playing and the engine no longer knows it: the engine restarted in the middle of the clip
          patchMessage(db, m.id, { status: 'failed', reason: 'engine_restarted', endedAt: now })
        } else {
          const since = now - (m.pushedAt ?? now)
          const lost = !s && since >= LOST_AFTER_MS
          const stuck = since >= START_TIMEOUT_MS && !(m.type === 'voice' && airing.current(stationId))
          if (!lost && !stuck) continue
          if (m.attempts < 2 && m.clipPath) await this.push(m)
          else if (stuck || lost) patchMessage(db, m.id, { status: 'failed', reason: 'not_started' })
        }
      } catch (e) {
        console.error(`delivery of ${m.id}:`, e instanceof Error ? e.message : e)
        // the engine keeps refusing the clip: give up after a while
        if (m.status === 'onair' && m.pushedAt && now - m.pushedAt > 4 * START_TIMEOUT_MS)
          patchMessage(db, m.id, { status: 'failed', reason: 'not_started' })
      }
    }
  }
}

// the app was restarted: messages still waiting for a slow voice will never be synthesized
export function closeStale(db: Db) {
  db.update(messages).set({ status: 'failed', reason: 'app_restarted' }).where(eq(messages.status, 'queued')).run()
}
