// Next / previous song: the app endpoints, the control (Shortcuts) endpoints, the engine client and a learn scheduler that meets a skipped song.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { learnPlays, stations, users } from './db/schema'
import { EngineClient, type EngineMsgState } from './engine/client'
import { LearnScheduler } from './learn/scheduler'
import { liveBus } from './live'
import { createPlaylist } from './playlists'
import { type T, addUser, login, setup } from './test-utils'

const setSource = (t: T, stationId: string, source: unknown) =>
  t.db
    .update(stations)
    .set({ source: JSON.stringify(source) })
    .where(eq(stations.id, stationId))
    .run()

async function withPlaylist(source: 'userplaylist' | 'folder' | 'relay' | 'silence' = 'userplaylist') {
  const t = setup()
  for (const n of ['a1.mp3', 'a2.mp3', 'a3.mp3']) writeFileSync(join(t.music, n), 'x')
  await t.library.scan()
  const { user, station } = await addUser(t, 'u@x.io')
  const cookie = await login(t, 'u@x.io')
  const pl = createPlaylist(t.db, user.id, {
    name: 'Mine',
    orderMode: 'ordered',
    trackIds: t.library.matching({}, 5).tracks.map((x) => x.id),
  })
  if (source === 'userplaylist') setSource(t, station.id, { type: 'userplaylist', playlistId: pl.id })
  if (source === 'folder') setSource(t, station.id, { type: 'playlist', dir: '', order: 'shuffle' })
  if (source === 'relay') setSource(t, station.id, { type: 'relay', url: 'https://r.example/s' })
  const key = await t.req('/api/app/control-token', { method: 'POST', cookie })
  const { secret: k } = (await key.json()) as { secret: string }
  return { t, user, station, cookie, k, pl }
}
const app = (t: T, cookie: string, dir: 'next' | 'previous') => t.req(`/api/app/station/${dir}`, { method: 'POST', cookie })
const ctl = (t: T, k: string, dir: 'next' | 'previous') => t.req(`/api/control/${dir}?k=${encodeURIComponent(k)}`, { method: 'POST' })

describe('POST /api/app/station/next and /previous', () => {
  it('need a session', async () => {
    const { t } = await withPlaylist()
    expect((await t.req('/api/app/station/next', { method: 'POST' })).status).toBe(401)
    expect((await t.req('/api/app/station/previous', { method: 'POST' })).status).toBe(401)
    expect(t.engine.skipMusic).not.toHaveBeenCalled()
  })

  it('next skips the music of the own playlist and of a folder', async () => {
    for (const kind of ['userplaylist', 'folder'] as const) {
      const { t, station, cookie } = await withPlaylist(kind)
      const res = await app(t, cookie, 'next')
      expect(res.status).toBe(200)
      expect(t.engine.skipMusic).toHaveBeenCalledWith(station.id)
    }
  })

  it('a relay and silence are 409 not_skippable, nothing reaches the engine', async () => {
    for (const kind of ['relay', 'silence'] as const) {
      const { t, cookie } = await withPlaylist(kind)
      for (const dir of ['next', 'previous'] as const) {
        const res = await app(t, cookie, dir)
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ error: 'not_skippable' })
      }
      expect(t.engine.skipMusic).not.toHaveBeenCalled()
      expect(t.engine.previousMusic).not.toHaveBeenCalled()
    }
  })

  it('previous with fewer than two songs in the history is 409 no_history', async () => {
    const { t, station, cookie } = await withPlaylist()
    t.engine.musicHistory.mockResolvedValue(['/music/a1.mp3'])
    const res = await app(t, cookie, 'previous')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'no_history' })
    expect(t.engine.previousMusic).not.toHaveBeenCalled()
    // the engine itself may have lost the history meanwhile
    t.engine.musicHistory.mockResolvedValue(['/music/a1.mp3', '/music/a2.mp3'])
    t.engine.previousMusic.mockResolvedValue(false)
    expect((await app(t, cookie, 'previous')).status).toBe(409)
    t.engine.previousMusic.mockResolvedValue(true)
    expect((await app(t, cookie, 'previous')).status).toBe(200)
    expect(t.engine.previousMusic).toHaveBeenLastCalledWith(station.id)
  })

  it('an engine failure is 503 and the page is told to refresh on success only', async () => {
    const { t, user, cookie } = await withPlaylist()
    const topics: string[] = []
    const off = liveBus.subscribe(user.id, (topic) => topics.push(topic))
    t.engine.skipMusic.mockRejectedValueOnce(new Error('down'))
    expect((await app(t, cookie, 'next')).status).toBe(503)
    expect(topics).toEqual([])
    expect((await app(t, cookie, 'next')).status).toBe(200)
    expect(topics.sort()).toEqual(['live', 'station'])
    off?.()
  })
})

