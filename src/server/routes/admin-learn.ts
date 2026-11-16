// Admin section "Учи язык": the intro prompt, the playground, the cache of lyrics and notes. Mounted by adminRoutes under /api/admin/learn
// (session + admin role come from there). Lyrics are never deleted here, only notes.
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { songLyrics, songNotes, tracks } from '../db/schema'
import type { FullDeps } from '../deps'
import type { AppEnv } from '../env'
import { HttpError, badRequest, notFound } from '../lib/http'
import { getSetting, setSetting } from '../lib/settings'
import { LlmError } from '../learn/llm'
import { DEFAULT_PROMPT, PLACEHOLDERS, promptProblem } from '../learn/prompt'

const PAGE = 50
const lang = z.string().trim().min(2).max(10)

export function learnAdminRoutes(deps: FullDeps) {
  const { db, learnPrep: prep, llm } = deps
  const r = new Hono<AppEnv>()

  const promptState = () => {
    const override = getSetting(db, 'learn.prompt')
    return {
      prompt: override || DEFAULT_PROMPT,
      isDefault: !override,
      default: DEFAULT_PROMPT,
      placeholders: PLACEHOLDERS,
      alwaysFresh: getSetting(db, 'learn.alwaysFresh'),
    }
  }

  r.get('/prompt', (c) => c.json(promptState()))

  // prompt: the new template; alwaysFresh: the switch. Either may be sent.
  r.put('/prompt', async (c) => {
    const body = z
      .object({ prompt: z.string().max(20000).optional(), alwaysFresh: z.boolean().optional() })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    const { prompt, alwaysFresh } = body.data
    if (prompt !== undefined) {
      const problem = promptProblem(prompt)
      if (problem) throw badRequest('invalid_prompt', problem)
      // the same text as the default is no override
      setSetting(db, 'learn.prompt', prompt.trim() === DEFAULT_PROMPT.trim() ? null : prompt)
    }
    if (alwaysFresh !== undefined) setSetting(db, 'learn.alwaysFresh', alwaysFresh)
    return c.json(promptState())
  })

  // reset to the default of the repo
  r.delete('/prompt', (c) => {
    setSetting(db, 'learn.prompt', null)
    return c.json(promptState())
  })

  // one model call with a prompt (the given one, else the current), nothing is saved; counts against the daily limit
  r.post('/playground', async (c) => {
    const body = z
      .object({
        artist: z.string().trim().max(300).default(''),
        title: z.string().trim().min(1).max(300),
        lyrics: z.string().max(30000).nullish(),
        lang,
        prompt: z.string().max(20000).optional(),
      })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    const b = body.data
    if (b.prompt !== undefined) {
      const problem = promptProblem(b.prompt)
      if (problem) throw badRequest('invalid_prompt', problem)
    }
    try {
      return c.json(await prep.preview({ artist: b.artist, title: b.title, lyrics: b.lyrics?.trim() || null }, b.lang, b.prompt))
    } catch (e) {
      if (e instanceof LlmError) {
        if (e.code === 'cap') throw new HttpError(429, 'cap', e.message)
        if (e.code === 'no_provider') throw new HttpError(409, 'no_provider', e.message)
        throw new HttpError(502, e.code, e.message)
      }
      throw e
    }
  })

  // ---- the cache of lyrics and notes ----

  const hasText = sql`(l.lyrics IS NOT NULL AND trim(l.lyrics) <> '')`

  r.get('/songs', (c) => {
    const q = (c.req.query('q') ?? '').trim().slice(0, 100)
    const langQ = (c.req.query('lang') ?? '').trim().slice(0, 10)
    const offset = Math.max(0, Number.parseInt(c.req.query('cursor') ?? '0', 10) || 0)
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    const where = sql`(${hasText} OR EXISTS (SELECT 1 FROM song_notes n WHERE n.track_id = t.id))
      ${q ? sql`AND (t.artist LIKE ${like} ESCAPE '\\' OR t.title LIKE ${like} ESCAPE '\\')` : sql``}
      ${langQ ? sql`AND EXISTS (SELECT 1 FROM song_notes n2 WHERE n2.track_id = t.id AND n2.lang = ${langQ})` : sql``}`
    const rows = db.all<{
      id: string
      artist: string
      title: string
      status: string | null
      source: string | null
      lyricsLang: string | null
      fetchedAt: string | null
      hasLyrics: number
    }>(sql`SELECT t.id, t.artist, t.title, l.status, l.source, l.lang AS lyricsLang, l.fetched_at AS fetchedAt,
        CASE WHEN ${hasText} THEN 1 ELSE 0 END AS hasLyrics
      FROM tracks t LEFT JOIN song_lyrics l ON l.track_id = t.id
      WHERE ${where}
      ORDER BY lower(t.artist), lower(t.title), t.id LIMIT ${PAGE + 1} OFFSET ${offset}`)
    const page = rows.slice(0, PAGE)
    const notes = page.length
      ? db.all<{ trackId: string; lang: string; model: string | null; createdAt: string }>(
          sql`SELECT track_id AS trackId, lang, model, created_at AS createdAt FROM song_notes
            WHERE track_id IN (${sql.join(
              page.map((p) => sql`${p.id}`),
              sql`, `,
            )}) ORDER BY lang`,
        )
      : []
    const totals = db.get<{ songs: number; withLyrics: number; withNotes: number; notes: number }>(sql`SELECT
        (SELECT count(*) FROM tracks t LEFT JOIN song_lyrics l ON l.track_id = t.id
           WHERE ${hasText} OR EXISTS (SELECT 1 FROM song_notes n WHERE n.track_id = t.id)) AS songs,
        (SELECT count(*) FROM song_lyrics l WHERE ${hasText}) AS withLyrics,
        (SELECT count(DISTINCT track_id) FROM song_notes) AS withNotes,
        (SELECT count(*) FROM song_notes) AS notes`)
    return c.json({
      songs: page.map((p) => ({
        trackId: p.id,
        artist: p.artist,
        title: p.title,
        lyrics: { status: p.status ?? 'none', hasText: p.hasLyrics === 1, source: p.source, lang: p.lyricsLang, fetchedAt: p.fetchedAt },
        notes: notes.filter((n) => n.trackId === p.id).map((n) => ({ lang: n.lang, model: n.model, createdAt: n.createdAt })),
      })),
      nextCursor: rows.length > PAGE ? String(offset + PAGE) : null,
      totals,
    })
  })

  const trackOr404 = (id: string) => {
    const t = db.select().from(tracks).where(eq(tracks.id, id)).get()
    if (!t) throw notFound('Track not found')
    return t
  }

  r.get('/songs/:trackId', (c) => {
    const t = trackOr404(c.req.param('trackId'))
    const l = db.select().from(songLyrics).where(eq(songLyrics.trackId, t.id)).get()
    const notes = db.select().from(songNotes).where(eq(songNotes.trackId, t.id)).all()
    const json = <T>(s: string | null, d: T): T => {
      try {
        return s ? (JSON.parse(s) as T) : d
      } catch {
        return d
      }
    }
    return c.json({
      trackId: t.id,
      artist: t.artist,
      title: t.title,
      lyrics: l
        ? { status: l.status, source: l.source, lang: l.lang, fetchedAt: l.fetchedAt, text: l.lyrics }
        : { status: 'none', source: null, lang: null, fetchedAt: null, text: null },
      notes: notes.map((n) => ({
        lang: n.lang,
        summary: n.summary,
        introText: n.introText,
        hooks: json<string[]>(n.hooks, []),
        pairs: json<{ src: string; tr: string }[] | null>(n.pairs, null),
        model: n.model,
        tokensIn: n.tokensIn,
        tokensOut: n.tokensOut,
        createdAt: n.createdAt,
      })),
    })
  })

  // delete the notes of the track (one language or all) and prepare them again in the background; the lyrics are not fetched again
  r.post('/songs/:trackId/regenerate', async (c) => {
    const t = trackOr404(c.req.param('trackId'))
    const body = z.object({ lang: lang.optional() }).safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) throw badRequest('invalid_body')
    const rows = prep.regenerateTrack(t.id, body.data.lang)
    return c.json({ ok: true, queued: rows.map((x) => x.lang) })
  })

  r.delete('/songs/:trackId/notes', (c) => {
    const t = trackOr404(c.req.param('trackId'))
    const l = c.req.query('lang')
    return c.json({ ok: true, deleted: prep.deleteNotes({ trackId: t.id, lang: l || undefined }).length })
  })

  // all notes of all tracks; the lyrics stay
  r.delete('/notes', (c) => c.json({ ok: true, deleted: prep.deleteNotes().length }))

  r.post('/regenerate-all', async (c) => {
    const body = z.object({ lang: lang.optional() }).safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) throw badRequest('invalid_body')
    if (!prep.regenerateAll(body.data.lang)) throw new HttpError(409, 'running', 'A regeneration is already running')
    return c.json({ ok: true, ...prep.progress() })
  })

  r.get('/regenerate-all', (c) => c.json({ ...prep.progress(), usage: llm.usage() }))

  return r
}
