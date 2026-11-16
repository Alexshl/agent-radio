import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Config } from './config'
import type { Db } from './db/client'
import { stations, users } from './db/schema'
import type { EngineApi, EngineLevels, EngineSourceSpec } from './engine/client'
import { badRequest } from './lib/http'
import { newId, nowIso, randomToken } from './lib/ids'
import { getSetting } from './lib/settings'
import { emitLive } from './live'
import { writePlaylist, writeTrackList } from './music'
import { getPlaylist } from './playlists'
import { relayUrlFor } from './routes/relay'

export const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('relay'), url: z.url({ protocol: /^https?$/ }).max(2000), name: z.string().max(200).optional() }),
  // folder inside the music library ('' = the whole library)
  z.object({ type: z.literal('playlist'), dir: z.string().max(500).default(''), order: z.enum(['shuffle', 'ordered']).default('shuffle') }),
  // one of the user's own playlists
  z.object({ type: z.literal('userplaylist'), playlistId: z.string().max(100) }),
  z.object({ type: z.literal('silence') }),
])
export type StationSource = z.infer<typeof sourceSchema>
export type StationRow = typeof stations.$inferSelect

export function parseSource(raw: string): StationSource {
  const r = sourceSchema.safeParse(JSON.parse(raw))
  return r.success ? r.data : { type: 'silence' }
}

// 12 lowercase hex chars: safe as an icecast mount and in URLs.
export const newStationId = () =>
  randomToken(9)
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .padEnd(12, '0')
    .slice(0, 12)
export const LEVEL_RANGES = {
  musicGainDb: { min: -30, max: 6 },
  voiceGainDb: { min: -12, max: 12 },
  trackGainDb: { min: -12, max: 6 },
} as const
const clampLevel = (v: number, r: { min: number; max: number }) => (Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, v)) : 0)
export const RATE_RANGE = { min: 0.8, max: 1.6 } as const
const clampRate = (v: number) => (Number.isFinite(v) ? Math.min(RATE_RANGE.max, Math.max(RATE_RANGE.min, v)) : 1)
export const levelsSchema = z.object({
  musicGainDb: z.number().min(LEVEL_RANGES.musicGainDb.min).max(LEVEL_RANGES.musicGainDb.max).optional(),
  voiceGainDb: z.number().min(LEVEL_RANGES.voiceGainDb.min).max(LEVEL_RANGES.voiceGainDb.max).optional(),
  trackGainDb: z.number().min(LEVEL_RANGES.trackGainDb.min).max(LEVEL_RANGES.trackGainDb.max).optional(),
})
export const levelsOf = (st: Pick<StationRow, 'musicGainDb' | 'voiceGainDb' | 'trackGainDb'>): EngineLevels => ({
  musicDb: st.musicGainDb,
  voiceDb: st.voiceGainDb,
  trackDb: st.trackGainDb,
})

export const levelFields = (st: Pick<StationRow, 'musicGainDb' | 'voiceGainDb' | 'trackGainDb'>) => ({
  musicGainDb: st.musicGainDb,
  voiceGainDb: st.voiceGainDb,
  trackGainDb: st.trackGainDb,
})

export const STATION_ID = /^[a-z0-9]{6,32}$/

