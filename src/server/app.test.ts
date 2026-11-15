import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app'
import { loadConfig } from './config'
import { openDb } from './db/client'
import type { EngineApi, EngineMsgState } from './engine/client'
import type { IcecastApi } from './icecast'
import { createApiKey, revokeApiKey } from './lib/api-keys'
import { RateLimiter } from './lib/rate-limit'
import { createUser } from './stations'

function setup(opts: { listeners?: number | null; rate?: number; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ar-test-'))
  const config = loadConfig({
    SHARED_DIR: dir,
    DATA_DIR: dir,
    PUBLIC_URL: 'http://radio.test',
    ICECAST_URL: 'http://icecast.test',
    ...opts.env,
  })
  const db = openDb(':memory:')
  const engine = {
    list: vi.fn(async () => []),
    add: vi.fn(async () => {}),
    setSource: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
    pushTrack: vi.fn(async () => {}),
    pushMusic: vi.fn(async () => {}),
    flushMusic: vi.fn(async () => {}),
    musicQueue: vi.fn(async () => 0),
    setDuck: vi.fn(async () => {}),
    setLevels: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    msgStates: vi.fn(async (): Promise<EngineMsgState[]> => []),
  } satisfies EngineApi
  const listeners = vi.fn(async (_id: string) => (opts.listeners === undefined ? 1 : opts.listeners))
  const icecast: IcecastApi = { listeners, isUp: async () => true }
  const makeClip = vi.fn(async () => {
    const f = join(dir, 'clip.mp3')
    writeFileSync(f, 'x')
    return f
  })
  const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    void init
    return new Response('AUDIO-BYTES', { headers: { 'content-type': 'audio/mpeg' } })
  })
  const app = createApp({
    db,
    config,
    engine,
    icecast,
    tts: { makeClip },
    limiter: new RateLimiter(opts.rate ?? 10),
    fetchStream: upstream as unknown as typeof fetch,
  })
  return { app, db, engine, listeners, makeClip, upstream, config }
}

async function userWithKey(db: ReturnType<typeof openDb>, email: string) {
  const { user, station } = createUser(db, { email })
  const { token, key } = await createApiKey(db, { userId: user.id, name: 't' })
  return { user, station, token, key }
}

