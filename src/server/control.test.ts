import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { controlTokens, messages, secrets, presets, stations, users } from './db/schema'
import { newId } from './lib/ids'
import { createPlaylist } from './playlists'
import { parseSource } from './stations'
import { type T, addUser, login, setup, userWithKey } from './test-utils'

function addMsg(t: T, userId: string, text: string, minutesAgo: number) {
  const id = newId()
  const clipPath = join(t.dir, `${id}.mp3`)
  writeFileSync(clipPath, 'x')
  t.db
    .insert(messages)
    .values({
      id,
      userId,
      session: 's',
      host: null,
      text,
      status: 'aired',
      clipPath,
      type: 'voice',
      durationSec: null,
      createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    })
    .run()
}

// a library with a few folders, scanned
async function withLibrary(t: T) {
  for (const f of ['rock/a.mp3', 'jazz/d.mp3', 'e.mp3']) {
    mkdirSync(join(t.music, f.split('/').slice(0, -1).join('/')), { recursive: true })
    writeFileSync(join(t.music, f), f)
  }
  await t.library.scan()
}

// a user with a control token made through the browser API
async function withToken(t: T, email = 'a@x.io') {
  const { user, station } = await addUser(t, email)
  const cookie = await login(t, email)
  const res = await t.req('/api/app/control-token', { method: 'POST', cookie })
  const { secret } = (await res.json()) as { secret: string }
  return { user, station, cookie, k: secret }
}
const post = (t: T, path: string, k: string) =>
  t.req(`/api/control/${path}${path.includes('?') ? '&' : '?'}k=${encodeURIComponent(k)}`, { method: 'POST' })
const getc = (t: T, path: string, k: string) => t.req(`/api/control/${path}?k=${encodeURIComponent(k)}`)

describe('control token management (/api/app/control-token)', () => {
  it('creates, shows no secret afterwards, regenerates (the old one dies) and revokes', async () => {
    const t = setup()
    const { cookie, k } = await withToken(t)
    expect(k).toMatch(/^arc_/)
    // only the hash is stored
    const row = t.db.select().from(controlTokens).get()
    expect(row?.tokenHash).not.toContain(k)
    const info = (await (await t.req('/api/app/control-token', { cookie })).json()) as { token: { lastUsedAt: string | null } | null }
    expect(JSON.stringify(info)).not.toContain(k)
    expect(info.token?.lastUsedAt).toBeNull()

    expect((await getc(t, 'status', k)).status).toBe(200)
    const used = (await (await t.req('/api/app/control-token', { cookie })).json()) as { token: { lastUsedAt: string | null } }
    expect(used.token.lastUsedAt).not.toBeNull()

    const res2 = await t.req('/api/app/control-token', { method: 'POST', cookie })
    const k2 = ((await res2.json()) as { secret: string }).secret
    expect(k2).not.toBe(k)
    expect((await getc(t, 'status', k)).status).toBe(401)
    expect((await getc(t, 'status', k2)).status).toBe(200)

    expect((await t.req('/api/app/control-token', { method: 'DELETE', cookie })).status).toBe(200)
    expect((await getc(t, 'status', k2)).status).toBe(401)
    expect((await t.req('/api/app/control-token', { method: 'DELETE', cookie })).status).toBe(404)
    const none = (await (await t.req('/api/app/control-token', { cookie })).json()) as { token: unknown }
    expect(none.token).toBeNull()
  })

  it('reveal returns the secret to the owner only; regenerate replaces it; revoke removes it', async () => {
    const t = setup()
    const a = await withToken(t, 'a@x.io')
    const b = await withToken(t, 'b@x.io')
    const reveal = async (cookie: string) => t.req('/api/app/control-token/reveal', { method: 'POST', cookie })
    const r1 = await reveal(a.cookie)
    expect(r1.status).toBe(200)
    expect(((await r1.json()) as { secret: string }).secret).toBe(a.k)
    expect(((await (await reveal(b.cookie)).json()) as { secret: string }).secret).toBe(b.k)
    expect((await t.req('/api/app/control-token/reveal', { method: 'POST' })).status).toBe(401)
    // the secret is stored encrypted, not in the clear
    expect(JSON.stringify(t.db.select().from(secrets).all())).not.toContain(a.k)

    const k2 = ((await (await t.req('/api/app/control-token', { method: 'POST', cookie: a.cookie })).json()) as { secret: string }).secret
    expect(((await (await reveal(a.cookie)).json()) as { secret: string }).secret).toBe(k2)

    await t.req('/api/app/control-token', { method: 'DELETE', cookie: a.cookie })
    expect((await reveal(a.cookie)).status).toBe(404)
    expect((await reveal(b.cookie)).status).toBe(200)
  })

  it('needs a session', async () => {
    const t = setup()
    expect((await t.req('/api/app/control-token')).status).toBe(401)
  })
})

