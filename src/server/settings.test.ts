import { describe, expect, it } from 'vitest'
import { SUMMARY_LANGS } from './lang'
import { addUser, login, setup, userWithKey } from './test-utils'

describe('source policy', () => {
  it('"allow own URLs" off: users may use presets only, admins anything', async () => {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    await addUser(t, 'u@x.io')
    const admin = await login(t, 'admin@x.io')
    const user = await login(t, 'u@x.io')
    t.db.$client
      .prepare("insert into presets (id, name, description, url, position) values ('p1', 'Soma', '', 'https://ice1.somafm.com/x', 0)")
      .run()
    const put = (cookie: string, url: string) => t.req('/api/app/station/source', { cookie, method: 'PUT', json: { type: 'relay', url } })
    expect((await put(user, 'https://radio.example.com/live.mp3')).status).toBe(200)
    await t.req('/api/admin/settings', { cookie: admin, method: 'PUT', json: { allowOwnUrls: false } })
    const denied = await put(user, 'https://radio.example.com/live.mp3')
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: 'own_urls_disabled' })
    expect((await put(user, 'https://ice1.somafm.com/x')).status).toBe(200)
    expect((await put(admin, 'https://radio.example.com/live.mp3')).status).toBe(200)
    const radio = (await (await t.req('/api/app/radio', { cookie: user })).json()) as { allowOwnUrls: boolean }
    expect(radio.allowOwnUrls).toBe(false)
  })

  it('the API key route follows the same policy', async () => {
    const t = setup()
    const { token } = await userWithKey(t, 'k@x.io')
    t.db.$client.prepare("insert into settings (key, value) values ('allowOwnUrls', 'false')").run()
    const r = await t.req('/api/station/source', {
      method: 'PUT',
      origin: null,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'relay', url: 'https://x.example.com/a.mp3' }),
    })
    expect(r.status).toBe(403)
  })

  it('refuses stream URLs that point into the internal network', async () => {
    const t = setup()
    await addUser(t, 'u@x.io')
    const user = await login(t, 'u@x.io')
    for (const url of [
      'http://localhost:8000/x',
      'http://127.0.0.1/x',
      'http://icecast:8000/admin',
      'http://10.0.0.5/x',
      'http://192.168.1.2/x',
      'http://169.254.169.254/latest',
      'http://[::1]/x',
    ]) {
      const r = await t.req('/api/app/station/source', { cookie: user, method: 'PUT', json: { type: 'relay', url } })
      expect(r.status, url).toBe(400)
    }
    expect(t.engine.setSource).not.toHaveBeenCalled()
  })
})

