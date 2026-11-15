// Who may put what on a station, then apply it live.
import { eq } from 'drizzle-orm'
import type { FullDeps } from './deps'
import { presets } from './db/schema'
import { HttpError } from './lib/http'
import { assertPublicUrl } from './lib/safe-fetch'
import { getSetting } from './lib/settings'
import { type StationRow, type StationSource, setStationSource } from './stations'
import type { UserRow } from './lib/auth'

// Who may put which relay URL on a station: presets for everybody, other URLs unless the admin switched them off. Admins get no bypass for
// the address check itself: the URL must resolve only to public addresses (the engine then pulls it through the app's relay).
export async function checkSourceAllowed(deps: FullDeps, user: Pick<UserRow, 'role'>, source: StationSource) {
  if (source.type !== 'relay') return
  const isPreset = !!deps.db.select().from(presets).where(eq(presets.url, source.url)).get()
  if (!isPreset && user.role !== 'admin' && !getSetting(deps.db, 'allowOwnUrls')) {
    throw new HttpError(403, 'own_urls_disabled', 'Own stream links are switched off by the administrator')
  }
  await assertPublicUrl(source.url, deps.resolver)
}

export async function changeSource(deps: FullDeps, user: UserRow, st: StationRow, source: StationSource) {
  await checkSourceAllowed(deps, user, source)
  try {
    return await setStationSource(deps.db, deps.config, deps.engine, st, source)
  } catch (e) {
    if (e instanceof HttpError) throw e
    console.error('set source failed:', e instanceof Error ? e.message : e)
    throw new HttpError(503, 'engine_unavailable', 'Engine did not accept the source')
  }
}
