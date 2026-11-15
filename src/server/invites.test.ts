import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { invites, stations, users } from './db/schema'
import { PASSWORD, addUser, login, setup } from './test-utils'
import type { T } from './test-utils'

async function adminCookie(t: T) {
  await addUser(t, 'admin@x.io', 'admin')
  return login(t, 'admin@x.io')
}

async function makeInvite(t: T, cookie: string, body: Record<string, unknown> = { email: 'new@x.io', role: 'user', days: 7 }) {
  const res = await t.req('/api/admin/invites', { method: 'POST', cookie, json: body })
  return { res, ...((await res.json()) as { url?: string }) }
}
const tokenOf = (url: string) => url.split('/').pop() as string

describe('invites', () => {
  it('admin creates a link that sets name + password and creates the station', async () => {
    const t = setup()
    const cookie = await adminCookie(t)
    const { res, url } = await makeInvite(t, cookie)
    expect(res.status).toBe(201)
    expect(url).toMatch(/^http:\/\/radio\.test\/invite\//)
    const token = tokenOf(url as string)

    const info = await t.req(`/api/auth/link/${token}`)
    expect(info.status).toBe(200)
    expect(await info.json()).toMatchObject({ kind: 'invite', email: 'new@x.io' })

    const accept = await t.req(`/api/auth/link/${token}`, { method: 'POST', json: { name: 'Marina', password: 'a very long password' } })
    expect(accept.status).toBe(200)
    expect(accept.headers.get('set-cookie')).toMatch(/ar_session=/)
    const user = t.db.select().from(users).where(eq(users.email, 'new@x.io')).get()
    expect(user).toMatchObject({ name: 'Marina', role: 'user' })
    expect(user?.passwordHash).toMatch(/^pbkdf2-sha256\$/)
    expect(
      t.db
        .select()
        .from(stations)
        .where(eq(stations.userId, user?.id ?? ''))
        .all(),
    ).toHaveLength(1)
    // and the new user can sign in
    expect(await login(t, 'new@x.io', 'a very long password')).toMatch(/ar_session=/)
  })

  it('is single use', async () => {
    const t = setup()
    const { url } = await makeInvite(t, await adminCookie(t))
    const token = tokenOf(url as string)
    const body = { name: 'Marina', password: 'a very long password' }
    expect((await t.req(`/api/auth/link/${token}`, { method: 'POST', json: body })).status).toBe(200)
    expect((await t.req(`/api/auth/link/${token}`, { method: 'POST', json: body })).status).toBe(410)
    expect((await t.req(`/api/auth/link/${token}`)).status).toBe(410)
  })

  it('expires', async () => {
    const t = setup()
    const { url } = await makeInvite(t, await adminCookie(t), { email: 'new@x.io', role: 'user', days: 1 })
    const token = tokenOf(url as string)
    t.db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .run()
    expect((await t.req(`/api/auth/link/${token}`)).status).toBe(410)
    expect((await t.req(`/api/auth/link/${token}`, { method: 'POST', json: { name: 'M', password: 'a very long password' } })).status).toBe(
      410,
    )
    expect(t.db.select().from(users).where(eq(users.email, 'new@x.io')).all()).toHaveLength(0)
  })

  it('only 1, 7 or 30 days; role is stored', async () => {
    const t = setup()
    const cookie = await adminCookie(t)
    expect((await makeInvite(t, cookie, { email: 'a@x.io', days: 5 })).res.status).toBe(400)
    const { url } = await makeInvite(t, cookie, { email: 'boss@x.io', role: 'admin', days: 30 })
    await t.req(`/api/auth/link/${tokenOf(url as string)}`, { method: 'POST', json: { name: 'Boss', password: 'a very long password' } })
    expect(t.db.select().from(users).where(eq(users.email, 'boss@x.io')).get()?.role).toBe('admin')
  })

  it('refuses a password shorter than 12 characters and keeps the link usable', async () => {
    const t = setup()
    const { url } = await makeInvite(t, await adminCookie(t))
    const token = tokenOf(url as string)
    const res = await t.req(`/api/auth/link/${token}`, { method: 'POST', json: { name: 'M', password: 'short-pass' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'password_too_short' })
    expect((await t.req(`/api/auth/link/${token}`)).status).toBe(200)
  })

  it('refuses an email that already has an account and non-admins', async () => {
    const t = setup()
    const cookie = await adminCookie(t)
    await addUser(t, 'taken@x.io')
    expect((await makeInvite(t, cookie, { email: 'TAKEN@x.io', days: 7 })).res.status).toBe(409)
    const userCookie = await login(t, 'taken@x.io')
    expect((await makeInvite(t, userCookie)).res.status).toBe(403)
  })

  it('stores only the hash of the token', async () => {
    const t = setup()
    const { url } = await makeInvite(t, await adminCookie(t))
    const row = t.db.select().from(invites).get()
    expect(row?.tokenHash).toHaveLength(64)
    expect(row?.tokenHash).not.toContain(tokenOf(url as string))
  })
})

describe('password reset', () => {
  it('admin gets a one-time link; it sets a new password and signs the old sessions out', async () => {
    const t = setup()
    const cookie = await adminCookie(t)
    const { user } = await addUser(t, 'marina@x.io')
    const oldCookie = await login(t, 'marina@x.io')
    const res = await t.req(`/api/admin/users/${user.id}/reset`, { method: 'POST', cookie })
    const { url } = (await res.json()) as { url: string }
    expect(url).toMatch(/\/reset\//)
    const token = tokenOf(url)
    const done = await t.req(`/api/auth/link/${token}`, { method: 'POST', json: { password: 'brand new password!' } })
    expect(done.status).toBe(200)
    expect((await t.req('/api/auth/me', { cookie: oldCookie })).status).toBe(401)
    expect(await login(t, 'marina@x.io', 'brand new password!')).toMatch(/ar_session=/)
    expect((await t.req('/api/auth/login', { method: 'POST', json: { email: 'marina@x.io', password: PASSWORD } })).status).toBe(401)
    expect((await t.req(`/api/auth/link/${token}`, { method: 'POST', json: { password: 'another new password' } })).status).toBe(410)
  })
})
