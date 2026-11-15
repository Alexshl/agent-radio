// Hourly cleanup: messages older than 30 days, clip files (voice clips and uploaded audio) older than 7 days, expired sessions / links.
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { and, isNotNull, lt, sql } from 'drizzle-orm'
import type { Config } from './config'
import type { Db } from './db/client'
import { invites, messages, sessions } from './db/schema'

export interface CleanupResult {
  messages: number
  clips: number
}

export function cleanup(db: Db, config: Config, now = Date.now()): CleanupResult {
  const msgCutoff = new Date(now - config.messageRetentionMs).toISOString()
  const clipCutoff = new Date(now - config.maxClipAgeMs).toISOString()
  const deleted = db.delete(messages).where(lt(messages.createdAt, msgCutoff)).returning({ id: messages.id }).all().length
  // the file is gone 7 days after the clip was made (not after the message: a replay can make it much later): do not keep pointing at it
  db.update(messages)
    .set({ clipPath: null })
    .where(and(isNotNull(messages.clipPath), sql`coalesce(${messages.clipCreatedAt}, ${messages.createdAt}) < ${clipCutoff}`))
    .run()
  const nowIso = new Date(now).toISOString()
  db.delete(sessions).where(lt(sessions.expiresAt, nowIso)).run()
  db.delete(invites)
    .where(lt(invites.expiresAt, new Date(now - 7 * 86400_000).toISOString()))
    .run()

  let clips = 0
  const dir = join(config.sharedDir, 'clips')
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (now - statSync(p).mtimeMs > config.maxClipAgeMs) {
        unlinkSync(p)
        clips++
      }
    }
  } catch {
    // no clips yet
  }
  // upload leftovers (a crashed request): nothing legitimate stays in there for an hour
  try {
    const up = join(config.dataDir, 'uploads')
    for (const f of readdirSync(up)) {
      const p = join(up, f)
      if (now - statSync(p).mtimeMs > 3600_000) unlinkSync(p)
    }
  } catch {
    // no uploads folder
  }
  return { messages: deleted, clips }
}
