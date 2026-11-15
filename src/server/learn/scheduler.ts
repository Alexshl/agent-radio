// Learn mode: the app, not the engine, decides which song comes next. It keeps exactly one song (with its spoken intro) queued ahead in the
// engine's music queue; the playlist of the "queue" source plays only while the queue is empty (the app was away, the engine just restarted).
//
// A row of learn_plays per song: planned -> pushed -> (intro) -> playing -> done | lost. The states come from the engine (/msg/states, polled by
// tick()). A song the engine does not know any more (a restart) is queued again. Every failure around the intro means "no intro": the song still plays.
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { learnPlays, stations, users } from '../db/schema'
import type { FullDeps } from '../deps'
import type { EngineMsgState } from '../engine/client'
import { newId } from '../lib/ids'
import { engineTrackPath } from '../music'
import { getPlaylist } from '../playlists'
import { type StationRow, parseSource, stationOfUser, withStationLock } from '../stations'
import type { SongPreparer } from './prepare'
import { LEARN_EVERY, type LearnPlayRow, OPEN_STATUSES, closeOpenPlays, skipFlags } from './plays'

// the engine forgets a clip it never heard of (restart): queue again after this
const LOST_AFTER_MS = 3_000
// a song queued longer ago than this and still "queued" in the engine: gone for good
const STUCK_AFTER_MS = 30 * 60_000
const RETRY_WINDOW_MS = 10 * 60_000
const MAX_ATTEMPTS = 3
const INTRO_TIMEOUT_MS = 25_000

type UserRow = typeof users.$inferSelect
type Part = Pick<FullDeps, 'db' | 'config' | 'engine' | 'tts'>
interface Track {
  id: string
  path: string
  title: string
  artist: string
}

export interface Bag {
  playlistId: string
  order: 'shuffle' | 'ordered'
  // shuffle: the track ids still to be played in this round
  ids: string[]
  // ordered: the next position
  cursor: number
  last?: string
}

const ms = (sec: number) => Math.round(sec * 1000)

export function parseBag(raw: string | null): Bag | null {
  if (!raw) return null
  try {
    const b = JSON.parse(raw) as Partial<Bag>
    if (typeof b.playlistId !== 'string' || (b.order !== 'shuffle' && b.order !== 'ordered')) return null
    return {
      playlistId: b.playlistId,
      order: b.order,
      ids: Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string') : [],
      cursor: Number.isInteger(b.cursor) ? (b.cursor as number) : 0,
      last: typeof b.last === 'string' ? b.last : undefined,
    }
  } catch {
    return null
  }
}

// The next track and the updated bag. Pure: the caller stores the bag.
export function drawTrack(
  bag: Bag | null,
  playlistId: string,
  order: 'shuffle' | 'ordered',
  tracks: Track[],
  rng: () => number,
): { track: Track; bag: Bag } {
  let b: Bag = bag && bag.playlistId === playlistId && bag.order === order ? bag : { playlistId, order, ids: [], cursor: 0 }
  if (order === 'ordered') {
    const i = b.cursor % tracks.length
    const track = tracks[i] as Track
    return { track, bag: { ...b, cursor: (i + 1) % tracks.length, ids: [], last: track.id } }
  }
  const byId = new Map(tracks.map((t) => [t.id, t]))
  let ids = b.ids.filter((id) => byId.has(id))
  if (!ids.length) {
    ids = tracks.map((t) => t.id)
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[ids[i], ids[j]] = [ids[j] as string, ids[i] as string]
    }
    // the first song of a new round is not the last one of the previous round
    if (ids.length > 1 && ids[0] === b.last) [ids[0], ids[1]] = [ids[1] as string, ids[0] as string]
  }
  const id = ids.shift() as string
  b = { ...b, ids, last: id }
  return { track: byId.get(id) as Track, bag: b }
}

export class LearnScheduler {
  private busy = false

