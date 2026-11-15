// The React app (static files built by vite), the SPA fallback and the files agents download (/client/*).
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import type { Config } from '../config'

// name -> content type; {{PUBLIC_URL}} in these files is replaced with the server's address
const CLIENT_FILES: Record<string, string> = {
  'install.sh': 'text/x-shellscript; charset=utf-8',
  'agent-radio': 'text/x-shellscript; charset=utf-8',
  'SKILL.md': 'text/markdown; charset=utf-8',
  'agent-radio-hook.sh': 'text/x-shellscript; charset=utf-8',
  'claude-md-snippet.md': 'text/markdown; charset=utf-8',
  'claude-md-snippet.en.md': 'text/markdown; charset=utf-8',
}

export function webRoutes(config: Config) {
  const web = new Hono()

  web.get('/client/:file', (c) => {
    const name = c.req.param('file')
    const type = CLIENT_FILES[name]
    const file = join(resolve(config.clientFilesDir), name)
    if (!type || !existsSync(file)) return c.json({ error: 'not_found' }, 404)
    const body = readFileSync(file, 'utf8').replaceAll('{{PUBLIC_URL}}', config.publicUrl)
    return c.body(body, 200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
  })

  web.use('/assets/*', async (c, next) => {
    await next()
    if (c.res.status === 200) c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  })
  if (existsSync(resolve(config.webDir))) web.use('*', serveStatic({ root: config.webDir }))

  // SPA: any other page path gets index.html (the router decides); API-ish prefixes stay JSON 404s
  web.get('*', (c) => {
    const p = new URL(c.req.url).pathname
    if (/^\/(api|stream|client|healthz)(\/|$)/.test(p) || /\.[a-z0-9]{1,8}$/i.test(p)) return c.json({ error: 'not_found' }, 404)
    const index = join(resolve(config.webDir), 'index.html')
    if (!existsSync(index)) return c.text('The web app is not built (npm run build)', 503)
    return c.html(readFileSync(index, 'utf8'), 200, { 'Cache-Control': 'no-cache' })
  })

  return web
}
