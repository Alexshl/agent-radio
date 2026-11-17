// Browser auth: cookie sessions (only sha256 of the token is stored) + CSRF (Origin check) + role guards.
import { and, eq, lt } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { sessions, users } from '../db/schema'
import type { AppEnv } from '../env'
import { HttpError } from './http'
import { nowIso, randomToken, sha256Hex } from './ids'

export const SESSION_COOKIE = 'ar_session'
// over https the cookie gets the __Host- prefix: the browser then only accepts it with Secure, Path=/ and no Domain
export const HOST_SESSION_COOKIE = '__Host-ar_session'
const cookieName = (secure: boolean) => (secure ? HOST_SESSION_COOKIE : SESSION_COOKIE)
const readSessionCookie = (c: Context) => getCookie(c, HOST_SESSION_COOKIE) ?? getCookie(c, SESSION_COOKIE)
export type UserRow = typeof users.$inferSelect

export function isSecureRequest(c: Context, config: Config): boolean {
  return config.cookieSecure || c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:'
}

// Creates the session and sets the cookie; returns the raw token.
export async function startSession(db: Db, config: Config, c: Context, userId: string): Promise<string> {
  const token = await createSession(db, config, c, userId)
  const secure = isSecureRequest(c, config)
  setCookie(c, cookieName(secure), token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  })
  return token
}

// Creates the session row only (no cookie); returns the raw token. Used for the iOS app token exchange.
export async function createSession(db: Db, config: Config, c: Context, userId: string): Promise<string> {
  const token = randomToken(32)
  const now = Date.now()
  db.insert(sessions)
    .values({
      id: await sha256Hex(token),
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + config.sessionTtlMs).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      userAgent: c.req.header('user-agent')?.slice(0, 200) ?? null,
    })
    .run()
  // opportunistic cleanup of expired rows
  db.delete(sessions)
    .where(lt(sessions.expiresAt, new Date(now).toISOString()))
    .run()
  db.update(users).set({ lastLoginAt: nowIso() }).where(eq(users.id, userId)).run()
  return token
}

export async function endSession(db: Db, c: Context, config: Config) {
  const token = readSessionCookie(c)
  if (token)
    db.delete(sessions)
      .where(eq(sessions.id, await sha256Hex(token)))
      .run()
  const secure = isSecureRequest(c, config)
  deleteCookie(c, cookieName(secure), { path: '/', secure })
}

export function dropUserSessions(db: Db, userId: string) {
  db.delete(sessions).where(eq(sessions.userId, userId)).run()
}

// The active user behind a session token; null for unknown, expired sessions and disabled users.
export async function userOfToken(db: Db, token: string): Promise<UserRow | null> {
  const id = await sha256Hex(token)
  const s = db.select().from(sessions).where(eq(sessions.id, id)).get()
  if (!s) return null
  if (s.expiresAt <= nowIso()) {
    db.delete(sessions)
      .where(and(eq(sessions.id, id)))
      .run()
    return null
  }
  const user = db.select().from(users).where(eq(users.id, s.userId)).get()
  if (!user || user.disabledAt) return null
  return user
}

// Mutations made with the session cookie must come from this site (Origin, or Sec-Fetch-Site when there is no Origin).
export function checkCsrf(c: Context, config: Config) {
  const m = c.req.method
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return
  const origin = c.req.header('origin')
  if (origin) {
    let host: string
    try {
      host = new URL(origin).host
    } catch {
      throw new HttpError(403, 'csrf', 'Cross-site request rejected')
    }
    const allowed = new Set([new URL(config.publicUrl).host, new URL(c.req.url).host])
    for (const h of [c.req.header('host'), c.req.header('x-forwarded-host')]) if (h) allowed.add(h)
    if (!allowed.has(host)) throw new HttpError(403, 'csrf', 'Cross-site request rejected')
    return
  }
  const site = c.req.header('sec-fetch-site')
  if (site === 'same-origin' || site === 'none') return
  throw new HttpError(403, 'csrf', 'Cross-site request rejected')
}

export const csrfGuard =
  (config: Config): MiddlewareHandler =>
  async (c, next) => {
    checkCsrf(c, config)
    await next()
  }

export const requireSession =
  (db: Db): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const token = readSessionCookie(c)
    const user = token ? await userOfToken(db, token) : null
    if (!user) throw new HttpError(401, 'unauthorized', 'Sign in required')
    c.set('user', user)
    await next()
  }

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user').role !== 'admin') throw new HttpError(403, 'forbidden', 'Admin only')
  await next()
}

// The caller's address for rate limits: the proxy headers only when TRUST_PROXY is on (behind a tunnel), else the socket address.
export function clientIp(c: Context, config: Pick<Config, 'trustProxy'>): string {
  if (config.trustProxy) {
    const h = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (h) return h
  }
  try {
    return getConnInfo(c).remote.address || 'unknown'
  } catch {
    return 'unknown'
  }
}