describe('user settings', () => {
  it('stores language, voice, session switch and chime; /api/status returns them for the agent', async () => {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    const admin = await login(t, 'admin@x.io')
    await t.req('/api/admin/tts/providers/openai', { method: 'PUT', cookie: admin, json: { key: 'sk-1' } })
    const { token } = await userWithKey(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const res = await t.req('/api/app/settings', {
      cookie,
      method: 'PATCH',
      json: { lang: 'en', voice: 'openai:alloy', speakSession: false, chime: false },
    })
    expect(res.status).toBe(200)
    const st = (await (await t.req('/api/status', { headers: { Authorization: `Bearer ${token}` } })).json()) as Record<string, unknown>
    expect(st).toMatchObject({ lang: 'en', voice: 'openai:alloy', speakSession: false, chime: false })
  })

  it('accepts each of the 8 summary languages, returns it in /api/status and rejects an unknown one', async () => {
    const t = setup()
    const { token } = await userWithKey(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    for (const lang of SUMMARY_LANGS) {
      const res = await t.req('/api/app/settings', { cookie, method: 'PATCH', json: { lang } })
      expect(res.status).toBe(200)
      const st = (await (await t.req('/api/status', { headers: { Authorization: `Bearer ${token}` } })).json()) as Record<string, unknown>
      expect(st).toMatchObject({ lang })
    }
    const bad = await t.req('/api/app/settings', { cookie, method: 'PATCH', json: { lang: 'xx' } })
    expect(bad.status).toBe(400)
    expect((await t.req('/api/app/pronunciations/preview', { cookie, method: 'POST', json: { text: 'x', lang: 'xx' } })).status).toBe(400)
  })

  it('only voices the admin enabled can be chosen', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const r = await t.req('/api/app/settings', { cookie, method: 'PATCH', json: { voice: 'openai:alloy' } })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'voice_unavailable' })
    expect((await t.req('/api/app/settings', { cookie, method: 'PATCH', json: { voice: 'piper:uk_UA-mykyta-high' } })).status).toBe(200)
  })

  it('the duck level is applied to the engine and stored', async () => {
    const t = setup()
    const { station } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    expect((await t.req('/api/app/settings', { cookie, method: 'PATCH', json: { duckDb: 22 } })).status).toBe(200)
    expect(t.engine.setDuck).toHaveBeenCalledWith(station.id, 22)
    t.engine.setDuck.mockRejectedValueOnce(new Error('down'))
    expect((await t.req('/api/app/settings', { cookie, method: 'PATCH', json: { duckDb: 5 } })).status).toBe(503)
    expect((t.db.$client.prepare('select duck_db from stations').get() as { duck_db: number }).duck_db).toBe(22)
  })

  it('mix levels: ranges are validated, applied live to the engine, stored and shown in /api/status', async () => {
    const t = setup()
    const { token } = await userWithKey(t, 'a@x.io')
    const { station } = await addUser(t, 'b@x.io')
    expect(station.musicGainDb).toBe(0)
    const cookie = await login(t, 'a@x.io')
    const patch = (json: unknown) => t.req('/api/app/settings', { cookie, method: 'PATCH', json })
    for (const bad of [
      { musicGainDb: -31 },
      { musicGainDb: 7 },
      { voiceGainDb: 13 },
      { voiceGainDb: -13 },
      { trackGainDb: 7 },
      { trackGainDb: -13 },
      { musicGainDb: 'x' },
    ])
      expect((await patch(bad)).status).toBe(400)
    expect(t.engine.setLevels).not.toHaveBeenCalled()
    expect((await patch({ musicGainDb: -8, voiceGainDb: 4 })).status).toBe(200)
    expect(t.engine.setLevels).toHaveBeenCalledWith(expect.any(String), { musicDb: -8, voiceDb: 4, trackDb: undefined })
    expect((await patch({ musicGainDb: -30, voiceGainDb: 12, trackGainDb: -12 })).status).toBe(200)
    t.engine.setLevels.mockRejectedValueOnce(new Error('down'))
    expect((await patch({ musicGainDb: 0 })).status).toBe(503)
    const st = (await (await t.req('/api/status', { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      station: Record<string, number>
    }
    expect(st.station).toMatchObject({ musicGainDb: -30, voiceGainDb: 12, trackGainDb: -12, duckDb: 14 })
  })

  it('speech rate: range validated, stored per user, shown in /api/status; admin default for new users', async () => {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    const admin = await login(t, 'admin@x.io')
    const { token } = await userWithKey(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const patch = (json: unknown) => t.req('/api/app/settings', { cookie, method: 'PATCH', json })
    expect((await patch({ speechRate: 0.7 })).status).toBe(400)
    expect((await patch({ speechRate: 1.7 })).status).toBe(400)
    expect((await patch({ speechRate: 1.25 })).status).toBe(200)
    const status = async () =>
      (await (await t.req('/api/status', { headers: { Authorization: `Bearer ${token}` } })).json()) as { speechRate: number }
    expect((await status()).speechRate).toBe(1.25)
    expect((await t.req('/api/admin/settings', { cookie: admin, method: 'PUT', json: { defaultSpeechRate: 2 } })).status).toBe(400)
    expect((await t.req('/api/admin/settings', { cookie: admin, method: 'PUT', json: { defaultSpeechRate: 1.15 } })).status).toBe(200)
    await addUser(t, 'new@x.io')
    expect(
      (t.db.$client.prepare("select speech_rate from users where email = 'new@x.io'").get() as { speech_rate: number }).speech_rate,
    ).toBe(1.15)
  })

  it('admin defaults for music / voice level go to new stations', async () => {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    const admin = await login(t, 'admin@x.io')
    const put = (json: unknown) => t.req('/api/admin/settings', { cookie: admin, method: 'PUT', json })
    expect((await put({ defaultMusicGainDb: -40 })).status).toBe(400)
    expect((await put({ defaultVoiceGainDb: 20 })).status).toBe(400)
    expect((await put({ defaultMusicGainDb: -6, defaultVoiceGainDb: 3 })).status).toBe(200)
    expect(await (await t.req('/api/admin/settings', { cookie: admin })).json()).toMatchObject({
      defaultMusicGainDb: -6,
      defaultVoiceGainDb: 3,
    })
    const { station } = await addUser(t, 'new@x.io')
    expect(station).toMatchObject({ musicGainDb: -6, voiceGainDb: 3, trackGainDb: 0 })
  })

  it('regenerating the link changes the listen token: the old stream URL stops working', async () => {
    const t = setup()
    const { station } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const before = await t.req(`/stream/${station.id}.m3u?k=${station.listenToken}`)
    expect(before.status).toBe(200)
    const r = (await (await t.req('/api/app/station/regenerate', { cookie, method: 'POST' })).json()) as { listenUrl: string }
    expect(r.listenUrl).not.toContain(station.listenToken)
    expect((await t.req(`/stream/${station.id}.m3u?k=${station.listenToken}`)).status).toBe(404)
  })

  it('"send test to air": skipped with nobody listening, aired otherwise, with the user voice', async () => {
    const t = setup({ listeners: 0 })
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    expect(await (await t.req('/api/app/test', { cookie, method: 'POST' })).json()).toMatchObject({ status: 'skipped' })
    t.state.listeners = 1
    expect(await (await t.req('/api/app/test', { cookie, method: 'POST' })).json()).toMatchObject({ status: 'aired' })
    expect(t.engine.push).toHaveBeenCalledTimes(1)
  })

  it('the per-user hourly message limit is enforced', async () => {
    const t = setup({ listeners: 0 })
    const { token } = await userWithKey(t, 'a@x.io')
    t.db.$client.prepare("insert into settings (key, value) values ('messageLimitPerHour', '2')").run()
    const say = () =>
      t.req('/api/say', {
        method: 'POST',
        origin: null,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: 's', text: 'hi' }),
      })
    expect((await say()).status).toBe(200)
    expect((await say()).status).toBe(200)
    expect((await say()).status).toBe(429)
  })
})

describe('presets', () => {
  it('admin CRUD, users only see the list', async () => {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    await addUser(t, 'u@x.io')
    const admin = await login(t, 'admin@x.io')
    const user = await login(t, 'u@x.io')
    const created = await t.req('/api/admin/presets', {
      cookie: admin,
      method: 'POST',
      json: { name: 'Lounge', description: 'd', url: 'https://lounge.example/a.mp3' },
    })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    expect(
      (await t.req('/api/admin/presets', { cookie: user, method: 'POST', json: { name: 'x', url: 'https://x.example/a' } })).status,
    ).toBe(403)
    expect(
      (
        await t.req(`/api/admin/presets/${id}`, {
          cookie: admin,
          method: 'PUT',
          json: { name: 'Lounge 2', description: '', url: 'https://lounge.example/b.mp3' },
        })
      ).status,
    ).toBe(200)
    const radio = (await (await t.req('/api/app/radio', { cookie: user })).json()) as { presets: { name: string }[] }
    expect(radio.presets.map((p) => p.name)).toEqual(['Lounge 2'])
    expect((await t.req(`/api/admin/presets/${id}`, { cookie: admin, method: 'DELETE' })).status).toBe(200)
    expect((await t.req('/api/admin/presets', { cookie: admin })).status).toBe(200)
  })

  it('reachability check: ok / down / blocked, through the safe client', async () => {
    const { checkReachable } = await import('./routes/admin')
    const { fakeResolver } = await import('./test-utils')
    const { Readable } = await import('node:stream')
    const reply = (status: number) => async () => ({ status, headers: {}, body: Readable.from([]), destroy() {} })
    expect(await checkReachable('https://a.example/s', { resolver: fakeResolver, transport: reply(200) })).toMatchObject({ status: 'ok' })
    expect(await checkReachable('https://a.example/s', { resolver: fakeResolver, transport: reply(404) })).toMatchObject({ status: 'down' })
    expect(
      await checkReachable('https://a.example/s', {
        resolver: fakeResolver,
        transport: async () => {
          throw new Error('refused')
        },
      }),
    ).toEqual({ status: 'down', ms: null })
    expect(await checkReachable('http://localhost/s', { resolver: fakeResolver, transport: reply(200) })).toEqual({
      status: 'blocked',
      ms: null,
    })
  })
})

describe('admin server tab', () => {
  it('status, engine restart and a database backup download', async () => {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    const cookie = await login(t, 'admin@x.io')
    const s = (await (await t.req('/api/admin/server', { cookie })).json()) as { engine: { up: boolean }; messagesToday: number }
    expect(s.engine.up).toBe(true)
    expect((await t.req('/api/admin/engine/restart', { cookie, method: 'POST' })).status).toBe(200)
    expect(t.engine.restart).toHaveBeenCalled()
    t.engine.restart.mockRejectedValueOnce(new Error('x'))
    expect((await t.req('/api/admin/engine/restart', { cookie, method: 'POST' })).status).toBe(503)
    const b = await t.req('/api/admin/backup', { cookie })
    expect(b.status).toBe(200)
    expect(b.headers.get('Content-Disposition')).toMatch(/attachment/)
    expect((await b.arrayBuffer()).byteLength).toBeGreaterThan(1000)
  })
})
