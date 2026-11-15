// Passkeys (WebAuthn) on top of @simplewebauthn/server: options, one-time challenges, verification, rows of the `passkeys` table.
// The RP ID is the host of PUBLIC_URL, the origin is PUBLIC_URL's origin. The challenge is ours (random 32 bytes, kept hashed-by-slot in
// auth_challenges, deleted by the statement that reads it). The signature counter is compared only AFTER the signature was verified.
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { and, asc, eq, gt, lt } from 'drizzle-orm'
import { z } from 'zod'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { authChallenges, passkeys } from '../db/schema'
import { base64url, base64urlDecode, newId, nowIso, randomToken, sha256Hex } from './ids'

// loaded on the first passkey request: the library (ASN.1, X.509) is not needed by the rest of the app
const webauthn = () => import('@simplewebauthn/server')

export const MAX_PASSKEYS_PER_USER = 10
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000
export const PASSKEY_NAME_MAX = 60
// EdDSA, ES256, RS256: what every platform and security key offers
const ALGORITHMS = [-8, -7, -257]

export type PasskeyKind = 'passkey-register' | 'passkey-login'
export type PasskeyRow = typeof passkeys.$inferSelect

export function relyingParty(config: Pick<Config, 'publicUrl'>): { rpID: string; origin: string } {
  const url = new URL(config.publicUrl)
  return { rpID: url.hostname, origin: url.origin }
}

// ---------- the browser's answers, as zod sees them (the library checks the contents) ----------
const b64 = z.string().min(1).max(8192)
const credentialId = z.string().min(1).max(1024)
const transports = z.array(z.string().max(32)).max(10).optional()

export const registrationResponseSchema = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: b64,
    attestationObject: b64,
    transports,
    authenticatorData: b64.optional(),
    publicKey: b64.optional(),
    publicKeyAlgorithm: z.number().optional(),
  }),
  authenticatorAttachment: z.string().max(32).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
})

export const authenticationResponseSchema = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: b64,
    authenticatorData: b64,
    signature: b64,
    userHandle: z.string().max(256).optional().nullable(),
  }),
  authenticatorAttachment: z.string().max(32).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
})

// ---------- one-time challenges ----------
// `slot` binds the challenge: the user (registration) or the cookie of the login attempt. Stored as a hash. One open challenge per slot
// and kind: a new one replaces the old.
const slotKey = (kind: PasskeyKind, slot: string) => sha256Hex(`${kind}:${slot}`)

export async function putChallenge(db: Db, p: { kind: PasskeyKind; slot: string; challenge: string; userId: string | null }) {
  const key = await slotKey(p.kind, p.slot)
  const now = Date.now()
  db.delete(authChallenges)
    .where(and(eq(authChallenges.kind, p.kind), eq(authChallenges.challenge, key)))
    .run()
  db.insert(authChallenges)
    .values({
      id: newId(),
      kind: p.kind,
      challenge: key,
      userId: p.userId,
      data: p.challenge,
      expiresAt: new Date(now + PASSKEY_CHALLENGE_TTL_MS).toISOString(),
    })
    .run()
  // whatever ran out
  db.delete(authChallenges)
    .where(lt(authChallenges.expiresAt, new Date(now).toISOString()))
    .run()
}

// Takes the challenge of the slot: deleted by this very statement, so a second try (or a try after a failure) finds nothing. null = none / expired.
export async function takeChallenge(db: Db, p: { kind: PasskeyKind; slot: string; userId?: string }): Promise<string | null> {
  const key = await slotKey(p.kind, p.slot)
  const [row] = db
    .delete(authChallenges)
    .where(
      and(
        eq(authChallenges.kind, p.kind),
        eq(authChallenges.challenge, key),
        p.userId ? eq(authChallenges.userId, p.userId) : undefined,
        gt(authChallenges.expiresAt, nowIso()),
      ),
    )
    .returning({ data: authChallenges.data })
    .all()
  return row?.data ?? null
}

// ---------- options ----------
const newChallenge = () => base64urlDecode(randomToken(32)) as Uint8Array<ArrayBuffer>

function parseTransports(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  try {
    const list: unknown = JSON.parse(raw)
    return Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : undefined
  } catch {
    return undefined
  }
}

