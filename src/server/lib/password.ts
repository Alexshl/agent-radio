// Password hashing with WebCrypto PBKDF2-SHA256 (ported from fdesk).
// Stored format: "pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>"; the iteration count is stored per hash, so it can be raised later.
import { base64url, base64urlDecode } from './ids'

export const PBKDF2_ITERATIONS = 310_000
const SCHEME = 'pbkdf2-sha256'
const MAX_STORED_ITERATIONS = 2_000_000

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 200

export type PasswordProblem = 'password_too_short' | 'password_too_long'

export function checkPasswordPolicy(password: string): PasswordProblem | null {
  if (password.length < PASSWORD_MIN_LENGTH) return 'password_too_short'
  if (password.length > PASSWORD_MAX_LENGTH) return 'password_too_long'
  return null
}

// NFKC: the same password typed on another keyboard / OS still matches.
const encode = (password: string) => new TextEncoder().encode(password.normalize('NFKC'))

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number, bits = 256): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, bits))
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, iterations)
  return `${SCHEME}$${iterations}$${base64url(salt)}$${base64url(hash)}`
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

// false for a malformed stored value or a wrong password; never throws.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== SCHEME || !/^[1-9][0-9]{0,8}$/.test(parts[1] ?? '')) return false
  const iterations = Number(parts[1])
  const salt = base64urlDecode(parts[2] ?? '')
  const hash = base64urlDecode(parts[3] ?? '')
  if (iterations > MAX_STORED_ITERATIONS || !salt?.length || !hash?.length) return false
  try {
    return constantTimeEqual(await derive(password, salt, iterations, hash.length * 8), hash)
  } catch {
    return false
  }
}

// Login verifies against this when the account does not exist, so "unknown email" costs the same time as "wrong password".
let dummy: Promise<string> | undefined
export async function spendPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword('nobody-knows-this-password')
  await verifyPassword(password, await dummy)
}
