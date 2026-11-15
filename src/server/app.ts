import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { type Deps, withDefaults } from './deps'
import { HttpError } from './lib/http'
import { adminRoutes } from './routes/admin'
import { apiRoutes } from './routes/api'
import { appRoutes } from './routes/app'
import { authRoutes } from './routes/auth'
import { controlRoutes } from './routes/control'
import { internalRoutes } from './routes/internal'
import { streamRoutes } from './routes/stream'
import { refreshFolderPlaylists } from './stations'
import { webRoutes } from './routes/web'
import { UPLOAD_MAX_MB } from './uploads'

export type { Deps }

// The SPA only loads its own scripts / styles / fonts / media; the style attribute needs 'unsafe-inline' (React inline styles); blob: and data: are
// for the in-browser players (test clips of the admin) and the QR code.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const tooLarge = (c: Context) => c.json({ error: 'payload_too_large', message: 'Request body is too large' }, 413)
const limit = (maxSize: number) => bodyLimit({ maxSize, onError: tooLarge })

export function createApp(input: Deps & { fetchStream?: typeof fetch }) {
  const deps = withDefaults(input)
  const app = new Hono()
  // a folder source (an auto-generated playlist) follows the library
  deps.library.afterScan = () => refreshFolderPlaylists(deps.db, deps.config)

  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('Referrer-Policy', 'no-referrer')
    c.res.headers.set('X-Content-Type-Options', 'nosniff')
    c.res.headers.set('X-Frame-Options', 'DENY')
    c.res.headers.set('Content-Security-Policy', CSP)
    if (deps.config.publicUrl.startsWith('https://')) c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  })

  // access log without the query string: stream URLs carry the listen token
  app.use('*', async (c, next) => {
    const started = Date.now()
    await next()
    if (!process.env.VITEST) console.log(`${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - started}ms`)
  })

  app.get('/healthz', (c) => c.json({ ok: true }))
  // body limits are checked before anything is parsed: 64 KB for JSON APIs (a playlist of thousands of tracks gets 1 MB)
  app.use('/api/auth/*', limit(64 * 1024))
  // (music uploads: one file of up to 95 MB per request, kept under the 100 MB request limit of Cloudflare)
  app.use('/api/app/*', (c, next) =>
    limit(
      c.req.path === '/api/app/library/upload'
        ? (UPLOAD_MAX_MB + 4) * 1024 * 1024
        : c.req.path.startsWith('/api/app/playlists')
          ? 1024 * 1024
          : 64 * 1024,
    )(c, next),
  )
  app.use('/api/admin/*', limit(64 * 1024))
  app.use('/api/say', limit(64 * 1024))

  // browser routes (session cookie + CSRF) first, then the agent routes (Bearer key)
  app.route('/api/auth', authRoutes(deps))
  app.route('/api/app', appRoutes(deps))
  app.route('/api/admin', adminRoutes(deps))
  app.route('/api/control', controlRoutes(deps))
  app.route('/api', apiRoutes(deps))
  app.route('/internal', internalRoutes(deps))
  app.route('/stream', streamRoutes(deps.db, deps.config, input.fetchStream))
  app.route('/', webRoutes(deps.config))

  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  app.onError((e, c) => {
    if (e instanceof HttpError) {
      return c.json({ error: e.code, message: e.message }, e.status, e.headers)
    }
    console.error('unhandled:', e instanceof Error ? e.message : e)
    return c.json({ error: 'internal_error' }, 500)
  })

  return app
}
