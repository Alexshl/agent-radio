import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config'
import { openDb } from './db/client'
import { UserLock } from './lib/user-lock'
import { type HopResponse, type Transport, assertPublicUrl, isPublicAddress, safeGet } from './lib/safe-fetch'
import { FfmpegMedia, INPUT_FORMATS } from './media'
import { cleanup } from './retention'
import { engineToken, relayRoutes, relayUrlFor } from './routes/relay'
import { createUser, setStationSource, syncEngine, withStationLock } from './stations'
import { PASSWORD, addUser, fakeResolver, login, setup, userWithKey } from './test-utils'
import type { T } from './test-utils'

const reply = (status: number, headers: Record<string, string> = {}, body: string[] = []): HopResponse => ({
  status,
  headers,
  body: Readable.from(body.map((x) => Buffer.from(x))),
  destroy() {},
})

describe('SSRF: address checks', () => {
  it('rejects every bypass form', async () => {
    const bad = [
      'http://evil.com\\@icecast:8000/x', // backslash: parsers disagree about the host
      'http://icecast./', // trailing dot
      'http://localhost./',
      'http://[::ffff:127.0.0.1]/', // IPv4-mapped loopback
      'http://[::ffff:a00:1]/', // IPv4-mapped 10.0.0.1
      'http://[64:ff9b::7f00:1]/', // NAT64 of 127.0.0.1
      'http://[::7f00:1]/', // IPv4-compatible
      'http://[fec0::1]/', // site-local
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[fd00::1]/',
      'http://[2002:7f00:1::]/', // 6to4 of 127.0.0.1
      'http://[2001::1]/', // teredo
      'http://127.0.0.1/',
      'http://2130706433/', // decimal 127.0.0.1
      'http://0x7f.0.0.1/',
      'http://0/',
      'http://10.1.2.3/',
      'http://172.16.0.1/',
      'http://192.168.0.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://100.64.0.1/', // carrier-grade NAT
      'http://224.0.0.1/',
      'http://rebind.example/', // DNS name that resolves to 127.0.0.1
      'http://mixed.example/', // one public and one private answer: all must be public
      'http://icecast:8000/admin', // docker service name -> private address
      'http://user:pass@example.com/',
      'http://exa mple.com/',
      'http://example.com/a\tb',
      'ftp://example.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://nothing.invalid/', // does not resolve
      '',
    ]
    for (const url of bad) await expect(assertPublicUrl(url, fakeResolver), url).rejects.toMatchObject({ code: 'invalid_url' })
  })

  it('accepts public hosts and normalises the URL', async () => {
    const ok = await assertPublicUrl('https://Radio.Example.com:8443/stream.mp3?x=1', fakeResolver)
    expect(ok.url.href).toBe('https://radio.example.com:8443/stream.mp3?x=1')
    await expect(assertPublicUrl('http://93.184.216.34/live', fakeResolver)).resolves.toBeTruthy()
    await expect(assertPublicUrl('http://[2606:4700::1111]/live', fakeResolver)).resolves.toBeTruthy()
  })

  it('isPublicAddress: only public unicast', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('2606:4700::1111')).toBe(true)
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true)
    for (const a of ['127.0.0.1', '::ffff:127.0.0.1', '::', '::1', '0.0.0.0', '255.255.255.255', 'garbage', '2001:db8::1'])
      expect(isPublicAddress(a), a).toBe(false)
  })
})

