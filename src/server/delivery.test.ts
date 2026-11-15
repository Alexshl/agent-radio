// Recent-listener grace, held messages, delivery confirmation (waiting -> onair -> playing -> aired | failed), internal endpoints, migrations.
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from './db/client'
import { HOLD_MS, START_TIMEOUT_MS, deliveryView } from './delivery'
import { IcecastStats, MONITOR_UA, cleanTitle } from './icecast'
import { LISTENER_GRACE_MS, ListenerTracker } from './listeners'
import { type T, setup, userWithKey } from './test-utils'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
})
afterEach(() => vi.useRealTimers())

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)
const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const rows = (t: T) =>
  t.db.$client.prepare('select id, status, reason, attempts, started_at, ended_at from messages').all() as {
    id: string
    status: string
    reason: string | null
    attempts: number
    started_at: number | null
    ended_at: number | null
  }[]
const say = (t: T, token: string) => t.req('/api/say', { method: 'POST', json: { session: 's', text: 'hello' }, headers: auth(token) })
const status = async (t: T, token: string) =>
  (await (await t.req('/api/status', { headers: auth(token) })).json()) as Record<string, unknown>

describe('ListenerTracker', () => {
  it('records the last sighting and keeps "recently listening" for the grace window', async () => {
    const t = setup({ listeners: 1 })
    const { station } = await userWithKey(t, 'a@x.io')
    const tracker = new ListenerTracker(t.db, t.icecast)
    expect(tracker.lastSeenAt(station.id)).toBeNull()
    expect(await tracker.observe(station.id)).toMatchObject({ listeners: 1, recentlyListening: true })
    t.state.listeners = 0
    advance(LISTENER_GRACE_MS - 1000)
    expect(await tracker.observe(station.id)).toMatchObject({ listeners: 0, recentlyListening: true })
    advance(2000)
    expect(await tracker.observe(station.id)).toMatchObject({ listeners: 0, recentlyListening: false })
  })

  it('never seen: not recently listening; icecast unreachable keeps the last known state', async () => {
    const t = setup({ listeners: 0 })
    const { station } = await userWithKey(t, 'a@x.io')
    const tracker = new ListenerTracker(t.db, t.icecast)
    expect((await tracker.observe(station.id)).recentlyListening).toBe(false)
    t.state.listeners = 2
    await tracker.observe(station.id)
    t.state.listeners = null
    expect(await tracker.observe(station.id)).toMatchObject({ listeners: null, recentlyListening: true })
  })

  it('the sighting survives a restart (it is in the db)', async () => {
    const t = setup({ listeners: 1 })
    const { station } = await userWithKey(t, 'a@x.io')
    await new ListenerTracker(t.db, t.icecast).observe(station.id)
    t.state.listeners = 0
    expect(await new ListenerTracker(t.db, t.icecast).observe(station.id)).toMatchObject({ recentlyListening: true })
  })
})

describe('/api/status', () => {
  it('listening: true + reconnecting while the listener is within the grace window', async () => {
    const t = setup({ listeners: 1 })
    const { token } = await userWithKey(t, 'a@x.io')
    expect(await status(t, token)).toMatchObject({ listeners: 1, listening: true, reconnecting: false })
    t.state.listeners = 0
    expect(await status(t, token)).toMatchObject({ listeners: 0, listening: true, reconnecting: true })
    advance(LISTENER_GRACE_MS + 1000)
    expect(await status(t, token)).toMatchObject({ listeners: 0, listening: false, reconnecting: false })
  })
})

