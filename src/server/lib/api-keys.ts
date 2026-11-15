// Incoming agent keys `ar_…`. Only sha256 of the token is stored; the token itself is shown once, in the response that creates it.
// Ported from fmetric (sqlite dialect, no scopes: a key can do everything its user can).
import { timingSafeEqual } from 'node:crypto'
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import type { Db } from '../db/client'
import { apiKeys, users } from '../db/schema'
import type { AppEnv } from '../env'
import { HttpError } from './http'
import { newId, nowIso, randomToken, sha256Hex } from './ids'

export const API_KEY_PREFIX = 'ar_'
// last_used_at is written at most this often
export const LAST_USED_GRANULARITY_MS = 5 * 60 * 1000
const PREFIX_SHOWN = 8

export interface ApiKeyRow {
  id: string
  userId: string
  name: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
  lastSession: string | null
  revokedAt: string | null
}

function toRow(r: typeof apiKeys.$inferSelect): ApiKeyRow {
  return {
    id: r.id,
    userId: r.userId,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    lastSession: r.lastSession,
    revokedAt: r.revokedAt,
  }
}

// Issues a key. The returned `token` exists only here: the db gets its hash and the first characters.
export async function createApiKey(db: Db, p: { name: string; userId: string }): Promise<{ key: ApiKeyRow; token: string }> {
  const token = API_KEY_PREFIX + randomToken(32)
  const [row] = db
    .insert(apiKeys)
    .values({
      id: `key_${newId()}`,
      userId: p.userId,
      name: p.name,
      prefix: token.slice(0, PREFIX_SHOWN + API_KEY_PREFIX.length),
      tokenHash: await sha256Hex(token),
      createdAt: nowIso(),
    })
    .returning()
    .all()
  return { key: toRow(row as typeof apiKeys.$inferSelect), token }
}

export function listApiKeys(db: Db, userId: string): ApiKeyRow[] {
  return db.select().from(apiKeys).where(eq(apiKeys.userId, userId)).orderBy(desc(apiKeys.createdAt)).all().map(toRow)
}

// false = no such key. Revoking a revoked key keeps the first revocation time.
export function revokeApiKey(db: Db, id: string, userId?: string): boolean {
  const [r] = db.select({ id: apiKeys.id, userId: apiKeys.userId }).from(apiKeys).where(eq(apiKeys.id, id)).limit(1).all()
  if (r && userId && r.userId !== userId) return false
  if (!r) return false
  db.update(apiKeys)
    .set({ revokedAt: nowIso() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .run()
  return true
}

const unauthorized = () => new HttpError(401, 'unauthorized', 'Missing or invalid API key', { 'WWW-Authenticate': 'Bearer' })

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export interface AuthedKey {
  keyId: string
  userId: string
}

// Resolves a bearer token to its key + active user, null when unknown or revoked.
export async function authenticateToken(db: Db, token: string): Promise<AuthedKey | null> {
  if (!token.startsWith(API_KEY_PREFIX)) return null
  const hash = await sha256Hex(token)
  const [row] = db.select().from(apiKeys).where(eq(apiKeys.tokenHash, hash)).limit(1).all()
  // the lookup is by hash (the secret never reaches a string comparison); the equality check is constant-time anyway
  if (!row || row.revokedAt || !safeEqual(row.tokenHash, hash)) return null
  const [user] = db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(users.id, row.userId)).limit(1).all()
  if (!user || user.disabledAt) return null
  const cutoff = new Date(Date.now() - LAST_USED_GRANULARITY_MS).toISOString()
  if (!row.lastUsedAt || row.lastUsedAt < cutoff) {
    db.update(apiKeys)
      .set({ lastUsedAt: nowIso() })
      .where(and(eq(apiKeys.id, row.id), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, cutoff))))
      .run()
  }
  return { keyId: row.id, userId: row.userId }
}

export const requireApiKey =
  (db: Db): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const m = /^Bearer +(\S+)$/i.exec(c.req.header('Authorization') ?? '')
    const token = m?.[1]
    if (!token) throw unauthorized()
    const auth = await authenticateToken(db, token)
    if (!auth) throw unauthorized()
    c.set('auth', auth)
    await next()
  }