describe('SSRF: safeGet', () => {
  it('connects to the address that was checked (pinned), with the original host name', async () => {
    const calls: { host: string; pinned: string }[] = []
    const transport: Transport = async (url, pinned) => {
      calls.push({ host: url.hostname, pinned: pinned.address })
      return reply(200)
    }
    await safeGet('https://radio.example.com/s', { resolver: fakeResolver, transport })
    expect(calls).toEqual([{ host: 'radio.example.com', pinned: '93.184.216.34' }])
  })

  it('follows redirects by hand and checks every hop', async () => {
    const hops: string[] = []
    const transport: Transport = async (url) => {
      hops.push(url.href)
      if (url.hostname === 'a.example') return reply(302, { location: 'http://10.0.0.5/secret' })
      return reply(200)
    }
    await expect(safeGet('http://a.example/x', { resolver: fakeResolver, transport })).rejects.toMatchObject({ code: 'invalid_url' })
    expect(hops).toEqual(['http://a.example/x']) // the private hop was never requested
    // to a name that resolves to loopback
    const t2: Transport = async () => reply(301, { location: 'http://rebind.example/' })
    await expect(safeGet('http://a.example/x', { resolver: fakeResolver, transport: t2 })).rejects.toMatchObject({ code: 'invalid_url' })
    // a relative redirect to a good place works
    let n = 0
    const t3: Transport = async (url) => (n++ === 0 ? reply(307, { location: '/live.mp3' }) : reply(200, { 'x-final': url.pathname }))
    const res = await safeGet('http://a.example/x', { resolver: fakeResolver, transport: t3 })
    expect(res.headers['x-final']).toBe('/live.mp3')
  })

  it('stops after 3 redirects', async () => {
    const transport: Transport = async () => reply(302, { location: 'http://a.example/again' })
    await expect(safeGet('http://a.example/', { resolver: fakeResolver, transport })).rejects.toMatchObject({ code: 'too_many_redirects' })
  })

  it('a DNS answer that changes between the check and the connection cannot matter: the pinned address comes from the one check', async () => {
    let lookups = 0
    const resolver = vi.fn(async () => {
      lookups++
      return lookups === 1 ? [{ address: '93.184.216.34', family: 4 as const }] : [{ address: '127.0.0.1', family: 4 as const }]
    })
    const seen: string[] = []
    const transport: Transport = async (_u, pinned) => {
      seen.push(pinned.address)
      return reply(200)
    }
    await safeGet('http://flip.example/', { resolver, transport })
    expect(seen).toEqual(['93.184.216.34'])
    expect(resolver).toHaveBeenCalledTimes(1)
  })
})

describe('SSRF: where the URL is used', () => {
  it('source change: loopback, internal names and redirect-style tricks are refused for users and admins alike', async () => {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    await addUser(t, 'u@x.io')
    const admin = await login(t, 'admin@x.io')
    const user = await login(t, 'u@x.io')
    for (const cookie of [user, admin]) {
      for (const url of ['http://rebind.example/x', 'http://icecast./', 'http://[::ffff:a00:1]/', 'http://evil.com\\@icecast:8000/x']) {
        const r = await t.req('/api/app/station/source', { cookie, method: 'PUT', json: { type: 'relay', url } })
        expect(r.status, url).toBe(400)
      }
    }
    expect(t.engine.setSource).not.toHaveBeenCalled()
  })

  it('check-url: ok / blocked / down only, honours allowOwnUrls, rate-limited', async () => {
    const calls: string[] = []
    const t = setup({
      transport: async (url) => {
        calls.push(url.hostname)
        return url.hostname === 'down.example' ? reply(503) : reply(200)
      },
    })
    await addUser(t, 'u@x.io')
    const cookie = await login(t, 'u@x.io')
    const check = async (url: string) => (await t.req('/api/app/check-url', { cookie, method: 'POST', json: { url } })).json()
    expect(await check('https://good.example/live')).toEqual({ status: 'ok' })
    expect(await check('https://down.example/live')).toEqual({ status: 'down' })
    expect(await check('http://localhost/x')).toEqual({ status: 'blocked' })
    expect(await check('http://[::ffff:7f00:1]/x')).toEqual({ status: 'blocked' })
    expect(calls).not.toContain('localhost')
    t.db.$client.prepare("insert into settings (key, value) values ('allowOwnUrls', 'false')").run()
    const denied = await t.req('/api/app/check-url', { cookie, method: 'POST', json: { url: 'https://good.example/live' } })
    expect(denied.status).toBe(403)
    t.db.$client.prepare("delete from settings where key = 'allowOwnUrls'").run()
    let last = 200
    for (let i = 0; i < 10; i++)
      last = (await t.req('/api/app/check-url', { cookie, method: 'POST', json: { url: 'https://good.example/live' } })).status
    expect(last).toBe(429)
  })

  it('admin preset URLs must be well-formed external URLs', async () => {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    const cookie = await login(t, 'admin@x.io')
    const add = (url: string) => t.req('/api/admin/presets', { cookie, method: 'POST', json: { name: 'x', url } })
    expect((await add('https://ok.example/live')).status).toBe(201)
    expect((await add('http://u:p@ok.example/live')).status).toBe(400)
    expect((await add('file:///etc/passwd')).status).toBe(400)
  })

  it('the relay listener: needs the engine token, fetches through the safe client, passes metadata headers', async () => {
    const t = setup()
    const seen: { url: string; headers: Record<string, string> }[] = []
    const transport: Transport = async (url, _p, headers) => {
      seen.push({ url: url.href, headers })
      return reply(200, { 'content-type': 'audio/mpeg', 'icy-metaint': '16000', 'icy-name': 'Soma' }, ['AUDIO'])
    }
    const app = relayRoutes(t.config, { resolver: fakeResolver, transport })
    const good = relayUrlFor(t.config, 'https://radio.example.com/live.mp3').replace('http://app:8792', '')
    expect((await app.request(good, { headers: { 'icy-metadata': '1' } })).status).toBe(200)
    const res = await app.request(good, { headers: { 'icy-metadata': '1' } })
    expect(res.headers.get('icy-metaint')).toBe('16000')
    expect(await res.text()).toBe('AUDIO')
    expect(seen[0]).toMatchObject({ url: 'https://radio.example.com/live.mp3', headers: { 'Icy-MetaData': '1' } })
    // wrong token, garbage target, internal target
    expect((await app.request(good.replace(engineToken(t.config), 'x'.repeat(40)))).status).toBe(404)
    expect((await app.request(`/relay/${engineToken(t.config)}/***`)).status).toBe(404)
    const evil = relayUrlFor(t.config, 'http://localhost:8080/admin').replace('http://app:8792', '')
    expect((await app.request(evil)).status).toBe(403)
    expect(seen).toHaveLength(2)
  })
})