describe('/api/control auth and scope', () => {
  it('rejects a missing, a wrong and a disabled-user token with a plain-text 401', async () => {
    const t = setup()
    const { user, k } = await withToken(t)
    const none = await t.req('/api/control/status')
    expect(none.status).toBe(401)
    expect(none.headers.get('content-type')).toContain('text/plain')
    expect((await getc(t, 'status', 'arc_nope')).status).toBe(401)
    expect((await getc(t, 'status', 'ar_whatever')).status).toBe(401)
    t.db.update(users).set({ disabledAt: new Date().toISOString() }).where(eq(users.id, user.id)).run()
    expect((await getc(t, 'status', k)).status).toBe(401)
  })

  it('the control token does not work on agent or app routes', async () => {
    const t = setup()
    const { k } = await withToken(t)
    const bearer = { Authorization: `Bearer ${k}` }
    expect((await t.req('/api/say', { method: 'POST', headers: bearer, json: { session: 's', text: 'hi' } })).status).toBe(401)
    expect((await t.req('/api/play', { method: 'POST', headers: bearer })).status).toBe(401)
    expect((await t.req('/api/status', { headers: bearer })).status).toBe(401)
    expect((await t.req('/api/station/source', { method: 'PUT', headers: bearer, json: { type: 'silence' } })).status).toBe(401)
    expect((await t.req(`/api/app/radio?k=${k}`)).status).toBe(401)
    expect((await t.req(`/api/app/settings?k=${k}`, { method: 'PUT', json: {} })).status).toBe(401)
    // and nothing speaks or plays through the control routes
    expect((await post(t, 'say', k)).status).toBe(404)
    expect((await post(t, 'play', k)).status).toBe(404)
    expect((await post(t, 'settings', k)).status).toBe(404)
  })

  it('an API key does not work on /api/control/*', async () => {
    const t = setup()
    const { token } = await userWithKey(t, 'k@x.io')
    expect((await getc(t, 'status', token)).status).toBe(401)
    expect((await post(t, 'replay?count=1', token)).status).toBe(401)
    const res = await t.req('/api/control/status', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
  })

  it('actions are POST, status is GET', async () => {
    const t = setup()
    const { k } = await withToken(t)
    expect((await t.req(`/api/control/replay?k=${k}&count=1`)).status).toBe(404)
    expect((await t.req(`/api/control/status?k=${k}`, { method: 'POST' })).status).toBe(404)
  })
})

describe('POST /api/control/replay', () => {
  it('replays 1, 2 and 3 messages, answering in text', async () => {
    const t = setup()
    const { user, k } = await withToken(t)
    addMsg(t, user.id, 'a', 30)
    addMsg(t, user.id, 'b', 20)
    addMsg(t, user.id, 'c', 10)
    const r1 = await post(t, 'replay?count=1', k)
    expect(r1.status).toBe(200)
    expect(r1.headers.get('content-type')).toContain('text/plain')
    expect(await r1.text()).toBe('Повторюю останнє повідомлення')
    expect(t.engine.push).toHaveBeenCalledTimes(1)
    const r2 = await post(t, 'replay?count=2', k)
    expect(await r2.text()).toBe('Повторюю останні повідомлення: 2')
    expect(t.engine.push).toHaveBeenCalledTimes(3)
    const r3 = await post(t, 'replay?count=3', k)
    expect(await r3.text()).toBe('Повторюю останні повідомлення: 3')
    expect(t.engine.push).toHaveBeenCalledTimes(6)
  })

  it('defaults to 1, refuses 0, 4 and junk', async () => {
    const t = setup()
    const { user, k } = await withToken(t)
    addMsg(t, user.id, 'a', 30)
    expect((await post(t, 'replay', k)).status).toBe(200)
    for (const c of ['0', '4', 'x', '1.5']) expect((await post(t, `replay?count=${c}`, k)).status).toBe(400)
  })

  it('says so when nobody listens or there is nothing to replay', async () => {
    const t = setup({ listeners: 0 })
    const { user, k } = await withToken(t)
    const empty = await post(t, 'replay?count=1', k)
    expect(empty.status).toBe(404)
    expect(await empty.text()).toBe('Ще немає що повторювати')
    addMsg(t, user.id, 'a', 30)
    const res = await post(t, 'replay?count=1', k)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Нікого не слухає — повтор не прозвучить')
    expect(t.engine.push).not.toHaveBeenCalled()
  })

  it('answers in the language of the user', async () => {
    const t = setup()
    const { user, k } = await withToken(t)
    addMsg(t, user.id, 'a', 30)
    t.db.update(users).set({ lang: 'en' }).where(eq(users.id, user.id)).run()
    expect(await (await post(t, 'replay?count=1', k)).text()).toBe('Replaying the last message')
    t.db.update(users).set({ lang: 'de' }).where(eq(users.id, user.id)).run()
    expect(await (await post(t, 'replay?count=1', k)).text()).toBe('Wiederhole die letzte Nachricht')
    expect(await (await getc(t, 'status', k)).text()).toContain('Quelle: Stille')
  })

  it('replays only the messages of the token owner', async () => {
    const t = setup()
    const a = await withToken(t, 'a@x.io')
    const b = await addUser(t, 'b@x.io')
    addMsg(t, b.user.id, 'secret of b', 5)
    const res = await post(t, 'replay?count=1', a.k)
    expect(res.status).toBe(404)
    expect(t.engine.push).not.toHaveBeenCalled()
  })
})

describe('POST /api/control/source', () => {
  it('switches to silence, the whole library, a folder, a playlist and a station preset', async () => {
    const t = setup()
    await withLibrary(t)
    const { user, station, k } = await withToken(t)
    const src = () => parseSource(t.db.select().from(stations).where(eq(stations.id, station.id)).get()?.source ?? '{}')

    expect(await (await post(t, 'source?kind=all', k)).text()).toBe('Джерело змінено: Уся бібліотека')
    expect(src()).toMatchObject({ type: 'playlist', dir: '' })

    expect(await (await post(t, 'source?kind=folder&id=rock', k)).text()).toBe('Джерело змінено: rock')
    expect(src()).toMatchObject({ type: 'playlist', dir: 'rock' })

    expect(await (await post(t, 'source?kind=silence', k)).text()).toBe('Джерело змінено: Тиша')
    expect(src()).toEqual({ type: 'silence' })

    t.db.insert(presets).values({ id: 'p1', name: 'Jazz FM', url: 'https://jazz.example/stream', position: 0 }).run()
    expect(await (await post(t, 'source?kind=station&id=p1', k)).text()).toBe('Джерело змінено: Jazz FM')
    expect(src()).toMatchObject({ type: 'relay', url: 'https://jazz.example/stream' })

    const pl = createPlaylist(t.db, user.id, {
      name: 'Morning',
      orderMode: 'shuffle',
      trackIds: t.library.matching({}, 5).tracks.map((x) => x.id),
    })
    expect(await (await post(t, `source?kind=playlist&id=${pl.id}`, k)).text()).toBe('Джерело змінено: Morning')
    expect(src()).toEqual({ type: 'userplaylist', playlistId: pl.id })
    expect(await (await getc(t, 'status', k)).text()).toContain('Джерело: Morning')
    expect(t.engine.setSource).toHaveBeenCalledTimes(5)
  })

  it('unknown ids are 404 with a text, a bad kind is 400, other users playlists are unknown', async () => {
    const t = setup()
    const { k } = await withToken(t)
    const other = await addUser(t, 'o@x.io')
    const foreign = createPlaylist(t.db, other.user.id, { name: 'Theirs', orderMode: 'shuffle', trackIds: [] })
    for (const q of [
      'kind=station&id=nope',
      'kind=playlist&id=nope',
      'kind=folder&id=nope',
      'kind=station',
      `kind=playlist&id=${foreign.id}`,
    ]) {
      const res = await post(t, `source?${q}`, k)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('Джерело не знайдено')
    }
    expect((await post(t, 'source?kind=weird', k)).status).toBe(400)
    expect((await post(t, 'source', k)).status).toBe(400)
    expect(t.engine.setSource).not.toHaveBeenCalled()
  })
})

describe('GET /api/control/status and /sources', () => {
  it('reports on-air, listeners, now playing and the source as text', async () => {
    const t = setup({ listeners: 2 })
    const { k } = await withToken(t)
    const res = await getc(t, 'status', k)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe('В ефірі: так\nСлухачів: 2\nЗараз грає: ICY title\nДжерело: Тиша')
  })

  it('lists ready action URLs for the replays, the sources and the status', async () => {
    const t = setup()
    const { user, k } = await withToken(t)
    t.db.insert(presets).values({ id: 'p1', name: 'Jazz FM', url: 'https://jazz.example/stream', position: 0 }).run()
    createPlaylist(t.db, user.id, { name: 'Morning', orderMode: 'shuffle', trackIds: [] })
    const res = await getc(t, 'sources', k)
    expect(res.status).toBe(200)
    const items = (await res.json()) as { title: string; url: string; method: string }[]
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]))
    expect(items.slice(0, 3).map((i) => i.url)).toEqual([
      `http://radio.test/api/control/replay?k=${k}&count=1`,
      `http://radio.test/api/control/replay?k=${k}&count=2`,
      `http://radio.test/api/control/replay?k=${k}&count=3`,
    ])
    expect(byTitle['Jazz FM']?.url).toBe(`http://radio.test/api/control/source?k=${k}&kind=station&id=p1`)
    expect(byTitle.Morning?.url).toContain('kind=playlist&id=')
    expect(byTitle.Тиша?.method).toBe('POST')
    expect(items.at(-1)).toMatchObject({ method: 'GET', url: `http://radio.test/api/control/status?k=${k}` })
  })
})

describe('rate limit', () => {
  it('allows 30 requests a minute per token, then 429 with a text', async () => {
    const t = setup()
    const { k } = await withToken(t)
    const other = await withToken(t, 'b@x.io')
    for (let i = 0; i < 30; i++) expect((await getc(t, 'status', k)).status).toBe(200)
    const res = await getc(t, 'status', k)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
    expect(await res.text()).toBe('Забагато запитів, спробуйте за хвилину')
    // another token has its own budget
    expect((await getc(t, 'status', other.k)).status).toBe(200)
  })
})
