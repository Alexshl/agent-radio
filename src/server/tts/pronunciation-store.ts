// Pronunciation entries in the db: loading for synthesis, CRUD shared by the user and admin routes.
import { and, eq, isNull, or } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client'
import { pronunciations } from '../db/schema'
import { newId, nowIso } from '../lib/ids'
import { PRON_LANGS, type PronEntry } from './pronunciation'

export type PronRow = typeof pronunciations.$inferSelect

// global entries + this user's own ones (the matcher lets the user's win)
export function loadEntries(db: Db, userId: string | undefined): PronEntry[] {
  const global = eq(pronunciations.scope, 'global')
  const where = userId ? or(global, and(eq(pronunciations.scope, 'user'), eq(pronunciations.userId, userId))) : global
  return db
    .select()
    .from(pronunciations)
    .where(where)
    .all()
    .map((r) => ({ lang: r.lang, match: r.match, replacement: r.replacement, scope: r.scope === 'user' ? 'user' : 'global' }))
}

export const pronBody = z.object({
  lang: z.enum(PRON_LANGS).default('*'),
  match: z.string().trim().min(1).max(100),
  replacement: z.string().trim().min(1).max(200),
  note: z.string().trim().max(300).default(''),
})
export const pronPatch = z.object({
  lang: z.enum(PRON_LANGS).optional(),
  match: z.string().trim().min(1).max(100).optional(),
  replacement: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(300).optional(),
})

const owned = (id: string, scope: 'global' | 'user', userId: string | null) =>
  and(
    eq(pronunciations.id, id),
    eq(pronunciations.scope, scope),
    scope === 'global' ? isNull(pronunciations.userId) : eq(pronunciations.userId, userId ?? ''),
  )

export function listPron(db: Db, scope: 'global' | 'user', userId: string | null): PronRow[] {
  const where =
    scope === 'global' ? eq(pronunciations.scope, 'global') : and(eq(pronunciations.scope, 'user'), eq(pronunciations.userId, userId ?? ''))
  return db
    .select()
    .from(pronunciations)
    .where(where)
    .all()
    .sort((a, b) => a.match.toLowerCase().localeCompare(b.match.toLowerCase()))
}

export function createPron(db: Db, scope: 'global' | 'user', userId: string | null, b: z.infer<typeof pronBody>): PronRow {
  const row = { id: newId(), scope, userId: scope === 'user' ? userId : null, ...b, createdAt: nowIso() }
  db.insert(pronunciations).values(row).run()
  return row
}

export function updatePron(
  db: Db,
  id: string,
  scope: 'global' | 'user',
  userId: string | null,
  b: z.infer<typeof pronPatch>,
): PronRow | undefined {
  if (Object.keys(b).length)
    db.update(pronunciations)
      .set(b)
      .where(owned(id, scope, userId))
      .run()
  return db
    .select()
    .from(pronunciations)
    .where(owned(id, scope, userId))
    .get()
}

export function deletePron(db: Db, id: string, scope: 'global' | 'user', userId: string | null): boolean {
  return (
    db
      .delete(pronunciations)
      .where(owned(id, scope, userId))
      .run().changes > 0
  )
}

export function pronView(r: PronRow) {
  return { id: r.id, scope: r.scope, lang: r.lang, match: r.match, replacement: r.replacement, note: r.note, createdAt: r.createdAt }
}