describe('invites: a refused attempt does not burn the link', () => {
  async function invite(t: T, email = 'new@x.io') {
    await addUser(t, 'admin@x.io', 'admin')
    const cookie = await login(t, 'admin@x.io')
    const r = (await (await t.req('/api/admin/invites', { cookie, method: 'POST', json: { email, role: 'user', days: 7 } })).json()) as {
      url: string
    }
    return r.url.split('/').pop() as string
  }

  it('missing name: 400 and the link still works', async () => {
    const t = setup()
    const token = await invite(t)
    const bad = await t.req(`/api/auth/link/${token}`, { method: 'POST', json: { password: 'a very long password' } })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'name_required' })
    expect((await t.req(`/api/auth/link/${token}`, { method: 'POST', json: { name: ' ', password: 'a very long password' } })).status).toBe(
      400,
    )
    expect(
      (await t.req(`/api/auth/link/${token}`, { method: 'POST', json: { name: 'Ok', password: 'a very long password' } })).status,
    ).toBe(200)
  })

  it('the email got an account meanwhile: clear 409, no half-created user, link not used up', async () => {
    const t = setup()
    const token = await invite(t, 'race@x.io')
    createUser(t.db, { email: 'race@x.io' })
    const r = await t.req(`/api/auth/link/${token}`, { method: 'POST', json: { name: 'M', password: 'a very long password' } })
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'email_taken' })
    expect(t.db.$client.prepare("select used_at from invites where email = 'race@x.io'").get()).toEqual({ used_at: null })
    expect(t.db.$client.prepare("select count(*) n from users where lower(email) = 'race@x.io'").get()).toEqual({ n: 1 })
    expect(t.db.$client.prepare('select count(*) n from stations').get()).toEqual({ n: 2 })
  })
})

