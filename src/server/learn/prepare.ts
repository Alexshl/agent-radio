// Lyrics and notes of a track, prepared ahead of its turn: LRCLIB (or the web search of Anthropic) -> one model call (translation, summary,
// spoken intro). Cached per track (song_lyrics) and per track + target language (song_notes). One preparation at a time (the local model
// sits on one GPU); the same track + language asked twice shares one run.
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client'
import { songLyrics, songNotes, tracks, users } from '../db/schema'
import { nowIso } from '../lib/ids'
import { getSetting } from '../lib/settings'
import { emitLive } from '../live'
import { LlmError, type LlmService } from './llm'
import { parseLrc, plainLines } from './lrc'
import { LrcLibClient } from './lrclib'
import { DEFAULT_PROMPT, MAX_INTRO_CHARS, buildSystem } from './prompt'

export const NOT_FOUND_RETRY_MS = 30 * 24 * 3600_000
export const ERROR_RETRY_MS = 3600_000
// the model failing is usually transient (the local GPU busy with something else): try again soon
export const LLM_ERROR_RETRY_MS = 10 * 60_000
const MAX_LINES = 150
const MAX_QUOTE_WORDS = 8

export type PrepareStatus = 'ready' | 'no_provider' | 'capped' | 'instrumental' | 'no_lyrics' | 'error'

export interface NotesRow {
  pairs: { src: string; tr: string }[] | null
  summary: string | null
  introText: string | null
  hooks: string[]
}

const notesSchema = z.object({
  original_lang: z.string().trim().min(1).max(40),
  summary: z.string().trim().min(1).max(1500),
  intro_script: z.string().trim().min(1).max(2000),
  hooks: z.array(z.string().max(200)).max(10).optional(),
  translations: z.array(z.string()).max(400).optional(),
})
const lyricsSchema = z.object({ lyrics: z.string().nullable() })

