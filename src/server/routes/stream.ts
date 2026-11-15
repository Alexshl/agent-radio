import { Hono } from 'hono'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { safeEqual } from '../lib/api-keys'
import { HttpError, notFound } from '../lib/http'
import { STATION_ID, stationById } from '../stations'

export function streamRoutes(db: Db, config: Config, fetchImpl: typeof fetch = fetch) {
  const stream = new Hono()

  stream.get('/:file', async (c) => {
    const m = /^([a-z0-9]+)\.(mp3|m3u)$/.exec(c.req.param('file'))
    const id = m?.[1]
    const ext = m?.[2]
    if (!id || !STATION_ID.test(id)) throw notFound()
    const st = stationById(db, id)
    const k = c.req.query('k') ?? ''
    // unknown station and wrong token look the same
    if (!st || !safeEqual(st.listenToken, k)) throw notFound()

    if (ext === 'm3u') {
      const body = `#EXTM3U\n#EXTINF:-1,agent-radio\n${config.publicUrl}/stream/${id}.mp3?k=${encodeURIComponent(st.listenToken)}\n`
      return c.body(body, 200, { 'Content-Type': 'audio/x-mpegurl', 'Cache-Control': 'no-store' })
    }

    // pass the icecast mount through chunk by chunk; the upstream request is dropped when the listener goes away
    const ctrl = new AbortController()
    c.req.raw.signal.addEventListener('abort', () => ctrl.abort(), { once: true })
    let upstream: Response
    try {
      upstream = await fetchImpl(`${config.icecastUrl}/${id}`, { signal: ctrl.signal })
    } catch {
      throw new HttpError(503, 'engine_unavailable', 'Stream is not available', { 'Retry-After': '5' })
    }
    if (!upstream.ok || !upstream.body) {
      ctrl.abort()
      throw new HttpError(503, 'engine_unavailable', 'Stream is not available', { 'Retry-After': '5' })
    }
    const reader = upstream.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(out) {
        try {
          const { done, value } = await reader.read()
          if (done) out.close()
          else out.enqueue(value)
        } catch {
          // upstream dropped or listener left
          out.close()
        }
      },
      cancel() {
        ctrl.abort()
      },
    })
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'audio/mpeg',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'icy-name': 'agent-radio',
      },
    })
  })

  return stream
}
