// Server flows of the passkeys with the WebAuthn library mocked (its signature checks are the library's business).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { passkeys } from './db/schema'
import { addUser, cookieOf, login, setup } from './test-utils'

const verifyReg = vi.fn()
const verifyAuth = vi.fn()
vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(async (o: { challenge: Uint8Array; rpID: string }) => ({
    challenge: Buffer.from(o.challenge).toString('base64url'),
    rp: { id: o.rpID },
  })),
  generateAuthenticationOptions: vi.fn(async (o: { challenge: Uint8Array; rpID: string; allowCredentials?: unknown }) => ({
    challenge: Buffer.from(o.challenge).toString('base64url'),
    rpId: o.rpID,
    allowCredentials: o.allowCredentials,
  })),
  verifyRegistrationResponse: (...a: unknown[]) => verifyReg(...a),
  verifyAuthenticationResponse: (...a: unknown[]) => verifyAuth(...a),
}))

beforeEach(() => {
  verifyReg.mockReset()
  verifyAuth.mockReset()
})

const regResponse = (id = 'cred-1') => ({
  id,
  rawId: id,
  type: 'public-key',
  response: { clientDataJSON: 'Y2xpZW50', attestationObject: 'YXR0ZXN0' },
  clientExtensionResults: {},
})
const authResponse = (id: string, userHandle?: string) => ({
  id,
  rawId: id,
  type: 'public-key',
  response: { clientDataJSON: 'Y2xpZW50', authenticatorData: 'YXV0aA', signature: 'c2ln', userHandle },
  clientExtensionResults: {},
})

function okRegistration(id = 'cred-1') {
  verifyReg.mockResolvedValueOnce({
    verified: true,
    registrationInfo: {
      userVerified: true,
      credential: { id, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] },
    },
  })
}

async function register(t: ReturnType<typeof setup>, cookie: string, id = 'cred-1', name = 'Phone') {
  const opts = await t.req('/api/auth/passkeys/options', { method: 'POST', cookie, json: {} })
  expect(opts.status).toBe(200)
  okRegistration(id)
  return t.req('/api/auth/passkeys', { method: 'POST', cookie, json: { response: regResponse(id), name } })
}

async function loginOptions(t: ReturnType<typeof setup>) {
  const res = await t.req('/api/auth/passkey/options', { method: 'POST', json: {} })
  return { res, cookie: cookieOf(res), body: (await res.json()) as { challenge: string; rpId: string; allowCredentials?: unknown } }
}

describe('passkey registration', () => {
  it('uses the host of PUBLIC_URL as RP ID and registers a passkey, listed with name and dates', async () => {
    const t = setup()
    await addUser(t, 'a@x.test')
    const cookie = await login(t, 'a@x.test')
    const opts = (await (await t.req('/api/auth/passkeys/options', { method: 'POST', cookie, json: {} })).json()) as { rp: { id: string } }
    expect(opts.rp.id).toBe('radio.test')
    okRegistration()
    const res = await t.req('/api/auth/passkeys', { method: 'POST', cookie, json: { response: regResponse(), name: 'Phone' } })
    expect(res.status).toBe(201)
    // origin and RP ID are what the library is asked to enforce
    expect(verifyReg).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedOrigin: 'http://radio.test', expectedRPID: 'radio.test', requireUserVerification: true }),
    )
    const list = (await (await t.req('/api/auth/passkeys', { cookie })).json()) as { passkeys: Record<string, unknown>[] }
    expect(list.passkeys).toHaveLength(1)
    expect(list.passkeys[0]).toMatchObject({ name: 'Phone', lastUsedAt: null })
    expect(list.passkeys[0]?.createdAt).toBeTruthy()
    // the public key never leaves the server
    expect(JSON.stringify(list)).not.toContain('publicKey')
  })

  it('needs a session, a fresh challenge, and a verification that holds', async () => {
    const t = setup()
    expect((await t.req('/api/auth/passkeys/options', { method: 'POST', json: {} })).status).toBe(401)
    await addUser(t, 'a@x.test')
    const cookie = await login(t, 'a@x.test')
    // no challenge asked for
    expect((await t.req('/api/auth/passkeys', { method: 'POST', cookie, json: { response: regResponse() } })).status).toBe(400)
    // verification fails: nothing is stored, the challenge is spent
    await t.req('/api/auth/passkeys/options', { method: 'POST', cookie, json: {} })
    verifyReg.mockRejectedValueOnce(new Error('bad'))
    const bad = await t.req('/api/auth/passkeys', { method: 'POST', cookie, json: { response: regResponse() } })
    expect(((await bad.json()) as { error: string }).error).toBe('passkey_invalid')
    expect(t.db.select().from(passkeys).all()).toHaveLength(0)
    okRegistration()
    expect((await t.req('/api/auth/passkeys', { method: 'POST', cookie, json: { response: regResponse() } })).status).toBe(400)
  })

  it('refuses the same credential twice and more than 10 passkeys', async () => {
    const t = setup()
    await addUser(t, 'a@x.test')
    const cookie = await login(t, 'a@x.test')
    expect((await register(t, cookie, 'c0')).status).toBe(201)
    expect((await register(t, cookie, 'c0')).status).toBe(409)
    for (let i = 1; i < 10; i++) expect((await register(t, cookie, `c${i}`)).status).toBe(201)
    const over = await t.req('/api/auth/passkeys/options', { method: 'POST', cookie, json: {} })
    expect(over.status).toBe(400)
  })

  it('deletes only the own passkeys, and keeps the last way in of a passwordless account', async () => {
    const t = setup()
    const a = await addUser(t, 'a@x.test')
    await addUser(t, 'b@x.test')
    const ca = await login(t, 'a@x.test')
    const cb = await login(t, 'b@x.test')
    await register(t, ca, 'ca1')
    const id = t.db.select().from(passkeys).get()?.id ?? ''
    expect((await t.req(`/api/auth/passkeys/${id}`, { method: 'DELETE', cookie: cb })).status).toBe(404)
    expect((await t.req(`/api/auth/passkeys/${id}`, { method: 'DELETE', cookie: ca })).status).toBe(200)
    expect(t.db.select().from(passkeys).all()).toHaveLength(0)
    // passwordless user with one passkey
    const { users } = await import('./db/schema')
    const { eq } = await import('drizzle-orm')
    await register(t, ca, 'ca2')
    t.db.update(users).set({ passwordHash: null }).where(eq(users.id, a.user.id)).run()
    const only = t.db.select().from(passkeys).get()?.id ?? ''
    const res = await t.req(`/api/auth/passkeys/${only}`, { method: 'DELETE', cookie: ca })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('last_credential')
  })
})

