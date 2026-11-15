// The signed-in user's API (cookie session): /api/app/*
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { and, desc, eq, gte } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { messages, presets, stations, users } from '../db/schema'
import type { FullDeps } from '../deps'
import type { AppEnv } from '../env'
import { createApiKey, listApiKeys, revokeApiKey } from '../lib/api-keys'
import { csrfGuard, requireSession } from '../lib/auth'
import { RateLimiter } from '../lib/rate-limit'
import { HttpError, badRequest, notFound } from '../lib/http'
import { nowIso, randomToken } from '../lib/ids'
import { serveFile } from '../lib/serve-file'
import { getSetting } from '../lib/settings'
import { createPlaylist, deletePlaylist, getPlaylist, listPlaylists, playlistBody, updatePlaylist } from '../playlists'
import { replayBody, replayMessages } from '../replay'
import { airMessage, notReplay, spokenText } from '../say'
import { changeSource } from '../source'
import { createPron, deletePron, listPron, pronBody, pronPatch, pronView, updatePron } from '../tts/pronunciation-store'
import { assertMayUpload, assertQuota, INCOMING_DIR, ingestFile, UPLOAD_EXT, UPLOAD_MAX_MB, uploadPolicy } from '../uploads'
import { checkReachable } from './admin'
import { receiveUpload } from './api'
import {
  type StationRow,
  levelFields,
  RATE_RANGE,
  levelsSchema,
  parseSource,
  sourceSchema,
  stationOfUser,
  withStationLock,
} from '../stations'

export const MAX_KEYS_PER_USER = 20
export const MAX_PRONUNCIATIONS = 500
const pagingQuery = z.object({
  dir: z.string().max(500).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
})

const settingsBody = z.object({
  voice: z.string().max(200).nullable().optional(),
  lang: z.enum(['uk', 'ru', 'en']).optional(),
  speakSession: z.boolean().optional(),
  chime: z.boolean().optional(),
  duckDb: z.number().min(0).max(40).optional(),
  ...levelsSchema.shape,
  speechRate: z.number().min(RATE_RANGE.min).max(RATE_RANGE.max).optional(),
})

export function listenLinks(config: FullDeps['config'], st: StationRow) {
  const q = `k=${st.listenToken}`
  return {
    listenUrl: `${config.publicUrl}/stream/${st.id}.mp3?${q}`,
    m3uUrl: `${config.publicUrl}/stream/${st.id}.m3u?${q}`,
    // same-origin URL for the in-browser player
    webStreamPath: `/stream/${st.id}.mp3?${q}`,
  }
}

