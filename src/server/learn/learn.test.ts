// Learn mode (phase 1): the scheduler (bag, every-N, intro, recovery), the engine source spec, the settings and the skip flag.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { learnPlays, stations, users } from '../db/schema'
import type { EngineMsgState } from '../engine/client'
import { createPlaylist } from '../playlists'
import { engineSpec, parseSource } from '../stations'
import { type T, addUser, login, setup, userWithKey } from '../test-utils'
import { introActive } from './plays'
import { LearnScheduler, drawTrack } from './scheduler'

const NAMES = ['a1.mp3', 'a2.mp3', 'a3.mp3', 'a4.mp3']

async function ready(opts: { order?: 'shuffle' | 'ordered'; every?: number; on?: boolean; env?: Record<string, string> } = {}) {
  const t = setup(opts.env ? { env: opts.env } : {})
  for (const n of NAMES) writeFileSync(join(t.music, n), 'x')
  await t.library.scan()
  const { user, station } = await addUser(t, 'u@x.io')
  const trackIds = t.library.matching({}, 10).tracks.map((x) => x.id)
  const pl = createPlaylist(t.db, user.id, { name: 'Mine', orderMode: opts.order ?? 'shuffle', trackIds })
  t.db
    .update(stations)
    .set({ source: JSON.stringify({ type: 'userplaylist', playlistId: pl.id }) })
    .where(eq(stations.id, station.id))
    .run()
  t.db
    .update(users)
    .set({ learnMode: opts.on === false ? 0 : 1, learnEvery: opts.every ?? 1 })
    .where(eq(users.id, user.id))
    .run()
  return { t, user, station, pl, trackIds }
}

// a fake engine clock: states are what the "engine" reports
function world(t: T) {
  const states = new Map<string, EngineMsgState>()
  t.engine.msgStates.mockImplementation(async () => [...states.values()])
  let now = 1_800_000_000_000
  const set = (id: string, state: EngineMsgState['state']) =>
    states.set(id, { id, state, started: state === 'queued' ? 0 : now / 1000, ended: state === 'done' ? now / 1000 : 0 })
  // like the engine: a pushed message is "queued"
  t.engine.pushMusic.mockImplementation(async (_s, _p, msg) => {
    set(msg, 'queued')
  })
  return { states, set, advance: (ms: number) => (now += ms), clock: () => now }
}

// notes are ready for every song: only then there is an intro
const READY = {
  getNotes: () => ({ pairs: null, summary: 's', introText: 'Intro from the notes', hooks: [] as string[] }),
  ensurePrepared: async () => 'ready' as const,
}
const pushed = (t: T) => t.engine.pushMusic.mock.calls.map((c) => ({ path: c[1] as string, msg: c[2] as string, opts: c[3] as unknown }))
const trackPushes = (t: T) => pushed(t).filter((p) => p.msg.endsWith('-t'))
const introPushes = (t: T) => pushed(t).filter((p) => p.msg.endsWith('-i'))
const lastTrackMsg = (t: T) => trackPushes(t).at(-1)?.msg as string
const lastSpec = (t: T) => (t.engine.setSource.mock.calls.at(-1) as unknown as [string, unknown])[1]
const rowsOf = (t: T) => t.db.select().from(learnPlays).all()

// plays the song that was queued last to the end and lets the scheduler queue the next one
async function playThrough(t: T, w: ReturnType<typeof world>, s: LearnScheduler) {
  w.advance(1000)
  const msg = lastTrackMsg(t)
  const intro = msg.replace(/-t$/, '-i')
  if (w.states.has(intro)) w.set(intro, 'done')
  w.set(msg, 'playing')
  await s.tick()
  w.set(msg, 'done')
  w.advance(1000)
  await s.tick()
}

