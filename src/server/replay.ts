// "Повторить в эфир": the user's own earlier messages go back into the user's radio stream (voice over the ducked music), so every
// listener hears them: VLC, the browser, a future app.
// Every replayed message is a NEW history row (same session / host / text, note = 'replay') that goes through the normal delivery
// (hold while the listener reconnects, push, play confirmation), so its status is as honest as that of any other message. The original
// row stays untouched; replays are never replayed again, never count into the hourly limit and are hidden from "last messages".
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { messages, type users } from './db/schema'
import type { FullDeps } from './deps'
import { HttpError, badRequest, notFound } from './lib/http'
import { newId, nowIso } from './lib/ids'
import { REPLAY_NOTE, spokenText } from './say'
import type { StationRow } from './stations'

type UserRow = typeof users.$inferSelect
type MessageRow = typeof messages.$inferSelect

export const MAX_REPLAY = 3

export const replayBody = z.union([
  z.object({ count: z.number().int().min(1).max(MAX_REPLAY) }),
  z.object({ id: z.string().min(1).max(100) }),
])

// aired: on its way to the listeners now; waiting: the listener is reconnecting, the messages are held; skipped: nobody listens
export type ReplayResult = { status: 'aired' | 'waiting' | 'skipped'; listeners: number; ids: string[] }

const hasClip = (m: MessageRow) => !!m.clipPath && existsSync(m.clipPath)
// spoken messages can always be synthesized again; an audio file only exists as its clip
const replayable = (m: MessageRow) => m.note !== REPLAY_NOTE && (m.type === 'voice' || (m.type === 'audio' && hasClip(m)))

export async function replayMessages(
  deps: FullDeps,
  p: { user: UserRow; station: StationRow; body: z.infer<typeof replayBody> },
): Promise<ReplayResult> {
  const { db, config, tts, delivery, listeners: tracker } = deps
  const { user, station: st, body } = p

  let picked: MessageRow[]
  if ('id' in body) {
    const m = db
      .select()
      .from(messages)
      .where(and(eq(messages.id, body.id), eq(messages.userId, user.id)))
      .get()
    if (!m) throw notFound('Message not found')
    if (!replayable(m)) throw badRequest('not_replayable', 'This message has no audio to replay')
    picked = [m]
  } else {
    const rows = db
      .select()
      .from(messages)
      .where(and(eq(messages.userId, user.id), inArray(messages.type, ['voice', 'audio'])))
      .orderBy(desc(messages.createdAt))
      .limit(200)
      .all()
    // newest N first, then played oldest first
    picked = rows.filter(replayable).slice(0, body.count).reverse()
  }
  if (picked.length === 0) throw notFound('Nothing to replay yet')

  const ls = await tracker.observe(st.id)
  if (ls.listeners === null) throw new HttpError(503, 'engine_unavailable', 'Streaming server is not reachable')
  const listeners = ls.listeners
  if (listeners === 0 && !ls.recentlyListening) return { status: 'skipped', listeners, ids: [] }

  const release = deps.userLock.acquire(user.id)
  try {
    const clipsDir = join(config.sharedDir, 'clips')
    mkdirSync(clipsDir, { recursive: true })
    const ids: string[] = []
    let status: ReplayResult['status'] = 'aired'
    for (const m of picked) {
      let clip = hasClip(m) ? (m.clipPath as string) : null
      if (!clip) {
        try {
          clip = await tts.makeClip({
            text: spokenText(user, m.session, m.text),
            voice: user.voice,
            lang: user.lang,
            chime: st.chime,
            rate: user.speechRate,
            userId: user.id,
          })
          db.update(messages).set({ clipPath: clip, clipCreatedAt: nowIso() }).where(eq(messages.id, m.id)).run()
        } catch (e) {
          console.error('replay synthesize failed:', e instanceof Error ? e.message : e)
          throw new HttpError(502, 'tts_failed', 'Could not synthesize the message')
        }
      }
      // its own copy: clip retention of the original must not pull the file from under the replay
      const id = newId()
      const copy = join(clipsDir, `${id}.mp3`)
      copyFileSync(clip, copy)
      db.insert(messages)
        .values({
          id,
          userId: user.id,
          session: m.session,
          host: m.host,
          text: m.text,
          type: m.type,
          durationSec: m.durationSec,
          status: 'waiting',
          clipPath: copy,
          clipCreatedAt: nowIso(),
          note: REPLAY_NOTE,
          createdAt: nowIso(),
        })
        .run()
      try {
        const res = await delivery.offer(id, st.id)
        if (res === 'waiting') status = 'waiting'
      } catch (e) {
        console.error('replay failed:', e instanceof Error ? e.message : e)
        db.update(messages).set({ status: 'failed', reason: 'push_failed' }).where(eq(messages.id, id)).run()
        throw new HttpError(502, 'replay_failed', 'Could not put the message on air')
      }
      ids.push(id)
    }
    return { status, listeners, ids }
  } finally {
    release()
  }
}