export function appRoutes(deps: FullDeps) {
  const { db, config, engine, icecast, registry, library, airing } = deps
  const r = new Hono<AppEnv>()
  r.use('*', csrfGuard(config))
  r.use('*', requireSession(db))

  const stationOf = (userId: string) => {
    const st = stationOfUser(db, userId)
    if (!st) throw new HttpError(404, 'no_station', 'No station for this user')
    return st
  }

  const messageView = (m: typeof messages.$inferSelect) => ({
    id: m.id,
    session: m.session,
    host: m.host,
    text: m.text,
    status: m.status,
    type: m.type,
    durationSec: m.durationSec,
    hasClip: !!m.clipPath && existsSync(m.clipPath),
    note: m.note,
    reason: m.reason,
    createdAt: m.createdAt,
  })

  // ---- radio ("Моё радио") ----

  r.get('/radio', async (c) => {
    const user = c.get('user')
    const st = stationOf(user.id)
    const keys = listApiKeys(db, user.id).filter((k) => !k.revokedAt)
    const lastKey = [...keys].filter((k) => k.lastUsedAt).sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))[0]
    const last = db
      .select()
      .from(messages)
      .where(and(eq(messages.userId, user.id), notReplay))
      .orderBy(desc(messages.createdAt))
      .limit(3)
      .all()
    return c.json({
      user: { name: user.name, email: user.email, role: user.role },
      station: {
        id: st.id,
        source: parseSource(st.source),
        duckDb: st.duckDb,
        ...levelFields(st),
        chime: st.chime,
        ...listenLinks(config, st),
      },
      settings: { voice: user.voice, lang: user.lang, speakSession: user.speakSession, speechRate: user.speechRate },
      allowOwnUrls: user.role === 'admin' || getSetting(db, 'allowOwnUrls'),
      defaultVoice: registry.defaultVoiceKey(user.lang),
      presets: db.select().from(presets).orderBy(presets.position).all(),
      playlists: listPlaylists(db, user.id),
      voices: registry.availableVoices(),
      messages: last.map(messageView),
      keys: { count: keys.length, lastUsedAt: lastKey?.lastUsedAt ?? null, lastName: lastKey?.name ?? null },
    })
  })

  // polled while the page is open
  r.get('/live', async (c) => {
    const st = stationOf(c.get('user').id)
    const [up, listeners, title] = await Promise.all([icecast.isUp(st.id), icecast.listeners(st.id), icecast.title?.(st.id) ?? null])
    const file = airing.current(st.id)
    return c.json({ up: up === true, listeners: listeners ?? 0, title: file ? file.title : title, file: !!file })
  })

  r.put('/station/source', async (c) => {
    const user = c.get('user')
    const parsed = sourceSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw badRequest('invalid_body', 'Invalid source')
    await changeSource(deps, user, stationOf(user.id), parsed.data)
    return c.json({ ok: true, source: parsed.data })
  })

  // "Проверить ссылку": ok / blocked / down only (no timing). Same address checks and the same "own URLs" rule as setting the source.
  r.post('/check-url', async (c) => {
    const user = c.get('user')
    deps.checkLimiter.check(user.id)
    const body = z.object({ url: z.string().max(2000) }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    const isPreset = !!db.select().from(presets).where(eq(presets.url, body.data.url)).get()
    if (!isPreset && user.role !== 'admin' && !getSetting(db, 'allowOwnUrls')) {
      throw new HttpError(403, 'own_urls_disabled', 'Own stream links are switched off by the administrator')
    }
    const r = await checkReachable(body.data.url, { resolver: deps.resolver, transport: deps.transport })
    return c.json({ status: r.status === 'slow' ? 'ok' : r.status })
  })

  r.post('/station/regenerate', (c) => {
    const st = stationOf(c.get('user').id)
    const listenToken = randomToken(24)
    db.update(stations).set({ listenToken, updatedAt: nowIso() }).where(eq(stations.id, st.id)).run()
    return c.json(listenLinks(config, { ...st, listenToken }))
  })

  r.patch('/settings', async (c) => {
    const user = c.get('user')
    const body = settingsBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    const b = body.data
    const st = stationOf(user.id)
    if (b.voice !== undefined && b.voice !== null) {
      const v = registry.findVoice(b.voice)
      if (!v || !registry.availableVoices().some((x) => x.key === b.voice))
        throw badRequest('voice_unavailable', 'This voice is not available')
    }
    const userSet: Partial<typeof users.$inferInsert> = {}
    if (b.voice !== undefined) userSet.voice = b.voice
    if (b.lang) userSet.lang = b.lang
    if (b.speakSession !== undefined) userSet.speakSession = b.speakSession
    if (b.speechRate !== undefined) userSet.speechRate = b.speechRate
    if (Object.keys(userSet).length)
      db.update(users)
        .set({ ...userSet, updatedAt: nowIso() })
        .where(eq(users.id, user.id))
        .run()
    const stSet: Partial<typeof stations.$inferInsert> = {}
    if (b.chime !== undefined) stSet.chime = b.chime
    if (b.duckDb !== undefined) {
      try {
        const duck = b.duckDb
        await withStationLock(st.id, () => engine.setDuck(st.id, duck))
      } catch (e) {
        console.error('set duck failed:', e instanceof Error ? e.message : e)
        throw new HttpError(503, 'engine_unavailable', 'Engine did not accept the change')
      }
      stSet.duckDb = b.duckDb
    }
    const lv: Partial<Record<'musicGainDb' | 'voiceGainDb' | 'trackGainDb', number>> = {}
    for (const k of ['musicGainDb', 'voiceGainDb', 'trackGainDb'] as const) if (b[k] !== undefined) lv[k] = b[k]
    if (Object.keys(lv).length) {
      try {
        await withStationLock(st.id, () =>
          engine.setLevels(st.id, {
            musicDb: lv.musicGainDb,
            voiceDb: lv.voiceGainDb,
            trackDb: lv.trackGainDb,
          }),
        )
      } catch (e) {
        console.error('set levels failed:', e instanceof Error ? e.message : e)
        throw new HttpError(503, 'engine_unavailable', 'Engine did not accept the change')
      }
      Object.assign(stSet, lv)
    }
    if (Object.keys(stSet).length)
      db.update(stations)
        .set({ ...stSet, updatedAt: nowIso() })
        .where(eq(stations.id, st.id))
        .run()
    return c.json({ ok: true })
  })

  r.post('/test', async (c) => {
    const user = c.get('user')
    const text = {
      uk: 'Це перевірка ефіру. Якщо ви це чуєте — все працює.',
      ru: 'Это проверка эфира. Если вы это слышите, всё работает.',
      en: 'This is an on-air test. If you hear it, everything works.',
    }[user.lang]
    const res = await airMessage(deps, { user, station: stationOf(user.id), session: 'test', host: 'browser', text: text ?? '' })
    return c.json(res)
  })

  // ---- agent keys ----

  r.get('/keys', (c) => c.json({ keys: listApiKeys(db, c.get('user').id) }))

  r.post('/keys', async (c) => {
    if (listApiKeys(db, c.get('user').id).filter((k) => !k.revokedAt).length >= MAX_KEYS_PER_USER) {
      throw badRequest('key_limit', `At most ${MAX_KEYS_PER_USER} active keys per user: revoke one first`)
    }
    const body = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body', 'Expected {name}')
    const { key, token } = await createApiKey(db, { userId: c.get('user').id, name: body.data.name })
    return c.json({ key, token }, 201)
  })

  r.delete('/keys/:id', (c) => {
    if (!revokeApiKey(db, c.req.param('id'), c.get('user').id)) throw notFound('Key not found')
    return c.json({ ok: true })
  })

  r.get('/connect', (c) => c.json({ publicUrl: config.publicUrl }))

  // ---- library ----

  r.get('/library/status', (c) =>
    c.json({
      total: library.count(),
      totalSize: library.totalSize(),
      scanning: library.scanning,
      lastScan: library.last,
      upload: uploadPolicy(deps, c.get('user')),
    }),
  )

  // One audio file per request (multipart: file). The browser sends several files one after another and shows the progress of each.
  r.post('/library/upload', async (c) => {
    const user = c.get('user')
    assertMayUpload(deps, user)
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > 0) assertQuota(deps, user, declared)
    // one upload / conversion per user at a time
    const release = deps.userLock.acquire(user.id)
    try {
      const up = await receiveUpload(c.req.raw, join(config.musicDir, INCOMING_DIR), UPLOAD_MAX_MB * 1024 * 1024, UPLOAD_EXT)
      return c.json({ track: await ingestFile(deps, user, up.file, up.filename) }, 201)
    } finally {
      release()
    }
  })
  r.get('/library/folders', (c) => c.json({ folders: library.folders(), total: library.count() }))
  r.get('/library/tracks', (c) => {
    const q = pagingQuery.safeParse(c.req.query())
    if (!q.success) throw badRequest('invalid_query', 'Invalid limit / offset')
    return c.json(library.search(q.data))
  })
  // All tracks of a folder (recursive) or search, for adding a whole folder to a playlist (capped at 5000)
  r.get('/library/track-ids', (c) => {
    const q = pagingQuery.pick({ dir: true, q: true }).safeParse(c.req.query())
    if (!q.success) throw badRequest('invalid_query')
    return c.json(library.matching(q.data))
  })
  r.get('/library/tracks/:id/audio', (c) => serveFile(c, library.fileOf(c.req.param('id')).file))

  // ---- playlists ----

  r.get('/playlists', (c) => c.json({ playlists: listPlaylists(db, c.get('user').id) }))
  r.get('/playlists/:id', (c) => c.json(getPlaylist(db, c.get('user').id, c.req.param('id'))))

  const parsePlaylist = async (c: { req: { json(): Promise<unknown> } }) => {
    const body = playlistBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body', 'Expected {name, orderMode, trackIds}')
    return body.data
  }

  r.post('/playlists', async (c) => c.json(createPlaylist(db, c.get('user').id, await parsePlaylist(c)), 201))

  r.put('/playlists/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const pl = updatePlaylist(db, user.id, id, await parsePlaylist(c))
    // a playlist that is on air right now: the engine gets the new list
    const st = stationOf(user.id)
    const src = parseSource(st.source)
    if (src.type === 'userplaylist' && src.playlistId === id)
      await changeSource(deps, user, st, src).catch((e) => console.error('playlist re-apply failed:', e))
    return c.json(pl)
  })

  r.delete('/playlists/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    deletePlaylist(db, user.id, id)
    const st = stationOf(user.id)
    const src = parseSource(st.source)
    if (src.type === 'userplaylist' && src.playlistId === id) await changeSource(deps, user, st, { type: 'silence' })
    return c.json({ ok: true })
  })

  // ---- history ----

  r.get('/history', (c) => {
    const user = c.get('user')
    const since = new Date(Date.now() - config.messageRetentionMs).toISOString()
    const rows = db
      .select()
      .from(messages)
      .where(and(eq(messages.userId, user.id), gte(messages.createdAt, since)))
      .orderBy(desc(messages.createdAt))
      .limit(1000)
      .all()
    return c.json({ messages: rows.map(messageView), retentionDays: Math.round(config.messageRetentionMs / 86400_000) })
  })

  const ownMessage = (userId: string, id: string) => {
    const m = db
      .select()
      .from(messages)
      .where(and(eq(messages.id, id), eq(messages.userId, userId)))
      .get()
    if (!m) throw notFound('Message not found')
    return m
  }

  r.get('/history/:id/audio', (c) => {
    const m = ownMessage(c.get('user').id, c.req.param('id'))
    if (!m.clipPath) throw notFound('No audio stored for this message')
    return serveFile(c, m.clipPath)
  })

  // A message nobody heard (or whose clip failed) is synthesized now with the user's current voice, so it can be played in the browser.
  r.post('/history/:id/synthesize', async (c) => {
    const user = c.get('user')
    const m = ownMessage(user.id, c.req.param('id'))
    if (m.type !== 'voice') throw badRequest('not_voice', 'Only spoken messages can be synthesized')
    if (m.clipPath && existsSync(m.clipPath)) return c.json({ ok: true })
    const text = spokenText(user, m.session, m.text)
    try {
      const clip = await deps.tts.makeClip({
        text,
        voice: user.voice,
        lang: user.lang,
        chime: false,
        rate: user.speechRate,
        userId: user.id,
      })
      db.update(messages).set({ clipPath: clip, clipCreatedAt: nowIso() }).where(eq(messages.id, m.id)).run()
    } catch (e) {
      console.error('synthesize failed:', e instanceof Error ? e.message : e)
      throw new HttpError(502, 'tts_failed', 'Could not synthesize the message')
    }
    return c.json({ ok: true })
  })

  // ---- pronunciation dictionary (own entries; the global ones are read-only here) ----

  r.get('/pronunciations', (c) => {
    const user = c.get('user')
    return c.json({
      mine: listPron(db, 'user', user.id).map(pronView),
      global: listPron(db, 'global', null).map(pronView),
    })
  })

  r.post('/pronunciations', async (c) => {
    const body = pronBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body', 'Expected {match, replacement, lang?, note?}')
    const user = c.get('user')
    if (listPron(db, 'user', user.id).length >= MAX_PRONUNCIATIONS) throw badRequest('too_many', `At most ${MAX_PRONUNCIATIONS} entries`)
    return c.json(pronView(createPron(db, 'user', user.id, body.data)), 201)
  })

  r.patch('/pronunciations/:id', async (c) => {
    const body = pronPatch.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    const row = updatePron(db, c.req.param('id'), 'user', c.get('user').id, body.data)
    if (!row) throw notFound('Entry not found')
    return c.json(pronView(row))
  })

  r.delete('/pronunciations/:id', (c) => {
    if (!deletePron(db, c.req.param('id'), 'user', c.get('user').id)) throw notFound('Entry not found')
    return c.json({ ok: true })
  })

  // One phrase with the user's current voice (for the "Прослушать" button); the dictionary applies as usual.
  const previewLimiter = new RateLimiter(10)
  r.post('/pronunciations/preview', async (c) => {
    const body = z
      .object({ text: z.string().trim().min(1).max(300), lang: z.enum(['uk', 'ru', 'en']).optional() })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body', 'Expected {text}')
    const user = c.get('user')
    previewLimiter.check(user.id)
    let clip: string | null = null
    try {
      clip = await deps.tts.makeClip({
        text: body.data.text,
        voice: user.voice,
        lang: body.data.lang ?? user.lang,
        chime: false,
        rate: user.speechRate,
        userId: user.id,
      })
      const audio = readFileSync(clip)
      return c.body(audio, 200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' })
    } catch (e) {
      console.error('pronunciation preview failed:', e instanceof Error ? e.message : e)
      throw new HttpError(502, 'tts_failed', 'Could not synthesize the phrase')
    } finally {
      if (clip) rmSync(clip, { force: true })
    }
  })

  // "Повторить в эфир": the last 1-3 messages (or one by id) go back on air in the user's own stream
  r.post('/history/replay', async (c) => {
    const user = c.get('user')
    const body = replayBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body', 'Expected {count: 1..3} or {id}')
    return c.json(await replayMessages(deps, { user, station: stationOf(user.id), body: body.data }))
  })

  return r
}
