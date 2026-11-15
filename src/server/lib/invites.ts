// One-time links: invite (creates the user and the station) and password reset (sets a new password). Only the token hash is stored.
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { invites, users } from '../db/schema'
import { createUser, findUserByEmail } from '../stations'
import { HttpError, badRequest } from './http'
import { newId, nowIso, randomToken, sha256Hex } from './ids'
import { checkPasswordPolicy, hashPassword } from './password'

export const INVITE_DAYS = [1, 7, 30] as const
const DAY = 24 * 60 * 60 * 1000
export type InviteRow = typeof invites.$inferSelect

async function insertLink(
  db: Db,
  p: { kind: 'invite' | 'reset'; email: string; role: string; userId: string | null; createdBy: string; days: number },
) {
  const token = randomToken(32)
  const now = Date.now()
  const row = db
    .insert(invites)
    .values({
      id: newId(),
      kind: p.kind,
      tokenHash: await sha256Hex(token),
      email: p.email,
      role: p.role,
      userId: p.userId,
      createdBy: p.createdBy,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + p.days * DAY).toISOString(),
    })
    .returning()
    .get()
  return { token, invite: row }
}

export async function createInvite(db: Db, p: { email: string; role: 'admin' | 'user'; days: number; createdBy: string }) {
  const email = p.email.trim()
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('invalid_email', 'Invalid email')
  if (!(INVITE_DAYS as readonly number[]).includes(p.days)) throw badRequest('invalid_expiry', 'Expiry must be 1, 7 or 30 days')
  if (findUserByEmail(db, email)) throw new HttpError(409, 'email_taken', 'A user with this email already exists')
  return insertLink(db, { kind: 'invite', email, role: p.role, userId: null, createdBy: p.createdBy, days: p.days })
}

// A reset link is valid for one day; only the newest one counts.
export async function createReset(db: Db, user: { id: string; email: string }, createdBy: string) {
  db.delete(invites)
    .where(and(eq(invites.userId, user.id), eq(invites.kind, 'reset'), isNull(invites.usedAt)))
    .run()
  return insertLink(db, { kind: 'reset', email: user.email, role: 'user', userId: user.id, createdBy, days: 1 })
}

// The link row when it can still be used, else null (unknown, expired, used).
export async function findUsableLink(db: Db, token: string): Promise<InviteRow | null> {
  const row = db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, await sha256Hex(token)))
    .get()
  if (!row || row.usedAt || row.expiresAt <= nowIso()) return null
  return row
}

export function listPendingInvites(db: Db) {
  return db.select().from(invites).where(isNull(invites.usedAt)).orderBy(desc(invites.createdAt)).all()
}

export function deleteInvite(db: Db, id: string) {
  db.delete(invites)
    .where(and(eq(invites.id, id), isNull(invites.usedAt)))
    .run()
}

// Consumes the link (single use) and returns the user who now has the password. Everything that can be refused (name, password, an email that
// got an account meanwhile) is checked first or rolled back with the claim, so a refused attempt never burns the link.
export async function acceptLink(db: Db, token: string, p: { name?: string; password: string }) {
  const link = await findUsableLink(db, token)
  if (!link) throw new HttpError(410, 'link_invalid', 'This link has expired or was already used')
  const problem = checkPasswordPolicy(p.password)
  if (problem) throw badRequest(problem, 'Password must be at least 12 characters')
  const name = p.name?.trim()
  const isReset = link.kind === 'reset' && !!link.userId
  if (!isReset && !name) throw badRequest('name_required', 'Name is required')
  const passwordHash = await hashPassword(p.password)
  return db.transaction((tx) => {
    const t = tx as unknown as Db
    // UPDATE ... WHERE used_at IS NULL is the single-use guard: of two concurrent accepts only one gets a row back
    const claimed = t
      .update(invites)
      .set({ usedAt: nowIso() })
      .where(and(eq(invites.id, link.id), isNull(invites.usedAt)))
      .returning()
      .get()
    if (!claimed) throw new HttpError(410, 'link_invalid', 'This link has expired or was already used')
    if (isReset && link.userId) {
      t.update(users).set({ passwordHash, updatedAt: nowIso() }).where(eq(users.id, link.userId)).run()
      return link.userId
    }
    // thrown inside the transaction: the claim above is rolled back and the link stays usable
    if (findUserByEmail(t, link.email)) throw new HttpError(409, 'email_taken', 'A user with this email already exists')
    const { user } = createUser(t, { email: link.email, name, role: link.role === 'admin' ? 'admin' : 'user' })
    t.update(users).set({ passwordHash }).where(eq(users.id, user.id)).run()
    return user.id
  })
}
