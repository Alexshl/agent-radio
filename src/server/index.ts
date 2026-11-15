import { serve } from '@hono/node-server'
import { createApp } from './app'
import { bootstrap, seedAdmin, seedPresets } from './bootstrap'
import { eq } from 'drizzle-orm'
import { messages } from './db/schema'
import { cleanup } from './retention'
import { relayRoutes } from './routes/relay'
import { syncEngine } from './stations'

const deps = bootstrap()
const { config } = deps

const admin = await seedAdmin(deps)
if (admin) console.log(`created admin ${admin.user.email}`)
seedPresets(deps)

// App is the source of truth: keep the engine in step with the db (first start, liquidsoap restart, a station created by the CLI).
let syncing = false
async function sync() {
  if (syncing) return
  syncing = true
  try {
    const r = await syncEngine(deps.db, config, deps.engine)
    if (r.added || r.removed) console.log(`engine sync: ${r.added} station(s) pushed, ${r.removed} removed`)
  } catch (e) {
    console.error('engine sync failed:', e instanceof Error ? e.message : e)
  } finally {
    syncing = false
  }
}
void sync()
setInterval(sync, 5_000).unref()

// the music library: scan on start and then every hour (incremental: unchanged files are skipped); retention cleanup every hour
const scan = () =>
  deps.library
    .scan()
    .then((r) => r && console.log(`library scan: +${r.added} ~${r.updated} -${r.removed}, ${r.total} tracks`))
    .catch((e) => console.error('library scan failed:', e instanceof Error ? e.message : e))
void scan()
setInterval(scan, 3600_000).unref()
const clean = () => {
  try {
    const r = cleanup(deps.db, config)
    if (r.messages || r.clips) console.log(`cleanup: ${r.messages} message(s), ${r.clips} clip(s) removed`)
  } catch (e) {
    console.error('cleanup failed:', e instanceof Error ? e.message : e)
  }
}
clean()
setInterval(clean, 3600_000).unref()

// voice model download in the background, so the first message does not wait for it
deps.ttsService.warmUp()?.catch((e) => console.error('TTS warm-up failed:', e instanceof Error ? e.message : e))
// the Piper voice catalog (cached in the data volume, refreshed daily)
const refreshCatalog = () => void deps.registry.catalog.refresh().catch(() => {})
refreshCatalog()
setInterval(refreshCatalog, 6 * 3600_000).unref()

// messages queued behind a slow voice when the app stopped will never air
deps.db.update(messages).set({ status: 'failed' }).where(eq(messages.status, 'queued')).run()

// local neural voices sidecar: which engines are loaded (the admin page and the voice lists read this)
if (config.ttsLocalUrl) {
  const refreshLocal = () => void deps.registry.refreshLocal()
  refreshLocal()
  setInterval(refreshLocal, 30_000).unref()
}

const server = serve({ fetch: createApp(deps).fetch, port: config.port }, (info) => console.log(`agent-radio listening on :${info.port}`))
// internal-only listener for the engine's relayed streams (not published by compose)
serve(
  { fetch: relayRoutes(config, { resolver: deps.resolver, transport: deps.transport }).fetch, port: config.relayPort, hostname: '0.0.0.0' },
  (info) => console.log(`relay listener on :${info.port}`),
)
process.on('SIGTERM', () => server.close(() => process.exit(0)))
