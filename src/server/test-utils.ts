// Shared setup for the route tests: in-memory db, mock engine / icecast / media / tts, temp directories.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { createApp } from './app'
import { loadConfig } from './config'
import { openDb } from './db/client'
import { users } from './db/schema'
import { type Deps, withDefaults } from './deps'
import type { EngineApi, EngineMsgState } from './engine/client'
import type { IcecastApi } from './icecast'
import { createApiKey } from './lib/api-keys'
import type { Resolver, Transport } from './lib/safe-fetch'
import { SecretStore } from './lib/secrets'
import type { PresetProbe } from './presets-health'
import { TtsRegistry } from './tts'
import { hashPassword } from './lib/password'
import { RateLimiter } from './lib/rate-limit'
import { Library } from './library'
import type { MediaTools } from './media'
import { createUser } from './stations'
import { eq } from 'drizzle-orm'

export const ORIGIN = 'http://radio.test'

// Fake DNS: public names resolve to a public address, a few special names to internal ones.
export const fakeResolver: Resolver = async (host) => {
  const internal: Record<string, string> = {
    localhost: '127.0.0.1',
    icecast: '172.18.0.2',
    liquidsoap: '172.18.0.3',
    app: '172.18.0.4',
    'rebind.example': '127.0.0.1',
    'mixed.example': '93.184.216.34,10.0.0.1',
    'metadata.example': '169.254.169.254',
  }
  const hit = internal[host]
  if (hit) return hit.split(',').map((address) => ({ address, family: 4 as const }))
  if (host.endsWith('.invalid')) throw new Error('ENOTFOUND')
  return [{ address: '93.184.216.34', family: 4 as const }]
}

export function setup(
  opts: {
    listeners?: number | null
    env?: Record<string, string>
    authLimit?: number
    transport?: Transport
    presetProbe?: PresetProbe
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'ar-test-'))
  const music = join(dir, 'music')
  mkdirSync(music)
  const config = loadConfig({
    SHARED_DIR: join(dir, 'shared'),
    DATA_DIR: dir,
    MUSIC_DIR: music,
    PUBLIC_URL: ORIGIN,
    ICECAST_URL: 'http://icecast.test',
    APP_SECRET: 'test-secret',
    WEB_DIR: join(dir, 'web'),
    ...opts.env,
  })
  const db = openDb(':memory:')
  const engine = {
    list: vi.fn(async () => []),
    add: vi.fn(async () => {}),
    setSource: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
    pushTrack: vi.fn(async () => {}),
    pushMusic: vi.fn(async (_id: string, _path: string, _msg: string, _opts?: { title?: string; amplifyDb?: number }) => {}),
    flushMusic: vi.fn(async () => {}),
    musicQueue: vi.fn(async () => 0),
    skipMusic: vi.fn(async () => {}),
    previousMusic: vi.fn(async () => true),
    musicHistory: vi.fn(async (): Promise<string[]> => []),
    setDuck: vi.fn(async () => {}),
    setLevels: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    msgStates: vi.fn(async (): Promise<EngineMsgState[]> => []),
  } satisfies EngineApi
  const state = { listeners: opts.listeners === undefined ? 1 : opts.listeners }
  const icecast: IcecastApi = { listeners: vi.fn(async () => state.listeners), isUp: async () => true, title: async () => 'ICY title' }
  const makeClip = vi.fn(async () => {
    mkdirSync(join(config.sharedDir, 'clips'), { recursive: true })
    const f = join(config.sharedDir, 'clips', `clip-${Math.random().toString(36).slice(2)}.mp3`)
    writeFileSync(f, 'x')
    return f
  })
  const media = {
    probe: vi.fn(async () => ({ durationSec: 30, hasAudio: true })),
    makeTrack: vi.fn(async (p: { out: string }) => {
      mkdirSync(join(config.sharedDir, 'clips'), { recursive: true })
      writeFileSync(p.out, 'mp3-bytes')
    }),
  } satisfies MediaTools
  const library = new Library(
    db,
    config,
    async (file) => ({
      title: file.split('/').pop() ?? file,
      artist: 'Artist',
      album: 'Album',
      durationSec: 100,
    }),
    0,
  )
  const registry = new TtsRegistry(db, config, new SecretStore(db, () => 'test-secret'))
  const deps: Deps = {
    db,
    config,
    engine,
    icecast,
    tts: { makeClip },
    limiter: new RateLimiter(100),
    authLimiter: new RateLimiter(opts.authLimit ?? 10, 15 * 60_000),
    media,
    library,
    registry,
    resolver: fakeResolver,
    transport: opts.transport,
    presetProbe: opts.presetProbe,
  }
  const full = withDefaults(deps)
  const app = createApp(full)
  const req = (path: string, init: RequestInit & { cookie?: string; json?: unknown; origin?: string | null } = {}) => {
    const headers = new Headers(init.headers)
    if (init.cookie) headers.set('Cookie', init.cookie)
    if (init.json !== undefined) headers.set('Content-Type', 'application/json')
    if (init.origin !== null && (init.method ?? 'GET') !== 'GET') headers.set('Origin', init.origin ?? ORIGIN)
    return app.request(`${ORIGIN}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body })
  }
  return {
    app,
    db,
    deps: full,
    delivery: full.delivery,
    registry,
    config,
    engine,
    icecast,
    state,
    makeClip,
    media,
    library,
    req,
    dir,
    music,
  }
}
export type T = ReturnType<typeof setup>

export const PASSWORD = 'correct horse battery'

// a user with a password (cheap hash for the tests)
export async function addUser(t: T, email: string, role: 'admin' | 'user' = 'user', password = PASSWORD) {
  const { user, station } = createUser(t.db, { email, role })
  t.db
    .update(users)
    .set({ passwordHash: await hashPassword(password, 1000) })
    .where(eq(users.id, user.id))
    .run()
  return { user, station }
}

export function cookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? ''
  return raw.split(';')[0] ?? ''
}

export async function login(t: T, email: string, password = PASSWORD): Promise<string> {
  const res = await t.req('/api/auth/login', { method: 'POST', json: { email, password } })
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`)
  return cookieOf(res)
}

export async function userWithKey(t: T, email: string) {
  const { user, station } = await addUser(t, email)
  const { token, key } = await createApiKey(t.db, { userId: user.id, name: 't' })
  return { user, station, token, key }
}