describe('drawTrack', () => {
  const tr = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, path: `p${i}`, title: `T${i}`, artist: 'A' }))
  it('a round plays every track once, the next round does not start with the last track', () => {
    const tracks = tr(5)
    let bag = null as ReturnType<typeof drawTrack>['bag'] | null
    const seen: string[] = []
    for (let i = 0; i < 10; i++) {
      const d = drawTrack(bag, 'pl', 'shuffle', tracks, Math.random)
      seen.push(d.track.id)
      bag = d.bag
    }
    expect(new Set(seen.slice(0, 5)).size).toBe(5)
    expect(new Set(seen.slice(5)).size).toBe(5)
    expect(seen[5]).not.toBe(seen[4])
  })
  it('a track removed from the playlist leaves the bag, a different playlist starts a new bag', () => {
    const first = drawTrack(null, 'pl', 'shuffle', tr(4), Math.random)
    const rest = tr(4).filter((t) => t.id !== 't0' && t.id !== first.track.id)
    const next = drawTrack(first.bag, 'pl', 'shuffle', rest, Math.random)
    expect(rest.map((r) => r.id)).toContain(next.track.id)
    const other = drawTrack(first.bag, 'other', 'shuffle', tr(4), Math.random)
    expect(other.bag.ids.length).toBe(3)
  })
})