describe('body limits', () => {
  it('JSON APIs refuse more than 64 KB before parsing; playlists may be bigger; /api/play is not capped by it', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const huge = { name: 'x'.repeat(70_000) }
    const big = JSON.stringify(huge)
    for (const path of ['/api/auth/login', '/api/app/keys', '/api/app/settings', '/api/admin/settings']) {
      const r = await t.req(path, {
        method: 'POST',
        cookie,
        body: big,
        headers: { 'Content-Type': 'application/json', 'content-length': String(big.length) },
      })
      expect(r.status, path).toBe(413)
    }
    const say = await t.req('/api/say', {
      method: 'POST',
      origin: null,
      body: big,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ar_x' },
    })
    expect(say.status).toBe(413)
    // chunked bodies without a Content-Length are counted too
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big))
        c.close()
      },
    })
    const chunked = await t.app.request('http://radio.test/api/app/keys', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'http://radio.test', 'Content-Type': 'application/json' },
      body: stream,
      // @ts-expect-error node fetch option
      duplex: 'half',
    })
    expect(chunked.status).toBe(413)
    // a playlist with thousands of ids fits (1 MB)
    const ids = Array.from({ length: 3000 }, (_, i) => `id-${i}-${'0'.repeat(30)}`)
    const pl = await t.req('/api/app/playlists', { method: 'POST', cookie, json: { name: 'big', trackIds: ids } })
    expect(pl.status).toBe(400) // unknown tracks, but it got through the size gate
  })
})

describe('abuse limits', () => {
  const upload = (t: T, token: string) => {
    const form = new FormData()
    form.set('file', new File(['x'.repeat(100)], 'a.mp3'))
    return t.req('/api/play', { method: 'POST', body: form, origin: null, headers: { Authorization: `Bearer ${token}` } })
  }

  it('/play counts against the hourly per-user limit', async () => {
    const t = setup({ listeners: 0 })
    const { token } = await userWithKey(t, 'a@x.io')
    t.db.$client.prepare("insert into settings (key, value) values ('messageLimitPerHour', '2')").run()
    expect((await upload(t, token)).status).toBe(200)
    expect((await upload(t, token)).status).toBe(200)
    expect((await upload(t, token)).status).toBe(429)
  })

  it('one /play at a time per user; the lock is released afterwards, also after a failure', async () => {
    const t = setup({ listeners: 0 })
    const a = await userWithKey(t, 'a@x.io')
    const b = await userWithKey(t, 'b@x.io')
    let release: () => void = () => {}
    t.media.probe.mockImplementationOnce(() => new Promise((r) => (release = () => r({ durationSec: 5, hasAudio: true }))))
    const first = upload(t, a.token)
    await vi.waitFor(() => expect(t.media.probe).toHaveBeenCalledTimes(1))
    expect((await upload(t, a.token)).status).toBe(429)
    expect((await upload(t, b.token)).status).toBe(200) // another user is not blocked
    release()
    expect((await first).status).toBe(200)
    t.media.probe.mockRejectedValueOnce(new Error('bad file'))
    expect((await upload(t, a.token)).status).toBe(415)
    expect((await upload(t, a.token)).status).toBe(200)
  })

  it('one spoken message at a time per user', async () => {
    const t = setup({ listeners: 1 })
    const { token } = await userWithKey(t, 'a@x.io')
    let release: () => void = () => {}
    t.makeClip.mockImplementationOnce(() => new Promise((r) => (release = () => r('/shared/clips/x.mp3'))))
    const say = () =>
      t.req('/api/say', {
        method: 'POST',
        origin: null,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: 's', text: 'hi' }),
      })
    const first = say()
    await vi.waitFor(() => expect(t.makeClip).toHaveBeenCalledTimes(1))
    expect((await say()).status).toBe(429)
    release()
    expect((await first).status).toBe(200)
    expect((await say()).status).toBe(200)
  })

  it('UserLock releases once', () => {
    const l = new UserLock()
    const r = l.acquire('u')
    expect(() => l.acquire('u')).toThrow()
    r()
    r()
    expect(() => l.acquire('u')).not.toThrow()
  })

  it('at most 20 active API keys per user; revoking frees a slot', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    let first = ''
    for (let i = 0; i < 20; i++) {
      const r = await t.req('/api/app/keys', { cookie, method: 'POST', json: { name: `k${i}` } })
      expect(r.status).toBe(201)
      if (i === 0) first = ((await r.json()) as { key: { id: string } }).key.id
    }
    expect((await t.req('/api/app/keys', { cookie, method: 'POST', json: { name: 'one too many' } })).status).toBe(400)
    await t.req(`/api/app/keys/${first}`, { cookie, method: 'DELETE' })
    expect((await t.req('/api/app/keys', { cookie, method: 'POST', json: { name: 'again' } })).status).toBe(201)
  })

  it('the default size limit is 95 MB', async () => {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    const cookie = await login(t, 'admin@x.io')
    expect(((await (await t.req('/api/admin/settings', { cookie })).json()) as { maxAudioMb: number }).maxAudioMb).toBe(95)
  })

  it('cleanup removes upload leftovers older than an hour', () => {
    const t = setup()
    const dir = join(t.config.dataDir, 'uploads')
    mkdirSync(dir, { recursive: true })
    const old = join(dir, 'old.mp3')
    const fresh = join(dir, 'fresh.mp3')
    writeFileSync(old, 'x')
    writeFileSync(fresh, 'x')
    const past = new Date(Date.now() - 2 * 3600_000)
    utimesSync(old, past, past)
    cleanup(t.db, t.config)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('a failed intro does not stop the file: it plays without it and the history says so', async () => {
    const t = setup({ listeners: 1 })
    const { token } = await userWithKey(t, 'a@x.io')
    t.makeClip.mockRejectedValueOnce(new Error('tts down'))
    const form = new FormData()
    form.set('file', new File(['x'], 'a.mp3'))
    form.set('intro', 'Сесія x. Новий мікс')
    const r = await t.req('/api/play', { method: 'POST', body: form, origin: null, headers: { Authorization: `Bearer ${token}` } })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ status: 'aired' })
    expect(t.media.makeTrack).toHaveBeenCalledWith(expect.objectContaining({ intro: null }))
    expect(t.engine.pushTrack).toHaveBeenCalledTimes(1)
    expect(t.db.$client.prepare('select status, note from messages').get()).toEqual({ status: 'aired', note: 'intro_failed' })
  })

  it('library paging is validated', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    for (const q of ['limit=abc', 'limit=0', 'limit=9999', 'offset=-1', 'offset=1.5', 'limit=10&offset=x']) {
      expect((await t.req(`/api/app/library/tracks?${q}`, { cookie })).status, q).toBe(400)
    }
    expect((await t.req('/api/app/library/tracks?limit=5&offset=0', { cookie })).status).toBe(200)
  })
})

