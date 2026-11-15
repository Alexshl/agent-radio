// Learn mode: the state of the queued songs (learn_plays) and what the rest of the app needs to know about it.
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { learnPlays, learnSongPrefs, stations, type users } from '../db/schema'
import { nowIso } from '../lib/ids'
import type { FullDeps } from '../deps'
import { parseSource, setStationSource, withStationLock } from '../stations'
import type { LlmService } from './llm'
import { learnProgress } from './view'

export const LEARN_EVERY = [1, 2, 3] as const
// rows that wait for the engine or are on air
export const OPEN_STATUSES = ['planned', 'pushed', 'intro', 'playing']
// a spoken intro of this age that is still "on air" is a stale record (the app was away): ignored
const INTRO_STALE_MS = 180_000

export type LearnPlayRow = typeof learnPlays.$inferSelect

// The spoken intro of a song is on air: a voice message must not be laid over it (it waits, delivery.ts).
export function introActive(db: Db, stationId: string, now = Date.now()): boolean {
  const row = db
    .select({ startedAt: learnPlays.startedAt, pushedAt: learnPlays.pushedAt })
    .from(learnPlays)
    .where(and(eq(learnPlays.stationId, stationId), eq(learnPlays.status, 'intro')))
    .get()
  if (!row) return false
  return now - (row.startedAt ?? row.pushedAt ?? now) < INTRO_STALE_MS
}

// Learn mode is available when the station plays one of the user's own playlists.
export function learnAvailable(db: Db, userId: string): boolean {
  const st = db.select({ source: stations.source }).from(stations).where(eq(stations.userId, userId)).get()
  return !!st && parseSource(st.source).type === 'userplaylist'
}

// configured: an AI model is set up (without one the mode only gives "artist - title"); lang: the language the notes are written in
export function learnView(db: Db, user: typeof users.$inferSelect, llm: Pick<LlmService, 'configured'>) {
  return {
    mode: !!user.learnMode,
    every: user.learnEvery,
    available: learnAvailable(db, user.id),
    configured: llm.configured(),
    lang: user.lang,
    ...learnProgress(db, user),
  }
}

export function skipFlags(db: Db, userId: string, trackIds: string[]): Set<string> {
  if (!trackIds.length) return new Set()
  return new Set(
    db
      .select({ trackId: learnSongPrefs.trackId })
      .from(learnSongPrefs)
      .where(and(eq(learnSongPrefs.userId, userId), eq(learnSongPrefs.skip, 1), inArray(learnSongPrefs.trackId, trackIds)))
      .all()
      .map((r) => r.trackId),
  )
}

export function setSkip(db: Db, userId: string, trackId: string, skip: boolean) {
  db.insert(learnSongPrefs)
    .values({ userId, trackId, skip: skip ? 1 : 0, createdAt: nowIso() })
    .onConflictDoUpdate({ target: [learnSongPrefs.userId, learnSongPrefs.trackId], set: { skip: skip ? 1 : 0 } })
    .run()
}

// Closes everything that is still open (learn mode switched off, the source is no longer a playlist): nothing will be queued again.
export function closeOpenPlays(db: Db, stationId: string, now = Date.now()) {
  db.update(learnPlays)
    .set({ status: 'lost', retried: 1, endedAt: now })
    .where(and(eq(learnPlays.stationId, stationId), inArray(learnPlays.status, OPEN_STATUSES)))
    .run()
}

// Switches learn mode of a user and re-applies the station source (the engine plays "queue" instead of "playlist" and back).
// Off also empties the music queue. Throws when the engine refuses (the caller reverts).
export async function applyLearnMode(deps: Pick<FullDeps, 'db' | 'config' | 'engine'>, st: typeof stations.$inferSelect, on: boolean) {
  const { db, config, engine } = deps
  const src = parseSource(st.source)
  if (src.type !== 'userplaylist') return
  if (on) await withStationLock(st.id, () => engine.flushMusic(st.id)).catch(() => {})
  await setStationSource(db, config, engine, st, src)
  if (!on) {
    await withStationLock(st.id, () => engine.flushMusic(st.id)).catch(() => {})
    closeOpenPlays(db, st.id)
  }
}