describe('LearnScheduler', () => {
  it('queues one song ahead; the next is queued only when it reaches "playing"', async () => {
    const { t } = await ready()
    const w = world(t)
    const s = new LearnScheduler(t.deps, { now: w.clock, prep: READY })
    await s.tick()
    expect(trackPushes(t)).toHaveLength(1)
    // intro first, then the song
    expect(pushed(t).map((p) => p.msg.slice(-1))).toEqual(['i', 't'])
    await s.tick()
    await s.tick()
    expect(trackPushes(t)).toHaveLength(1)
    w.set(lastTrackMsg(t), 'playing')
    await s.tick()
    expect(rowsOf(t)[0]?.status).toBe('playing')
    expect(trackPushes(t)).toHaveLength(2)
    expect(
      rowsOf(t)
        .map((r) => r.status)
        .sort(),
    ).toEqual(['playing', 'pushed'])
  })

  it('the song path is the engine path of the library file; the intro is levelled to the voice', async () => {
    const { t, station } = await ready()
    t.db.update(stations).set({ voiceGainDb: 3, musicGainDb: -5 }).where(eq(stations.id, station.id)).run()
    const w = world(t)
    await new LearnScheduler(t.deps, { now: w.clock, prep: READY }).tick()
    expect(trackPushes(t)[0]?.path).toMatch(/^\/music\/a\d\.mp3$/)
    expect(introPushes(t)[0]?.opts).toMatchObject({ amplifyDb: 8, title: expect.stringContaining('Artist') })
    expect(t.makeClip).toHaveBeenCalledWith(expect.objectContaining({ chime: false, lang: 'uk' }))
  })

  it('nobody listening: the song is queued without an intro and no clip is made', async () => {
    const { t } = await ready()
    const w = world(t)
    const listeners = { observe: async () => ({ listeners: 0 }) } as unknown as NonNullable<(typeof t.deps)['listeners']>
    await new LearnScheduler({ ...t.deps, listeners }, { now: w.clock, prep: READY }).tick()
    expect(trackPushes(t)).toHaveLength(1)
    expect(introPushes(t)).toHaveLength(0)
    expect(t.makeClip).not.toHaveBeenCalled()
  })

  it('the shuffle bag survives an app restart: a round has no repeats', async () => {
    const { t } = await ready()
    const w = world(t)
    let s = new LearnScheduler(t.deps, { now: w.clock, prep: READY })
    await s.tick()
    await playThrough(t, w, s)
    // "restart": a new scheduler, the bag comes from the db
    s = new LearnScheduler(t.deps, { now: w.clock, prep: READY })
    await playThrough(t, w, s)
    await playThrough(t, w, s)
    const order = rowsOf(t)
      .sort((a, b) => a.plannedAt - b.plannedAt || a.id.localeCompare(b.id))
      .map((r) => r.trackId)
    expect(order.length).toBeGreaterThanOrEqual(4)
    expect(new Set(order.slice(0, 4)).size).toBe(4)
  })

  it('ordered mode follows the playlist order and wraps around', async () => {
    const { t, trackIds } = await ready({ order: 'ordered' })
    const w = world(t)
    const s = new LearnScheduler(t.deps, { now: w.clock, prep: READY })
    await s.tick()
    for (let i = 0; i < 4; i++) await playThrough(t, w, s)
    const planned = [...rowsOf(t)].sort((a, b) => a.plannedAt - b.plannedAt)
    expect(planned.length).toBeGreaterThanOrEqual(5)
    const ids = planned.slice(0, 5).map((r) => r.trackId)
    expect(ids).toEqual([...trackIds, trackIds[0]])
  })

  it('"every 2nd": an intro before the 1st, 3rd, ... song', async () => {
    const { t } = await ready({ every: 2 })
    const w = world(t)
    const s = new LearnScheduler(t.deps, { now: w.clock, prep: READY })
    await s.tick()
    for (let i = 0; i < 3; i++) await playThrough(t, w, s)
    expect(trackPushes(t)).toHaveLength(4)
    expect(introPushes(t)).toHaveLength(2)
    const withIntro = rowsOf(t)
      .sort((a, b) => a.plannedAt - b.plannedAt || a.id.localeCompare(b.id))
      .map((r) => !!r.introMsg)
    expect(withIntro.slice(0, 4)).toEqual([true, false, true, false])
  })

  it('a song the user flagged has no intro and is not counted', async () => {
    const { t, user, trackIds } = await ready({ order: 'ordered', every: 2 })
    t.db.$client
      .prepare("insert into learn_song_prefs (user_id, track_id, skip, created_at) values (?, ?, 1, '2026-01-01')")
      .run(user.id, trackIds[1])
    const w = world(t)
    const s = new LearnScheduler(t.deps, { now: w.clock, prep: READY })
    await s.tick()
    for (let i = 0; i < 3; i++) await playThrough(t, w, s)
    const rows = [...rowsOf(t)].sort((a, b) => a.plannedAt - b.plannedAt || a.id.localeCompare(b.id))
    // song 1 (intro, counter 0), song 2 flagged (none, not counted), song 3 (counter 1: none), song 4 (counter 2: intro)
    expect(rows.slice(0, 4).map((r) => !!r.introMsg)).toEqual([true, false, false, true])
    expect(t.db.select().from(stations).get()?.learnCounter).toBeGreaterThanOrEqual(3)
  })

  it('an intro that cannot be made (error or too slow) still queues the song', async () => {
    const a = await ready()
    a.t.makeClip.mockRejectedValueOnce(new Error('tts down'))
    const wa = world(a.t)
    await new LearnScheduler(a.t.deps, { now: wa.clock, prep: READY }).tick()
    expect(introPushes(a.t)).toHaveLength(0)
    expect(trackPushes(a.t)).toHaveLength(1)
    expect(rowsOf(a.t)[0]).toMatchObject({ introMsg: null, status: 'pushed' })

    const b = await ready()
    b.t.makeClip.mockImplementationOnce(() => new Promise<string>(() => {}))
    const wb = world(b.t)
    await new LearnScheduler(b.t.deps, { now: wb.clock, prep: READY, introTimeoutMs: 20 }).tick()
    expect(introPushes(b.t)).toHaveLength(0)
    expect(trackPushes(b.t)).toHaveLength(1)

    // the engine refuses the intro only: the song is still queued
    const c = await ready()
    const wc = world(c.t)
    c.t.engine.pushMusic.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    await new LearnScheduler(c.t.deps, { now: wc.clock, prep: READY }).tick()
    expect(trackPushes(c.t)).toHaveLength(1)
    expect(rowsOf(c.t)[0]).toMatchObject({ introMsg: null, status: 'pushed' })
  })

  it('engine restart: a queued song the engine forgot is queued again (with its intro)', async () => {
    const { t } = await ready()
    const w = world(t)
    const s = new LearnScheduler(t.deps, { now: w.clock, prep: READY })
    await s.tick()
    const first = rowsOf(t)[0]
    expect(first?.status).toBe('pushed')
    // the engine restarted: no states
    w.states.clear()
    w.advance(5000)
    await s.tick()
    const rows = rowsOf(t)
    expect(rows.find((r) => r.id === first?.id)).toMatchObject({ status: 'lost', retried: 1 })
    const again = rows.find((r) => r.id !== first?.id)
    expect(again).toMatchObject({ status: 'pushed', attempt: 2, trackId: first?.trackId })
    expect(again?.introMsg).toBeTruthy()
    expect(trackPushes(t)).toHaveLength(2)
    expect(introPushes(t)).toHaveLength(2)
    // the bag did not advance because of the retry: still one song drawn
    const bag = JSON.parse(t.db.select().from(stations).get()?.learnBag ?? '{}') as { ids: string[] }
    expect(bag.ids).toHaveLength(3)
  })

  it('engine restart in the middle of a song: it is not repeated, the next one is queued', async () => {
    const { t } = await ready()
    const w = world(t)
    const s = new LearnScheduler(t.deps, { now: w.clock, prep: READY })
    await s.tick()
    w.set(lastTrackMsg(t), 'playing')
    await s.tick()
    // the next song is queued while this one plays
    expect(trackPushes(t)).toHaveLength(2)
    w.states.clear()
    w.advance(5000)
    await s.tick()
    const rows = rowsOf(t)
    expect(rows.filter((r) => r.status === 'lost')).toHaveLength(2)
    // the song that never started is queued again, the one that played is not
    expect(trackPushes(t).length).toBe(3)
  })

  it('the engine is down: nothing changes; a refused push is retried on the next pass', async () => {
    const { t } = await ready()
    const w = world(t)
    const s = new LearnScheduler(t.deps, { now: w.clock, prep: READY })
    t.engine.msgStates.mockRejectedValueOnce(new Error('down'))
    await s.tick()
    expect(rowsOf(t)).toHaveLength(0)
    const push = t.engine.pushMusic.getMockImplementation()
    t.engine.pushMusic.mockImplementation(async () => {
      throw new Error('refused')
    })
    await s.tick()
    expect(rowsOf(t)[0]).toMatchObject({ status: 'lost', retried: 0 })
    // no second song is drawn while the lost one waits
    await s.tick()
    expect(rowsOf(t).filter((r) => r.status !== 'lost')).toHaveLength(0)
    t.engine.pushMusic.mockImplementation(push as never)
    await s.tick()
    expect(rowsOf(t).filter((r) => r.status === 'pushed')).toHaveLength(1)
  })

  it('learn mode off or the source no longer a playlist: the queue is flushed and nothing is queued', async () => {
    const { t, user, station } = await ready()
    const w = world(t)
    const s = new LearnScheduler(t.deps, { now: w.clock, prep: READY })
    await s.tick()
    t.db
      .update(stations)
      .set({ source: JSON.stringify({ type: 'silence' }) })
      .where(eq(stations.id, station.id))
      .run()
    await s.tick()
    expect(t.engine.flushMusic).toHaveBeenCalledWith(station.id)
    expect(rowsOf(t).every((r) => r.status === 'lost')).toBe(true)
    const n = trackPushes(t).length
    t.db.update(users).set({ learnMode: 0 }).where(eq(users.id, user.id)).run()
    await s.tick()
    expect(trackPushes(t)).toHaveLength(n)
  })

  it('the intro is reported as on air while the engine plays it', async () => {
    const { t, station } = await ready()
    world(t)
    const s = new LearnScheduler(t.deps, { prep: READY })
    await s.tick()
    const row = rowsOf(t)[0]
    // the engine says the intro plays
    t.engine.msgStates.mockImplementation(async () => [
      { id: row?.introMsg as string, state: 'playing', started: Date.now() / 1000, ended: 0 },
      { id: row?.trackMsg as string, state: 'queued', started: 0, ended: 0 },
    ])
    await s.tick()
    expect(introActive(t.db, station.id)).toBe(true)
  })
})

