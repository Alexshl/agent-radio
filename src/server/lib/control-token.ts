// Control token `arc_…` of "Быстрые команды" (iOS Shortcuts): one per user, only sha256 is stored, shown once. It is a different secret from
// the API keys (those can speak on air) and from the listen token (that one lives in stream URLs): it only replays, switches the source and reads the status.
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { controlTokens, users } from '../db/schema'
import { nowIso, randomToken, sha256Hex } from './ids'

export const CONTROL_PREFIX = 'arc_'

export interface ControlTokenInfo {
  createdAt: string
  lastUsedAt: string | null
}

export function controlTokenInfo(db: Db, userId: string): ControlTokenInfo | null {
  const r = db.select().from(controlTokens).where(eq(controlTokens.userId, userId)).get()
  return r ? { createdAt: r.createdAt, lastUsedAt: r.lastUsedAt } : null
}

// Creates the token, or replaces the old one (the old links stop working at once).
export async function issueControlToken(db: Db, userId: string): Promise<{ token: string; info: ControlTokenInfo }> {
  const token = CONTROL_PREFIX + randomToken(32)
  const tokenHash = await sha256Hex(token)
  const createdAt = nowIso()
  db.transaction((tx) => {
    tx.delete(controlTokens).where(eq(controlTokens.userId, userId)).run()
    tx.insert(controlTokens).values({ userId, tokenHash, createdAt }).run()
  })
  return { token, info: { createdAt, lastUsedAt: null } }
}

export function revokeControlToken(db: Db, userId: string): boolean {
  return db.delete(controlTokens).where(eq(controlTokens.userId, userId)).run().changes > 0
}

// The user of a token, null when unknown / revoked / the user is disabled. Writes the last used time.
export async function authenticateControl(db: Db, token: string): Promise<string | null> {
  if (!token.startsWith(CONTROL_PREFIX)) return null
  const row = db
    .select()
    .from(controlTokens)
    .where(eq(controlTokens.tokenHash, await sha256Hex(token)))
    .get()
  if (!row) return null
  const user = db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, row.userId)).get()
  if (!user || user.disabledAt) return null
  db.update(controlTokens).set({ lastUsedAt: nowIso() }).where(eq(controlTokens.userId, row.userId)).run()
  return row.userId
}
