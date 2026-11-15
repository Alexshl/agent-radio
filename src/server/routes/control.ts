// "Быстрые команды": /api/control/* for iOS Shortcuts ("Get Contents of URL"). Authenticated by the control token in ?k= (see lib/control-token.ts),
// which can only replay the last messages, switch the source and read the status. Answers are short plain text in the user's language.
import { eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { presets } from '../db/schema'
import type { FullDeps } from '../deps'
import { type ControlText, controlText } from '../control-text'
import { authenticateControl } from '../lib/control-token'
import { HttpError } from '../lib/http'
import { sha256Hex } from '../lib/ids'
import { listPlaylists } from '../playlists'
import { replayBody, replayMessages } from '../replay'
import { changeSource } from '../source'
import { type StationSource, parseSource, stationOfUser, userById } from '../stations'
import type { users } from '../db/schema'

type UserRow = typeof users.$inferSelect
type Env = { Variables: { cuser: UserRow } }

const NO_STORE = { 'Cache-Control': 'no-store' }
const text = (c: Context, body: string, status: 200 | 400 | 401 | 404 | 429 | 500 | 502 | 503 = 200) => c.text(body, status, NO_STORE)

export const CONTROL_KINDS = ['silence', 'playlist', 'folder', 'station', 'all'] as const
type Kind = (typeof CONTROL_KINDS)[number]

export function controlRoutes(deps: FullDeps) {
  const { db, config, icecast, airing, library } = deps
  const r = new Hono<Env>()

  r.use('*', async (c, next) => {
    const k = c.req.query('k') ?? ''
    if (!k) return text(c, controlText('uk').unauthorized, 401)
    try {
      deps.controlLimiter.check(await sha256Hex(k))
    } catch (e) {
      if (e instanceof HttpError) {
        return c.text(controlText('uk').rateLimited, 429, { ...NO_STORE, ...e.headers })
      }
      throw e
    }
    const userId = await authenticateControl(db, k)
    const user = userId ? userById(db, userId) : undefined
    if (!user) return text(c, controlText('uk').unauthorized, 401)
    c.set('cuser', user)
    await next()
  })

  // an HttpError of the shared logic becomes a plain-text answer in the user's language
  const failure = (c: Context, t: ControlText, e: unknown) => {
    if (!(e instanceof HttpError)) throw e
    if (e.status === 429) return c.text(t.rateLimited, 429, { ...NO_STORE, ...e.headers })
    if (e.code === 'engine_unavailable') return text(c, t.engineDown, 503)
    if (e.status === 404) return text(c, t.nothingToReplay, 404)
    return text(c, t.failed, e.status >= 500 ? 502 : 400)
  }

  const stationOf = (user: UserRow) => {
    const st = stationOfUser(db, user.id)
    if (!st) throw new HttpError(404, 'no_station', 'No station for this user')
    return st
  }

  const sourceName = (user: UserRow, t: ControlText, src: StationSource): string => {
    if (src.type === 'silence') return t.silence
    if (src.type === 'relay') return src.name || src.url
    if (src.type === 'playlist') return src.dir || t.library
    return listPlaylists(db, user.id).find((p) => p.id === src.playlistId)?.name ?? '—'
  }

  r.post('/replay', async (c) => {
    const user = c.get('cuser')
    const t = controlText(user.lang)
    const body = replayBody.safeParse({ count: Number(c.req.query('count') ?? '1') })
    if (!body.success) return text(c, t.badRequest, 400)
    try {
      const res = await replayMessages(deps, { user, station: stationOf(user), body: body.data })
      if (res.status === 'skipped') return text(c, t.replaySkipped)
      if (res.status === 'waiting') return text(c, t.replayWaiting)
      return text(c, res.ids.length === 1 ? t.replay1 : t.replayN(res.ids.length))
    } catch (e) {
      return failure(c, t, e)
    }
  })

  r.post('/source', async (c) => {
    const user = c.get('cuser')
    const t = controlText(user.lang)
    const kind = c.req.query('kind') as Kind | undefined
    const id = c.req.query('id') ?? ''
    if (!kind || !CONTROL_KINDS.includes(kind)) return text(c, t.badRequest, 400)
    let source: StationSource | null = null
    if (kind === 'silence') source = { type: 'silence' }
    else if (kind === 'all') source = { type: 'playlist', dir: '', order: 'shuffle' }
    else if (kind === 'folder') {
      if (library.folders().some((f) => f.path === id)) source = { type: 'playlist', dir: id, order: 'shuffle' }
    } else if (kind === 'playlist') {
      if (listPlaylists(db, user.id).some((p) => p.id === id)) source = { type: 'userplaylist', playlistId: id }
    } else {
      const preset = id ? db.select().from(presets).where(eq(presets.id, id)).get() : undefined
      if (preset) source = { type: 'relay', url: preset.url, name: preset.name }
    }
    if (!source) return text(c, t.sourceNotFound, 404)
    try {
      await changeSource(deps, user, stationOf(user), source)
      return text(c, t.sourceSet(sourceName(user, t, source)))
    } catch (e) {
      return failure(c, t, e)
    }
  })

  r.get('/status', async (c) => {
    const user = c.get('cuser')
    const t = controlText(user.lang)
    try {
      const st = stationOf(user)
      const [up, ls, title] = await Promise.all([icecast.isUp(st.id), deps.listeners.observe(st.id), icecast.title?.(st.id) ?? null])
      const file = airing.current(st.id)
      return text(
        c,
        [
          `${t.statusOnAir}: ${up === true ? t.yes : t.no}`,
          `${t.listeners}: ${ls.listeners ?? 0}`,
          `${t.nowPlaying}: ${(file ? file.title : title) || '—'}`,
          `${t.source}: ${sourceName(user, t, parseSource(st.source))}`,
        ].join('\n'),
      )
    } catch (e) {
      return failure(c, t, e)
    }
  })

  // the menu of a shortcut: ready action URLs for the 3 replays, every source and the status
  r.get('/sources', (c) => {
    const user = c.get('cuser')
    const t = controlText(user.lang)
    const base = `${config.publicUrl}/api/control`
    const k = encodeURIComponent(c.req.query('k') ?? '')
    const source = (kind: Kind, id?: string) =>
      `${base}/source?k=${k}&kind=${kind}${id === undefined ? '' : `&id=${encodeURIComponent(id)}`}`
    const items: { title: string; url: string; method: 'GET' | 'POST' }[] = [
      { title: t.replay1, url: `${base}/replay?k=${k}&count=1`, method: 'POST' },
      { title: t.replayN(2), url: `${base}/replay?k=${k}&count=2`, method: 'POST' },
      { title: t.replayN(3), url: `${base}/replay?k=${k}&count=3`, method: 'POST' },
      { title: t.silence, url: source('silence'), method: 'POST' },
      { title: t.library, url: source('all'), method: 'POST' },
      ...listPlaylists(db, user.id).map((p) => ({ title: p.name, url: source('playlist', p.id), method: 'POST' as const })),
      ...library.folders().map((f) => ({ title: f.path, url: source('folder', f.path), method: 'POST' as const })),
      ...db
        .select()
        .from(presets)
        .orderBy(presets.position)
        .all()
        .map((p) => ({ title: p.name, url: source('station', p.id), method: 'POST' as const })),
      { title: t.status, url: `${base}/status?k=${k}`, method: 'GET' },
    ]
    return c.json(items, 200, NO_STORE)
  })

  return r
}