describe('engineSpec', () => {
  it('learn off: the queue type with nothing pushed; learn on: the same spec (the app starts queueing songs)', async () => {
    const { t, user, station } = await ready({ on: false, order: 'ordered' })
    const st = () => t.db.select().from(stations).where(eq(stations.id, station.id)).get() as typeof station
    const off = engineSpec(t.db, t.config, st())
    expect(off).toEqual({ type: 'queue', path: `${t.config.engineSharedDir}/playlists/${station.id}.m3u`, mode: 'normal' })
    // with learn off the app pushes nothing: the queue stays empty and the list plays as a plain playlist
    await new LearnScheduler(t.deps, { prep: READY }).tick()
    expect(t.engine.pushMusic).not.toHaveBeenCalled()
    t.db.update(users).set({ learnMode: 1 }).where(eq(users.id, user.id)).run()
    expect(engineSpec(t.db, t.config, st())).toEqual(off)
    // other sources are not touched by the flag
    t.db
      .update(stations)
      .set({ source: JSON.stringify({ type: 'silence' }) })
      .where(eq(stations.id, station.id))
      .run()
    expect(engineSpec(t.db, t.config, st())).toEqual({ type: 'silence' })
    expect(parseSource(st().source).type).toBe('silence')
  })
})

describe('settings and /api/app/learn', () => {
  const patch = (t: T, cookie: string, json: unknown) => t.req('/api/app/settings', { cookie, method: 'PATCH', json })
  const radio = async (t: T, cookie: string) => (await (await t.req('/api/app/radio', { cookie })).json()) as { learn: unknown }

  it('learn is refused without a playlist source, then switched on and off with the engine following', async () => {
    const t = setup()
    for (const n of NAMES) writeFileSync(join(t.music, n), 'x')
    await t.library.scan()
    const { user } = await addUser(t, 'u@x.io')
    const cookie = await login(t, 'u@x.io')
    expect(await radio(t, cookie)).toMatchObject({ learn: { mode: false, every: 1, available: false } })
    const denied = await patch(t, cookie, { learnMode: true })
    expect(denied.status).toBe(400)
    expect(await denied.json()).toMatchObject({ error: 'learn_unavailable' })

    const pl = createPlaylist(t.db, user.id, {
      name: 'P',
      orderMode: 'shuffle',
      trackIds: t.library.matching({}, 5).tracks.map((x) => x.id),
    })
    expect(
      (await t.req('/api/app/station/source', { cookie, method: 'PUT', json: { type: 'userplaylist', playlistId: pl.id } })).status,
    ).toBe(200)
    expect(
      (await t.req('/api/app/station/source', { cookie, method: 'PUT', json: { type: 'userplaylist', playlistId: pl.id } })).status,
    ).toBe(200)
    expect(lastSpec(t)).toMatchObject({ type: 'queue' })
    expect(await radio(t, cookie)).toMatchObject({ learn: { mode: false, available: true } })

    expect((await patch(t, cookie, { learnMode: true, learnEvery: 3 })).status).toBe(200)
    expect(lastSpec(t)).toMatchObject({ type: 'queue', mode: 'randomize' })
    expect(t.db.select().from(users).get()).toMatchObject({ learnMode: 1, learnEvery: 3 })
    expect(await radio(t, cookie)).toMatchObject({ learn: { mode: true, every: 3, available: true } })
    const me = (await (await t.req('/api/auth/me', { cookie })).json()) as { learn: unknown }
    expect(me.learn).toMatchObject({ mode: true, every: 3 })

    t.engine.flushMusic.mockClear()
    expect((await patch(t, cookie, { learnMode: false })).status).toBe(200)
    expect(lastSpec(t)).toMatchObject({ type: 'queue' })
    expect(t.engine.flushMusic).toHaveBeenCalled()
    expect(t.db.select().from(users).get()).toMatchObject({ learnMode: 0, learnEvery: 3 })
  })

  it('a bad frequency is refused; an engine error reverts the switch', async () => {
    const t = setup()
    for (const n of NAMES) writeFileSync(join(t.music, n), 'x')
    await t.library.scan()
    const { user } = await addUser(t, 'u@x.io')
    const cookie = await login(t, 'u@x.io')
    expect((await patch(t, cookie, { learnEvery: 4 })).status).toBe(400)
    expect((await patch(t, cookie, { learnEvery: 0 })).status).toBe(400)
    const pl = createPlaylist(t.db, user.id, {
      name: 'P',
      orderMode: 'shuffle',
      trackIds: t.library.matching({}, 5).tracks.map((x) => x.id),
    })
    await t.req('/api/app/station/source', { cookie, method: 'PUT', json: { type: 'userplaylist', playlistId: pl.id } })
    t.engine.setSource.mockRejectedValueOnce(new Error('down'))
    expect((await patch(t, cookie, { learnMode: true })).status).toBe(503)
    expect(t.db.select().from(users).get()?.learnMode).toBe(0)
  })

  it('the "I know this song" flag: set, cleared, only for library tracks, per user', async () => {
    const t = setup()
    for (const n of NAMES) writeFileSync(join(t.music, n), 'x')
    await t.library.scan()
    const { user } = await addUser(t, 'u@x.io')
    await addUser(t, 'o@x.io')
    const cookie = await login(t, 'u@x.io')
    const other = await login(t, 'o@x.io')
    const id = t.library.matching({}, 5).tracks[0]?.id as string
    const put = (c: string, tid: string, skip: unknown) =>
      t.req(`/api/app/learn/songs/${tid}/skip`, { cookie: c, method: 'PUT', json: { skip } })
    expect((await put(cookie, id, true)).status).toBe(200)
    const flags = () =>
      t.db.$client.prepare('select user_id, skip from learn_song_prefs where track_id = ?').all(id) as { user_id: string; skip: number }[]
    expect(flags()).toEqual([{ user_id: user.id, skip: 1 }])
    expect((await put(cookie, id, false)).status).toBe(200)
    expect(flags()).toEqual([{ user_id: user.id, skip: 0 }])
    expect((await put(other, id, true)).status).toBe(200)
    expect(flags()).toHaveLength(2)
    expect((await put(cookie, 'nope', true)).status).toBe(404)
    expect((await put(cookie, id, 'yes')).status).toBe(400)
    expect((await t.req(`/api/app/learn/songs/${id}/skip`, { method: 'PUT', json: { skip: true } })).status).toBe(401)
  })
})

