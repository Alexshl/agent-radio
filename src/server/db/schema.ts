import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Conventions (same as fmetric): ids are uuid TEXT (stations: a short slug, it is the icecast mount), times are ISO-8601 UTC strings,
// enums are checked in TypeScript (no CHECK constraints), migrations only add.

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    // admin | user
    role: text('role').notNull().default('user'),
    name: text('name').notNull(),
    // stored as typed; uniqueness is on lower(email)
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    disabledAt: text('disabled_at'),
    lastLoginAt: text('last_login_at'),
    // per-user voice settings: voice is '<provider>:<voice id>', null = the server default
    voice: text('voice'),
    // summary language the agent writes in: uk | ru | en
    lang: text('lang').notNull().default('uk'),
    speakSession: integer('speak_session', { mode: 'boolean' }).notNull().default(true),
    // speech rate multiplier 0.8..1.6
    speechRate: real('speech_rate').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('users_email_unique').on(sql`lower(${t.email})`)],
)

// Only sha256 of the token is stored; the token itself is shown once, in the response that creates it.
export const apiKeys = sqliteTable(
  'api_keys',
  {
    // 'key_…'
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    // first characters of the token, shown in the list
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
    lastSession: text('last_session'),
    revokedAt: text('revoked_at'),
  },
  (t) => [index('api_keys_user').on(t.userId)],
)

// One station per user. `id` is the public slug: the icecast mount is /<id>, the stream URL is /stream/<id>.mp3?k=<listenToken>.
export const stations = sqliteTable('stations', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .unique()
    .references(() => users.id),
  listenToken: text('listen_token').notNull(),
  // JSON: {type:'relay',url} | {type:'playlist',dir} | {type:'silence'}
  source: text('source').notNull(),
  // how far the music drops while the voice speaks
  duckDb: real('duck_db').notNull().default(14),
  // mix levels in dB: music bed (before ducking) -30..+6, voice messages -12..+12, uploaded files -12..+6
  musicGainDb: real('music_gain_db').notNull().default(0),
  voiceGainDb: real('voice_gain_db').notNull().default(0),
  trackGainDb: real('track_gain_db').notNull().default(0),
  chime: integer('chime', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    session: text('session').notNull(),
    host: text('host'),
    text: text('text').notNull(),
    // aired | skipped | failed
    status: text('status').notNull(),
    clipPath: text('clip_path'),
    // voice | audio (a file the agent sent: `text` holds its title)
    type: text('type').notNull().default('voice'),
    durationSec: real('duration_sec'),
    // when clip_path was produced (clip retention counts from here, not from the message time: a replay can synthesize it much later)
    clipCreatedAt: text('clip_created_at'),
    // a warning to show in the history (for example the spoken intro of a file failed)
    note: text('note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('messages_user_created').on(t.userId, t.createdAt)],
)

// Browser sessions: only sha256 of the cookie token is stored.
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user').on(t.userId)],
)

// One-time links: an invite creates a user, a reset sets a new password for an existing one. Only the token hash is stored.
export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  // invite | reset
  kind: text('kind').notNull().default('invite'),
  tokenHash: text('token_hash').notNull().unique(),
  email: text('email').notNull(),
  role: text('role').notNull().default('user'),
  // for a reset: the user whose password it sets
  userId: text('user_id'),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
})

// Encrypted values (TTS provider keys). name = e.g. 'tts.azure.key'; the name is the AAD of the ciphertext.
export const secrets = sqliteTable('secrets', {
  name: text('name').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Plain admin settings, values are JSON.
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

// Voices the admin switched off ('<provider>:<voice id>'); everything else of a configured provider is on.
export const voicePrefs = sqliteTable('voice_prefs', {
  voiceKey: text('voice_key').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
})

export const presets = sqliteTable('presets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  url: text('url').notNull(),
  position: integer('position').notNull().default(0),
})

// The shared music library index (paths are relative to MUSIC_DIR, '/'-separated).
export const tracks = sqliteTable(
  'tracks',
  {
    id: text('id').primaryKey(),
    path: text('path').notNull().unique(),
    dir: text('dir').notNull(),
    title: text('title').notNull(),
    artist: text('artist').notNull().default(''),
    album: text('album').notNull().default(''),
    durationSec: real('duration_sec').notNull().default(0),
    size: integer('size').notNull().default(0),
    mtimeMs: integer('mtime_ms').notNull().default(0),
    // set for files uploaded through the web UI (quota accounting, duplicate detection); null for files that were just found by the scan
    uploadedBy: text('uploaded_by'),
    sha256: text('sha256'),
  },
  (t) => [index('tracks_dir').on(t.dir), index('tracks_size').on(t.size)],
)

export const playlists = sqliteTable(
  'playlists',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    // shuffle | ordered
    orderMode: text('order_mode').notNull().default('shuffle'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('playlists_user').on(t.userId)],
)

export const playlistTracks = sqliteTable(
  'playlist_tracks',
  {
    playlistId: text('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    trackId: text('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => [uniqueIndex('playlist_tracks_pos').on(t.playlistId, t.position)],
)

// Passkeys (WebAuthn): the public key of a credential, base64url. The credential id is what the browser sends to find the row.
export const passkeys = sqliteTable(
  'passkeys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull().unique(),
    publicKey: text('public_key').notNull(),
    signCount: integer('sign_count').notNull().default(0),
    // JSON array of transports, or null
    transports: text('transports'),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (t) => [index('passkeys_user').on(t.userId)],
)

// One-time WebAuthn challenges. `challenge` is the hash of the slot (the session user, or the cookie of a login attempt), `data` the challenge.
export const authChallenges = sqliteTable(
  'auth_challenges',
  {
    id: text('id').primaryKey(),
    // passkey-register | passkey-login
    kind: text('kind').notNull(),
    challenge: text('challenge').notNull(),
    userId: text('user_id'),
    data: text('data').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [index('auth_challenges_slot').on(t.kind, t.challenge)],
)