// quotes in "…", «…», “…”, „…“ must be short
export function introProblem(text: string): string | null {
  if (text.length > MAX_INTRO_CHARS + 100) return 'intro too long'
  for (const m of text.matchAll(/["«“„]([^"»”“]+)["»”“]/g)) {
    if ((m[1] ?? '').trim().split(/\s+/).length > MAX_QUOTE_WORDS) return 'quote too long'
  }
  return null
}

export class SongPreparer {
  private inflight = new Map<string, Promise<PrepareStatus>>()
  private chain: Promise<unknown> = Promise.resolve()
  // notes that failed (the model, not the lyrics): not tried again for an hour
  private failedAt = new Map<string, number>()

  constructor(
    private db: Db,
    private llm: LlmService,
    private lrclib: LrcLibClient = new LrcLibClient(),
    private now: () => number = Date.now,
  ) {}

  // the finished notes of a track in a language, or null
  getNotes(trackId: string, lang: string): NotesRow | null {
    const r = this.db
      .select()
      .from(songNotes)
      .where(and(eq(songNotes.trackId, trackId), eq(songNotes.lang, lang)))
      .get()
    if (!r) return null
    const json = <T>(s: string | null, d: T): T => {
      try {
        return s ? (JSON.parse(s) as T) : d
      } catch {
        return d
      }
    }
    return { pairs: json(r.pairs, null), summary: r.summary, introText: r.introText, hooks: json(r.hooks, [] as string[]) }
  }

  // fresh: ignore the cached notes (and an earlier failure) and ask the model again; the lyrics stay cached
  ensurePrepared(trackId: string, lang: string, opts: { fresh?: boolean } = {}): Promise<PrepareStatus> {
    const key = `${trackId}:${lang}`
    const cur = this.inflight.get(key)
    if (cur) return cur
    if (!opts.fresh && this.getNotes(trackId, lang)) return Promise.resolve('ready')
    const run = this.chain.then(() => this.prepare(trackId, lang, opts.fresh === true)).catch((): PrepareStatus => 'error')
    this.chain = run
    const p = run.finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  private async prepare(trackId: string, lang: string, force = false): Promise<PrepareStatus> {
    if (!force && this.getNotes(trackId, lang)) return 'ready'
    if (!this.llm.configured()) return 'no_provider'
    const failed = this.failedAt.get(`${trackId}:${lang}`)
    if (!force && failed !== undefined && this.now() - failed < LLM_ERROR_RETRY_MS) return 'error'
    const track = this.db.select().from(tracks).where(eq(tracks.id, trackId)).get()
    if (!track) return 'error'
    let lyr = this.db.select().from(songLyrics).where(eq(songLyrics.trackId, trackId)).get()
    const age = lyr ? this.now() - Date.parse(lyr.fetchedAt) : 0
    const fresh =
      lyr &&
      (lyr.status === 'found' ||
        lyr.status === 'instrumental' ||
        (lyr.status === 'not_found' && age < NOT_FOUND_RETRY_MS) ||
        (lyr.status === 'error' && age < ERROR_RETRY_MS))
    if (!fresh) {
      try {
        lyr = await this.fetchLyrics(track)
      } catch (e) {
        if (e instanceof LlmError && (e.code === 'cap' || e.code === 'no_provider')) return e.code === 'cap' ? 'capped' : 'no_provider'
        this.saveLyrics(trackId, { status: 'error', lyrics: null, synced: null, source: null })
        return 'error'
      }
    }
    if (!lyr) return 'error'
    if (lyr.status === 'instrumental') return 'instrumental'
    if (lyr.status === 'error') return 'error'
    // no lyrics (not found): no notes and no model call; the status stays cached
    if (lyr.status !== 'found' || !lyr.lyrics?.trim()) return 'no_lyrics'
    return this.writeNotes(trackId, lang, track, lyr)
  }

  private saveLyrics(
    trackId: string,
    v: { status: string; lyrics: string | null; synced: string | null; source: string | null; lang?: string | null },
  ) {
    const row = {
      trackId,
      lyrics: v.lyrics,
      synced: v.synced,
      lang: v.lang ?? null,
      source: v.source,
      status: v.status,
      fetchedAt: new Date(this.now()).toISOString(),
    }
    this.db.insert(songLyrics).values(row).onConflictDoUpdate({ target: songLyrics.trackId, set: row }).run()
    return this.db.select().from(songLyrics).where(eq(songLyrics.trackId, trackId)).get()
  }

  private async fetchLyrics(track: typeof tracks.$inferSelect) {
    const r = await this.lrclib.find({ artist: track.artist, title: track.title, album: track.album, durationSec: track.durationSec })
    if (r.status === 'instrumental')
      return this.saveLyrics(track.id, { status: 'instrumental', lyrics: null, synced: null, source: 'lrclib' })
    if (r.status === 'found') {
      const synced = r.synced ? parseLrc(r.synced) : []
      const plain = r.plain ?? synced.map((l) => l.text).join('\n')
      return this.saveLyrics(track.id, {
        status: 'found',
        lyrics: plain,
        synced: synced.length ? JSON.stringify(synced) : null,
        source: 'lrclib',
      })
    }
    // only a model with a search tool can look further
    if (this.llm.canSearchWeb()) {
      try {
        const q = await this.llm.chatJson(
          'Find the lyrics of the song with the web search. Return {"lyrics": "<the full text, one line per row>"} or {"lyrics": null} when you cannot find them. Never make lyrics up.',
          `Artist: ${track.artist}\nTitle: ${track.title}\nAlbum: ${track.album}`,
          lyricsSchema,
          { webSearch: true },
        )
        const text = q.data.lyrics?.trim()
        if (text && plainLines(text).length >= 4)
          return this.saveLyrics(track.id, { status: 'found', lyrics: text, synced: null, source: 'web' })
      } catch (e) {
        if (e instanceof LlmError && (e.code === 'cap' || e.code === 'no_provider')) throw e
      }
    }
    return this.saveLyrics(track.id, { status: 'not_found', lyrics: null, synced: null, source: null })
  }

  // the active template: the admin's override or the default of the repo
  promptTemplate(): string {
    return getSetting(this.db, 'learn.prompt') || DEFAULT_PROMPT
  }

  // One model call for a song; nothing is saved. `template` overrides the active one (the playground).
  private async generate(
    input: { artist: string; title: string; lyrics: string | null },
    lang: string,
    template: string = this.promptTemplate(),
  ) {
    const lines = input.lyrics ? plainLines(input.lyrics).slice(0, MAX_LINES) : []
    const hasLyrics = lines.length > 0
    const user = `Artist: ${input.artist || 'unknown'}\nTitle: ${input.title}\n${
      hasLyrics ? `Lyrics, numbered:\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}` : 'Lyrics: not available'
    }`
    const r = await this.llm.chatJson(buildSystem(template, lang, hasLyrics), user, notesSchema)
    const d = r.data
    const orig = d.original_lang.toLowerCase().slice(0, 2)
    const tr = d.translations ?? []
    // a translation with a different line count is not paired (the summary and the intro stay)
    const pairs = hasLyrics && orig !== lang && tr.length === lines.length ? lines.map((src, i) => ({ src, tr: tr[i] as string })) : null
    return { r, d, orig, lines, hasLyrics, pairs }
  }

  // The playground: the model answer for any text and prompt, nothing is written (it still counts against the daily limit).
  async preview(input: { artist: string; title: string; lyrics: string | null }, lang: string, template?: string) {
    const started = Date.now()
    const g = await this.generate(input, lang, template)
    const problems: string[] = []
    const p = introProblem(g.d.intro_script)
    if (p) problems.push(p)
    const tr = g.d.translations ?? []
    if (g.hasLyrics && g.orig !== lang && tr.length !== g.lines.length)
      problems.push(`translations: ${tr.length} lines instead of ${g.lines.length}`)
    return {
      originalLang: g.orig,
      summary: g.d.summary,
      introScript: g.d.intro_script,
      hooks: g.d.hooks ?? [],
      translations: tr,
      problems,
      model: `${g.r.provider}:${g.r.model}`,
      tokensIn: g.r.tokensIn,
      tokensOut: g.r.tokensOut,
      ms: Date.now() - started,
    }
  }

  private async writeNotes(
    trackId: string,
    lang: string,
    track: typeof tracks.$inferSelect,
    lyr: typeof songLyrics.$inferSelect,
  ): Promise<PrepareStatus> {
    const failKey = `${trackId}:${lang}`
    try {
      const { r, d, orig, pairs, hasLyrics } = await this.generate({ artist: track.artist, title: track.title, lyrics: lyr.lyrics }, lang)
      const problem = introProblem(d.intro_script)
      if (problem) throw new Error(problem)
      if (hasLyrics && lyr.lang !== orig) this.db.update(songLyrics).set({ lang: orig }).where(eq(songLyrics.trackId, trackId)).run()
      const row = {
        trackId,
        lang,
        pairs: pairs ? JSON.stringify(pairs) : null,
        summary: d.summary,
        introText: d.intro_script,
        hooks: JSON.stringify(d.hooks ?? []),
        model: `${r.provider}:${r.model}`,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        createdAt: nowIso(),
      }
      this.db
        .insert(songNotes)
        .values(row)
        .onConflictDoUpdate({ target: [songNotes.trackId, songNotes.lang], set: row })
        .run()
      this.failedAt.delete(failKey)
      return 'ready'
    } catch (e) {
      if (e instanceof LlmError && e.code === 'cap') return 'capped'
      if (e instanceof LlmError && e.code === 'no_provider') return 'no_provider'
      this.failedAt.set(failKey, this.now())
      return 'error'
    }
  }

  // ---- admin: forget notes (the lyrics are never touched) and make them again ----

  // tell the open pages of the listeners (learn mode on) of these languages
  private notify(langs: Iterable<string>) {
    const set = [...new Set(langs)]
    if (!set.length) return
    for (const u of this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.learnMode, 1), inArray(users.lang, set)))
      .all())
      emitLive(u.id, 'learn')
  }

  // deletes the notes of one track (one language or all) or of every track; returns the removed rows
  deleteNotes(filter: { trackId?: string; lang?: string } = {}): { trackId: string; lang: string }[] {
    const conds = []
    if (filter.trackId) conds.push(eq(songNotes.trackId, filter.trackId))
    if (filter.lang) conds.push(eq(songNotes.lang, filter.lang))
    const rows = this.db
      .delete(songNotes)
      .where(conds.length ? and(...conds) : undefined)
      .returning({ trackId: songNotes.trackId, lang: songNotes.lang })
      .all()
    for (const r of rows) this.failedAt.delete(`${r.trackId}:${r.lang}`)
    this.notify(rows.map((r) => r.lang))
    return rows
  }

  // deletes the notes of one track and prepares them again in the background (no waiting); the lyrics stay
  regenerateTrack(trackId: string, lang?: string): { trackId: string; lang: string }[] {
    const rows = this.deleteNotes({ trackId, lang })
    for (const r of rows) void this.ensurePrepared(r.trackId, r.lang, { fresh: true }).then(() => this.notify([r.lang]))
    return rows
  }

  private bulk = { total: 0, done: 0, failed: 0, running: false, capped: false }

  progress() {
    return { ...this.bulk }
  }

  // Deletes ALL notes (of one language when given) and makes them again, one after another through the same queue as every other
  // preparation, until the daily limit stops it. Only the tracks that had notes and still have lyrics are redone. Returns false when
  // a run is already going.
  regenerateAll(lang?: string): boolean {
    if (this.bulk.running) return false
    const withLyrics = new Set(
      this.db
        .select({ id: songLyrics.trackId, lyrics: songLyrics.lyrics })
        .from(songLyrics)
        .where(eq(songLyrics.status, 'found'))
        .all()
        .filter((r) => r.lyrics?.trim())
        .map((r) => r.id),
    )
    const todo = this.deleteNotes({ lang }).filter((r) => withLyrics.has(r.trackId))
    this.bulk = { total: todo.length, done: 0, failed: 0, running: todo.length > 0, capped: false }
    if (!todo.length) return true
    void (async () => {
      for (const [i, r] of todo.entries()) {
        const st = await this.ensurePrepared(r.trackId, r.lang, { fresh: true })
        if (st === 'ready') this.bulk.done++
        else this.bulk.failed++
        this.notify([r.lang])
        if (st === 'capped' || st === 'no_provider') {
          this.bulk.capped = st === 'capped'
          this.bulk.failed += todo.length - i - 1
          break
        }
      }
      this.bulk.running = false
    })()
    return true
  }
}