describe('delivery while an intro plays', () => {
  it('a spoken message is held until the intro is over', async () => {
    const t = setup({ listeners: 1 })
    const { station, token } = await userWithKey(t, 'k@x.io')
    const say = () =>
      t.req('/api/say', { method: 'POST', json: { session: 's', text: 'hi' }, headers: { Authorization: `Bearer ${token}` } })
    t.db
      .insert(learnPlays)
      .values({
        id: 'p1',
        userId: station.userId,
        stationId: station.id,
        trackId: 'x',
        status: 'intro',
        trackMsg: 'learn-p1-t',
        introMsg: 'learn-p1-i',
        plannedAt: Date.now(),
        startedAt: Date.now(),
      })
      .run()
    const held = await say()
    expect(held.status).toBe(202)
    expect(await held.json()).toMatchObject({ status: 'waiting' })
    expect(t.engine.push).not.toHaveBeenCalled()
    t.db.update(learnPlays).set({ status: 'playing' }).where(eq(learnPlays.id, 'p1')).run()
    await t.delivery.tick()
    expect(t.engine.push).toHaveBeenCalledTimes(1)
  })

  it('a stale intro record does not block messages', async () => {
    const t = setup({ listeners: 1 })
    const { station, token } = await userWithKey(t, 'k@x.io')
    t.db
      .insert(learnPlays)
      .values({
        id: 'p1',
        userId: station.userId,
        stationId: station.id,
        trackId: 'x',
        status: 'intro',
        trackMsg: 'a',
        plannedAt: 0,
        startedAt: Date.now() - 10 * 60_000,
      })
      .run()
    const r = await t.req('/api/say', { method: 'POST', json: { session: 's', text: 'hi' }, headers: { Authorization: `Bearer ${token}` } })
    expect(r.status).toBe(200)
    expect(t.engine.push).toHaveBeenCalledTimes(1)
  })
})