describe('POST /api/control/next and /previous', () => {
  it('answers in plain text in the language of the user', async () => {
    const { t, user, k } = await withPlaylist()
    t.engine.musicHistory.mockResolvedValue(['/music/a1.mp3', '/music/a2.mp3'])
    t.db.update(users).set({ lang: 'en' }).where(eq(users.id, user.id)).run()
    const next = await ctl(t, k, 'next')
    expect(next.status).toBe(200)
    expect(next.headers.get('content-type')).toContain('text/plain')
    expect(await next.text()).toBe('Skipping the track')
    expect(await (await ctl(t, k, 'previous')).text()).toBe('Playing the previous track')
    t.db.update(users).set({ lang: 'uk' }).where(eq(users.id, user.id)).run()
    expect(await (await ctl(t, k, 'next')).text()).toBe('Пропускаю трек')
  })

  it('needs a valid token', async () => {
    const { t } = await withPlaylist()
    expect((await t.req('/api/control/next', { method: 'POST' })).status).toBe(401)
    expect((await ctl(t, 'arc_wrong', 'next')).status).toBe(401)
    expect(t.engine.skipMusic).not.toHaveBeenCalled()
  })

  it('a relay is 409 with a text, an empty history is 409 with a text', async () => {
    const r = await withPlaylist('relay')
    const res = await ctl(r.t, r.k, 'next')
    expect(res.status).toBe(409)
    expect(await res.text()).toBe('Зараз грає не музика — пропускати нічого')
    const p = await withPlaylist()
    const none = await ctl(p.t, p.k, 'previous')
    expect(none.status).toBe(409)
    expect(await none.text()).toBe('Попереднього треку ще немає')
  })

  it('is part of the rate limit and listed in the shortcut menu', async () => {
    const { t, k } = await withPlaylist()
    const items = (await (await t.req(`/api/control/sources?k=${k}`)).json()) as { title: string; url: string; method: string }[]
    expect(items.find((i) => i.url === `http://radio.test/api/control/next?k=${k}`)).toMatchObject({
      method: 'POST',
      title: 'Наступний трек',
    })
    expect(items.find((i) => i.url === `http://radio.test/api/control/previous?k=${k}`)).toMatchObject({ method: 'POST' })
    for (let i = 0; i < 29; i++) expect((await ctl(t, k, 'next')).status).toBe(200)
    expect((await ctl(t, k, 'next')).status).toBe(429)
  })
})

describe('EngineClient music skip / previous / history', () => {
  it('calls the engine endpoints', async () => {
    const calls: { url: string; method: string; body: unknown }[] = []
    const f = (async (url: string, init: { method: string; body?: string }) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
      const json = url.includes('previous')
        ? { ok: true, done: true }
        : url.includes('history')
          ? { ok: true, files: ['/music/a.mp3'] }
          : { ok: true }
      return new Response(JSON.stringify(json))
    }) as unknown as typeof fetch
    const c = new EngineClient('http://engine', f)
    await c.skipMusic('s1')
    expect(await c.previousMusic('s1')).toBe(true)
    expect(await c.musicHistory('s 1')).toEqual(['/music/a.mp3'])
    expect(calls).toEqual([
      { url: 'http://engine/music/skip', method: 'POST', body: { id: 's1' } },
      { url: 'http://engine/music/previous', method: 'POST', body: { id: 's1' } },
      { url: 'http://engine/music/history?id=s%201', method: 'GET', body: undefined },
    ])
  })
})

describe('learn scheduler and a skipped song', () => {
  it('a song skipped while it plays is "done" and the next song is queued', async () => {
    const { t, user } = await withPlaylist()
    t.db.update(users).set({ learnMode: 1, learnEvery: 1 }).where(eq(users.id, user.id)).run()
    const states = new Map<string, EngineMsgState>()
    t.engine.msgStates.mockImplementation(async () => [...states.values()])
    t.engine.pushMusic.mockImplementation(async (_s, _p, msg) => {
      states.set(msg, { id: msg, state: 'queued', started: 0, ended: 0 })
    })
    const s = new LearnScheduler(t.deps)
    await s.tick()
    const pushed = () => t.engine.pushMusic.mock.calls.map((c) => c[2] as string)
    expect(pushed()).toHaveLength(1)
    const first = pushed()[0] as string
    const now = Date.now() / 1000
    states.set(first, { id: first, state: 'playing', started: now, ended: 0 })
    await s.tick()
    expect(pushed()).toHaveLength(2)
    // "next" pressed: the engine reports the playing song as done after 2 s, the queued one starts
    const second = pushed()[1] as string
    states.set(first, { id: first, state: 'done', started: now, ended: now + 2 })
    states.set(second, { id: second, state: 'playing', started: now + 2, ended: 0 })
    await s.tick()
    const rows = t.db.select().from(learnPlays).all()
    expect(rows.find((r) => r.trackMsg === first)).toMatchObject({ status: 'done' })
    expect(rows.find((r) => r.trackMsg === second)).toMatchObject({ status: 'playing' })
    // exactly one song ahead again
    expect(pushed()).toHaveLength(3)
  })
})
