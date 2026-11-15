import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, login, setup, userWithKey } from './test-utils'
import type { T } from './test-utils'

function upload(
  t: T,
  token: string | null,
  opts: { name?: string; bytes?: number | string; fields?: Record<string, string>; skipFile?: boolean } = {},
) {
  const form = new FormData()
  if (!opts.skipFile) {
    const data = typeof opts.bytes === 'string' ? opts.bytes : 'x'.repeat(opts.bytes ?? 1000)
    form.set('file', new File([data], opts.name ?? 'mix.mp3', { type: 'audio/mpeg' }))
  }
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.set(k, v)
  return t.req('/api/play', { method: 'POST', body: form, origin: null, headers: token ? { Authorization: `Bearer ${token}` } : {} })
}

const clips = (t: T) => {
  const d = join(t.config.sharedDir, 'clips')
  return existsSync(d) ? readdirSync(d) : []
}

describe('POST /api/play', () => {
  it('needs an API key', async () => {
    const t = setup()
    expect((await upload(t, null)).status).toBe(401)
    expect((await upload(t, 'ar_unknownunknownunknown')).status).toBe(401)
  })

  it('pushes the file to the track queue when somebody listens and records an aired audio message', async () => {
    const t = setup({ listeners: 2 })
    const { token, station } = await userWithKey(t, 'a@x.io')
    const res = await upload(t, token, { fields: { title: 'Новий мікс', session: 'tu-mani', host: 'studio-mac' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'aired', listeners: 2, title: 'Новий мікс', durationSec: 30 })
    expect(t.engine.pushTrack).toHaveBeenCalledTimes(1)
    const [id, path] = t.engine.pushTrack.mock.calls[0] as unknown as [string, string]
    expect(id).toBe(station.id)
    expect(path).toMatch(/^\/shared\/clips\/.+\.mp3$/)
    expect(t.engine.push).not.toHaveBeenCalled()
    expect(t.media.makeTrack).toHaveBeenCalledWith(expect.objectContaining({ intro: null }))
    const row = t.db.$client.prepare('select type, status, text, session, host, duration_sec, clip_path from messages').get() as Record<
      string,
      unknown
    >
    expect(row).toMatchObject({
      type: 'audio',
      status: 'onair',
      text: 'Новий мікс',
      session: 'tu-mani',
      host: 'studio-mac',
      duration_sec: 30,
    })
    expect(existsSync(row.clip_path as string)).toBe(true)
  })

  it('with nobody listening the file is kept in the history (not discarded) and not aired', async () => {
    const t = setup({ listeners: 0 })
    const { token } = await userWithKey(t, 'a@x.io')
    const res = await upload(t, token, { name: 'beat.wav', fields: { intro: 'Привіт' } })
    expect(await res.json()).toMatchObject({ status: 'skipped', listeners: 0 })
    expect(t.engine.pushTrack).not.toHaveBeenCalled()
    expect(t.makeClip).not.toHaveBeenCalled() // no TTS for an intro nobody hears
    const row = t.db.$client.prepare('select type, status, text, clip_path from messages').get() as Record<string, string>
    expect(row).toMatchObject({ type: 'audio', status: 'skipped', text: 'beat' })
    expect(existsSync(row.clip_path as string)).toBe(true)
  })

  it('speaks the intro before the file (one clip) when somebody listens', async () => {
    const t = setup({ listeners: 1 })
    const { token } = await userWithKey(t, 'a@x.io')
    await upload(t, token, { fields: { intro: 'Сесія tu-mani. Ось новий мікс' } })
    expect(t.makeClip).toHaveBeenCalledWith(expect.objectContaining({ text: 'Сесія tu-mani. Ось новий мікс' }))
    expect(t.media.makeTrack).toHaveBeenCalledWith(expect.objectContaining({ intro: expect.stringContaining('clip-') }))
    expect(t.engine.pushTrack).toHaveBeenCalledTimes(1)
  })

  it('rejects unsupported types, a missing file and non-multipart bodies', async () => {
    const t = setup()
    const { token } = await userWithKey(t, 'a@x.io')
    expect((await upload(t, token, { name: 'virus.exe' })).status).toBe(415)
    expect((await upload(t, token, { name: 'notes.txt' })).status).toBe(415)
    expect((await upload(t, token, { skipFile: true, fields: { title: 'x' } })).status).toBe(400)
    const json = await t.req('/api/play', {
      method: 'POST',
      origin: null,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(json.status).toBe(400)
    expect(t.media.makeTrack).not.toHaveBeenCalled()
    expect(t.db.$client.prepare('select count(*) n from messages').get()).toEqual({ n: 0 })
  })

  it('rejects a file that ffprobe cannot read or that has no audio', async () => {
    const t = setup()
    const { token } = await userWithKey(t, 'a@x.io')
    t.media.probe.mockRejectedValueOnce(new Error('invalid data'))
    expect((await upload(t, token)).status).toBe(415)
    t.media.probe.mockResolvedValueOnce({ durationSec: 10, hasAudio: false })
    expect((await upload(t, token)).status).toBe(400)
    expect(clips(t)).toHaveLength(0)
  })

  it('rejects files over the size limit (admin setting)', async () => {
    const t = setup()
    const { token } = await userWithKey(t, 'a@x.io')
    t.db.$client.prepare("insert into settings (key, value) values ('maxAudioMb', '1')").run()
    const res = await upload(t, token, { bytes: 2 * 1024 * 1024 })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'too_large' })
    expect(t.media.probe).not.toHaveBeenCalled()
    expect(upload(t, token, { bytes: 500 * 1024 })).resolves.toBeTruthy()
  })

  it('rejects files over the duration limit (default 20 min, admin setting)', async () => {
    const t = setup()
    const { token } = await userWithKey(t, 'a@x.io')
    t.media.probe.mockResolvedValueOnce({ durationSec: 21 * 60, hasAudio: true })
    const res = await upload(t, token)
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'too_long' })
    expect(t.media.makeTrack).not.toHaveBeenCalled()
    // an admin can raise the limit
    t.db.$client.prepare("insert into settings (key, value) values ('maxAudioMinutes', '30')").run()
    t.media.probe.mockResolvedValueOnce({ durationSec: 21 * 60, hasAudio: true })
    expect((await upload(t, token)).status).toBe(200)
  })

  it("is isolated per user: the file goes only to the key owner's station and history", async () => {
    const t = setup({ listeners: 1 })
    const a = await userWithKey(t, 'a@x.io')
    const b = await userWithKey(t, 'b@x.io')
    await upload(t, a.token, { fields: { title: 'for A', userId: b.user.id, stationId: b.station.id } })
    expect(t.engine.pushTrack).toHaveBeenCalledWith(a.station.id, expect.any(String), expect.any(String))
    expect(t.engine.pushTrack).not.toHaveBeenCalledWith(b.station.id, expect.anything())
    await t.req('/api/auth/login', { method: 'POST', json: { email: 'b@x.io', password: 'correct horse battery' } })
    const cookieB = await login(t, 'b@x.io')
    const hist = (await (await t.req('/api/app/history', { cookie: cookieB })).json()) as { messages: unknown[] }
    expect(hist.messages).toHaveLength(0)
  })

  it('removes the temp upload and does not keep a clip when the queue push fails', async () => {
    const t = setup({ listeners: 1 })
    const { token } = await userWithKey(t, 'a@x.io')
    t.engine.pushTrack.mockRejectedValueOnce(new Error('engine down'))
    const res = await upload(t, token)
    expect(res.status).toBe(502)
    expect(clips(t)).toHaveLength(0)
    const uploads = join(t.config.dataDir, 'uploads')
    expect(existsSync(uploads) ? readdirSync(uploads) : []).toHaveLength(0)
    expect(t.db.$client.prepare('select status, clip_path from messages').get()).toEqual({ status: 'failed', clip_path: null })
  })

  it('shows the file in /api/status while it plays', async () => {
    const t = setup({ listeners: 1 })
    const { token } = await userWithKey(t, 'a@x.io')
    await upload(t, token, { fields: { title: 'Live mix' } })
    const st = (await (await t.req('/api/status', { headers: { Authorization: `Bearer ${token}` } })).json()) as { title: string }
    expect(st.title).toBe('Live mix')
  })
})