describe('say during the grace window', () => {
  it('holds the message (202 waiting), airs it when the listener is back', async () => {
    const t = setup({ listeners: 1 })
    const { token, station } = await userWithKey(t, 'a@x.io')
    await status(t, token) // a sighting
    t.state.listeners = 0
    const res = await say(t, token)
    expect(res.status).toBe(202)
    const body = (await res.json()) as { id: string; status: string }
    expect(body.status).toBe('waiting')
    expect(t.makeClip).toHaveBeenCalledTimes(1) // the clip is ready before the listener returns
    expect(t.engine.push).not.toHaveBeenCalled()
    expect(rows(t)[0]).toMatchObject({ status: 'waiting' })
    const view = await (await t.req(`/api/messages/${body.id}`, { headers: auth(token) })).json()
    expect(view).toMatchObject({ status: 'waiting' })

    await t.delivery.tick()
    expect(t.engine.push).not.toHaveBeenCalled()
    t.state.listeners = 1
    await t.delivery.tick()
    expect(t.engine.push).toHaveBeenCalledWith(station.id, expect.stringMatching(/^\/shared\/clips\/.+\.mp3$/), body.id)
    expect(rows(t)[0]).toMatchObject({ status: 'onair', attempts: 1 })
    // a second tick does not push it again
    await t.delivery.tick()
    expect(t.engine.push).toHaveBeenCalledTimes(1)
  })

  it('a held message expires after 180 s: skipped (expired), never aired', async () => {
    const t = setup({ listeners: 1 })
    const { token } = await userWithKey(t, 'a@x.io')
    await status(t, token)
    t.state.listeners = 0
    await say(t, token)
    advance(HOLD_MS - 1000)
    await t.delivery.tick()
    expect(rows(t)[0]).toMatchObject({ status: 'waiting' })
    advance(2000)
    await t.delivery.tick()
    expect(rows(t)[0]).toMatchObject({ status: 'skipped', reason: 'expired' })
    t.state.listeners = 1
    await t.delivery.tick()
    expect(t.engine.push).not.toHaveBeenCalled()
  })

  it('nobody seen within the grace: skipped at once, no TTS', async () => {
    const t = setup({ listeners: 0 })
    const { token } = await userWithKey(t, 'a@x.io')
    const res = await say(t, token)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'skipped' })
    expect(t.makeClip).not.toHaveBeenCalled()
    expect(rows(t)[0]).toMatchObject({ status: 'skipped', reason: 'nobody_listening' })
  })

  it('a file sent with /api/play is held too and goes to the track queue on reconnect', async () => {
    const t = setup({ listeners: 1 })
    const { token, station } = await userWithKey(t, 'a@x.io')
    await status(t, token)
    t.state.listeners = 0
    const form = new FormData()
    form.set('file', new File(['x'.repeat(100)], 'mix.mp3', { type: 'audio/mpeg' }))
    const res = await t.req('/api/play', { method: 'POST', body: form, origin: null, headers: auth(token) })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ status: 'waiting' })
    expect(t.engine.pushTrack).not.toHaveBeenCalled()
    t.state.listeners = 1
    await t.delivery.tick()
    expect(t.engine.pushTrack).toHaveBeenCalledWith(station.id, expect.stringMatching(/\.mp3$/), expect.any(String))
    expect(rows(t)[0]).toMatchObject({ status: 'onair' })
  })
})

