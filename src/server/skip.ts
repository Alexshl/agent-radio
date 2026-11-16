// "Next / previous song": the music of the user's station only (own playlist or a folder). Voice messages and uploaded files are not touched:
// they run on their own queues in the engine. The same logic serves the web app, the remote and the iOS Shortcuts.
import type { FullDeps } from './deps'
import { HttpError } from './lib/http'
import { emitLive } from './live'
import { type StationRow, parseSource, withStationLock } from './stations'

async function viaEngine<T>(st: StationRow, fn: () => Promise<T>): Promise<T> {
  try {
    return await withStationLock(st.id, fn)
  } catch (e) {
    if (e instanceof HttpError) throw e
    console.error('skip failed:', e instanceof Error ? e.message : e)
    throw new HttpError(503, 'engine_unavailable', 'Engine did not accept the command')
  }
}

// a relay stream or silence has no tracks to skip
function assertSkippable(st: StationRow) {
  const t = parseSource(st.source).type
  if (t !== 'userplaylist' && t !== 'playlist') throw new HttpError(409, 'not_skippable', 'The station does not play music from a playlist')
}

export async function skipNext(deps: Pick<FullDeps, 'engine'>, st: StationRow) {
  assertSkippable(st)
  await viaEngine(st, () => deps.engine.skipMusic(st.id))
  emitLive(st.userId, 'live', 'station')
}

export async function skipPrevious(deps: Pick<FullDeps, 'engine'>, st: StationRow) {
  assertSkippable(st)
  const done = await viaEngine(st, async () => {
    // the last entry is the song that plays now: the one before it is "previous"
    if ((await deps.engine.musicHistory(st.id)).length < 2) return false
    return deps.engine.previousMusic(st.id)
  })
  if (!done) throw new HttpError(409, 'no_history', 'There is no previous song yet')
  emitLive(st.userId, 'live', 'station')
}