describe('history of audio items', () => {
  it('lists audio items, serves the stored file with Range, and keeps per-user isolation', async () => {
    const t = setup({ listeners: 0 })
    const a = await userWithKey(t, 'a@x.io')
    await addUser(t, 'b@x.io')
    await upload(t, a.token, { fields: { title: 'Mix' } })
    const cookie = await login(t, 'a@x.io')
    const hist = (await (await t.req('/api/app/history', { cookie })).json()) as {
      messages: { id: string; type: string; status: string; hasClip: boolean; durationSec: number }[]
    }
    expect(hist.messages[0]).toMatchObject({ type: 'audio', status: 'skipped', hasClip: true, durationSec: 30 })
    const id = hist.messages[0]?.id
    const full = await t.req(`/api/app/history/${id}/audio`, { cookie })
    expect(full.status).toBe(200)
    expect(await full.text()).toBe('mp3-bytes')
    const part = await t.req(`/api/app/history/${id}/audio`, { cookie, headers: { Range: 'bytes=0-2' } })
    expect(part.status).toBe(206)
    expect(await part.text()).toBe('mp3')
    const cookieB = await login(t, 'b@x.io')
    expect((await t.req(`/api/app/history/${id}/audio`, { cookie: cookieB })).status).toBe(404)
  })
})