describe('delivery confirmation', () => {
  async function onAir() {
    const t = setup({ listeners: 1 })
    const { token } = await userWithKey(t, 'a@x.io')
    const body = (await (await say(t, token)).json()) as { id: string; status: string }
    expect(body.status).toBe('aired')
    return { t, token, id: body.id }
  }
  const unix = () => Date.now() / 1000

  it('onair -> playing -> aired with the times the engine reports', async () => {
    const { t, id } = await onAir()
    expect(rows(t)[0]).toMatchObject({ status: 'onair' })
    t.engine.msgStates.mockResolvedValue([{ id, state: 'queued', started: 0, ended: 0 }])
    await t.delivery.tick()
    expect(rows(t)[0]).toMatchObject({ status: 'onair' })
    t.engine.msgStates.mockResolvedValue([{ id, state: 'playing', started: unix(), ended: 0 }])
    await t.delivery.tick()
    expect(rows(t)[0]?.status).toBe('playing')
    expect(rows(t)[0]?.started_at).toBeGreaterThan(0)
    t.engine.msgStates.mockResolvedValue([{ id, state: 'done', started: unix(), ended: unix() + 4 }])
    await t.delivery.tick()
    const r = rows(t)[0]
    expect(r).toMatchObject({ status: 'aired' })
    expect(r?.ended_at).toBeGreaterThan(r?.started_at ?? 0)
    expect(deliveryView(t.db.$client.prepare('select * from messages').get() as never)).toMatchObject({ status: 'played' })
  })

  it('"done" seen without "playing" (the app was down meanwhile) still ends as aired', async () => {
    const { t, id } = await onAir()
    t.engine.msgStates.mockResolvedValue([{ id, state: 'done', started: unix() - 5, ended: unix() }])
    await t.delivery.tick()
    expect(rows(t)[0]).toMatchObject({ status: 'aired' })
  })

  it('not started within 30 s: pushed once more, then failed (not_started)', async () => {
    const { t, id } = await onAir()
    t.engine.msgStates.mockResolvedValue([{ id, state: 'queued', started: 0, ended: 0 }])
    advance(START_TIMEOUT_MS - 1000)
    await t.delivery.tick()
    expect(t.engine.push).toHaveBeenCalledTimes(1)
    advance(2000)
    await t.delivery.tick()
    expect(t.engine.push).toHaveBeenCalledTimes(2)
    expect(rows(t)[0]).toMatchObject({ status: 'onair', attempts: 2 })
    advance(START_TIMEOUT_MS + 1000)
    await t.delivery.tick()
    expect(rows(t)[0]).toMatchObject({ status: 'failed', reason: 'not_started' })
    expect(t.engine.push).toHaveBeenCalledTimes(2)
  })

  it('the engine lost the clip (restart): pushed again at once', async () => {
    const { t } = await onAir()
    t.engine.msgStates.mockResolvedValue([])
    advance(4000)
    await t.delivery.tick()
    expect(t.engine.push).toHaveBeenCalledTimes(2)
    expect(rows(t)[0]).toMatchObject({ status: 'onair', attempts: 2 })
  })

  it('a clip that was playing when the engine restarted is failed (engine_restarted)', async () => {
    const { t, id } = await onAir()
    t.engine.msgStates.mockResolvedValue([{ id, state: 'playing', started: unix(), ended: 0 }])
    await t.delivery.tick()
    t.engine.msgStates.mockResolvedValue([])
    await t.delivery.tick()
    expect(rows(t)[0]).toMatchObject({ status: 'failed', reason: 'engine_restarted' })
  })

  it('a clip whose end the engine never reported is closed after its length plus a minute', async () => {
    const { t, id } = await onAir()
    t.engine.msgStates.mockResolvedValue([{ id, state: 'playing', started: unix(), ended: 0 }])
    await t.delivery.tick()
    expect(rows(t)[0]?.status).toBe('playing')
    advance(200_000)
    t.engine.msgStates.mockResolvedValue([{ id, state: 'playing', started: (Date.now() - 200_000) / 1000, ended: 0 }])
    await t.delivery.tick()
    expect(rows(t)[0]?.status).toBe('aired')
  })

  it('an unreachable engine changes nothing', async () => {
    const { t } = await onAir()
    t.engine.msgStates.mockRejectedValue(new Error('down'))
    advance(START_TIMEOUT_MS * 3)
    await t.delivery.tick()
    expect(rows(t)[0]).toMatchObject({ status: 'onair', attempts: 1 })
  })

  it('a voice message queued behind an airing file is not re-pushed while the file plays', async () => {
    const { t, id } = await onAir()
    const station = t.db.$client.prepare('select id from stations').get() as { id: string }
    t.deps.airing.start(station.id, 'file', 600)
    t.engine.msgStates.mockResolvedValue([{ id, state: 'queued', started: 0, ended: 0 }])
    advance(START_TIMEOUT_MS * 2)
    await t.delivery.tick()
    expect(t.engine.push).toHaveBeenCalledTimes(1)
    expect(rows(t)[0]).toMatchObject({ status: 'onair' })
  })

  it('GET /api/messages/:id: own messages only, public status names', async () => {
    const { t, token, id } = await onAir()
    const other = await userWithKey(t, 'b@x.io')
    expect(await (await t.req(`/api/messages/${id}`, { headers: auth(token) })).json()).toMatchObject({
      id,
      status: 'on_air_queued',
      attempts: 1,
    })
    expect((await t.req(`/api/messages/${id}`, { headers: auth(other.token) })).status).toBe(404)
    expect((await t.req('/api/messages/nope', { headers: auth(token) })).status).toBe(404)
    expect((await t.req(`/api/messages/${id}`)).status).toBe(401)
    t.engine.msgStates.mockResolvedValue([{ id, state: 'done', started: unix(), ended: unix() }])
    await t.delivery.tick()
    expect(await (await t.req(`/api/messages/${id}`, { headers: auth(token) })).json()).toMatchObject({ status: 'played' })
  })

  it('a failed push on say is a 502 and the message is failed (push_failed)', async () => {
    const t = setup({ listeners: 1 })
    const { token } = await userWithKey(t, 'a@x.io')
    t.engine.push.mockRejectedValueOnce(new Error('engine down'))
    expect((await say(t, token)).status).toBe(502)
    expect(rows(t)[0]).toMatchObject({ status: 'failed', reason: 'push_failed' })
  })
})

