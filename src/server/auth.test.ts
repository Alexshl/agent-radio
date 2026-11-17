import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessions } from './db/schema'
import { PASSWORD, addUser, cookieOf, login, setup } from './test-utils'

describe('login', () => {
  it('signs in with the right password: httpOnly SameSite=Lax cookie, only the hash of the token is stored', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const res = await t.req('/api/auth/login', { method: 'POST', json: { email: 'A@x.io', password: PASSWORD } })
    expect(res.status).toBe(200)
    const raw = res.headers.get('set-cookie') ?? ''
    expect(raw).toMatch(/ar_session=/)
    expect(raw).toMatch(/HttpOnly/i)
    expect(raw).toMatch(/SameSite=Lax/i)
    expect(raw).not.toMatch(/Secure/i) // plain http (local use)
  })

  it('sets Secure behind https (PUBLIC_URL or X-Forwarded-Proto)', async () => {
    const t = setup({ env: { PUBLIC_URL: 'https://radio.test' } })
    await addUser(t, 'a@x.io')
    const res = await t.req('/api/auth/login', { method: 'POST', json: { email: 'a@x.io', password: PASSWORD } })
    expect(res.headers.get('set-cookie')).toMatch(/Secure/i)
    const t2 = setup()
    await addUser(t2, 'a@x.io')
    const res2 = await t2.req('/api/auth/login', {
      method: 'POST',
      json: { email: 'a@x.io', password: PASSWORD },
      headers: { 'X-Forwarded-Proto': 'https' },
    })
    expect(res2.headers.get('set-cookie')).toMatch(/Secure/i)
  })

  it('rejects a wrong password and an unknown email the same way', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const wrong = await t.req('/api/auth/login', { method: 'POST', json: { email: 'a@x.io', password: 'not the password!!' } })
    const unknown = await t.req('/api/auth/login', { method: 'POST', json: { email: 'nobody@x.io', password: 'not the password!!' } })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(await wrong.json()).toEqual(await unknown.json())
    expect(wrong.headers.get('set-cookie')).toBeNull()
  })

  it('does not let a disabled user in', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    t.db.$client.prepare('update users set disabled_at = ? where id = ?').run(new Date().toISOString(), user.id)
    const res = await t.req('/api/auth/login', { method: 'POST', json: { email: 'a@x.io', password: PASSWORD } })
    expect(res.status).toBe(401)
  })

  it('rate-limits per IP + email', async () => {
    const t = setup({ authLimit: 3 })
    await addUser(t, 'a@x.io')
    const attempt = (email: string) =>
      t.req('/api/auth/login', {
        method: 'POST',
        json: { email, password: 'wrong wrong wrong' },
        headers: { 'cf-connecting-ip': '1.2.3.4' },
      })
    for (let i = 0; i < 3; i++) expect((await attempt('a@x.io')).status).toBe(401)
    const blocked = await attempt('a@x.io')
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBeTruthy()
    // another email from the same IP has its own budget
    expect((await attempt('b@x.io')).status).toBe(401)
  })
})

describe('sessions', () => {
  it('/me works with the cookie and not without', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    expect((await t.req('/api/auth/me')).status).toBe(401)
    const cookie = await login(t, 'a@x.io')
    const me = await t.req('/api/auth/me', { cookie })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe('a@x.io')
  })

  it('an expired session is refused and removed', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    t.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .run()
    expect((await t.req('/api/auth/me', { cookie })).status).toBe(401)
    expect(t.db.select().from(sessions).all()).toHaveLength(0)
  })

  it('logout ends the session on the server', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    expect((await t.req('/api/auth/logout', { method: 'POST', cookie })).status).toBe(200)
    expect((await t.req('/api/auth/me', { cookie })).status).toBe(401)
  })

  it('a disabled user loses the session', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    t.db.$client.prepare('update users set disabled_at = ? where id = ?').run(new Date().toISOString(), user.id)
    expect((await t.req('/api/auth/me', { cookie })).status).toBe(401)
  })

  it('the session cookie itself is a random token, not the stored value', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const row = t.db.select().from(sessions).get()
    expect(cookie.split('=')[1]).not.toBe(row?.id)
    expect(row?.id).toHaveLength(64)
  })
})

