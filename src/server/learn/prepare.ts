// Lyrics and notes of a track, prepared ahead of its turn: LRCLIB (or the web search of Anthropic) -> one model call (translation, summary,
// spoken intro). Cached per track (song_lyrics) and per track + target language (song_notes). One preparation at a time (the local model
// sits on one GPU); the same track + language asked twice shares one run.
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client'
import { songLyrics, songNotes, tracks } from '../db/schema'
import { nowIso } from '../lib/ids'
import { LlmError, type LlmService } from './llm'
import { parseLrc, plainLines } from './lrc'
import { LrcLibClient } from './lrclib'

export const NOT_FOUND_RETRY_MS = 30 * 24 * 3600_000
export const ERROR_RETRY_MS = 3600_000
// the model failing is usually transient (the local GPU busy with something else): try again soon
export const LLM_ERROR_RETRY_MS = 10 * 60_000
const MAX_LINES = 150
const MAX_QUOTE_WORDS = 8
const MAX_INTRO_CHARS = 600
const LANG_NAME: Record<string, string> = {
  uk: 'Ukrainian',
  ru: 'Russian',
  en: 'English',
  lv: 'Latvian',
  et: 'Estonian',
  lt: 'Lithuanian',
  de: 'German',
  sv: 'Swedish',
}

export type PrepareStatus = 'ready' | 'no_provider' | 'capped' | 'instrumental' | 'error'

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

const SYSTEM = (lang: string, hasLyrics: boolean) =>
  `You prepare a short radio introduction for a song, for a listener who likes to understand songs in other languages.
Target language of everything you write: ${LANG_NAME[lang] ?? lang} (code ${lang}).
Return JSON with the keys:
- "original_lang": ISO 639-1 code of the language the song is sung in.
- "summary": 2-3 sentences in the target language about what the song is about.
- "intro_script": what a radio host says before the song, in the target language, spoken style, 2-4 sentences, at most ${MAX_INTRO_CHARS} characters. Say the artist and the title, then what the song is about emotionally in plain words (for example: it is a love song, he is suffering). ${
    hasLyrics
      ? 'Then give 2-3 short phrases from the song in the original language (each at most 6 words, in quotes), each followed by its meaning. '
      : 'You have no lyrics: do not quote anything and do not invent the content; only say the artist and the title and, if you are sure, one general remark. '
  }Do not talk about learning vocabulary and do not give study advice.
- "hooks": the original phrases you quoted in the intro (array of strings).
- "translations": ${
    hasLyrics
      ? 'an array with the translation of EVERY numbered line of the lyrics into the target language, in the same order and the same count; an empty array if the song is already in the target language.'
      : 'an empty array.'
  }`

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

  ensurePrepared(trackId: string, lang: string): Promise<PrepareStatus> {
    const key = `${trackId}:${lang}`
    const cur = this.inflight.get(key)
    if (cur) return cur
    if (this.getNotes(trackId, lang)) return Promise.resolve('ready')
    const run = this.chain.then(() => this.prepare(trackId, lang)).catch((): PrepareStatus => 'error')
    this.chain = run
    const p = run.finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  private async prepare(trackId: string, lang: string): Promise<PrepareStatus> {
    if (this.getNotes(trackId, lang)) return 'ready'
    if (!this.llm.configured()) return 'no_provider'
    const failed = this.failedAt.get(`${trackId}:${lang}`)
    if (failed !== undefined && this.now() - failed < LLM_ERROR_RETRY_MS) return 'error'
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

  private async writeNotes(
    trackId: string,
    lang: string,
    track: typeof tracks.$inferSelect,
    lyr: typeof songLyrics.$inferSelect,
  ): Promise<PrepareStatus> {
    const lines = lyr.lyrics ? plainLines(lyr.lyrics).slice(0, MAX_LINES) : []
    const hasLyrics = lines.length > 0
    const user = `Artist: ${track.artist || 'unknown'}\nTitle: ${track.title}\n${
      hasLyrics ? `Lyrics, numbered:\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}` : 'Lyrics: not available'
    }`
    const failKey = `${trackId}:${lang}`
    try {
      const r = await this.llm.chatJson(SYSTEM(lang, hasLyrics), user, notesSchema)
      const d = r.data
      const problem = introProblem(d.intro_script)
      if (problem) throw new Error(problem)
      const orig = d.original_lang.toLowerCase().slice(0, 2)
      const same = orig === lang
      const tr = d.translations ?? []
      // a translation with a different line count is not paired (the summary and the intro stay)
      const pairs = hasLyrics && !same && tr.length === lines.length ? lines.map((src, i) => ({ src, tr: tr[i] as string })) : null
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
}