export async function registrationOptions(
  config: Pick<Config, 'publicUrl'>,
  user: { id: string; email: string; name: string },
  existing: { credentialId: string; transports: string | null }[],
  rpName: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpID } = relyingParty(config)
  const { generateRegistrationOptions } = await webauthn()
  return generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email,
    userDisplayName: user.name || user.email,
    // the user handle: our opaque user id, the same for every passkey of the person
    userID: new TextEncoder().encode(user.id) as Uint8Array<ArrayBuffer>,
    challenge: newChallenge(),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: parseTransports(p.transports) as never })),
    // discoverable credential: the passkey can sign in without typing an e-mail
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    supportedAlgorithmIDs: ALGORITHMS,
    timeout: PASSKEY_CHALLENGE_TTL_MS,
  })
}

// No allowCredentials = the discoverable flow (the browser lists the passkeys it holds for this site).
export async function authenticationOptions(config: Pick<Config, 'publicUrl'>): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpID } = relyingParty(config)
  const { generateAuthenticationOptions } = await webauthn()
  return generateAuthenticationOptions({
    rpID,
    challenge: newChallenge(),
    userVerification: 'required',
    timeout: PASSKEY_CHALLENGE_TTL_MS,
  })
}

// ---------- verification ----------
export interface NewPasskey {
  credentialId: string
  publicKey: string
  signCount: number
  transports: string | null
}

// Throws (anything) when the registration does not hold.
export async function verifyRegistration(
  config: Pick<Config, 'publicUrl'>,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<NewPasskey> {
  const { rpID, origin } = relyingParty(config)
  const { verifyRegistrationResponse } = await webauthn()
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserPresence: true,
    requireUserVerification: true,
    supportedAlgorithmIDs: ALGORITHMS,
  })
  if (!result.verified) throw new Error('not verified')
  const info = result.registrationInfo
  if (!info.userVerified) throw new Error('user verification missing')
  const list = info.credential.transports
  return {
    credentialId: info.credential.id,
    publicKey: base64url(info.credential.publicKey),
    signCount: info.credential.counter,
    transports: list?.length ? JSON.stringify(list) : null,
  }
}

export type AssertionResult = { ok: true; newCounter: number } | { ok: false; reason: 'invalid' | 'counter_regressed' }

// The counter is handed to the library as 0 (so its own pre-signature check cannot fire for an unverified message) and compared here once
// the signature is good: when non-zero on either side it must go up. A passkey that always says 0 (synced) is fine.
export async function verifyAssertion(
  config: Pick<Config, 'publicUrl'>,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  stored: PasskeyRow,
): Promise<AssertionResult> {
  const { rpID, origin } = relyingParty(config)
  const publicKey = base64urlDecode(stored.publicKey)
  if (!publicKey) return { ok: false, reason: 'invalid' }
  let counter: number
  try {
    const { verifyAuthenticationResponse } = await webauthn()
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: { id: stored.credentialId, publicKey, counter: 0, transports: parseTransports(stored.transports) as never },
    })
    if (!result.verified || !result.authenticationInfo.userVerified) return { ok: false, reason: 'invalid' }
    counter = result.authenticationInfo.newCounter
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if ((counter > 0 || stored.signCount > 0) && counter <= stored.signCount) return { ok: false, reason: 'counter_regressed' }
  return { ok: true, newCounter: counter }
}

// ---------- rows ----------
export function listPasskeys(db: Db, userId: string): PasskeyRow[] {
  return db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(asc(passkeys.createdAt)).all()
}

export const passkeyView = (p: PasskeyRow) => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })

// A stored key that belongs to nobody, for the time class of an unknown credential id: verifying against it costs what a real failed check does.
export const DUMMY_PASSKEY: PasskeyRow = {
  id: 'dummy',
  userId: 'dummy',
  credentialId: 'dummy',
  publicKey: 'pQECAyYgASFYINK3hWBeoIXitZbV5cu5l8hsbozkwUd0Vh--9jH9TGEhIlggts1WIzmF9KzzOp8MAYrwI4Uu1uX9HZQo9e8XmN-dawo',
  signCount: 0,
  transports: null,
  name: '',
  createdAt: '',
  lastUsedAt: null,
}