  constructor(
    private deps: Part,
    private opts: {
      now?: () => number
      rng?: () => number
      introTimeoutMs?: number
      prep?: Pick<SongPreparer, 'getNotes' | 'ensurePrepared'>
    } = {},
  ) {}

  private now = () => (this.opts.now ?? Date.now)()
  private rng = () => (this.opts.rng ?? Math.random)()

  // one pass (the app runs it every 5 s, after the engine sync)
  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      await this.run()
    } catch (e) {
      console.error('learn tick failed:', e instanceof Error ? e.message : e)
    } finally {
      this.busy = false
    }
  }

  private async run() {
    const { db, engine } = this.deps
    const on = db.select().from(users).where(eq(users.learnMode, 1)).all()
    // rows left open by a user who switched learn mode off while the app was away
    const open = db.select().from(learnPlays).where(inArray(learnPlays.status, OPEN_STATUSES)).all()
    const onIds = new Set(on.map((u) => u.id))
    for (const sid of new Set(open.filter((r) => !onIds.has(r.userId)).map((r) => r.stationId))) closeOpenPlays(db, sid, this.now())
    if (!on.length) return
    let states: Map<string, EngineMsgState>
    try {
      states = new Map((await engine.msgStates()).map((s) => [s.id, s]))
    } catch {
      return
    }
    for (const user of on) {
      try {
        await this.station(user, states)
      } catch (e) {
        console.error(`learn ${user.id}:`, e instanceof Error ? e.message : e)
      }
    }
  }

  private async station(user: UserRow, states: Map<string, EngineMsgState>) {
    const { db, engine } = this.deps
    const st = stationOfUser(db, user.id)
    if (!st) return
    const src = parseSource(st.source)
    const rows = () =>
      db
        .select()
        .from(learnPlays)
        .where(and(eq(learnPlays.stationId, st.id), inArray(learnPlays.status, OPEN_STATUSES)))
        .all()
    if (src.type !== 'userplaylist') {
      if (rows().length) {
        await withStationLock(st.id, () => engine.flushMusic(st.id)).catch(() => {})
        closeOpenPlays(db, st.id, this.now())
      }
      return
    }
    for (const row of rows()) this.reconcile(row, states)
    await this.retryLost(st)
    // exactly one song ahead: the next one is queued when this one starts playing
    if (rows().some((r) => r.status !== 'playing')) return
    // a lost song still waits to be queued again (the engine is not back yet): do not pick another one meanwhile
    const waiting = db
      .select()
      .from(learnPlays)
      .where(and(eq(learnPlays.stationId, st.id), eq(learnPlays.status, 'lost'), eq(learnPlays.retried, 0)))
      .all()
    if (waiting.length) return
    // the engine does not know the station yet (it is being pushed again after a restart): try on the next pass
    const pl = getPlaylist(db, user.id, src.playlistId)
    if (!pl.tracks.length) return
    await this.plan(user, st, pl)
  }

  // learn_plays <- what the engine says about the song's messages
  private reconcile(row: LearnPlayRow, states: Map<string, EngineMsgState>) {
    const { db } = this.deps
    const now = this.now()
    const set = (v: Partial<typeof learnPlays.$inferInsert>) => db.update(learnPlays).set(v).where(eq(learnPlays.id, row.id)).run()
    const t = states.get(row.trackMsg)
    const i = row.introMsg ? states.get(row.introMsg) : undefined
    if (t?.state === 'done') {
      set({ status: 'done', startedAt: t.started ? ms(t.started) : (row.startedAt ?? now), endedAt: t.ended ? ms(t.ended) : now })
    } else if (t?.state === 'playing') {
      if (row.status !== 'playing') set({ status: 'playing', startedAt: ms(t.started) })
    } else if (i?.state === 'playing') {
      if (row.status !== 'intro') set({ status: 'intro', startedAt: ms(i.started) })
    } else if (t || i) {
      // known to the engine, waiting for its turn (or the intro is done and the song starts now)
      if (row.status === 'intro') set({ status: 'pushed' })
      else if (row.status === 'planned') set({ status: 'pushed' })
      else if (now - (row.pushedAt ?? now) > STUCK_AFTER_MS) set({ status: 'lost', retried: 1, endedAt: now })
    } else if (row.status === 'planned') {
      // the app died between planning and pushing
      if (now - row.plannedAt > LOST_AFTER_MS * 10) set({ status: 'lost', endedAt: now })
    } else if (now - (row.pushedAt ?? now) >= LOST_AFTER_MS) {
      // the engine forgot it (restart). A song that was already audible is not played again.
      set({ status: 'lost', retried: row.status === 'pushed' ? 0 : 1, endedAt: now })
    }
  }

  // a song lost before it started goes into the queue again (with its intro when the clip is still there)
  private async retryLost(st: StationRow) {
    const { db } = this.deps
    const now = this.now()
    const lost = db
      .select()
      .from(learnPlays)
      .where(and(eq(learnPlays.stationId, st.id), eq(learnPlays.status, 'lost'), eq(learnPlays.retried, 0)))
      .all()
    for (const row of lost) {
      if (row.attempt >= MAX_ATTEMPTS || now - row.plannedAt > RETRY_WINDOW_MS) {
        db.update(learnPlays).set({ retried: 1 }).where(eq(learnPlays.id, row.id)).run()
        continue
      }
      const again = this.newRow(row.userId, st.id, row.trackId, row.introClip, row.attempt + 1)
      try {
        await this.pushRow(st, again, null)
      } catch (e) {
        console.error(`learn ${st.id}: queue again failed:`, e instanceof Error ? e.message : e)
        db.delete(learnPlays).where(eq(learnPlays.id, again.id)).run()
        // a song that is not in the library any more is not queued again
        if (e instanceof Error && e.message === 'track is gone')
          db.update(learnPlays).set({ retried: 1 }).where(eq(learnPlays.id, row.id)).run()
        return
      }
      db.update(learnPlays).set({ retried: 1 }).where(eq(learnPlays.id, row.id)).run()
      return
    }
  }

  private newRow(userId: string, stationId: string, trackId: string, introClip: string | null, attempt: number): LearnPlayRow {
    const id = newId()
    const row: LearnPlayRow = {
      id,
      userId,
      stationId,
      trackId,
      status: 'planned',
      trackMsg: `learn-${id}-t`,
      introMsg: introClip ? `learn-${id}-i` : null,
      introClip,
      attempt,
      retried: 0,
      plannedAt: this.now(),
      pushedAt: null,
      startedAt: null,
      endedAt: null,
    }
    this.deps.db.insert(learnPlays).values(row).run()
    return row
  }

  // queues the song of `row` (intro first). A track the library no longer has is an error.
  private async pushRow(st: StationRow, row: LearnPlayRow, title: string | null) {
    const { db, engine, config } = this.deps
    const t = db.$client.prepare('select path, title, artist from tracks where id = ?').get(row.trackId) as
      | { path: string; title: string; artist: string }
      | undefined
    if (!t) throw new Error('track is gone')
    const set = (v: Partial<typeof learnPlays.$inferInsert>) => db.update(learnPlays).set(v).where(eq(learnPlays.id, row.id)).run()
    let intro = false
    await withStationLock(st.id, async () => {
      if (row.introMsg && row.introClip && existsSync(row.introClip)) {
        try {
          const gain = Math.max(-24, Math.min(24, st.voiceGainDb - st.musicGainDb))
          await engine.pushMusic(st.id, join(config.engineSharedDir, 'clips', basename(row.introClip)), row.introMsg, {
            title: title ?? introText(t),
            amplifyDb: gain,
          })
          intro = true
        } catch (e) {
          console.error(`learn ${st.id}: intro not queued:`, e instanceof Error ? e.message : e)
        }
      }
      try {
        await engine.pushMusic(st.id, engineTrackPath(config, t.path), row.trackMsg)
      } catch (e) {
        // do not leave an intro without its song in the queue
        if (intro) await engine.flushMusic(st.id).catch(() => {})
        throw e
      }
    })
    set({ status: 'pushed', pushedAt: this.now(), introMsg: intro ? row.introMsg : null })
  }

  // picks the next song and queues it
  private async plan(user: UserRow, st: StationRow, pl: ReturnType<typeof getPlaylist>) {
    const { db, config } = this.deps
    const order = pl.orderMode === 'ordered' ? 'ordered' : 'shuffle'
    let bag = parseBag(st.learnBag)
    let track: Track | undefined
    // a file that is not on disk any more is passed over
    for (let n = 0; n < pl.tracks.length && !track; n++) {
      const d = drawTrack(bag, pl.id, order, pl.tracks, this.rng)
      bag = d.bag
      if (existsSync(join(config.musicDir, d.track.path))) track = d.track
    }
    if (!track || !bag) return
    const every = LEARN_EVERY.includes(user.learnEvery as 1 | 2 | 3) ? user.learnEvery : 1
    const skipped = skipFlags(db, user.id, [track.id]).has(track.id)
    // a song the user knows: no intro, and it does not count
    const withIntro = !skipped && st.learnCounter % every === 0
    db.update(stations)
      .set({ learnBag: JSON.stringify(bag), learnCounter: skipped ? st.learnCounter : st.learnCounter + 1 })
      .where(eq(stations.id, st.id))
      .run()
    let clip: string | null = null
    // the prepared spoken intro when the notes are ready, else the plain "artist - title"
    const notes = withIntro ? this.opts.prep?.getNotes(track.id, user.lang) : null
    if (withIntro) clip = await this.makeIntro(user, notes?.introText || introText(track))
    this.prefetch(user, pl, order, bag)
    const row = this.newRow(user.id, st.id, track.id, clip, 1)
    try {
      await this.pushRow(st, row, introText(track))
    } catch (e) {
      // the engine refused: the lost-song path queues it again on the next pass
      console.error(`learn ${st.id}: song not queued:`, e instanceof Error ? e.message : e)
      db.update(learnPlays).set({ status: 'lost', endedAt: this.now() }).where(eq(learnPlays.id, row.id)).run()
    }
  }

  // starts preparing the song after this one (peeks into the bag without advancing it), so that it is ready about one song later
  private prefetch(user: UserRow, pl: ReturnType<typeof getPlaylist>, order: 'shuffle' | 'ordered', bag: Bag) {
    const prep = this.opts.prep
    if (!prep) return
    // a new shuffle round is drawn at random: nothing to peek at
    if (order === 'shuffle' && !bag.ids.some((id) => pl.tracks.some((t) => t.id === id))) return
    try {
      const next = drawTrack(bag, pl.id, order, pl.tracks, () => 0).track
      if (skipFlags(this.deps.db, user.id, [next.id]).has(next.id)) return
      void prep.ensurePrepared(next.id, user.lang).catch(() => {})
    } catch {
      // nothing to prefetch
    }
  }

  // the intro text in the user's voice and language; null on any failure (no intro)
  private async makeIntro(user: UserRow, text: string): Promise<string | null> {
    const { tts } = this.deps
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const clip = tts.makeClip({
        text,
        voice: user.voice,
        lang: user.lang,
        chime: false,
        rate: user.speechRate,
        userId: user.id,
      })
      clip.catch(() => {})
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.opts.introTimeoutMs ?? INTRO_TIMEOUT_MS)
      })
      return await Promise.race([clip, timeout])
    } catch (e) {
      console.error('learn intro failed:', e instanceof Error ? e.message : e)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

export const introText = (t: { title: string; artist: string }) => (t.artist ? `${t.artist} — ${t.title}` : t.title)
