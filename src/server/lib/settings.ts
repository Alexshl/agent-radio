// Admin settings: key -> JSON value in the `settings` table, with typed defaults.
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { settings } from '../db/schema'

export const DEFAULTS = {
  allowOwnUrls: true,
  // messages per user per hour, 0 = unlimited
  messageLimitPerHour: 60,
  // below the 100 MB request limit of Cloudflare's free plan
  maxAudioMb: 95,
  maxAudioMinutes: 20,
  // may ordinary users upload music to the shared library (the admin always may)
  allowUserUploads: false,
  // quota of the files one user uploaded, MB (2 GB); the admin has none
  uploadQuotaMb: 2048,
  defaultVoice: null as string | null,
  // per summary language ('ru' -> 'local:silero/xenia'); before defaultVoice, which stays for languages without their own
  defaultVoiceByLang: {} as Record<string, string>,
  // mix levels (dB) given to newly created stations
  defaultMusicGainDb: 0,
  defaultVoiceGainDb: 0,
  // speech rate (x) given to newly created users
  defaultSpeechRate: 1,
  'tts.azure.region': 'westeurope',
  'tts.openai.model': 'gpt-4o-mini-tts',
  'tts.gemini.model': 'gemini-3.8-flash-tts',
  // learn mode: the AI model (admin section "ИИ-модели"); the base URL of `local` is null = LEARN_LLM_URL
  'learn.provider': 'local',
  'learn.model': 'gemma4-e4b',
  'learn.webSearch': false,
  'learn.dailyLlmCalls': 200,
  'learn.localUrl': null as string | null,
  // the admin's override of the intro prompt template (null = the default of the repo, see learn/prompt.ts)
  'learn.prompt': null as string | null,
  // regenerate the notes of a song each time it is about to be played (lyrics stay cached)
  'learn.alwaysFresh': false,
  // model calls made today (UTC day) and their tokens
  'learn.usage': { day: '', calls: 0, tokensIn: 0, tokensOut: 0 },
}
export type SettingKey = keyof typeof DEFAULTS

export function getSetting<K extends SettingKey>(db: Db, key: K): (typeof DEFAULTS)[K] {
  const row = db.select().from(settings).where(eq(settings.key, key)).get()
  if (!row) return DEFAULTS[key]
  try {
    return JSON.parse(row.value) as (typeof DEFAULTS)[K]
  } catch {
    return DEFAULTS[key]
  }
}

export function setSetting<K extends SettingKey>(db: Db, key: K, value: (typeof DEFAULTS)[K]) {
  const v = JSON.stringify(value)
  db.insert(settings)
    .values({ key, value: v })
    .onConflictDoUpdate({ target: settings.key, set: { value: v } })
    .run()
}
