import { Readable } from 'node:stream'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import busboy from 'busboy'
import { eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { apiKeys, messages } from '../db/schema'
import type { FullDeps } from '../deps'
import type { AppEnv } from '../env'
import { deliveryView, messageById, patchMessage } from '../delivery'
import { requireApiKey } from '../lib/api-keys'
import { HttpError, badRequest } from '../lib/http'
import { newId, nowIso } from '../lib/ids'
import { getSetting } from '../lib/settings'
import { airMessage, checkHourlyLimit } from '../say'
import { changeSource } from '../source'
import { levelFields, parseSource, sourceSchema, stationOfUser, userById } from '../stations'

const sayBody = z.object({
  session: z.string().trim().min(1).max(200),
  host: z.string().trim().max(200).optional(),
  // longer text is cut, not refused: an agent summary that runs long should still be heard
  text: z.string().trim().min(1),
})

export function listenUrl(config: { publicUrl: string }, id: string, token: string) {
  return `${config.publicUrl}/stream/${id}.mp3?k=${token}`
}

export const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac'])
const MAX_FIELD = 4000

export interface Upload {
  file: string
  filename: string
  fields: Record<string, string>
}

// multipart/form-data -> a temp file (streamed, never held in memory) + text fields. Throws 413 over `maxBytes`, 415 for a bad extension.
export async function receiveUpload(req: Request, dir: string, maxBytes: number, exts: ReadonlySet<string> = AUDIO_EXT): Promise<Upload> {
  const contentType = req.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data/i.test(contentType) || !req.body)
    throw badRequest('invalid_body', 'Expected multipart/form-data with a "file" field')
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > maxBytes + 1024 * 1024)
    throw new HttpError(413, 'too_large', `File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`)
  mkdirSync(dir, { recursive: true })
  const fields: Record<string, string> = {}
  let file: string | null = null
  let filename = ''
  let failure: HttpError | null = null
  const writes: Promise<void>[] = []
  const bb = busboy({
    headers: { 'content-type': contentType },
    defParamCharset: 'utf8',
    limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: MAX_FIELD },
  })
  bb.on('field', (name, value) => {
    fields[name] = value
  })
  bb.on('file', (name, stream, info) => {
    if (name !== 'file' || file) {
      stream.resume()
      return
    }
    filename = basename(info.filename || 'upload')
    if (!exts.has(extname(filename).toLowerCase())) {
      failure = new HttpError(415, 'unsupported_type', `Supported: ${[...exts].map((e) => e.slice(1)).join(', ')}`)
      stream.resume()
      return
    }
    const path = join(dir, `${newId()}${extname(filename).toLowerCase()}`)
    file = path
    stream.on('limit', () => {
      failure = new HttpError(413, 'too_large', `File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`)
    })
    writes.push(pipeline(stream, createWriteStream(path)))
  })
  try {
    await pipeline(Readable.fromWeb(req.body as never), bb)
    await Promise.all(writes)
  } catch (e) {
    if (file) rmSync(file, { force: true })
    if (e instanceof HttpError) throw e
    throw badRequest('invalid_body', 'Could not read the upload')
  }
  if (failure) {
    if (file) rmSync(file, { force: true })
    throw failure
  }
  if (!file) throw badRequest('file_required', 'Expected a "file" field')
  return { file, filename, fields }
}

