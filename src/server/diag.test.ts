import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIAG_MAX_FILE } from './lib/diag'
import { addUser, login, setup } from './test-utils'

const ev = (type: string, n = 0) => ({ t: 1000 + n, type, data: { n } })

describe('player diagnostics (/api/app/diag)', () => {
  it('needs a session and a same-origin request', async () => {
    const t = setup()
    expect((await t.req('/api/app/diag', { method: 'POST', json: { events: [] } })).status).toBe(401)
    expect((await t.req('/api/app/diag')).status).toBe(401)
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const res = await t.req('/api/app/diag', { method: 'POST', cookie, json: { events: [ev('x')] }, origin: 'https://evil.example' })
    expect(res.status).toBe(403)
  })

  it('stores events with the receive time and user agent, and returns them to the same user only', async () => {
    const t = setup()
    const a = await addUser(t, 'a@x.io')
    await addUser(t, 'b@x.io')
    const ca = await login(t, 'a@x.io')
    const cb = await login(t, 'b@x.io')
    const res = await t.req('/api/app/diag', {
      method: 'POST',
      cookie: ca,
      headers: { 'User-Agent': 'iPhone-test' },
      json: { events: [ev('play'), ev('pause', 1)] },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, count: 2 })
    const got = (await (await t.req('/api/app/diag', { cookie: ca })).json()) as { events: Record<string, unknown>[] }
    expect(got.events.map((e) => e.type)).toEqual(['play', 'pause'])
    expect(got.events[0]).toMatchObject({ t: 1000, ua: 'iPhone-test', data: { n: 0 } })
    expect(typeof got.events[0]?.receivedAt).toBe('number')
    expect(
      readFileSync(join(t.config.dataDir, 'diag', `${a.user.id}.jsonl`), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(2)
    const other = (await (await t.req('/api/app/diag', { cookie: cb })).json()) as { events: unknown[] }
    expect(other.events).toEqual([])
  })

  it('the tail is the last 200 lines', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const c = await login(t, 'a@x.io')
    for (let i = 0; i < 3; i++) {
      const events = Array.from({ length: 100 }, (_, j) => ev('e', i * 100 + j))
      expect((await t.req('/api/app/diag', { method: 'POST', cookie: c, json: { events } })).status).toBe(200)
    }
    const got = (await (await t.req('/api/app/diag', { cookie: c })).json()) as { events: { data: { n: number } }[] }
    expect(got.events).toHaveLength(200)
    expect(got.events[0]?.data.n).toBe(100)
  })

  it('rejects more than 100 events, a body over 8 KB and a bad shape', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const post = (json: unknown) => t.req('/api/app/diag', { method: 'POST', cookie, json })
    expect((await post({ events: Array.from({ length: 101 }, () => ({ t: 1, type: 'e' })) })).status).toBe(400)
    expect((await post({ events: [{ t: 1, type: 'e', data: { s: 'x'.repeat(9000) } }] })).status).toBe(413)
    expect((await post({ events: [{ t: 'now', type: 'e' }] })).status).toBe(400)
    expect((await post({})).status).toBe(400)
    const bad = await t.req('/api/app/diag', { method: 'POST', cookie, body: 'not json', headers: { 'Content-Type': 'application/json' } })
    expect(bad.status).toBe(400)
  })

  it('keeps the file near 1 MB by dropping the oldest half', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    // 12 events of ~550 bytes: a request under 8 KB
    for (let i = 0; i < 400; i++) {
      const events = Array.from({ length: 12 }, (_, j) => ({ t: i * 12 + j, type: 'big', data: { pad: 'x'.repeat(400) } }))
      const res = await t.req('/api/app/diag', { method: 'POST', cookie, json: { events } })
      expect(res.status).toBe(200)
    }
    const file = join(t.config.dataDir, 'diag', `${user.id}.jsonl`)
    expect(statSync(file).size).toBeLessThanOrEqual(DIAG_MAX_FILE)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(JSON.parse(lines[lines.length - 1] as string).t).toBe(400 * 12 - 1)
    expect(JSON.parse(lines[0] as string).t).toBeGreaterThan(0)
  })
})