export function createUser(db: Db, p: { email: string; name?: string; role?: 'admin' | 'user' }) {
  const now = nowIso()
  const email = p.email.trim()
  if (!email.includes('@')) throw badRequest('invalid_email', 'Invalid email')
  const user = db
    .insert(users)
    .values({
      id: newId(),
      email,
      name: p.name?.trim() || email.split('@')[0] || email,
      role: p.role ?? 'user',
      speechRate: clampRate(getSetting(db, 'defaultSpeechRate')),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
  const station = db
    .insert(stations)
    .values({
      id: newStationId(),
      userId: user.id,
      listenToken: randomToken(24),
      source: JSON.stringify({ type: 'silence' } satisfies StationSource),
      musicGainDb: clampLevel(getSetting(db, 'defaultMusicGainDb'), LEVEL_RANGES.musicGainDb),
      voiceGainDb: clampLevel(getSetting(db, 'defaultVoiceGainDb'), LEVEL_RANGES.voiceGainDb),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
  return { user, station }
}

export function findUserByEmail(db: Db, email: string) {
  return db.select().from(users).where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`).get()
}

export function userById(db: Db, id: string) {
  return db.select().from(users).where(eq(users.id, id)).get()
}

export function stationOfUser(db: Db, userId: string): StationRow | undefined {
  return db.select().from(stations).where(eq(stations.userId, userId)).get()
}

export function stationById(db: Db, id: string): StationRow | undefined {
  return db.select().from(stations).where(eq(stations.id, id)).get()
}

// What the engine plays for a station; writes the .m3u for playlist sources (folder and own playlists are always the "queue" type).
export function engineSpec(db: Db, config: Config, st: StationRow): EngineSourceSpec {
  const src = parseSource(st.source)
  // the engine has no internet access: it pulls the stream through the app's relay listener (SSRF-safe fetch)
  if (src.type === 'relay') return { type: 'relay', url: relayUrlFor(config, src.url) }
  if (src.type === 'playlist')
    return { type: 'queue', path: writePlaylist(config, st.id, src.dir), mode: src.order === 'ordered' ? 'normal' : 'randomize' }
  if (src.type === 'userplaylist') {
    const pl = getPlaylist(db, st.userId, src.playlistId)
    const path = writeTrackList(
      config,
      st.id,
      pl.tracks.map((t) => t.path),
    )
    const mode = pl.orderMode === 'ordered' ? 'normal' : 'randomize'
    // always the queue type: learn mode queues the songs in it and "previous" pushes the earlier file into it; with an empty queue the list plays as is
    return { type: 'queue', path, mode }
  }
  return { type: 'silence' }
}

// Pushes one station (add + source) to the engine.
export async function pushStation(db: Db, config: Config, engine: EngineApi, st: StationRow) {
  const spec = engineSpec(db, config, st)
  await engine.add(st.id, st.duckDb, levelsOf(st))
  await engine.setSource(st.id, spec)
}

// Engine calls for one station run one after another (a user changing the source, the duck level and the background sync must not interleave).
const chains = new Map<string, Promise<unknown>>()
export function withStationLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.then(
    () => {},
    () => {},
  )
  chains.set(id, tail)
  void tail.then(() => {
    if (chains.get(id) === tail) chains.delete(id)
  })
  return next
}

// Saves a new source and applies it live. The engine is called first so that a bad playlist folder is rejected before anything is stored.
export function setStationSource(db: Db, config: Config, engine: EngineApi, st: StationRow, source: StationSource) {
  return withStationLock(st.id, async () => {
    // the row may have changed while this call waited (duck level, listen token)
    const fresh = stationById(db, st.id) ?? st
    const next = { ...fresh, source: JSON.stringify(source) }
    const spec = engineSpec(db, config, next)
    await engine.add(st.id, fresh.duckDb, levelsOf(fresh))
    await engine.setSource(st.id, spec)
    db.update(stations).set({ source: next.source, updatedAt: nowIso() }).where(eq(stations.id, st.id)).run()
    emitLive(st.userId, 'station', 'live', 'learn')
    return next
  })
}

// App is the source of truth: after a liquidsoap restart (empty list) every station is pushed again; unknown mounts are removed.
export async function syncEngine(db: Db, config: Config, engine: EngineApi): Promise<{ added: number; removed: number }> {
  const live = new Set(await engine.list())
  const all = db.select().from(stations).all()
  let added = 0
  for (const st of all) {
    if (live.has(st.id)) continue
    const pushed = await withStationLock(st.id, async () => {
      // re-read inside the lock: a source change that ran meanwhile must not be overwritten with the stale row
      const fresh = stationById(db, st.id)
      if (!fresh) return false
      try {
        await pushStation(db, config, engine, fresh)
      } catch (e) {
        // a source that cannot be built (deleted folder / playlist): the station still goes on air, in silence
        console.error(`station ${st.id}: source failed (${e instanceof Error ? e.message : e}), using silence`)
        await engine.add(fresh.id, fresh.duckDb, levelsOf(fresh))
        await engine.setSource(fresh.id, { type: 'silence' })
      }
      return true
    })
    if (pushed) added++
  }
  const known = new Set(all.map((s) => s.id))
  let removed = 0
  for (const id of live) {
    if (!known.has(id)) {
      await withStationLock(id, () => engine.remove(id))
      removed++
    }
  }
  return { added, removed }
}

// A folder source is an auto-generated playlist: after a library scan its .m3u is written again (the engine watches the file and picks it up).
export function refreshFolderPlaylists(db: Db, config: Config) {
  for (const st of db.select().from(stations).all()) {
    const src = parseSource(st.source)
    if (src.type !== 'playlist') continue
    try {
      writePlaylist(config, st.id, src.dir)
    } catch (e) {
      // the folder is gone or empty: the engine keeps the last list
      console.error(`station ${st.id}: folder playlist not refreshed (${e instanceof Error ? e.message : e})`)
    }
  }
}