export function apiRoutes(deps: FullDeps) {
  const { db, config, icecast, limiter, media, airing } = deps
  const api = new Hono<AppEnv>()
  // agent routes only; the browser routes (/api/auth, /api/app, /api/admin) are mounted before this router
  for (const path of ['/say', '/status', '/station/*', '/play', '/messages/*']) api.use(path, requireApiKey(db))

  api.post('/say', async (c) => {
    const { keyId, userId } = c.get('auth')
    limiter.check(keyId)
    const parsed = sayBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw badRequest('invalid_body', 'Expected {session, host?, text<=2000}')
    const { session, host } = parsed.data
    const text = parsed.data.text.length > 2000 ? `${parsed.data.text.slice(0, 1999)}…` : parsed.data.text
    // a key only ever reaches its own user's station
    const st = stationOfUser(db, userId)
    const user = userById(db, userId)
    if (!st || !user) throw new HttpError(404, 'no_station', 'No station for this user')
    db.update(apiKeys).set({ lastUsedAt: nowIso(), lastSession: session }).where(eq(apiKeys.id, keyId)).run()
    const r = await airMessage(deps, { user, station: st, session, host: host ?? null, text })
    return c.json(r, r.status === 'queued' || r.status === 'waiting' ? 202 : 200)
  })

  api.get('/status', async (c) => {
    const user = userById(db, c.get('auth').userId)
    const st = user && stationOfUser(db, user.id)
    if (!user || !st) throw new HttpError(404, 'no_station', 'No station for this user')
    const [up, ls, title] = await Promise.all([icecast.isUp(st.id), deps.listeners.observe(st.id), icecast.title?.(st.id) ?? null])
    const file = airing.current(st.id)
    return c.json({
      up: up === true,
      listeners: ls.listeners ?? 0,
      // somebody listens now or was seen within the last 180 s (a player reconnecting): messages are still sent, and held until they are back
      listening: ls.recentlyListening,
      reconnecting: (ls.listeners ?? 0) === 0 && ls.recentlyListening,
      title: file ? file.title : title,
      // what the agent skill needs to write the summary
      lang: user.lang,
      speakSession: user.speakSession,
      chime: st.chime,
      voice: user.voice,
      speechRate: user.speechRate,
      station: {
        id: st.id,
        source: parseSource(st.source),
        duckDb: st.duckDb,
        ...levelFields(st),
        chime: st.chime,
        listenUrl: listenUrl(config, st.id, st.listenToken),
      },
    })
  })

  // Where a message stands: waiting | queued | on_air_queued | playing | played | skipped | failed (+ reason, startedAt, endedAt)
  api.get('/messages/:id', (c) => {
    const m = messageById(db, c.req.param('id'))
    if (!m || m.userId !== c.get('auth').userId) throw new HttpError(404, 'not_found', 'No such message')
    return c.json(deliveryView(m))
  })

  // Changes the music bed live (the stream keeps running).
  api.put('/station/source', async (c) => {
    const user = userById(db, c.get('auth').userId)
    const st = user && stationOfUser(db, user.id)
    if (!user || !st) throw new HttpError(404, 'no_station', 'No station for this user')
    const parsed = sourceSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw badRequest('invalid_body', 'Expected {type: relay|playlist|userplaylist|silence, url?|dir?|playlistId?}')
    await changeSource(deps, user, st, parsed.data)
    return c.json({ ok: true, source: parsed.data })
  })

  // An audio file for the user's station (multipart: file, title?, intro?, session?, host?). Always kept in the history; it goes on air only
  // when somebody listens right now. On air the music bed is muted for the whole file and voice messages wait for its end.
  api.post('/play', async (c) => {
    const { keyId, userId } = c.get('auth')
    limiter.check(keyId)
    checkHourlyLimit(deps, userId)
    // one upload / conversion per user at a time
    const release = deps.userLock.acquire(userId)
    try {
      return await handlePlay(c)
    } finally {
      release()
    }
  })

  const handlePlay = async (c: Context<AppEnv>) => {
    const { userId } = c.get('auth')
    const st = stationOfUser(db, userId)
    const user = userById(db, userId)
    if (!st || !user) throw new HttpError(404, 'no_station', 'No station for this user')
    const maxBytes = getSetting(db, 'maxAudioMb') * 1024 * 1024
    const maxSec = getSetting(db, 'maxAudioMinutes') * 60
    const uploadDir = join(config.dataDir, 'uploads')
    const up = await receiveUpload(c.req.raw, uploadDir, maxBytes)
    const clipsDir = join(config.sharedDir, 'clips')
    const out = join(clipsDir, `${newId()}.mp3`)
    let introClip: string | null = null
    try {
      let durationSec: number
      try {
        const info = await media.probe(up.file)
        if (!info.hasAudio) throw badRequest('no_audio', 'The file has no audio stream')
        durationSec = info.durationSec
      } catch (e) {
        if (e instanceof HttpError) throw e
        throw new HttpError(415, 'unsupported_type', 'Could not read this file as audio')
      }
      if (!(durationSec > 0)) throw badRequest('no_audio', 'The file has no duration')
      if (durationSec > maxSec) throw new HttpError(413, 'too_long', `Longer than ${Math.round(maxSec / 60)} minutes`)

      const title = (up.fields.title ?? '').trim().slice(0, 200) || up.filename.replace(/\.[^.]+$/, '')
      const session = (up.fields.session ?? '').trim().slice(0, 200) || 'audio'
      const host = (up.fields.host ?? '').trim().slice(0, 200) || null
      const intro = (up.fields.intro ?? '').trim().slice(0, 2000)

      const ls = await deps.listeners.observe(st.id)
      const listeners = ls.listeners ?? 0
      // somebody listens now, or was seen within the grace window (a reconnecting player): the file is prepared and held for them
      const heard = listeners > 0 || ls.recentlyListening
      let note: string | null = null
      if (heard && intro) {
        try {
          introClip = await deps.tts.makeClip({
            text: intro,
            voice: user.voice,
            lang: user.lang,
            chime: st.chime,
            rate: user.speechRate,
            userId: user.id,
          })
        } catch (e) {
          // the file matters more than its announcement: play without the intro and say so in the history
          console.error('intro failed:', e instanceof Error ? e.message : e)
          note = 'intro_failed'
        }
      }
      mkdirSync(clipsDir, { recursive: true })
      await media.makeTrack({ input: up.file, intro: introClip, out })

      const id = newId()
      const base = {
        id,
        userId,
        session,
        host,
        text: title,
        type: 'audio',
        durationSec,
        createdAt: nowIso(),
        clipPath: out,
        clipCreatedAt: nowIso(),
        note,
      }
      if (!heard) {
        db.insert(messages)
          .values({ ...base, status: 'skipped', reason: 'nobody_listening' })
          .run()
        return c.json({ status: 'skipped', listeners, id, title, durationSec })
      }
      db.insert(messages)
        .values({ ...base, status: 'waiting' })
        .run()
      let status: 'onair' | 'waiting' | 'skipped'
      try {
        status = await deps.delivery.offer(id, st.id)
      } catch (e) {
        console.error('play failed:', e instanceof Error ? e.message : e)
        patchMessage(db, id, { status: 'failed', reason: 'push_failed', clipPath: null, clipCreatedAt: null })
        throw new HttpError(502, 'play_failed', 'Could not queue the file on air')
      }
      return c.json({ status: status === 'onair' ? 'aired' : status, listeners, id, title, durationSec }, status === 'waiting' ? 202 : 200)
    } catch (e) {
      rmSync(out, { force: true })
      throw e
    } finally {
      rmSync(up.file, { force: true })
      if (introClip) rmSync(introClip, { force: true })
    }
  }

  return api
}
