import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanup } from './retention'
import { addUser, login, setup, userWithKey } from './test-utils'
import type { T } from './test-utils'

const DAY = 86400_000

function addMessage(t: T, userId: string, ageDays: number, clip: string | null) {
  t.db.$client
    .prepare('insert into messages (id, user_id, session, text, status, type, clip_path, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      `m${ageDays}-${Math.random()}`,
      userId,
      's',
      `text ${ageDays}d`,
      'aired',
      'voice',
      clip,
      new Date(Date.now() - ageDays * DAY).toISOString(),
    )
}

function addClip(t: T, name: string, ageDays: number) {
  const dir = join(t.config.sharedDir, 'clips')
  mkdirSync(dir, { recursive: true })
  const f = join(dir, name)
  writeFileSync(f, 'x')
  const when = new Date(Date.now() - ageDays * DAY)
  utimesSync(f, when, when)
  return f
}

describe('retention cleanup', () => {
  it('deletes messages after 30 days and clips (voice and audio) after 7', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const oldClip = addClip(t, 'old.mp3', 8)
    const freshClip = addClip(t, 'fresh.mp3', 2)
    const veryOld = addClip(t, 'veryold.mp3', 40)
    addMessage(t, user.id, 31, veryOld)
    addMessage(t, user.id, 10, oldClip)
    addMessage(t, user.id, 1, freshClip)

    const r = cleanup(t.db, t.config)
    expect(r).toEqual({ messages: 1, clips: 2 })
    expect(existsSync(oldClip)).toBe(false)
    expect(existsSync(veryOld)).toBe(false)
    expect(existsSync(freshClip)).toBe(true)
    const rows = t.db.$client.prepare('select text, clip_path from messages order by created_at').all() as {
      text: string
      clip_path: string | null
    }[]
    // the 31-day message is gone; the 10-day one stays as text only; the fresh one keeps its clip
    expect(rows).toEqual([
      { text: 'text 10d', clip_path: null },
      { text: 'text 1d', clip_path: freshClip },
    ])
  })

  it('also drops expired sessions and old invites, and is safe without a clips folder', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    await login(t, 'a@x.io')
    t.db.$client.prepare('update sessions set expires_at = ?').run(new Date(Date.now() - 1000).toISOString())
    expect(cleanup(t.db, t.config)).toEqual({ messages: 0, clips: 0 })
    expect(t.db.$client.prepare('select count(*) n from sessions').get()).toEqual({ n: 0 })
  })

  it('history shows only the last 30 days', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    addMessage(t, user.id, 31, null)
    addMessage(t, user.id, 3, null)
    const cookie = await login(t, 'a@x.io')
    const h = (await (await t.req('/api/app/history', { cookie })).json()) as { messages: { text: string }[] }
    expect(h.messages.map((m) => m.text)).toEqual(['text 3d'])
  })
})

describe('on-demand replay of a skipped message', () => {
  it('synthesizes with the current voice and then serves the clip', async () => {
    const t = setup({ listeners: 0 })
    const { token } = await userWithKey(t, 'a@x.io')
    await t.req('/api/say', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      json: { session: 'fdesk', text: 'Деплой завершён' },
      origin: null,
    })
    const cookie = await login(t, 'a@x.io')
    const id = (
      (await (await t.req('/api/app/history', { cookie })).json()) as { messages: { id: string; status: string; hasClip: boolean }[] }
    ).messages[0] as { id: string; status: string; hasClip: boolean }
    expect(id).toMatchObject({ status: 'skipped', hasClip: false })
    expect(t.makeClip).not.toHaveBeenCalled()
    expect((await t.req(`/api/app/history/${id.id}/audio`, { cookie })).status).toBe(404)
    expect((await t.req(`/api/app/history/${id.id}/synthesize`, { cookie, method: 'POST' })).status).toBe(200)
    expect(t.makeClip).toHaveBeenCalledWith(expect.objectContaining({ text: 'Сесія fdesk. Деплой завершён', chime: false }))
    expect((await t.req(`/api/app/history/${id.id}/audio`, { cookie })).status).toBe(200)
    // the second call does not synthesize again
    await t.req(`/api/app/history/${id.id}/synthesize`, { cookie, method: 'POST' })
    expect(t.makeClip).toHaveBeenCalledTimes(1)
  })
})