describe('passkey sign-in (usernameless)', () => {
  async function withPasskey() {
    const t = setup()
    const a = await addUser(t, 'a@x.test')
    const cookie = await login(t, 'a@x.test')
    await register(t, cookie, 'cred-1')
    return { t, user: a.user }
  }
  const okAuth = (counter = 5) =>
    verifyAuth.mockResolvedValueOnce({ verified: true, authenticationInfo: { userVerified: true, newCounter: counter } })

  it('offers options with no allowCredentials and signs in with a valid answer', async () => {
    const { t, user } = await withPasskey()
    const { res, cookie, body } = await loginOptions(t)
    expect(res.status).toBe(200)
    expect(body.allowCredentials).toBeUndefined()
    expect(body.rpId).toBe('radio.test')
    okAuth()
    const handle = Buffer.from(user.id).toString('base64url')
    const done = await t.req('/api/auth/passkey/login', { method: 'POST', cookie, json: { response: authResponse('cred-1', handle) } })
    expect(done.status).toBe(200)
    const session = (done.headers.getSetCookie().find((c) => c.startsWith('ar_session=')) ?? '').split(';')[0] ?? ''
    expect(session).toContain('ar_session=')
    const me = await t.req('/api/auth/me', { cookie: session })
    expect(me.status).toBe(200)
    const row = t.db.select().from(passkeys).get()
    expect(row?.signCount).toBe(5)
    expect(row?.lastUsedAt).toBeTruthy()
    expect(verifyAuth).toHaveBeenLastCalledWith(expect.objectContaining({ expectedChallenge: body.challenge, expectedRPID: 'radio.test' }))
  })

  it('a challenge works once', async () => {
    const { t } = await withPasskey()
    const { cookie } = await loginOptions(t)
    okAuth()
    expect((await t.req('/api/auth/passkey/login', { method: 'POST', cookie, json: { response: authResponse('cred-1') } })).status).toBe(
      200,
    )
    okAuth(6)
    expect((await t.req('/api/auth/passkey/login', { method: 'POST', cookie, json: { response: authResponse('cred-1') } })).status).toBe(
      401,
    )
  })

  it('refuses without a challenge, an unknown credential, a failed signature, a regressed counter', async () => {
    const { t } = await withPasskey()
    const post = (cookie: string, id: string) =>
      t.req('/api/auth/passkey/login', { method: 'POST', cookie, json: { response: authResponse(id) } })
    expect((await post('', 'cred-1')).status).toBe(401)

    let { cookie } = await loginOptions(t)
    verifyAuth.mockResolvedValueOnce({ verified: false, authenticationInfo: { userVerified: false, newCounter: 0 } })
    const unknown = await post(cookie, 'nope')
    expect(unknown.status).toBe(401)
    expect(((await unknown.json()) as { error: string }).error).toBe('passkey_failed')

    ;({ cookie } = await loginOptions(t))
    verifyAuth.mockRejectedValueOnce(new Error('bad signature'))
    expect((await post(cookie, 'cred-1')).status).toBe(401)

    ;({ cookie } = await loginOptions(t))
    okAuth(5)
    expect((await post(cookie, 'cred-1')).status).toBe(200)
    ;({ cookie } = await loginOptions(t))
    okAuth(5)
    expect((await post(cookie, 'cred-1')).status).toBe(401)
  })

  it('refuses a disabled user and a user handle of somebody else', async () => {
    const { t, user } = await withPasskey()
    const { users } = await import('./db/schema')
    const { eq } = await import('drizzle-orm')
    let { cookie } = await loginOptions(t)
    okAuth()
    const wrong = Buffer.from('someone-else').toString('base64url')
    expect(
      (await t.req('/api/auth/passkey/login', { method: 'POST', cookie, json: { response: authResponse('cred-1', wrong) } })).status,
    ).toBe(401)
    ;({ cookie } = await loginOptions(t))
    t.db.update(users).set({ disabledAt: new Date().toISOString() }).where(eq(users.id, user.id)).run()
    okAuth()
    expect((await t.req('/api/auth/passkey/login', { method: 'POST', cookie, json: { response: authResponse('cred-1') } })).status).toBe(
      401,
    )
  })

  it('advertises passkeys in /me', async () => {
    const t = setup()
    await addUser(t, 'a@x.test')
    const cookie = await login(t, 'a@x.test')
    expect(((await (await t.req('/api/auth/me', { cookie })).json()) as { features: { passkeys: boolean } }).features.passkeys).toBe(true)
  })
})
