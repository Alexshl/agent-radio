import { eq } from 'drizzle-orm'
import { loadConfig } from './config'
import { openDb } from './db/client'
import { presets, users } from './db/schema'
import { type Deps, type FullDeps, withDefaults } from './deps'
import { EngineClient } from './engine/client'
import { IcecastStats } from './icecast'
import { newId } from './lib/ids'
import { checkPasswordPolicy, hashPassword } from './lib/password'
import { RateLimiter } from './lib/rate-limit'
import { createUser, findUserByEmail } from './stations'
import { TtsService, ensureChime } from './tts'

export function bootstrap(): FullDeps & { ttsService: TtsService } {
  const config = loadConfig()
  const db = openDb(config.dbPath, process.env.MIGRATIONS_DIR ?? './migrations')
  const base: Deps = {
    db,
    config,
    engine: new EngineClient(config.engineUrl),
    icecast: new IcecastStats(config.icecastUrl),
    // replaced below: the service needs the registry that withDefaults builds
    tts: { makeClip: () => Promise.reject(new Error('tts not ready')) },
    limiter: new RateLimiter(config.sayRatePerMin),
  }
  const full = withDefaults(base)
  const ttsService = new TtsService(full.registry, config, () => ensureChime(config.dataDir))
  return { ...full, tts: ttsService, ttsService }
}

// The admin from ADMIN_EMAIL (+ ADMIN_PASSWORD), created once; an existing admin without a password gets ADMIN_PASSWORD.
export async function seedAdmin(deps: Pick<FullDeps, 'db' | 'config'>) {
  const { db, config } = deps
  const email = config.adminEmail
  if (!email) return null
  const password = config.adminPassword
  if (password) {
    const problem = checkPasswordPolicy(password)
    if (problem) throw new Error(`ADMIN_PASSWORD rejected: ${problem} (at least 12 characters)`)
  }
  const existing = findUserByEmail(db, email)
  if (existing) {
    if (password && !existing.passwordHash)
      db.update(users)
        .set({ passwordHash: await hashPassword(password) })
        .where(eq(users.id, existing.id))
        .run()
    return null
  }
  const created = createUser(db, { email, role: 'admin' })
  if (password)
    db.update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, created.user.id))
      .run()
  return created
}

const DEFAULT_PRESETS = [
  { name: 'SomaFM · Groove Salad', description: 'Эмбиент и даунтемпо · 128 kbps', url: 'https://ice1.somafm.com/groovesalad-128-mp3' },
  { name: 'SomaFM · Drone Zone', description: 'Атмосферный эмбиент без ритма', url: 'https://ice1.somafm.com/dronezone-128-mp3' },
  { name: 'Radio Paradise · Main Mix', description: 'Эклектика без рекламы', url: 'http://stream.radioparadise.com/mp3-128' },
]

export function seedPresets(deps: Pick<FullDeps, 'db'>) {
  if (deps.db.select().from(presets).limit(1).get()) return
  for (const [position, p] of DEFAULT_PRESETS.entries())
    deps.db
      .insert(presets)
      .values({ id: newId(), ...p, position })
      .run()
}
