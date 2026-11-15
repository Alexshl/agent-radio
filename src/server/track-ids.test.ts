import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, login, setup } from './test-utils'

async function lib() {
  const t = setup()
  for (const f of ['rock/a.mp3', 'rock/live/b.mp3', 'rock/live/c.flac', 'jazz/d.mp3', 'e.mp3']) {
    mkdirSync(join(t.music, f.split('/').slice(0, -1).join('/')), { recursive: true })
    writeFileSync(join(t.music, f), f)
  }
  await t.library.scan()
  await addUser(t, 'u@x.test')
  return { t, cookie: await login(t, 'u@x.test') }
}

describe('GET /api/app/library/track-ids', () => {
  it('returns every track of a folder, recursively, with the draft fields', async () => {
    const { t, cookie } = await lib()
    const res = await t.req('/api/app/library/track-ids?dir=rock', { cookie })
    const body = (await res.json()) as { tracks: { id: string; path: string; title: string; durationSec: number }[]; truncated: boolean }
    expect(body.tracks.map((x) => x.path)).toEqual(['rock/a.mp3', 'rock/live/b.mp3', 'rock/live/c.flac'])
    expect(body.truncated).toBe(false)
    expect(body.tracks[0]).toMatchObject({ title: 'a.mp3', durationSec: 100 })
    const all = (await (await t.req('/api/app/library/track-ids', { cookie })).json()) as { tracks: unknown[] }
    expect(all.tracks).toHaveLength(5)
  })

  it('filters by the search text inside the folder', async () => {
    const { t, cookie } = await lib()
    const res = await t.req('/api/app/library/track-ids?dir=rock&q=flac', { cookie })
    expect(((await res.json()) as { tracks: unknown[] }).tracks).toHaveLength(1)
  })

  it('caps the answer and says so', async () => {
    const { t } = await lib()
    const r = t.library.matching({}, 3)
    expect(r.tracks).toHaveLength(3)
    expect(r.truncated).toBe(true)
    expect(t.library.matching({}, 5).truncated).toBe(false)
  })

  it('refuses a folder outside the library and needs a session', async () => {
    const { t, cookie } = await lib()
    for (const dir of ['../..', '..%2F..%2Fetc', '/etc', 'rock/../../x']) {
      const res = await t.req(`/api/app/library/track-ids?dir=${dir}`, { cookie })
      expect(res.status).toBe(400)
    }
    expect((await t.req('/api/app/library/track-ids')).status).toBe(401)
  })
})

describe('folder as a station source', () => {
  it('passes the order to the engine and writes the m3u again after a scan', async () => {
    const { t, cookie } = await lib()
    const put = await t.req('/api/app/station/source', { method: 'PUT', cookie, json: { type: 'playlist', dir: 'rock', order: 'ordered' } })
    expect(put.status).toBe(200)
    expect(t.engine.setSource).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ type: 'playlist', mode: 'normal' }))
    const calls = t.engine.setSource.mock.calls as unknown as [string, { path: string }][]
    const spec = calls[calls.length - 1]?.[1] ?? { path: '' }
    const file = join(t.config.sharedDir, 'playlists', spec.path.split('/').pop() ?? '')
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3)
    writeFileSync(join(t.music, 'rock', 'new.mp3'), 'new')
    await t.library.scan()
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(4)
  })
})