describe('CSRF', () => {
  it('rejects cookie-authenticated mutations from another origin or without Origin', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const body = { type: 'silence' }
    expect((await t.req('/api/app/station/source', { method: 'PUT', cookie, json: body, origin: 'https://evil.example' })).status).toBe(403)
    expect((await t.req('/api/app/station/source', { method: 'PUT', cookie, json: body, origin: null })).status).toBe(403)
    expect((await t.req('/api/app/station/source', { method: 'PUT', cookie, json: body })).status).toBe(200)
  })

  it('accepts Sec-Fetch-Site: same-origin when there is no Origin header', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const res = await t.req('/api/app/station/source', {
      method: 'PUT',
      cookie,
      json: { type: 'silence' },
      origin: null,
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    })
    expect(res.status).toBe(200)
  })

  it('protects the login itself (login CSRF)', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const res = await t.req('/api/auth/login', {
      method: 'POST',
      json: { email: 'a@x.io', password: PASSWORD },
      origin: 'https://evil.example',
    })
    expect(res.status).toBe(403)
    expect(cookieOf(res)).toBe('')
  })
})

describe('role guards', () => {
  it('admin routes need a session and the admin role', async () => {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    await addUser(t, 'user@x.io')
    expect((await t.req('/api/admin/users')).status).toBe(401)
    const userCookie = await login(t, 'user@x.io')
    expect((await t.req('/api/admin/users', { cookie: userCookie })).status).toBe(403)
    expect((await t.req('/api/admin/settings', { method: 'PUT', cookie: userCookie, json: { allowOwnUrls: false } })).status).toBe(403)
    expect((await t.req('/api/admin/engine/restart', { method: 'POST', cookie: userCookie })).status).toBe(403)
    expect((await t.req('/api/admin/backup', { cookie: userCookie })).status).toBe(403)
    const adminCookie = await login(t, 'admin@x.io')
    const res = await t.req('/api/admin/users', { cookie: adminCookie })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { users: unknown[] }).users).toHaveLength(2)
  })

  it('an API key does not open the browser or admin routes', async () => {
    const t = setup()
    const { token } = await (await import('./test-utils')).userWithKey(t, 'k@x.io')
    expect((await t.req('/api/admin/users', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
    expect((await t.req('/api/app/radio', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
  })

  it('an admin cannot demote or disable themselves', async () => {
    const t = setup()
    const { user } = await addUser(t, 'admin@x.io', 'admin')
    const cookie = await login(t, 'admin@x.io')
    expect((await t.req(`/api/admin/users/${user.id}`, { method: 'PATCH', cookie, json: { role: 'user' } })).status).toBe(400)
    expect((await t.req(`/api/admin/users/${user.id}`, { method: 'PATCH', cookie, json: { disabled: true } })).status).toBe(400)
  })
})

describe('iOS app handoff (PKCE)', () => {
  const verifier = 'v'.repeat(43)
  const cc = createHash('sha256').update(verifier).digest('base64url')

  async function codeFor(t: ReturnType<typeof setup>) {
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const res = await t.req('/api/auth/app-handoff', { method: 'POST', cookie, json: { cc } })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
    const loc = ((await res.json()) as { url: string }).url
    expect(loc).toMatch(/^agentradio:\/\/auth\?code=/)
    return decodeURIComponent(loc.split('code=')[1] ?? '')
  }
  const exchange = (t: ReturnType<typeof setup>, code: string, v = verifier) =>
    t.req('/api/auth/app-token', { method: 'POST', json: { code, verifier: v } })

  afterEach(() => vi.restoreAllMocks())

  it('rejects a handoff without a valid cc', async () => {
    const t = setup()
    expect((await t.req('/api/auth/app-handoff', { method: 'POST', json: {} })).status).toBe(400)
    expect((await t.req('/api/auth/app-handoff', { method: 'POST', json: { cc: 'short' } })).status).toBe(400)
    // never by a plain link
    expect((await t.req(`/api/auth/app-handoff?cc=${cc}`)).status).not.toBe(200)
  })

  it('refuses a handoff without a session', async () => {
    const t = setup()
    expect((await t.req('/api/auth/app-handoff', { method: 'POST', json: { cc } })).status).toBe(401)
  })

  it('trades code + verifier for a working session token, without setting a cookie', async () => {
    const t = setup()
    const code = await codeFor(t)
    const res = await exchange(t, code)
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
    const { token } = (await res.json()) as { token: string }
    expect((await t.req('/api/app/radio', { cookie: `ar_session=${token}` })).status).toBe(200)
  })

  it('accepts a code only once', async () => {
    const t = setup()
    const code = await codeFor(t)
    expect((await exchange(t, code)).status).toBe(200)
    expect((await exchange(t, code)).status).toBe(401)
  })

  it('burns the code on a wrong verifier', async () => {
    const t = setup()
    const code = await codeFor(t)
    expect((await exchange(t, code, 'w'.repeat(43))).status).toBe(401)
    expect((await exchange(t, code)).status).toBe(401)
  })

  it('rejects an expired code', async () => {
    const t = setup()
    const code = await codeFor(t)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    expect((await exchange(t, code)).status).toBe(401)
  })
})
