import { createHash, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { passkeys, users } from '../db/schema'
import type { FullDeps } from '../deps'
import type { AppEnv } from '../env'
import {
  HOST_SESSION_COOKIE,
  SESSION_COOKIE,
  clientIp,
  csrfGuard,
  dropUserSessions,
  endSession,
  isSecureRequest,
  requireSession,
  startSession,
  createSession,
  userOfToken,
} from '../lib/auth'
import { HttpError, badRequest, notFound } from '../lib/http'
import { base64urlDecode, newId, nowIso, randomToken } from '../lib/ids'
import { acceptLink, findUsableLink } from '../lib/invites'
import {
  DUMMY_PASSKEY,
  MAX_PASSKEYS_PER_USER,
  PASSKEY_CHALLENGE_TTL_MS,
  PASSKEY_NAME_MAX,
  authenticationOptions,
  authenticationResponseSchema,
  listPasskeys,
  passkeyView,
  putChallenge,
  registrationOptions,
  registrationResponseSchema,
  takeChallenge,
  verifyAssertion,
  verifyRegistration,
} from '../lib/passkeys'
import { checkPasswordPolicy, hashPassword, spendPasswordCheck, verifyPassword } from '../lib/password'
import { learnView } from '../learn/plays'
import { findUserByEmail, stationOfUser } from '../stations'

const loginBody = z.object({ email: z.string().trim().min(1).max(320), password: z.string().min(1).max(500) })
const acceptBody = z.object({ name: z.string().trim().max(120).optional(), password: z.string().min(1).max(500) })

const PASSKEY_COOKIE = 'ar_passkey'
const passkeyFailed = () => new HttpError(401, 'passkey_failed', 'Could not sign in with the passkey')

export function publicUser(u: typeof users.$inferSelect) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, lang: u.lang }
}

