// Airing a spoken message: shared by POST /api/say (agent key) and "send test to air" (browser).
import { and, eq, gte, isNull, ne, or, sql } from 'drizzle-orm'
import { patchMessage } from './delivery'
import type { FullDeps } from './deps'
import { messages, type users } from './db/schema'
import { HttpError } from './lib/http'
import { newId, nowIso } from './lib/ids'
import { getSetting } from './lib/settings'
import type { StationRow } from './stations'

type UserRow = typeof users.$inferSelect

// a message that was put on air again from the history (Пульт): hidden from "last messages", not counted into the hourly limit
export const REPLAY_NOTE = 'replay'
export const notReplay = or(isNull(messages.note), ne(messages.note, REPLAY_NOTE))

const SESSION_WORD: Record<string, string> = { uk: 'Сесія', ru: 'Сессия', en: 'Session' }

export function spokenText(user: Pick<UserRow, 'lang' | 'speakSession'>, session: string, text: string): string {
  if (!user.speakSession) return text
  return `${SESSION_WORD[user.lang] ?? SESSION_WORD.en} ${session}. ${text}`
}

export function checkHourlyLimit(deps: FullDeps, userId: string) {
  const limit = getSetting(deps.db, 'messageLimitPerHour')
  if (!limit || limit <= 0) return
  const since = new Date(Date.now() - 3600_000).toISOString()
  const n =
    deps.db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(eq(messages.userId, userId), gte(messages.createdAt, since), notReplay))
      .get()?.n ?? 0
  if (n >= limit) throw new HttpError(429, 'user_limit', 'Hourly message limit reached', { 'Retry-After': '600' })
}

// A slow engine (F5-TTS on a CPU) must not hold the agent's HTTP request: after config.sayWaitMs (15 s) the answer is 202 "queued" and the
// clip goes on air when it is ready (if somebody still listens by then).
// With nobody listening right now but somebody seen within the last 180 s (a player reconnecting, an app deploy) the message is held
// ("waiting", 202) and goes on air when the listener is back; after 180 s it is skipped. `id` follows the delivery (GET /api/messages/:id).

export type AirResult = { id: string; status: 'aired' | 'skipped' | 'queued' | 'waiting'; listeners: number }

export async function airMessage(
  deps: FullDeps,
  p: { user: UserRow; station: StationRow; session: string; host: string | null; text: string },
): Promise<AirResult> {
  const { db, config, tts, delivery, listeners: tracker } = deps
  const { user, station: st, session, host, text } = p
  checkHourlyLimit(deps, user.id)
  const ls = await tracker.observe(st.id)
  if (ls.listeners === null) throw new HttpError(503, 'engine_unavailable', 'Streaming server is not reachable')
  const listeners = ls.listeners
  const base = { id: newId(), userId: user.id, session, host, text, type: 'voice', createdAt: nowIso() }
  if (listeners === 0 && !ls.recentlyListening) {
    db.insert(messages)
      .values({ ...base, status: 'skipped', clipPath: null, reason: 'nobody_listening' })
      .run()
    return { id: base.id, status: 'skipped', listeners }
  }
  const release = deps.userLock.acquire(user.id)
  const synth = tts.makeClip({
    text: spokenText(user, session, text),
    voice: user.voice,
    lang: user.lang,
    chime: st.chime,
    rate: user.speechRate,
    userId: user.id,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<'slow'>((resolve) => {
    timer = setTimeout(() => resolve('slow'), config.sayWaitMs)
  })
  let clip: string
  try {
    const first = await Promise.race([synth, slow])
    clearTimeout(timer)
    if (first === 'slow') {
      db.insert(messages)
        .values({ ...base, status: 'queued', clipPath: null })
        .run()
      void finishQueued(deps, base.id, st.id, synth).finally(release)
      return { id: base.id, status: 'queued', listeners }
    }
    clip = first
  } catch (e) {
    clearTimeout(timer)
    console.error('say failed:', e instanceof Error ? e.message : e)
    db.insert(messages)
      .values({ ...base, status: 'failed', reason: 'tts_failed' })
      .run()
    release()
    throw new HttpError(502, 'tts_failed', 'Could not synthesize or play the message')
  }
  db.insert(messages)
    .values({ ...base, status: 'waiting', clipPath: clip, clipCreatedAt: nowIso() })
    .run()
  try {
    const status = await delivery.offer(base.id, st.id)
    return { id: base.id, status: status === 'onair' ? 'aired' : status, listeners }
  } catch (e) {
    console.error('say failed:', e instanceof Error ? e.message : e)
    patchMessage(db, base.id, { status: 'failed', reason: 'push_failed' })
    throw new HttpError(502, 'tts_failed', 'Could not synthesize or play the message')
  } finally {
    release()
  }
}

// The clip of a queued message is ready (or failed): air it when somebody listens (or hold it for a reconnecting listener).
async function finishQueued(deps: FullDeps, id: string, stationId: string, synth: Promise<string>) {
  const { db, delivery } = deps
  try {
    const clip = await synth
    patchMessage(db, id, { status: 'waiting', clipPath: clip, clipCreatedAt: nowIso() })
    await delivery.offer(id, stationId)
  } catch (e) {
    console.error('queued say failed:', e instanceof Error ? e.message : e)
    patchMessage(db, id, { status: 'failed', reason: 'tts_failed' })
  }
}
