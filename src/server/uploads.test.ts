import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tracks } from './db/schema'
import { setSetting } from './lib/settings'
import { addUser, login, setup } from './test-utils'
import { sanitizeSegment } from './uploads'

async function admin(t: ReturnType<typeof setup>) {
  await addUser(t, 'admin@x.test', 'admin')
  return login(t, 'admin@x.test')
}
async function user(t: ReturnType<typeof setup>, email = 'u@x.test') {
  await addUser(t, email)
  return login(t, email)
}

function upload(t: ReturnType<typeof setup>, cookie: string, name: string, bytes: Uint8Array | string = 'audio-bytes-1') {
  const form = new FormData()
  form.append('file', new Blob([bytes as BlobPart]), name)
  return t.req('/api/app/library/upload', { method: 'POST', body: form, cookie })
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))

describe('sanitizeSegment', () => {
  it('removes separators, control characters and leading dots', () => {
    expect(sanitizeSegment('../../etc', 'x')).toBe('etc')
    expect(sanitizeSegment('a/b\\c:d*e?"<>|', 'x')).toBe('a b c d e')
    expect(sanitizeSegment('..', 'fallback')).toBe('fallback')
    expect(sanitizeSegment('   ', 'fallback')).toBe('fallback')
    expect(sanitizeSegment('x\u0000y', 'f')).toBe('x y')
    expect(sanitizeSegment('a'.repeat(300), 'f').length).toBe(80)
  })
})

