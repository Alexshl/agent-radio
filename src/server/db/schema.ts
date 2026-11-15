import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
    // summary language the agent writes in: uk | ru | en | lv | et | lt | de | sv (SUMMARY_LANGS in server/lang.ts)
    lang: text('lang').notNull().default('uk'),
    speakSession: integer('speak_session', { mode: 'boolean' }).notNull().default(true),
    // speech rate multiplier 0.8..1.6
    speechRate: real('speech_rate').notNull().default(1),
    // "Learn language" mode: the app queues the songs of the user's playlist itself and says who sings before some of them.
    // learnEvery: an intro before every 1st / 2nd / 3rd song
    learnMode: integer('learn_mode').notNull().default(0),
    learnEvery: integer('learn_every').notNull().default(1),
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
  // learn mode: JSON {playlistId, order, bag: [track ids still to play], cursor} (the shuffle bag survives restarts) and the every-N counter
  learnBag: text('learn_bag'),
  learnCounter: integer('learn_counter').notNull().default(0),
  // epoch ms of the last moment icecast showed a listener (the grace window of "recently listening", see listeners.ts)
  lastListenerSeenAt: integer('last_listener_seen_at'),
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
    // waiting (held until a listener reconnects) | queued (slow voice still synthesizing) | onair (pushed to the engine, not started yet) |
    // playing | aired (= played to the end) | skipped | failed
    status: text('status').notNull(),
    clipPath: text('clip_path'),
    // voice | audio (a file the agent sent: `text` holds its title)
    type: text('type').notNull().default('voice'),
    durationSec: real('duration_sec'),
    // when clip_path was produced (clip retention counts from here, not from the message time: a replay can synthesize it much later)
    clipCreatedAt: text('clip_created_at'),
    // a warning to show in the history (for example the spoken intro of a file failed)
    note: text('note'),
    // delivery: when the clip was handed to the engine / the engine started and finished playing it (epoch ms), how many times it was pushed
    pushedAt: integer('pushed_at'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    attempts: integer('attempts').notNull().default(0),
    // why a message was not played: nobody_listening | expired | tts_failed | push_failed | not_started | engine_restarted
    reason: text('reason'),
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

// Pronunciation dictionary applied to the text before every TTS call. scope 'global' (admin, user_id null) | 'user' (own entries, win over global).
// match: a word or phrase, case-insensitive, whole words; a trailing `*` makes it a stem (all word forms). replacement may carry `+` BEFORE the stressed vowel.
export const pronunciations = sqliteTable(
  'pronunciations',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull().default('user'),
    userId: text('user_id').references(() => users.id),
    // ru | uk | en | *
    lang: text('lang').notNull().default('*'),
    match: text('match').notNull(),
    replacement: text('replacement').notNull(),
    note: text('note').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('pronunciations_user').on(t.userId), index('pronunciations_scope').on(t.scope)],
)

// "Быстрые команды": one control token per user (iOS Shortcuts and the like). It can only replay, switch the source and read the status.
// Only sha256 of the token is stored; the token itself is shown once. Regenerating replaces the row, revoking deletes it.
export const controlTokens = sqliteTable('control_tokens', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
})

// Learn mode: lyrics of a library track (filled in by a later phase), one row per track.
export const songLyrics = sqliteTable('song_lyrics', {
  trackId: text('track_id')
    .primaryKey()
    .references(() => tracks.id, { onDelete: 'cascade' }),
  lyrics: text('lyrics'),
  // JSON [{t: seconds, text}] when the source has timing
  synced: text('synced'),
  lang: text('lang'),
  source: text('source'),
  // found | not_found | instrumental | error
  status: text('status').notNull().default('not_found'),
  fetchedAt: text('fetched_at').notNull(),
})

// Learn mode: the generated notes of a track in one target language (translation, summary, spoken intro).
export const songNotes = sqliteTable(
  'song_notes',
  {
    trackId: text('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    lang: text('lang').notNull(),
    // JSON [{src, tr}]
    pairs: text('pairs'),
    summary: text('summary'),
    introText: text('intro_text'),
    // JSON [string]: phrases worth noticing
    hooks: text('hooks'),
    model: text('model'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('song_notes_track_lang').on(t.trackId, t.lang)],
)

// Learn mode: a log of what the app queued. One row per song: planned -> pushed -> intro (the spoken intro is on air) -> playing -> done,
// or lost (the engine forgot it: a restart) / skipped. Also drives the recovery after an engine restart and, later, the archive.
export const learnPlays = sqliteTable(
  'learn_plays',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    stationId: text('station_id').notNull(),
    trackId: text('track_id').notNull(),
    status: text('status').notNull(),
    // the engine message ids (engine /msg/states); the intro is null when there is none
    trackMsg: text('track_msg').notNull(),
    introMsg: text('intro_msg'),
    // the spoken intro clip (path inside the app container), kept so that a lost song can be queued again with it
    introClip: text('intro_clip'),
    // 1 + how many times this song was queued again after the engine lost it
    attempt: integer('attempt').notNull().default(1),
    // a lost, never started song has been queued again (or given up)
    retried: integer('retried').notNull().default(0),
    plannedAt: integer('planned_at').notNull(),
    pushedAt: integer('pushed_at'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
  },
  (t) => [index('learn_plays_user_status').on(t.userId, t.status), index('learn_plays_station_status').on(t.stationId, t.status)],
)

// Learn mode: "I know this song / not interesting": such a song is queued without an intro and is not counted for the every-N counter.
export const learnSongPrefs = sqliteTable(
  'learn_song_prefs',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    trackId: text('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    skip: integer('skip').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.trackId] })],
)
