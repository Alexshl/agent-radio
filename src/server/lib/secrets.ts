// Encrypted values in the `secrets` table (TTS provider keys): AES-256-GCM, key = sha256(APP_SECRET), the secret's name is the AAD.
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { secrets } from '../db/schema'
import { nowIso } from './ids'

export interface Sealed {
  // base64
  ciphertext: string
  iv: string
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

async function importKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptString(secret: string, value: string, aad: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const out = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    await importKey(secret),
    new TextEncoder().encode(value),
  )
  return { ciphertext: b64(new Uint8Array(out)), iv: b64(iv) }
}

export async function decryptString(secret: string, sealed: Sealed, aad: string): Promise<string> {
  try {
    const out = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: new TextEncoder().encode(aad) },
      await importKey(secret),
      unb64(sealed.ciphertext),
    )
    return new TextDecoder().decode(out)
  } catch {
    throw new Error(`cannot decrypt secret ${aad} (wrong APP_SECRET?)`)
  }
}

// APP_SECRET from the environment, else a random one generated once into <dataDir>/app-secret (mode 600).
export function getAppSecret(config: Pick<Config, 'appSecret' | 'dataDir'>): string {
  if (config.appSecret) return config.appSecret
  const file = join(config.dataDir, 'app-secret')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  mkdirSync(config.dataDir, { recursive: true })
  const fresh = randomBytes(32).toString('base64url')
  writeFileSync(file, fresh, { mode: 0o600 })
  chmodSync(file, 0o600)
  return fresh
}

export class SecretStore {
  constructor(
    private db: Db,
    private appSecret: () => string,
  ) {}

  async get(name: string): Promise<string | null> {
    const row = this.db.select().from(secrets).where(eq(secrets.name, name)).get()
    return row ? decryptString(this.appSecret(), row, name) : null
  }

  async put(name: string, value: string): Promise<void> {
    const sealed = await encryptString(this.appSecret(), value, name)
    const row = { ...sealed, updatedAt: nowIso() }
    this.db
      .insert(secrets)
      .values({ name, ...row })
      .onConflictDoUpdate({ target: secrets.name, set: row })
      .run()
  }

  has(name: string): boolean {
    return !!this.db.select({ name: secrets.name }).from(secrets).where(eq(secrets.name, name)).get()
  }

  delete(name: string): void {
    this.db.delete(secrets).where(eq(secrets.name, name)).run()
  }
}
