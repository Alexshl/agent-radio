import { describe, expect, it } from 'vitest'
import { addUser, login, setup } from './test-utils'

describe('agent keys (browser API)', () => {
  it('creates a key shown once, lists it, and the key works on /api/status', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const created = await t.req('/api/app/keys', { method: 'POST', cookie, json: { name: 'studio-mac' } })
    expect(created.status).toBe(201)
    const { token, key } = (await created.json()) as { token: string; key: { id: string; prefix: string } }
    expect(token).toMatch(/^ar_/)

    const list = (await (await t.req('/api/app/keys', { cookie })).json()) as { keys: { name: string; lastUsedAt: string | null }[] }
    expect(list.keys).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(token)

    const status = await t.req('/api/status', { headers: { Authorization: `Bearer ${token}` } })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ lang: 'uk', speakSession: true })
    expect(key.prefix).toBe(token.slice(0, 11))
  })

  it('records the last session and time on /say', async () => {
    const t = setup({ listeners: 0 })
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const { token } = (await (await t.req('/api/app/keys', { cookie, method: 'POST', json: { name: 'devbox' } })).json()) as {
      token: string
    }
    await t.req('/api/say', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      json: { session: 'invoa', text: 'hi' },
      origin: null,
    })
    const list = (await (await t.req('/api/app/keys', { cookie })).json()) as { keys: { lastSession: string; lastUsedAt: string }[] }
    expect(list.keys[0]).toMatchObject({ lastSession: 'invoa' })
    expect(list.keys[0]?.lastUsedAt).toBeTruthy()
  })

  it('revokes a key: it stops working and shows as revoked', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const { token, key } = (await (await t.req('/api/app/keys', { cookie, method: 'POST', json: { name: 'x' } })).json()) as {
      token: string
      key: { id: string }
    }
    expect((await t.req(`/api/app/keys/${key.id}`, { method: 'DELETE', cookie })).status).toBe(200)
    expect((await t.req('/api/status', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
    const list = (await (await t.req('/api/app/keys', { cookie })).json()) as { keys: { revokedAt: string | null }[] }
    expect(list.keys[0]?.revokedAt).toBeTruthy()
  })

  it("cannot revoke or see another user's keys", async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    await addUser(t, 'b@x.io')
    const a = await login(t, 'a@x.io')
    const b = await login(t, 'b@x.io')
    const { token, key } = (await (await t.req('/api/app/keys', { cookie: a, method: 'POST', json: { name: 'x' } })).json()) as {
      token: string
      key: { id: string }
    }
    expect((await t.req(`/api/app/keys/${key.id}`, { method: 'DELETE', cookie: b })).status).toBe(404)
    expect((await t.req('/api/status', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
    expect(((await (await t.req('/api/app/keys', { cookie: b })).json()) as { keys: unknown[] }).keys).toHaveLength(0)
  })

  it('needs a key name', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    expect((await t.req('/api/app/keys', { cookie, method: 'POST', json: { name: '  ' } })).status).toBe(400)
  })
})
