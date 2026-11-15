import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveInside, writeTrackList } from './music'
import { addUser, login, setup } from './test-utils'
import type { T } from './test-utils'

function seedMusic(t: T) {
  mkdirSync(join(t.music, 'Ambient', 'Deep'), { recursive: true })
  mkdirSync(join(t.music, 'Jazz'), { recursive: true })
  writeFileSync(join(t.music, 'Ambient', 'a1.mp3'), 'x')
  writeFileSync(join(t.music, 'Ambient', 'Deep', 'a2.flac'), 'x')
  writeFileSync(join(t.music, 'Jazz', 'j1.ogg'), 'x')
  writeFileSync(join(t.music, 'Jazz', 'notes.txt'), 'x')
  writeFileSync(join(t.music, 'root.opus'), 'x')
}

describe('library scan', () => {
  it('indexes audio files recursively, incrementally, and drops the removed ones', async () => {
    const t = setup()
    seedMusic(t)
    expect(await t.library.scan()).toMatchObject({ added: 4, updated: 0, removed: 0, total: 4 })
    // unchanged -> nothing to do
    expect(await t.library.scan()).toMatchObject({ added: 0, updated: 0, removed: 0, total: 4 })
    // touched -> re-read
    const f = join(t.music, 'Jazz', 'j1.ogg')
    utimesSync(f, new Date(), new Date(Date.now() + 5000))
    writeFileSync(join(t.music, 'Jazz', 'new.m4a'), 'x')
    expect(await t.library.scan()).toMatchObject({ added: 1, updated: 1, removed: 0, total: 5 })
    const { rmSync } = await import('node:fs')
    rmSync(join(t.music, 'root.opus'))
    expect(await t.library.scan()).toMatchObject({ removed: 1, total: 4 })
  })

  it('folder tree, search and track list through the API', async () => {
    const t = setup()
    seedMusic(t)
    await t.library.scan()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const folders = (await (await t.req('/api/app/library/folders', { cookie })).json()) as {
      folders: { path: string; count: number; depth: number }[]
      total: number
    }
    expect(folders.total).toBe(4)
    expect(folders.folders).toEqual([
      { path: 'Ambient', name: 'Ambient', depth: 0, count: 2 },
      { path: 'Ambient/Deep', name: 'Deep', depth: 1, count: 1 },
      { path: 'Jazz', name: 'Jazz', depth: 0, count: 1 },
    ])
    const inAmbient = (await (await t.req('/api/app/library/tracks?dir=Ambient', { cookie })).json()) as {
      tracks: unknown[]
      total: number
    }
    expect(inAmbient.total).toBe(2)
    const search = (await (await t.req('/api/app/library/tracks?q=j1', { cookie })).json()) as { tracks: { title: string }[] }
    expect(search.tracks.map((x) => x.title)).toEqual(['j1.ogg'])
    // LIKE wildcards in the query are literal
    const wild = (await (await t.req('/api/app/library/tracks?q=%25', { cookie })).json()) as { total: number }
    expect(wild.total).toBe(0)
  })

  it('streams a track with Range support, only for signed-in users', async () => {
    const t = setup()
    writeFileSync(join(t.music, 'song.mp3'), '0123456789')
    await t.library.scan()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const id = ((await (await t.req('/api/app/library/tracks', { cookie })).json()) as { tracks: { id: string }[] }).tracks[0]?.id as string
    expect((await t.req(`/api/app/library/tracks/${id}/audio`)).status).toBe(401)
    const full = await t.req(`/api/app/library/tracks/${id}/audio`, { cookie })
    expect(full.status).toBe(200)
    expect(full.headers.get('Accept-Ranges')).toBe('bytes')
    expect(await full.text()).toBe('0123456789')
    const part = await t.req(`/api/app/library/tracks/${id}/audio`, { cookie, headers: { Range: 'bytes=2-5' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('Content-Range')).toBe('bytes 2-5/10')
    expect(await part.text()).toBe('2345')
    const tail = await t.req(`/api/app/library/tracks/${id}/audio`, { cookie, headers: { Range: 'bytes=-3' } })
    expect(await tail.text()).toBe('789')
    expect((await t.req(`/api/app/library/tracks/${id}/audio`, { cookie, headers: { Range: 'bytes=50-60' } })).status).toBe(416)
  })
})

describe('path traversal', () => {
  it('resolveInside refuses anything outside the root', () => {
    const t = setup()
    expect(() => resolveInside(t.music, '../etc/passwd')).toThrow()
    expect(() => resolveInside(t.music, 'a/../../x')).toThrow()
    expect(() => resolveInside(t.music, '/etc/passwd')).toThrow()
    expect(() => resolveInside(t.music, 'ok\0.mp3')).toThrow()
    expect(resolveInside(t.music, 'Ambient/a1.mp3')).toBe(join(t.music, 'Ambient/a1.mp3'))
  })

  it('refuses a symlink that leaves the library', () => {
    const t = setup()
    symlinkSync('/etc', join(t.music, 'escape'))
    expect(() => resolveInside(t.music, 'escape/passwd')).toThrow()
  })

  it('folder filters, source folders and playlist files cannot leave the library', async () => {
    const t = setup()
    seedMusic(t)
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    expect((await t.req('/api/app/library/tracks?dir=../..', { cookie })).status).toBe(400)
    expect((await t.req('/api/app/station/source', { cookie, method: 'PUT', json: { type: 'playlist', dir: '../../etc' } })).status).toBe(
      400,
    )
    expect(() => writeTrackList(t.config, 'st1', ['../../etc/passwd'])).toThrow()
  })

  it('a poisoned track path in the index is not served', async () => {
    const t = setup()
    seedMusic(t)
    await t.library.scan()
    t.db.$client.prepare("update tracks set path = '../../../etc/passwd' where title = 'a1.mp3'").run()
    const id = (t.db.$client.prepare("select id from tracks where title = 'a1.mp3'").get() as { id: string }).id
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    expect((await t.req(`/api/app/library/tracks/${id}/audio`, { cookie })).status).toBe(400)
  })
})

describe('playlists', () => {
  async function ready() {
    const t = setup()
    seedMusic(t)
    await t.library.scan()
    await addUser(t, 'a@x.io')
    await addUser(t, 'b@x.io')
    const a = await login(t, 'a@x.io')
    const b = await login(t, 'b@x.io')
    const ids = ((await (await t.req('/api/app/library/tracks', { cookie: a })).json()) as { tracks: { id: string }[] }).tracks.map(
      (x) => x.id,
    )
    return { t, a, b, ids }
  }

  it('create, read, reorder, update, delete', async () => {
    const { t, a, ids } = await ready()
    const created = await t.req('/api/app/playlists', {
      cookie: a,
      method: 'POST',
      json: { name: 'Work', orderMode: 'ordered', trackIds: [ids[2], ids[0], ids[1]] },
    })
    expect(created.status).toBe(201)
    const pl = (await created.json()) as { id: string; tracks: { id: string }[]; orderMode: string }
    expect(pl.tracks.map((x) => x.id)).toEqual([ids[2], ids[0], ids[1]])
    expect(pl.orderMode).toBe('ordered')

    const list = (await (await t.req('/api/app/playlists', { cookie: a })).json()) as {
      playlists: { name: string; count: number; durationSec: number }[]
    }
    expect(list.playlists).toMatchObject([{ name: 'Work', count: 3, durationSec: 300 }])

    const upd = await t.req(`/api/app/playlists/${pl.id}`, {
      cookie: a,
      method: 'PUT',
      json: { name: 'Work 2', orderMode: 'shuffle', trackIds: [ids[1], ids[3]] },
    })
    expect(((await upd.json()) as { tracks: { id: string }[] }).tracks.map((x) => x.id)).toEqual([ids[1], ids[3]])

    expect((await t.req(`/api/app/playlists/${pl.id}`, { cookie: a, method: 'DELETE' })).status).toBe(200)
    expect((await t.req(`/api/app/playlists/${pl.id}`, { cookie: a })).status).toBe(404)
  })

  it('validates names and track ids', async () => {
    const { t, a, ids } = await ready()
    expect((await t.req('/api/app/playlists', { cookie: a, method: 'POST', json: { name: ' ', trackIds: [] } })).status).toBe(400)
    expect((await t.req('/api/app/playlists', { cookie: a, method: 'POST', json: { name: 'x', trackIds: [ids[0], 'nope'] } })).status).toBe(
      400,
    )
  })

  it("a user cannot read, change or air another user's playlist", async () => {
    const { t, a, b, ids } = await ready()
    const pl = (await (
      await t.req('/api/app/playlists', { cookie: a, method: 'POST', json: { name: 'Mine', trackIds: [ids[0]] } })
    ).json()) as { id: string }
    expect((await t.req(`/api/app/playlists/${pl.id}`, { cookie: b })).status).toBe(404)
    expect((await t.req(`/api/app/playlists/${pl.id}`, { cookie: b, method: 'PUT', json: { name: 'x', trackIds: [] } })).status).toBe(404)
    expect((await t.req(`/api/app/playlists/${pl.id}`, { cookie: b, method: 'DELETE' })).status).toBe(404)
    expect(
      (await t.req('/api/app/station/source', { cookie: b, method: 'PUT', json: { type: 'userplaylist', playlistId: pl.id } })).status,
    ).toBe(404)
  })

  it('"save and put on air": the engine gets an m3u of the playlist in order, with the right mode', async () => {
    const { t, a, ids } = await ready()
    const pl = (await (
      await t.req('/api/app/playlists', {
        cookie: a,
        method: 'POST',
        json: { name: 'Mine', orderMode: 'ordered', trackIds: [ids[1], ids[0]] },
      })
    ).json()) as { id: string; tracks: { path: string }[] }
    const res = await t.req('/api/app/station/source', { cookie: a, method: 'PUT', json: { type: 'userplaylist', playlistId: pl.id } })
    expect(res.status).toBe(200)
    const call = t.engine.setSource.mock.calls.at(-1) as unknown as [string, { type: string; path: string; mode: string }]
    expect(call[1]).toMatchObject({ type: 'playlist', mode: 'normal' })
    const { readFileSync } = await import('node:fs')
    const m3u = readFileSync(join(t.config.sharedDir, 'playlists', `${call[0]}.m3u`), 'utf8')
      .trim()
      .split('\n')
    expect(m3u).toEqual(pl.tracks.map((x) => `/music/${x.path}`))
    // editing the playlist that is on air re-applies it
    const before = t.engine.setSource.mock.calls.length
    await t.req(`/api/app/playlists/${pl.id}`, {
      cookie: a,
      method: 'PUT',
      json: { name: 'Mine', orderMode: 'shuffle', trackIds: [ids[0]] },
    })
    expect(t.engine.setSource.mock.calls.length).toBe(before + 1)
    expect((t.engine.setSource.mock.calls.at(-1) as unknown as [string, { mode: string }])[1].mode).toBe('randomize')
  })
})