const CC_RE = /^[A-Za-z0-9_-]{43}$/
const APP_CODE_TTL_MS = 60_000
const appTokenBody = z.object({ code: z.string().min(1).max(200), verifier: z.string().min(43).max(128) })
// one-time codes for the iOS app handoff; short-lived, so process memory is enough
const appCodes = new Map<string, { userId: string; cc: string; expiresAt: number }>()
const sweepAppCodes = () => {
  const now = Date.now()
  for (const [k, v] of appCodes) if (v.expiresAt <= now) appCodes.delete(k)
}
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function authRoutes(deps: FullDeps) {
  const { db, config, authLimiter } = deps
  const r = new Hono<AppEnv>()
  r.use('*', csrfGuard(config))

  r.post('/login', async (c) => {
    const body = loginBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body', 'Expected {email, password}')
    const { email, password } = body.data
    authLimiter.check(`${clientIp(c, config)}|${email.toLowerCase()}`)
    const user = findUserByEmail(db, email)
    let ok = false
    if (user?.passwordHash) ok = await verifyPassword(password, user.passwordHash)
    else await spendPasswordCheck(password)
    if (!user || !ok || user.disabledAt) throw new HttpError(401, 'invalid_credentials', 'Wrong email or password')
    await startSession(db, config, c, user.id)
    return c.json({ user: publicUser(user) })
  })

  // ---- native iOS app sign-in (PKCE). The app opens /login?app=1&cc=<base64url(SHA256(verifier))> in the system
  // browser sheet (ASWebAuthenticationSession, passkeys work there). Signed in, the handoff issues a one-time code
  // bound to the user and cc, never a session; the app trades code + verifier for a session token over JSON.
  // POST from our own login page right after an interactive sign-in (never a GET a foreign page could trigger by a link)
  r.post('/app-handoff', async (c) => {
    const body = z.object({ cc: z.string() }).safeParse(await c.req.json().catch(() => null))
    const cc = body.success ? body.data.cc : ''
    if (!CC_RE.test(cc)) throw badRequest('invalid_challenge', 'Expected cc=base64url(SHA256(verifier))')
    c.header('Cache-Control', 'no-store')
    const current = getCookie(c, HOST_SESSION_COOKIE) ?? getCookie(c, SESSION_COOKIE)
    const user = current ? await userOfToken(db, current) : null
    if (!user) throw new HttpError(401, 'unauthorized', 'Sign in first')
    const code = randomToken(32)
    sweepAppCodes()
    appCodes.set(code, { userId: user.id, cc, expiresAt: Date.now() + APP_CODE_TTL_MS })
    return c.json({ url: `agentradio://auth?code=${encodeURIComponent(code)}` })
  })

  r.post('/app-token', async (c) => {
    const body = appTokenBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body', 'Expected {code, verifier}')
    const { code, verifier } = body.data
    authLimiter.check(`${clientIp(c, config)}|app-token`)
    const entry = appCodes.get(code)
    appCodes.delete(code) // single use, even when the check below fails
    const ok = !!entry && entry.expiresAt > Date.now() && safeEqual(createHash('sha256').update(verifier).digest('base64url'), entry.cc)
    const user = ok ? db.select().from(users).where(eq(users.id, entry.userId)).get() : null
    if (!user || user.disabledAt) throw new HttpError(401, 'invalid_code', 'Invalid or expired code')
    const token = await createSession(db, config, c, user.id)
    c.header('Cache-Control', 'no-store')
    return c.json({ token })
  })

  // ---- passkey sign-in (no session yet): the challenge belongs to the cookie of this attempt ----

  r.post('/passkey/options', async (c) => {
    authLimiter.check(`${clientIp(c, config)}|passkey-options`)
    const options = await authenticationOptions(config)
    const slot = randomToken(24)
    await putChallenge(db, { kind: 'passkey-login', slot, challenge: options.challenge, userId: null })
    setCookie(c, PASSKEY_COOKIE, slot, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isSecureRequest(c, config),
      path: '/api/auth',
      maxAge: Math.floor(PASSKEY_CHALLENGE_TTL_MS / 1000),
    })
    return c.json(options)
  })

  r.post('/passkey/login', async (c) => {
    authLimiter.check(`${clientIp(c, config)}|passkey-login`)
    const body = z.object({ response: authenticationResponseSchema }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body', 'Expected {response}')
    const slot = getCookie(c, PASSKEY_COOKIE)
    deleteCookie(c, PASSKEY_COOKIE, { path: '/api/auth' })
    // the challenge is spent whatever happens next
    const challenge = slot ? await takeChallenge(db, { kind: 'passkey-login', slot }) : null
    const response = body.data.response
    const stored = db.select().from(passkeys).where(eq(passkeys.credentialId, response.id)).get()
    if (!challenge) throw passkeyFailed()
    // an unknown credential id costs the same as a real failed check
    const result = await verifyAssertion(config, response as never, challenge, stored ?? DUMMY_PASSKEY)
    if (!stored || !result.ok) throw passkeyFailed()
    const user = db.select().from(users).where(eq(users.id, stored.userId)).get()
    // the user handle (when the authenticator sends one) is the id of the owner of the passkey
    const handle = response.response.userHandle ? base64urlDecode(response.response.userHandle) : null
    if (!user || user.disabledAt || (handle && new TextDecoder().decode(handle) !== user.id)) throw passkeyFailed()
    db.update(passkeys).set({ signCount: result.newCounter, lastUsedAt: nowIso() }).where(eq(passkeys.id, stored.id)).run()
    await startSession(db, config, c, user.id)
    return c.json({ user: publicUser(user) })
  })

  // ---- the passkeys of the signed-in user ----

  r.get('/passkeys', requireSession(db), (c) => c.json({ passkeys: listPasskeys(db, c.get('user').id).map(passkeyView) }))

  r.post('/passkeys/options', requireSession(db), async (c) => {
    const u = c.get('user')
    const existing = listPasskeys(db, u.id)
    if (existing.length >= MAX_PASSKEYS_PER_USER) throw new HttpError(400, 'passkey_limit', 'Too many passkeys')
    const options = await registrationOptions(config, u, existing, 'agent-radio')
    await putChallenge(db, { kind: 'passkey-register', slot: u.id, challenge: options.challenge, userId: u.id })
    return c.json(options)
  })

  r.post('/passkeys', requireSession(db), async (c) => {
    const u = c.get('user')
    const body = z
      .object({ response: registrationResponseSchema, name: z.string().trim().max(PASSKEY_NAME_MAX).optional() })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body', 'Expected {response, name?}')
    const challenge = await takeChallenge(db, { kind: 'passkey-register', slot: u.id, userId: u.id })
    if (!challenge) throw badRequest('challenge_expired', 'The request expired, try again')
    if (listPasskeys(db, u.id).length >= MAX_PASSKEYS_PER_USER) throw new HttpError(400, 'passkey_limit', 'Too many passkeys')
    let added: Awaited<ReturnType<typeof verifyRegistration>>
    try {
      added = await verifyRegistration(config, body.data.response as never, challenge)
    } catch {
      throw badRequest('passkey_invalid', 'The passkey could not be verified')
    }
    if (db.select().from(passkeys).where(eq(passkeys.credentialId, added.credentialId)).get())
      throw new HttpError(409, 'passkey_exists', 'This passkey is already registered')
    const row = {
      id: newId(),
      userId: u.id,
      credentialId: added.credentialId,
      publicKey: added.publicKey,
      signCount: added.signCount,
      transports: added.transports,
      name: body.data.name || 'Passkey',
      createdAt: nowIso(),
      lastUsedAt: null,
    }
    db.insert(passkeys).values(row).run()
    return c.json({ passkey: passkeyView(row) }, 201)
  })

  r.delete('/passkeys/:id', requireSession(db), (c) => {
    const u = c.get('user')
    const id = c.req.param('id')
    const list = listPasskeys(db, u.id)
    if (!list.some((p) => p.id === id)) throw notFound('Passkey not found')
    // an account with no password must keep one way in
    if (!u.passwordHash && list.length === 1) throw badRequest('last_credential', 'This is the only way to sign in')
    db.delete(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, u.id)))
      .run()
    return c.json({ ok: true })
  })

  r.post('/logout', async (c) => {
    await endSession(db, c, config)
    return c.json({ ok: true })
  })

  r.get('/me', requireSession(db), (c) =>
    c.json({ user: publicUser(c.get('user')), features: { passkeys: true }, learn: learnView(db, c.get('user'), deps.llm) }),
  )

  // Changing the own password needs the current one; other sessions are signed out.
  r.post('/password', requireSession(db), async (c) => {
    const body = z.object({ current: z.string().max(500), password: z.string().max(500) }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    const u = c.get('user')
    if (!u.passwordHash || !(await verifyPassword(body.data.current, u.passwordHash)))
      throw new HttpError(401, 'invalid_credentials', 'Wrong password')
    const problem = checkPasswordPolicy(body.data.password)
    if (problem) throw badRequest(problem, 'Password must be at least 12 characters')
    db.update(users)
      .set({ passwordHash: await hashPassword(body.data.password) })
      .where(eq(users.id, u.id))
      .run()
    dropUserSessions(db, u.id)
    await startSession(db, config, c, u.id)
    return c.json({ ok: true })
  })

  // What the invite / reset page shows. Unknown, expired and used links answer the same.
  r.get('/link/:token', async (c) => {
    const link = await findUsableLink(db, c.req.param('token'))
    if (!link) throw new HttpError(410, 'link_invalid', 'This link has expired or was already used')
    const inviter = db.select().from(users).where(eq(users.id, link.createdBy)).get()
    return c.json({ kind: link.kind, email: link.email, expiresAt: link.expiresAt, invitedBy: inviter?.name ?? null })
  })

  r.post('/link/:token', async (c) => {
    authLimiter.check(`${clientIp(c, config)}|link`)
    const body = acceptBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body', 'Expected {name, password}')
    const userId = await acceptLink(db, c.req.param('token'), body.data)
    dropUserSessions(db, userId)
    await startSession(db, config, c, userId)
    const user = db.select().from(users).where(eq(users.id, userId)).get()
    if (!user || !stationOfUser(db, userId)) throw new HttpError(500, 'internal_error')
    return c.json({ user: publicUser(user) })
  })

  return r
}