describe('music upload', () => {
  it('stores the file under uploads/<artist>/<album>/ and indexes it', async () => {
    const t = setup()
    const cookie = await admin(t)
    const res = await upload(t, cookie, 'My Song.mp3')
    expect(res.status).toBe(201)
    const body = (await res.json()) as { track: { id: string; path: string; artist: string } }
    expect(body.track.path).toBe('uploads/Artist/Album/My Song.mp3')
    expect(readFileSync(join(t.music, body.track.path), 'utf8')).toBe('audio-bytes-1')
    expect(statSync(join(t.music, body.track.path)).mode & 0o044).toBe(0o044)
    const row = t.db.select().from(tracks).get()
    expect(row?.uploadedBy).toBeTruthy()
    expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/)
    // nothing is left in the temp folder
    expect(walk(join(t.music, '.incoming'))).toEqual([])
    expect(t.media.probe).toHaveBeenCalled()
  })

  it('uses a free name for a different file with the same name', async () => {
    const t = setup()
    const cookie = await admin(t)
    await upload(t, cookie, 'a.mp3', 'one')
    const res = await upload(t, cookie, 'a.mp3', 'two')
    expect(((await res.json()) as { track: { path: string } }).track.path).toBe('uploads/Artist/Album/a (2).mp3')
  })

  it('rejects the same bytes as a duplicate (size + hash)', async () => {
    const t = setup()
    const cookie = await admin(t)
    expect((await upload(t, cookie, 'a.mp3', 'same')).status).toBe(201)
    const dup = await upload(t, cookie, 'b.flac', 'same')
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: string }).error).toBe('duplicate')
    expect(walk(join(t.music, 'uploads'))).toHaveLength(1)
    // same size, other content: fine
    expect((await upload(t, cookie, 'c.mp3', 'sAme')).status).toBe(201)
  })

  it('detects a duplicate of a file that was found by the scan (hash computed on demand)', async () => {
    const t = setup()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(t.music, 'old.mp3'), 'same-bytes')
    await t.library.scan()
    const cookie = await admin(t)
    expect((await upload(t, cookie, 'new.mp3', 'same-bytes')).status).toBe(409)
  })

  it('rejects non-audio: bad extension and a file ffprobe does not accept', async () => {
    const t = setup()
    const cookie = await admin(t)
    const bad = await upload(t, cookie, 'notes.txt')
    expect(bad.status).toBe(415)
    t.media.probe.mockResolvedValueOnce({ durationSec: 0, hasAudio: false })
    const noAudio = await upload(t, cookie, 'x.mp3')
    expect(noAudio.status).toBe(400)
    t.media.probe.mockRejectedValueOnce(new Error('invalid data'))
    const garbage = await upload(t, cookie, 'y.wav')
    expect(garbage.status).toBe(415)
    expect(walk(t.music)).toEqual([])
  })

  it('cannot escape the library through the file name or the tags', async () => {
    const t = setup()
    const cookie = await admin(t)
    vi.spyOn(t.library, 'readTags').mockResolvedValue({ title: 't', artist: '../../../evil', album: '..', durationSec: 5 })
    const res = await upload(t, cookie, '../../../etc/passwd.mp3')
    expect(res.status).toBe(201)
    const path = ((await res.json()) as { track: { path: string } }).track.path
    expect(path.startsWith('uploads/')).toBe(true)
    expect(path.split('/')).not.toContain('..')
    expect(
      walk(t.dir)
        .filter((f) => f.includes('passwd') || f.includes('evil'))
        .every((f) => f.startsWith(join(t.music, 'uploads'))),
    ).toBe(true)
  })

  it('needs a session and respects the user switch and the quota', async () => {
    const t = setup()
    expect((await t.req('/api/app/library/upload', { method: 'POST', body: new FormData() })).status).toBe(401)
    const cookie = await user(t)
    const off = await upload(t, cookie, 'a.mp3')
    expect(off.status).toBe(403)
    expect(((await off.json()) as { error: string }).error).toBe('uploads_disabled')
    setSetting(t.db, 'allowUserUploads', true)
    expect((await upload(t, cookie, 'a.mp3', 'x'.repeat(600_000))).status).toBe(201)
    setSetting(t.db, 'uploadQuotaMb', 1)
    const over = await upload(t, cookie, 'b.mp3', 'y'.repeat(600_000))
    expect(over.status).toBe(413)
    expect(((await over.json()) as { error: string }).error).toBe('quota_exceeded')
    // the admin has no quota
    const a = await admin(t)
    expect((await upload(t, a, 'c.mp3', 'z'.repeat(2_000_000))).status).toBe(201)
  })

  it('reports the upload policy in the library status', async () => {
    const t = setup()
    const cookie = await user(t)
    let s = (await (await t.req('/api/app/library/status', { cookie })).json()) as { upload: { allowed: boolean; quotaBytes: number } }
    expect(s.upload.allowed).toBe(false)
    setSetting(t.db, 'allowUserUploads', true)
    s = (await (await t.req('/api/app/library/status', { cookie })).json()) as typeof s
    expect(s.upload).toMatchObject({ allowed: true, quotaBytes: 2048 * 1024 * 1024 })
  })

  it('deletes a track (admin only) by moving the file to .trash', async () => {
    const t = setup()
    const a = await admin(t)
    const up = (await (await upload(t, a, 'gone.mp3')).json()) as { track: { id: string; path: string } }
    const u = await user(t)
    expect((await t.req(`/api/admin/library/tracks/${up.track.id}`, { method: 'DELETE', cookie: u })).status).toBe(403)
    expect(existsSync(join(t.music, up.track.path))).toBe(true)
    expect((await t.req(`/api/admin/library/tracks/${up.track.id}`, { method: 'DELETE', cookie: a })).status).toBe(200)
    expect(existsSync(join(t.music, up.track.path))).toBe(false)
    const trashed = readdirSync(join(t.music, '.trash'))
    expect(trashed).toHaveLength(1)
    expect(trashed[0]).toContain('gone.mp3')
    expect(t.db.select().from(tracks).all()).toHaveLength(0)
    // the artist / album folders that became empty are gone
    expect(existsSync(join(t.music, 'uploads', 'Artist'))).toBe(false)
    expect((await t.req(`/api/admin/library/tracks/${up.track.id}`, { method: 'DELETE', cookie: a })).status).toBe(404)
    // the scanner skips the trash
    await t.library.scan()
    expect(t.library.count()).toBe(0)
  })

  it('shows free disk space and the settings to the admin', async () => {
    const t = setup()
    const a = await admin(t)
    const lib = (await (await t.req('/api/admin/library', { cookie: a })).json()) as { disk: { freeBytes: number; totalBytes: number } }
    expect(lib.disk.freeBytes).toBeGreaterThan(0)
    expect(await (await t.req('/api/admin/settings', { cookie: a })).json()).toMatchObject({ allowUserUploads: false, uploadQuotaMb: 2048 })
    expect(
      (await t.req('/api/admin/settings', { method: 'PUT', cookie: a, json: { allowUserUploads: true, uploadQuotaMb: 500 } })).status,
    ).toBe(200)
    expect(await (await t.req('/api/admin/settings', { cookie: a })).json()).toMatchObject({ allowUserUploads: true, uploadQuotaMb: 500 })
  })
})