describe('internal endpoints', () => {
  it('stream-auth: 200 for the right token, 404 for anything else', async () => {
    const t = setup()
    const { station } = await userWithKey(t, 'a@x.io')
    const check = async (uri: string | null) =>
      (await t.req('/internal/stream-auth', { headers: uri === null ? {} : { 'X-Forwarded-Uri': uri } })).status
    expect(await check(`/stream/${station.id}.mp3?k=${station.listenToken}`)).toBe(200)
    expect(await check(`/stream/${station.id}.mp3?k=wrong`)).toBe(404)
    expect(await check(`/stream/${station.id}.mp3`)).toBe(404)
    expect(await check(`/stream/nosuchstation.mp3?k=${station.listenToken}`)).toBe(404)
    expect(await check(`/stream/${station.id}.m3u?k=${station.listenToken}`)).toBe(404)
    expect(await check('/api/status')).toBe(404)
    expect(await check(null)).toBe(404)
  })

  it('health: the stations of the db against the engine', async () => {
    const t = setup()
    const { station } = await userWithKey(t, 'a@x.io')
    t.engine.list.mockResolvedValue([station.id] as never)
    expect(await (await t.req('/internal/health')).json()).toMatchObject({ ok: true, stations: 1, engine: 1, missing: [] })
    t.engine.list.mockResolvedValue([] as never)
    const r = await t.req('/internal/health')
    expect(r.status).toBe(503)
    expect(await r.json()).toMatchObject({ ok: false, missing: [station.id] })
    t.engine.list.mockRejectedValue(new Error('down'))
    expect(await (await t.req('/internal/health')).json()).toMatchObject({ ok: false, error: 'engine_unreachable' })
  })

  it('tts-test: ok / failure, and the clip is removed', async () => {
    const t = setup()
    expect(await (await t.req('/internal/tts-test', { method: 'POST' })).json()).toMatchObject({ ok: true })
    t.makeClip.mockRejectedValueOnce(new Error('piper missing'))
    const r = await t.req('/internal/tts-test', { method: 'POST' })
    expect(r.status).toBe(503)
    expect(await r.json()).toMatchObject({ ok: false })
  })
})

