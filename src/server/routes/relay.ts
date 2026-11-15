// Internal-only listener (own port, never published): the engine (liquidsoap, no internet access) pulls relayed radio streams from here.
// GET /relay/<engine token>/<base64url of the stream URL>. The app fetches the stream with the SSRF-safe client and passes it through.
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import type { Config } from '../config'
import { HttpError, notFound } from '../lib/http'
import { base64url, base64urlDecode } from '../lib/ids'
import { safeEqual } from '../lib/api-keys'
import { getAppSecret } from '../lib/secrets'
import { type Resolver, type Transport, UrlBlockedError, safeGet } from '../lib/safe-fetch'

export const engineToken = (config: Pick<Config, 'appSecret' | 'dataDir'>) =>
  createHash('sha256')
    .update(`${getAppSecret(config)}:engine-relay`)
    .digest('hex')
    .slice(0, 40)

// The address the engine is told to play for a relay source.
export function relayUrlFor(config: Config, streamUrl: string): string {
  return `http://${config.relayHost}:${config.relayPort}/relay/${engineToken(config)}/${base64url(new TextEncoder().encode(streamUrl))}`
}

export function relayRoutes(config: Config, opts: { resolver?: Resolver; transport?: Transport } = {}) {
  const app = new Hono()
  app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.code }, e.status) : c.json({ error: 'internal_error' }, 500)))
  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  app.get('/relay/:token/:target', async (c) => {
    if (!safeEqual(c.req.param('token'), engineToken(config))) throw notFound()
    const bytes = base64urlDecode(c.req.param('target'))
    if (!bytes) throw notFound()
    const target = new TextDecoder().decode(bytes)
    let res: Awaited<ReturnType<typeof safeGet>>
    try {
      const wantsMeta = c.req.header('icy-metadata')
      res = await safeGet(target, {
        resolver: opts.resolver,
        transport: opts.transport,
        headers: wantsMeta ? { 'Icy-MetaData': wantsMeta } : {},
      })
    } catch (e) {
      if (e instanceof UrlBlockedError) throw new HttpError(403, 'blocked', 'Address not allowed')
      throw new HttpError(502, 'upstream_unreachable', 'Stream is not reachable')
    }
    if (res.status < 200 || res.status >= 300) {
      res.destroy()
      throw new HttpError(502, 'upstream_error', `Stream answered ${res.status}`)
    }
    const stop = () => {
      res.destroy()
    }
    c.req.raw.signal.addEventListener('abort', stop, { once: true })
    const headers: Record<string, string> = {
      'Content-Type': String(res.headers['content-type'] ?? 'audio/mpeg'),
      'Cache-Control': 'no-store',
    }
    for (const h of ['icy-metaint', 'icy-name', 'icy-br', 'icy-genre']) {
      const v = res.headers[h]
      if (typeof v === 'string') headers[h] = v
    }
    res.body.on('error', () => {})
    return new Response(Readable.toWeb(res.body) as ReadableStream, { status: 200, headers })
  })
  return app
}
