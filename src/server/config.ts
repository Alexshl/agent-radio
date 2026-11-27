export interface Config {
  port: number
  dataDir: string
  dbPath: string
  sharedDir: string
  musicDir: string
  // where the engine (liquidsoap) sees the same volumes
  engineSharedDir: string
  engineMusicDir: string
  piperModelsDir: string
  piperBin: string
  icecastUrl: string
  // icecast admin login (listclients: the watchdog's monitor connections are not counted as listeners); null = they are counted
  icecastAdmin: { user: string; password: string } | null
  engineUrl: string
  adminEmail: string | null
  ttsProvider: string
  ttsVoice: string | null
  ttsLang: string
  // the tts-local sidecar (local neural voices); null = not used
  ttsLocalUrl: string | null
  // a GPU voice server on another machine (same API as tts-local, Bearer token); null = not used
  ttsRemoteUrl: string | null
  ttsRemoteToken: string | null
  // learn mode: the default OpenAI-compatible server (llama.cpp on the host) used while the admin has not chosen another provider
  learnLlmUrl: string
  publicUrl: string
  sayRatePerMin: number
  // /api/say answers 202 "queued" when the speech is not ready after this long
  sayWaitMs: number
  maxClipAgeMs: number
  messageRetentionMs: number
  // AES key material for the stored provider keys; null = generate one into <dataDir>/app-secret (see lib/secrets.ts)
  appSecret: string | null
  // built React app (vite) and the files served as /client/* (install.sh, skill)
  webDir: string
  clientFilesDir: string
  sessionTtlMs: number
  // tail of PUBLIC_URL decides the Secure flag of the session cookie
  cookieSecure: boolean
  ffmpegBin: string
  ffprobeBin: string
  adminPassword: string | null
  // internal-only listener the engine pulls relayed streams from (never published), and the host name the engine reaches it under
  relayPort: number
  relayHost: string
  // believe CF-Connecting-IP / X-Forwarded-For (only behind a tunnel or reverse proxy)
  trustProxy: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8790)
  const dataDir = env.DATA_DIR ?? './data'
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '')
  return {
    port,
    dataDir,
    dbPath: env.DB_PATH ?? `${dataDir}/radio.db`,
    sharedDir: env.SHARED_DIR ?? `${dataDir}/shared`,
    musicDir: env.MUSIC_DIR ?? './music',
    engineSharedDir: env.ENGINE_SHARED_DIR ?? '/shared',
    engineMusicDir: env.ENGINE_MUSIC_DIR ?? '/music',
    piperModelsDir: env.PIPER_MODELS_DIR ?? `${dataDir}/piper`,
    piperBin: env.PIPER_BIN ?? 'piper',
    icecastUrl: (env.ICECAST_URL ?? 'http://localhost:8000').replace(/\/+$/, ''),
    icecastAdmin: env.ICECAST_ADMIN_PASSWORD ? { user: env.ICECAST_ADMIN_USER ?? 'admin', password: env.ICECAST_ADMIN_PASSWORD } : null,
    engineUrl: (env.ENGINE_URL ?? 'http://localhost:8080').replace(/\/+$/, ''),
    adminEmail: env.ADMIN_EMAIL?.trim() || null,
    ttsProvider: env.TTS_PROVIDER ?? 'piper',
    ttsVoice: env.TTS_VOICE?.trim() || null,
    ttsLang: env.TTS_LANG ?? 'uk',
    ttsLocalUrl: env.TTS_LOCAL_URL?.trim().replace(/\/+$/, '') || null,
    ttsRemoteUrl: env.TTS_REMOTE_URL?.trim().replace(/\/+$/, '') || null,
    ttsRemoteToken: env.TTS_REMOTE_TOKEN?.trim() || null,
    learnLlmUrl: (env.LEARN_LLM_URL?.trim() || 'http://host.docker.internal:8091/v1').replace(/\/+$/, ''),
    publicUrl,
    sayRatePerMin: Number(env.SAY_RATE_PER_MIN ?? 10),
    sayWaitMs: Number(env.SAY_SYNC_WAIT_MS ?? 15_000),
    maxClipAgeMs: 7 * 24 * 60 * 60 * 1000,
    messageRetentionMs: 30 * 24 * 60 * 60 * 1000,
    appSecret: env.APP_SECRET?.trim() || null,
    webDir: env.WEB_DIR ?? './dist/client',
    clientFilesDir: env.CLIENT_FILES_DIR ?? './client',
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    cookieSecure: publicUrl.startsWith('https://'),
    ffmpegBin: env.FFMPEG_BIN ?? 'ffmpeg',
    ffprobeBin: env.FFPROBE_BIN ?? 'ffprobe',
    adminPassword: env.ADMIN_PASSWORD || null,
    relayPort: Number(env.RELAY_PORT ?? 8792),
    relayHost: env.RELAY_HOST ?? 'app',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  }
}