describe('LearnScheduler with prepared notes', () => {
  const notes = (introText: string | null) => ({ pairs: null, summary: 's', introText, hooks: [] as string[] })

  it('speaks intro_script when the notes are ready; no notes yet = no intro at all', async () => {
    const { t } = await ready()
    const w = world(t)
    const prep = { getNotes: vi.fn(() => notes('Spoken intro from the model')), ensurePrepared: vi.fn(async () => 'ready' as const) }
    await new LearnScheduler(t.deps, { now: w.clock, prep }).tick()
    expect(t.makeClip).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Spoken intro from the model' }))
    expect(introPushes(t)).toHaveLength(1)

    const t2 = (await ready()).t
    const w2 = world(t2)
    const none = { getNotes: vi.fn(() => null), ensurePrepared: vi.fn(async () => 'error' as const) }
    await new LearnScheduler(t2.deps, { now: w2.clock, prep: none }).tick()
    expect(t2.makeClip).not.toHaveBeenCalled()
    expect(introPushes(t2)).toHaveLength(0)
    expect(trackPushes(t2)).toHaveLength(1)
  })

  it('starts preparing the next candidate of the bag without advancing it', async () => {
    const { t, station } = await ready({ order: 'ordered' })
    const w = world(t)
    const prep = { getNotes: vi.fn(() => null), ensurePrepared: vi.fn(async () => 'ready' as const) }
    await new LearnScheduler(t.deps, { now: w.clock, prep }).tick()
    const first = rowsOf(t)[0]?.trackId
    expect(prep.ensurePrepared).toHaveBeenCalledTimes(1)
    const [nextId, lang] = prep.ensurePrepared.mock.calls[0] as unknown as [string, string]
    expect(nextId).not.toBe(first)
    expect(lang).toBe('uk')
    // the cursor moved by one song only: the prefetched track is the one queued next
    const bag = JSON.parse(t.db.select().from(stations).where(eq(stations.id, station.id)).get()?.learnBag ?? '{}')
    expect(bag.cursor).toBe(1)
    w.set(lastTrackMsg(t), 'playing')
    await new LearnScheduler(t.deps, { now: w.clock, prep }).tick()
    expect(rowsOf(t).at(-1)?.trackId === nextId || rowsOf(t).some((r) => r.trackId === nextId)).toBe(true)
  })

  it('the skip flag still wins over the prepared intro', async () => {
    const { t, user, trackIds } = await ready({ order: 'ordered' })
    const { setSkip } = await import('./plays')
    for (const id of trackIds) setSkip(t.db, user.id, id, true)
    const w = world(t)
    const prep = { getNotes: vi.fn(() => notes('Spoken')), ensurePrepared: vi.fn(async () => 'ready' as const) }
    await new LearnScheduler(t.deps, { now: w.clock, prep }).tick()
    expect(introPushes(t)).toHaveLength(0)
    expect(trackPushes(t)).toHaveLength(1)
    expect(prep.ensurePrepared).not.toHaveBeenCalled()
  })
})