const say = (app: ReturnType<typeof setup>['app'], token: string | null, body: unknown = { session: 's1', host: 'h', text: 'Привіт' }) =>
  app.request('/api/say', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

describe('api key auth', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  it('rejects missing, malformed and unknown keys', async () => {
    expect((await say(t.app, null)).status).toBe(401)
    expect((await say(t.app, 'nope')).status).toBe(401)
    expect((await say(t.app, 'ar_unknownunknownunknown')).status).toBe(401)
    const r = await t.app.request('/api/status', { headers: { Authorization: 'Basic abc' } })
    expect(r.status).toBe(401)
    expect(r.headers.get('WWW-Authenticate')).toBe('Bearer')
  })

  it('accepts a valid key and stores only its hash', async () => {
    const { token, key } = await userWithKey(t.db, 'a@x.io')
    expect((await t.app.request('/api/status', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
    expect(token.startsWith('ar_')).toBe(true)
    expect(key.prefix).toBe(token.slice(0, 11))
    const row = t.db.$client.prepare('select token_hash from api_keys').get() as { token_hash: string }
    expect(row.token_hash).not.toContain(token)
    expect(row.token_hash).toHaveLength(64)
  })

  it('rejects a revoked key', async () => {
    const { token, key } = await userWithKey(t.db, 'a@x.io')
    expect(revokeApiKey(t.db, key.id)).toBe(true)
    expect((await say(t.app, token)).status).toBe(401)
  })

  it('sets Referrer-Policy: no-referrer', async () => {
    expect((await t.app.request('/healthz')).headers.get('Referrer-Policy')).toBe('no-referrer')
  })
})

describe('POST /api/say', () => {
  it('skips without TTS when nobody listens', async () => {
    const t = setup({ listeners: 0 })
    const { token } = await userWithKey(t.db, 'a@x.io')
    const r = await say(t.app, token)
    expect(await r.json()).toMatchObject({ status: 'skipped' })
    expect(t.makeClip).not.toHaveBeenCalled()
    expect(t.engine.push).not.toHaveBeenCalled()
    const m = t.db.$client.prepare('select status from messages').all()
    expect(m).toEqual([{ status: 'skipped' }])
  })

  it('synthesizes and pushes the clip when someone listens', async () => {
    const t = setup({ listeners: 2 })
    const { token, station } = await userWithKey(t.db, 'a@x.io')
    const r = await say(t.app, token)
    expect(await r.json()).toMatchObject({ status: 'aired', listeners: 2 })
    expect(t.makeClip).toHaveBeenCalledOnce()
    expect(t.engine.push).toHaveBeenCalledWith(station.id, '/shared/clips/clip.mp3', expect.any(String))
  })

  it('202 queued when the speech is slow; airs when ready and somebody still listens', async () => {
    const t = setup({ listeners: 2, env: { SAY_SYNC_WAIT_MS: '20' } })
    const { token, station } = await userWithKey(t.db, 'a@x.io')
    let finish: (f: string) => void = () => {}
    t.makeClip.mockImplementationOnce(() => new Promise<string>((r) => (finish = r)))
    const r = await say(t.app, token)
    expect(r.status).toBe(202)
    expect(await r.json()).toMatchObject({ status: 'queued', listeners: 2 })
    expect(t.db.$client.prepare('select status from messages').all()).toEqual([{ status: 'queued' }])
    expect(t.engine.push).not.toHaveBeenCalled()
    finish('/shared/clips/slow.mp3')
    await vi.waitFor(() => expect(t.db.$client.prepare('select status from messages').all()).toEqual([{ status: 'onair' }]))
    expect(t.engine.push).toHaveBeenCalledWith(station.id, '/shared/clips/slow.mp3', expect.any(String))
  })

  it('a queued message is held when the listeners left meanwhile (within the grace), failed when the speech fails', async () => {
    const t = setup({ listeners: 1, env: { SAY_SYNC_WAIT_MS: '20' } })
    const { token } = await userWithKey(t.db, 'a@x.io')
    let finish: (f: string) => void = () => {}
    t.makeClip.mockImplementationOnce(() => new Promise<string>((r) => (finish = r)))
    expect((await say(t.app, token)).status).toBe(202)
    t.listeners.mockImplementation(async () => 0)
    finish('/shared/clips/late.mp3')
    await vi.waitFor(() => expect(t.db.$client.prepare('select status from messages').all()).toEqual([{ status: 'waiting' }]))
    expect(t.engine.push).not.toHaveBeenCalled()

    t.listeners.mockImplementation(async () => 1)
    let fail: (e: Error) => void = () => {}
    t.makeClip.mockImplementationOnce(() => new Promise<string>((_r, rej) => (fail = rej)))
    expect((await say(t.app, token)).status).toBe(202)
    fail(new Error('boom'))
    await vi.waitFor(() =>
      expect(t.db.$client.prepare('select status from messages order by created_at desc limit 1').all()).toEqual([{ status: 'failed' }]),
    )
  })

  it('answers 503 when icecast is unreachable', async () => {
    const t = setup({ listeners: null })
    const { token } = await userWithKey(t.db, 'a@x.io')
    expect((await say(t.app, token)).status).toBe(503)
  })

  it('records a failed message when TTS breaks', async () => {
    const t = setup()
    const { token } = await userWithKey(t.db, 'a@x.io')
    t.makeClip.mockRejectedValueOnce(new Error('boom'))
    expect((await say(t.app, token)).status).toBe(502)
    expect(t.db.$client.prepare('select status from messages').all()).toEqual([{ status: 'failed' }])
  })

  it('validates the body (text <= 2000, session required)', async () => {
    const t = setup()
    const { token } = await userWithKey(t.db, 'a@x.io')
    // text longer than 2000 characters is cut with an ellipsis, not refused
    expect((await say(t.app, token, { session: 's', text: 'x'.repeat(2001) })).status).toBe(200)
    const spoken = (t.makeClip.mock.calls.at(-1) as unknown as [{ text: string }])[0].text
    expect(spoken.endsWith('…')).toBe(true)
    expect(spoken.length).toBeLessThanOrEqual(2000 + 'Сесія s. '.length)
    expect((await say(t.app, token, { text: 'hi' })).status).toBe(400)
    expect((await say(t.app, token, { session: 's', text: '   ' })).status).toBe(400)
  })

  it('rate-limits per key', async () => {
    const t = setup({ listeners: 0, rate: 3 })
    const a = await userWithKey(t.db, 'a@x.io')
    const b = await userWithKey(t.db, 'b@x.io')
    for (let i = 0; i < 3; i++) expect((await say(t.app, a.token)).status).toBe(200)
    const r = await say(t.app, a.token)
    expect(r.status).toBe(429)
    expect(r.headers.get('Retry-After')).toBeTruthy()
    // another key has its own budget
    expect((await say(t.app, b.token)).status).toBe(200)
  })
})

describe('user isolation', () => {
  it("a key only reaches its own user's station", async () => {
    const t = setup({ listeners: 1 })
    const a = await userWithKey(t.db, 'a@x.io')
    const b = await userWithKey(t.db, 'b@x.io')
    await say(t.app, a.token)
    expect(t.listeners).toHaveBeenLastCalledWith(a.station.id)
    expect(t.engine.push).toHaveBeenLastCalledWith(a.station.id, expect.any(String), expect.any(String))
    await say(t.app, b.token)
    expect(t.listeners).toHaveBeenLastCalledWith(b.station.id)
    expect(t.engine.push).toHaveBeenLastCalledWith(b.station.id, expect.any(String), expect.any(String))
    expect(t.engine.push.mock.calls.map((x: unknown[]) => x[0])).toEqual([a.station.id, b.station.id])
    const r = await t.app.request('/api/status', { headers: { Authorization: `Bearer ${a.token}` } })
    const body = (await r.json()) as { station: { id: string } }
    expect(body.station.id).toBe(a.station.id)
    expect(body.station.id).not.toBe(b.station.id)
  })

  it('cannot address another station by id in the request', async () => {
    const t = setup({ listeners: 1 })
    const a = await userWithKey(t.db, 'a@x.io')
    const b = await userWithKey(t.db, 'b@x.io')
    await say(t.app, a.token, { session: 's', text: 'hi', stationId: b.station.id, userId: b.user.id })
    expect(t.engine.push).toHaveBeenCalledTimes(1)
    expect(t.engine.push).toHaveBeenCalledWith(a.station.id, expect.any(String), expect.any(String))
  })

  it("changing A's source touches only A's station", async () => {
    const t = setup()
    const a = await userWithKey(t.db, 'a@x.io')
    const b = await userWithKey(t.db, 'b@x.io')
    const r = await t.app.request('/api/station/source', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ type: 'relay', url: 'https://example.com/stream.mp3' }),
    })
    expect(r.status).toBe(200)
    // the engine gets the app's internal relay address, never the user's URL
    const [id, spec] = t.engine.setSource.mock.calls[0] as unknown as [string, { type: string; url: string }]
    expect(id).toBe(a.station.id)
    expect(spec.type).toBe('relay')
    expect(spec.url).toMatch(/^http:\/\/app:8792\/relay\/[0-9a-f]{40}\//)
    expect(spec.url).not.toContain('example.com')
    expect(t.engine.setSource).not.toHaveBeenCalledWith(b.station.id, expect.anything())
  })
})

describe('GET /stream', () => {
  it('404 for a wrong, missing or foreign token and for unknown stations', async () => {
    const t = setup()
    const a = await userWithKey(t.db, 'a@x.io')
    const b = await userWithKey(t.db, 'b@x.io')
    expect((await t.app.request(`/stream/${a.station.id}.mp3?k=wrong`)).status).toBe(404)
    expect((await t.app.request(`/stream/${a.station.id}.mp3`)).status).toBe(404)
    expect((await t.app.request(`/stream/${a.station.id}.mp3?k=${b.station.listenToken}`)).status).toBe(404)
    expect((await t.app.request(`/stream/doesnotexist1.mp3?k=${a.station.listenToken}`)).status).toBe(404)
    expect((await t.app.request(`/stream/${a.station.id}.m3u?k=wrong`)).status).toBe(404)
    expect(t.upstream).not.toHaveBeenCalled()
  })

  it('proxies the icecast mount with the right token', async () => {
    const t = setup()
    const a = await userWithKey(t.db, 'a@x.io')
    const r = await t.app.request(`/stream/${a.station.id}.mp3?k=${a.station.listenToken}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('Content-Type')).toBe('audio/mpeg')
    expect(r.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(await r.text()).toBe('AUDIO-BYTES')
    expect(t.upstream.mock.calls[0]?.[0]).toBe(`http://icecast.test/${a.station.id}`)
  })

  it('serves an m3u pointing at the stream URL', async () => {
    const t = setup()
    const a = await userWithKey(t.db, 'a@x.io')
    const r = await t.app.request(`/stream/${a.station.id}.m3u?k=${a.station.listenToken}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('Content-Type')).toContain('mpegurl')
    expect(await r.text()).toContain(`http://radio.test/stream/${a.station.id}.mp3?k=${a.station.listenToken}`)
  })
})
