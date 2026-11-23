import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { presets } from './db/schema'
import { checkAllPresets, checkPreset, parseMaxVolume, probeUrl } from './presets-health'
import { addUser, login, setup } from './test-utils'

const VOL = (max: string) => `[Parsed_volumedetect_0 @ 0x1] mean_volume: -30.1 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: ${max} dB\n`

type T = ReturnType<typeof setup>

function addPreset(t: T, id: string, failCount = 0) {
  t.db
    .insert(presets)
    .values({
      id,
      name: `Station ${id}`,
      url: `https://${id}.example/stream`,
      position: 0,
      failCount,
      status: failCount ? 'fail' : 'unknown',
    })
    .run()
}
const row = (t: T, id: string) => t.db.select().from(presets).where(eq(presets.id, id)).get()

describe('parseMaxVolume / probeUrl', () => {
  it('reads max_volume from the volumedetect output', () => {
    expect(parseMaxVolume(VOL('-3.5'))).toBe(-3.5)
    expect(parseMaxVolume(VOL('-inf'))).toBe(Number.NEGATIVE_INFINITY)
    expect(parseMaxVolume('Server returned 5XX Server Error reply')).toBeNull()
  })

  it('ok for audible audio, fail for silence, no volume line and a failing run', async () => {
    expect(await probeUrl('u', async () => VOL('-12.0'))).toBe(true)
    expect(await probeUrl('u', async () => VOL('-60.0'))).toBe(false)
    expect(await probeUrl('u', async () => VOL('-inf'))).toBe(false)
    expect(await probeUrl('u', async () => 'no stats')).toBe(false)
    expect(
      await probeUrl('u', async () => {
        throw new Error('ffmpeg exited with 1')
      }),
    ).toBe(false)
  })
})

describe('fail_count', () => {
  it('counts failures in a row and resets on success', async () => {
    const t = setup()
    addPreset(t, 'a')
    const bad = async () => 'nothing'
    expect((await checkPreset(t.db, 'a', bad))?.failCount).toBe(1)
    const second = await checkPreset(t.db, 'a', bad)
    expect(second).toMatchObject({ failCount: 2, status: 'fail' })
    expect(second?.checkedAt).toBeTypeOf('number')
    expect(await checkPreset(t.db, 'a', async () => VOL('-9'))).toMatchObject({ failCount: 0, status: 'ok' })
    expect(await checkPreset(t.db, 'nope', bad)).toBeNull()
  })

  it('checks every preset one after another and never deletes', async () => {
    const t = setup()
    for (const id of ['a', 'b', 'c']) addPreset(t, id)
    let active = 0
    let peak = 0
    const probe = vi.fn(async (url: string) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return url.includes('b.example') ? 'fail' : VOL('-10')
    })
    await checkAllPresets(t.db, probe)
    expect(peak).toBe(1)
    expect(probe).toHaveBeenCalledTimes(3)
    const all = t.db.select().from(presets).all()
    expect(all.map((p) => `${p.id}:${p.status}`).sort()).toEqual(['a:ok', 'b:fail', 'c:ok'])
  })
})

describe('visibility', () => {
  it('users do not see presets with fail_count >= 2, the admin sees all with the status', async () => {
    const t = setup()
    addPreset(t, 'good')
    addPreset(t, 'flaky', 1)
    addPreset(t, 'dead', 2)
    await addUser(t, 'u@x.io')
    await addUser(t, 'a@x.io', 'admin')
    const user = await login(t, 'u@x.io')
    const admin = await login(t, 'a@x.io')
    const radio = (await (await t.req('/api/app/radio', { cookie: user })).json()) as { presets: { id: string }[] }
    expect(radio.presets.map((p) => p.id).sort()).toEqual(['flaky', 'good'])
    const all = (await (await t.req('/api/admin/presets', { cookie: admin })).json()) as {
      presets: { id: string; status: string; failCount: number; checkedAt: number | null }[]
    }
    expect(all.presets.map((p) => p.id).sort()).toEqual(['dead', 'flaky', 'good'])
    expect(all.presets.find((p) => p.id === 'dead')).toMatchObject({ status: 'fail', failCount: 2, checkedAt: null })
  })

  it('admin check endpoints: one preset and all of them', async () => {
    const probe = async (url: string) => (url.includes('a.example') ? VOL('-8') : 'broken')
    const t = setup({ presetProbe: probe })
    addPreset(t, 'a')
    addPreset(t, 'b')
    await addUser(t, 'a@x.io', 'admin')
    const admin = await login(t, 'a@x.io')
    const one = await t.req('/api/admin/presets/a/check', { cookie: admin, method: 'POST' })
    expect(await one.json()).toMatchObject({ id: 'a', status: 'ok', failCount: 0 })
    expect((await t.req('/api/admin/presets/zzz/check', { cookie: admin, method: 'POST' })).status).toBe(404)
    const all = await t.req('/api/admin/presets/check', { cookie: admin, method: 'POST', json: {} })
    expect(all.status).toBe(202)
    await checkAllPresets(t.db, probe)
    expect(row(t, 'b')?.status).toBe('fail')
    await addUser(t, 'u@x.io')
    const user = await login(t, 'u@x.io')
    expect((await t.req('/api/admin/presets/a/check', { cookie: user, method: 'POST' })).status).toBe(403)
  })
})