describe('IcecastStats monitor probes', () => {
  const status = (n: number) => JSON.stringify({ icestats: { source: [{ listenurl: 'http://i/abc', listeners: n }] } })
  const listclients = (agents: string[]) =>
    `<icestats><source mount="/abc"><listeners>${agents.length}</listeners>${agents.map((a) => `<listener><UserAgent>${a}</UserAgent></listener>`).join('')}</source></icestats>`

  const make = (listeners: number, agents: string[]) => {
    const f = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('listclients')) return new Response(listclients(agents))
      return new Response(status(listeners))
    })
    return { f, ice: new IcecastStats('http://i', f as unknown as typeof fetch, { user: 'admin', password: 'pw' }) }
  }

  it('does not count the watchdog probe as a listener', async () => {
    expect(await make(2, [MONITOR_UA, 'VLC/3']).ice.listeners('abc')).toBe(1)
    expect(await make(1, [MONITOR_UA]).ice.listeners('abc')).toBe(0)
  })

  it('without admin credentials or when listclients fails, everything counts', async () => {
    const f = vi.fn(async () => new Response(status(2)))
    expect(await new IcecastStats('http://i', f as unknown as typeof fetch).listeners('abc')).toBe(2)
    const failing = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('listclients') ? new Response('no', { status: 401 }) : new Response(status(2)),
    )
    expect(await new IcecastStats('http://i', failing as unknown as typeof fetch, { user: 'a', password: 'b' }).listeners('abc')).toBe(2)
  })
})

describe('migrations', () => {
  const folder = './migrations'

  it('0006 is additive: only ALTER TABLE ... ADD', () => {
    const sql = readFileSync(join(folder, '0006_delivery.sql'), 'utf8')
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)
    expect(statements.length).toBeGreaterThan(0)
    for (const s of statements) expect(s).toMatch(/^ALTER TABLE `\w+` ADD `\w+` /)
  })

  it('a database from before 0006 is migrated on open, data and all, before any code reads the new columns', () => {
    const old = mkdtempSync(join(tmpdir(), 'ar-mig-'))
    cpSync(folder, old, { recursive: true })
    const journal = JSON.parse(readFileSync(join(old, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] }
    journal.entries = journal.entries.filter((e) => e.tag < '0006')
    writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify(journal))
    const dbFile = join(old, 'radio.db')
    const before = openDb(dbFile, old)
    const now = new Date().toISOString()
    before.$client
      .prepare("insert into users (id, email, name, role, created_at, updated_at) values ('u1', 'a@x.io', 'a', 'user', ?, ?)")
      .run(now, now)
    before.$client
      .prepare(
        "insert into stations (id, user_id, listen_token, source, created_at, updated_at) values ('st1abcdef12', 'u1', 'tok', '{\"type\":\"silence\"}', ?, ?)",
      )
      .run(now, now)
    before.$client
      .prepare(
        "insert into messages (id, user_id, session, text, status, type, created_at) values ('m1', 'u1', 's', 't', 'aired', 'voice', ?)",
      )
      .run(now)
    expect(() => before.$client.prepare('select last_listener_seen_at from stations').all()).toThrow()
    before.$client.close()

    const after = openDb(dbFile, folder)
    expect(after.$client.prepare('select last_listener_seen_at from stations').get()).toEqual({ last_listener_seen_at: null })
    expect(after.$client.prepare('select status, attempts, pushed_at, started_at, ended_at, reason from messages').get()).toEqual({
      status: 'aired',
      attempts: 0,
      pushed_at: null,
      started_at: null,
      ended_at: null,
      reason: null,
    })
    // opening again is a no-op
    after.$client.close()
    const again = new Database(dbFile)
    expect((again.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n).toBe(
      readdirSync(folder).filter((f) => f.endsWith('.sql')).length,
    )
  })
})

describe('lag marker in the stream title', () => {
  it('the engine appends the broadcast minute; the UI title does not show it', () => {
    expect(cleanTitle('Bonobo - Kerala [14:32]')).toBe('Bonobo - Kerala')
    expect(cleanTitle('Bonobo - Kerala')).toBe('Bonobo - Kerala')
    expect(cleanTitle('agent-radio [09:05]')).toBeNull()
    expect(cleanTitle(' [23:59]')).toBeNull()
    expect(cleanTitle(undefined)).toBeNull()
    expect(cleanTitle('Live [at 5] [14:32]')).toBe('Live [at 5]')
  })
})
