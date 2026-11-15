// Internal endpoints for the front proxy (Caddy) and the watchdog. They are never reachable from outside: the front answers 404 for /internal/*
// and the app port is not published (see compose.yaml, deploy/Caddyfile).
import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import type { FullDeps } from '../deps'
import { safeEqual } from '../lib/api-keys'
import { STATION_ID, stationById } from '../stations'
import { stations } from '../db/schema'

const STREAM_PATH = /^\/stream\/([a-z0-9]+)\.mp3$/

export function internalRoutes(deps: FullDeps) {
  const { db, engine, tts } = deps
  const r = new Hono()

  // forward_auth of the front: 200 when the original request (X-Forwarded-Uri) is a stream URL with the right listen token, else 404.
  // Same rule as routes/stream.ts: an unknown station and a wrong token look the same.
  r.get('/stream-auth', (c) => {
    const uri = c.req.header('x-forwarded-uri') ?? ''
    let url: URL
    try {
      url = new URL(uri, 'http://front')
    } catch {
      return c.body(null, 404)
    }
    const id = STREAM_PATH.exec(url.pathname)?.[1]
    if (!id || !STATION_ID.test(id)) return c.body(null, 404)
    const st = stationById(db, id)
    if (!st || !safeEqual(st.listenToken, url.searchParams.get('k') ?? '')) return c.body(null, 404)
    return c.body(null, 200)
  })

  // watchdog: the stations of the db against the stations the engine runs
  r.get('/health', async (c) => {
    const known = db
      .select({ id: stations.id })
      .from(stations)
      .all()
      .map((s) => s.id)
    try {
      const live = new Set(await engine.list())
      const missing = known.filter((id) => !live.has(id))
      const extra = [...live].filter((id) => !known.includes(id))
      return c.json(
        { ok: missing.length === 0, stations: known.length, engine: live.size, missing, extra },
        missing.length === 0 ? 200 : 503,
      )
    } catch (e) {
      return c.json({ ok: false, error: 'engine_unreachable', message: e instanceof Error ? e.message : String(e) }, 503)
    }
  })

  // watchdog: one short synthesis (the clip is deleted at once)
  r.post('/tts-test', async (c) => {
    const started = Date.now()
    try {
      const clip = await tts.makeClip({ text: 'Перевірка голосу.', voice: null, lang: 'uk', chime: false, rate: 1 })
      rmSync(clip, { force: true })
      return c.json({ ok: true, ms: Date.now() - started })
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 503)
    }
  })

  return r
}