describe('ffprobe / ffmpeg hardening', () => {
  function fakeBins() {
    const dir = mkdtempSync(join(tmpdir(), 'ar-bin-'))
    const log = join(dir, 'args.log')
    const probe = join(dir, 'ffprobe')
    const ffmpeg = join(dir, 'ffmpeg')
    writeFileSync(probe, `#!/bin/sh\necho "$@" >> ${log}\necho '{"format":{"duration":"12.5"},"streams":[{"codec_type":"audio"}]}'\n`)
    writeFileSync(ffmpeg, `#!/bin/sh\necho "$@" >> ${log}\n`)
    const sleeper = join(dir, 'sleeper')
    writeFileSync(sleeper, '#!/bin/sh\nexec sleep 30\n')
    for (const f of [probe, ffmpeg, sleeper]) chmodSync(f, 0o755)
    return { probe, ffmpeg, sleeper, log }
  }

  it('every input is limited to audio demuxers and the file protocol', async () => {
    const b = fakeBins()
    const m = new FfmpegMedia(b.ffmpeg, b.probe)
    expect(await m.probe('/x/in.mp3')).toEqual({ durationSec: 12.5, hasAudio: true })
    await m.makeTrack({ input: '/x/in.mp3', intro: null, out: '/x/out.mp3' })
    await m.makeTrack({ input: '/x/in.mp3', intro: '/x/intro.mp3', out: '/x/out2.mp3' })
    const lines = readFileSync(b.log, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    for (const l of lines) {
      expect(l).toContain(`-format_whitelist ${INPUT_FORMATS}`)
      expect(l).toContain('-protocol_whitelist file')
    }
    expect(INPUT_FORMATS.split(',')).toEqual(expect.arrayContaining(['mp3', 'wav', 'flac', 'ogg', 'mov', 'mp4', 'aac']))
    expect(INPUT_FORMATS).not.toMatch(/concat|hls|dash|rtsp|http|image|mpegts|sdp|tty|lavfi/)
    // with an intro both inputs carry the whitelist
    expect((lines[2]?.match(/-format_whitelist/g) ?? []).length).toBe(2)
  })

  it('a hung process is killed at the deadline', async () => {
    const b = fakeBins()
    const m = new FfmpegMedia(b.sleeper, b.sleeper, { probe: 300, ffmpeg: 300 })
    const started = Date.now()
    await expect(m.probe('/x/in.mp3')).rejects.toThrow(/killed|exited/)
    await expect(m.makeTrack({ input: '/x/in.mp3', intro: null, out: '/x/o.mp3' })).rejects.toThrow(/killed|exited/)
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('engine sync race', () => {
  it('calls for one station run one after another', async () => {
    const order: string[] = []
    const slow = withStationLock('s1', async () => {
      order.push('a-start')
      await new Promise((r) => setTimeout(r, 30))
      order.push('a-end')
    })
    const fast = withStationLock('s1', async () => {
      order.push('b')
    })
    const other = withStationLock('s2', async () => {
      order.push('c')
    })
    await Promise.all([slow, fast, other])
    expect(order.indexOf('a-end')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('a-end'))
    // a failure does not block the next call
    await expect(withStationLock('s3', async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(withStationLock('s3', async () => 'fine')).resolves.toBe('fine')
  })

  it('sync pushes the row as it is when it gets the lock, not the stale one it read before', async () => {
    const t = setup()
    const { station } = await addUser(t, 'a@x.io')
    const user = t.db.$client.prepare('select * from users').get() as { id: string }
    void user
    let release: () => void = () => {}
    // the engine is slow on the first add: a source change is running when the sync starts
    t.engine.add.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
    const change = setStationSource(t.db, t.config, t.engine, station, { type: 'silence' })
    await vi.waitFor(() => expect(t.engine.add).toHaveBeenCalledTimes(1))
    const sync = syncEngine(t.db, t.config, t.engine)
    release()
    await change
    await sync
    // the sync pushed after the change, in the same order, with the stored (new) source
    const last = t.engine.setSource.mock.calls.at(-1) as unknown as [string, { type: string }]
    expect(last[1]).toEqual({ type: 'silence' })
    expect(t.engine.add.mock.calls.length).toBe(2)
  })
})

describe('retention counts from the clip, not the message', () => {
  it('a clip synthesized today for an old message keeps its pointer; the message itself still ages out at 30 days', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const dir = join(t.config.sharedDir, 'clips')
    mkdirSync(dir, { recursive: true })
    const clip = join(dir, 'late.mp3')
    writeFileSync(clip, 'x')
    const ins = t.db.$client.prepare(
      'insert into messages (id, user_id, session, text, status, type, clip_path, clip_created_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    ins.run(
      'm1',
      user.id,
      's',
      'old message, fresh clip',
      'skipped',
      'voice',
      clip,
      new Date().toISOString(),
      new Date(Date.now() - 10 * 86400_000).toISOString(),
    )
    ins.run(
      'm2',
      user.id,
      's',
      'old message, old clip',
      'aired',
      'voice',
      '/gone.mp3',
      new Date(Date.now() - 9 * 86400_000).toISOString(),
      new Date(Date.now() - 9 * 86400_000).toISOString(),
    )
    cleanup(t.db, t.config)
    const rows = t.db.$client.prepare('select id, clip_path from messages order by id').all()
    expect(rows).toEqual([
      { id: 'm1', clip_path: clip },
      { id: 'm2', clip_path: null },
    ])
    expect(existsSync(clip)).toBe(true)
  })

  it('synthesizing on demand stamps clip_created_at', async () => {
    const t = setup({ listeners: 0 })
    const { token } = await userWithKey(t, 'a@x.io')
    await t.req('/api/say', {
      method: 'POST',
      origin: null,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: 's', text: 'hi' }),
    })
    const cookie = await login(t, 'a@x.io')
    const id = ((await (await t.req('/api/app/history', { cookie })).json()) as { messages: { id: string }[] }).messages[0]?.id
    await t.req(`/api/app/history/${id}/synthesize`, { cookie, method: 'POST' })
    const row = t.db.$client.prepare('select clip_path, clip_created_at from messages').get() as {
      clip_path: string
      clip_created_at: string
    }
    expect(row.clip_path).toBeTruthy()
    expect(Date.now() - new Date(row.clip_created_at).getTime()).toBeLessThan(5000)
  })
})

describe('headers, cookies, client address', () => {
  it('CSP, nosniff, frame-ancestors; HSTS only on https', async () => {
    const t = setup()
    const res = await t.req('/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain('media-src')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('strict-transport-security')).toBeNull()
    const s = setup({ env: { PUBLIC_URL: 'https://radio.test' } })
    expect((await s.req('/healthz')).headers.get('strict-transport-security')).toMatch(/max-age=\d+/)
  })

  it('the SPA page has no inline script (CSP script-src self)', async () => {
    const t = setup()
    mkdirSync(t.config.webDir, { recursive: true })
    writeFileSync(join(t.config.webDir, 'index.html'), '<!doctype html><script src="/theme-init.js"></script>')
    const html = await (await t.req('/library')).text()
    expect(html).toContain('/theme-init.js')
    const real = readFileSync('src/client/index.html', 'utf8')
    expect(real).not.toMatch(/<script>(?!\s*<\/script>)/)
  })

  it('over https the session cookie is __Host- prefixed (Secure, Path=/, no Domain) and works', async () => {
    const t = setup({ env: { PUBLIC_URL: 'https://radio.test' } })
    await addUser(t, 'a@x.io')
    const res = await t.req('/api/auth/login', { method: 'POST', json: { email: 'a@x.io', password: PASSWORD } })
    const raw = res.headers.get('set-cookie') ?? ''
    expect(raw).toMatch(/^__Host-ar_session=/)
    expect(raw).toMatch(/Secure/i)
    expect(raw).toMatch(/Path=\//)
    expect(raw).not.toMatch(/Domain=/i)
    const cookie = raw.split(';')[0] as string
    expect((await t.req('/api/auth/me', { cookie })).status).toBe(200)
    const out = await t.req('/api/auth/logout', { method: 'POST', cookie })
    expect(out.headers.get('set-cookie')).toMatch(/__Host-ar_session=;/)
    expect((await t.req('/api/auth/me', { cookie })).status).toBe(401)
  })

  it('proxy headers are believed only with TRUST_PROXY=1', async () => {
    const attempt = (t: T, ip: string) =>
      t.req('/api/auth/login', {
        method: 'POST',
        json: { email: 'a@x.io', password: 'wrong wrong wrong' },
        headers: { 'cf-connecting-ip': ip },
      })
    // off: the header is ignored, so rotating it does not buy fresh attempts
    const off = setup({ authLimit: 2 })
    await addUser(off, 'a@x.io')
    expect((await attempt(off, '1.1.1.1')).status).toBe(401)
    expect((await attempt(off, '2.2.2.2')).status).toBe(401)
    expect((await attempt(off, '3.3.3.3')).status).toBe(429)
    // on: each client address has its own budget
    const on = setup({ authLimit: 2, env: { TRUST_PROXY: '1' } })
    await addUser(on, 'a@x.io')
    expect((await attempt(on, '1.1.1.1')).status).toBe(401)
    expect((await attempt(on, '1.1.1.1')).status).toBe(401)
    expect((await attempt(on, '1.1.1.1')).status).toBe(429)
    expect((await attempt(on, '2.2.2.2')).status).toBe(401)
  })

  it('loadConfig: TRUST_PROXY defaults to off', () => {
    expect(loadConfig({}).trustProxy).toBe(false)
    expect(loadConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(true)
    void openDb
  })
})
