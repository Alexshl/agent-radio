// Airing a spoken message: shared by POST /api/say (agent key) and "send test to air" (browser).
import { join, basename } from 'node:path'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { FullDeps } from './deps'
import { messages, type users } from './db/schema'
import { HttpError } from './lib/http'
import { newId, nowIso } from './lib/ids'
import { getSetting } from './lib/settings'
import type { StationRow } from './stations'

type UserRow = typeof users.$inferSelect

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
      .where(and(eq(messages.userId, userId), gte(messages.createdAt, since)))
      .get()?.n ?? 0
  if (n >= limit) throw new HttpError(429, 'user_limit', 'Hourly message limit reached', { 'Retry-After': '600' })
}

// A slow engine (F5-TTS on a CPU) must not hold the agent's HTTP request: after config.sayWaitMs (15 s) the answer is 202 "queued" and the
// clip goes on air when it is ready (if somebody still listens by then).

export type AirResult = { status: 'aired' | 'skipped' | 'queued'; listeners: number }

export async function airMessage(
  deps: FullDeps,
  p: { user: UserRow; station: StationRow; session: string; host: string | null; text: string },
): Promise<AirResult> {
  const { db, config, engine, icecast, tts } = deps
  const { user, station: st, session, host, text } = p
  checkHourlyLimit(deps, user.id)
  const listeners = await icecast.listeners(st.id)
  if (listeners === null) throw new HttpError(503, 'engine_unavailable', 'Streaming server is not reachable')
  const base = { id: newId(), userId: user.id, session, host, text, type: 'voice', createdAt: nowIso() }
  if (listeners === 0) {
    db.insert(messages)
      .values({ ...base, status: 'skipped', clipPath: null })
      .run()
    return { status: 'skipped', listeners }
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
  const play = async (clip: string) => {
    await engine.push(st.id, join(config.engineSharedDir, 'clips', basename(clip)))
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<'slow'>((resolve) => {
    timer = setTimeout(() => resolve('slow'), config.sayWaitMs)
  })
  let clip: string | null = null
  try {
    const first = await Promise.race([synth, slow])
    clearTimeout(timer)
    if (first === 'slow') {
      db.insert(messages)
        .values({ ...base, status: 'queued', clipPath: null })
        .run()
      void finishQueued(deps, base.id, st.id, synth).finally(release)
      return { status: 'queued', listeners }
    }
    clip = first
    await play(clip)
  } catch (e) {
    clearTimeout(timer)
    console.error('say failed:', e instanceof Error ? e.message : e)
    db.insert(messages)
      .values({ ...base, status: 'failed', clipPath: clip, clipCreatedAt: clip ? nowIso() : null })
      .run()
    release()
    throw new HttpError(502, 'tts_failed', 'Could not synthesize or play the message')
  }
  release()
  db.insert(messages)
    .values({ ...base, status: 'aired', clipPath: clip, clipCreatedAt: nowIso() })
    .run()
  return { status: 'aired', listeners }
}

// The clip of a queued message is ready (or failed): air it when somebody still listens, else keep it in the history as skipped.
async function finishQueued(deps: FullDeps, id: string, stationId: string, synth: Promise<string>) {
  const { db, config, engine, icecast } = deps
  const set = (v: Partial<typeof messages.$inferInsert>) => db.update(messages).set(v).where(eq(messages.id, id)).run()
  try {
    const clip = await synth
    const now = (await icecast.listeners(stationId)) ?? 0
    if (now === 0) return set({ status: 'skipped', clipPath: clip, clipCreatedAt: nowIso() })
    await engine.push(stationId, join(config.engineSharedDir, 'clips', basename(clip)))
    set({ status: 'aired', clipPath: clip, clipCreatedAt: nowIso() })
  } catch (e) {
    console.error('queued say failed:', e instanceof Error ? e.message : e)
    set({ status: 'failed' })
  }
}
