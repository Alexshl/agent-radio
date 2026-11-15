// Learn mode: what the web UI shows. The song on air with its lyrics and notes (player panel), the archive of the songs the user has heard
// and the card of one song. Everything is scoped to the signed-in user: the shared lyrics / notes cache is reached only through their own plays.
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { learnPlays, learnSongPrefs, playlistTracks, songLyrics, songNotes, stations, tracks, type users } from '../db/schema'
import { parseSource } from '../stations'
import { plainLines } from './lrc'

type UserRow = typeof users.$inferSelect

export interface LyricLine {
  ms: number | null
  orig: string
  tr: string | null
}

const json = <T>(s: string | null | undefined, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d
  } catch {
    return d
  }
}
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

// the plays that were heard (or are being heard): the intro alone does not count
const HEARD = ['playing', 'done']

// lyrics rows with the translation. Synced lines come from the timed LRC; the translation was made for the plain lines, so it is matched by
// the line text (or by the index when both have the same count).
export function buildLines(lyr: typeof songLyrics.$inferSelect | undefined, pairs: { src: string; tr: string }[] | null): LyricLine[] {
  if (lyr?.status !== 'found') return []
  const byText = new Map<string, string>()
  for (const p of pairs ?? []) if (!byText.has(norm(p.src))) byText.set(norm(p.src), p.tr)
  const synced = json<{ t: number; text: string }[]>(lyr.synced, [])
  if (synced.length) {
    const sameCount = !!pairs && pairs.length === synced.length
    return synced.map((l, i) => ({
      ms: Math.round(l.t * 1000),
      orig: l.text,
      tr: byText.get(norm(l.text)) ?? (sameCount ? (pairs?.[i]?.tr ?? null) : null),
    }))
  }
  if (pairs?.length) return pairs.map((p) => ({ ms: null, orig: p.src, tr: p.tr }))
  return lyr.lyrics ? plainLines(lyr.lyrics).map((orig) => ({ ms: null, orig, tr: null })) : []
}

// the hooks are quoted original phrases; the translation of one is taken from the line it was quoted from
function hookView(hooks: string[], pairs: { src: string; tr: string }[] | null) {
  return hooks.map((orig) => {
    const o = norm(orig)
    const hit = o ? pairs?.find((p) => norm(p.src).includes(o)) : undefined
    return { orig, tr: hit?.tr ?? null }
  })
}

function songParts(db: Db, trackId: string, lang: string) {
  const lyr = db.select().from(songLyrics).where(eq(songLyrics.trackId, trackId)).get()
  const notes = db
    .select()
    .from(songNotes)
    .where(and(eq(songNotes.trackId, trackId), eq(songNotes.lang, lang)))
    .get()
  const pairs = json<{ src: string; tr: string }[] | null>(notes?.pairs, null)
  const lines = buildLines(lyr, pairs)
  return {
    lyr,
    notes,
    lyrics: {
      status: lyr?.status ?? 'pending',
      origLang: lyr?.lang ?? null,
      synced: lines.some((l) => l.ms !== null),
      lines,
    },
    noteView: notes
      ? {
          summary: notes.summary ?? '',
          hooks: hookView(json<string[]>(notes.hooks, []), pairs),
          intro: notes.introText,
        }
      : null,
  }
}

const skipOf = (db: Db, userId: string, trackId: string) =>
  !!db
    .select({ skip: learnSongPrefs.skip })
    .from(learnSongPrefs)
    .where(and(eq(learnSongPrefs.userId, userId), eq(learnSongPrefs.trackId, trackId), eq(learnSongPrefs.skip, 1)))
    .get()

// the song on air now in the user's station (null when nothing is playing: learn mode off, a gap between songs)
export function learnNow(db: Db, user: UserRow, now = Date.now()) {
  const st = db.select({ id: stations.id }).from(stations).where(eq(stations.userId, user.id)).get()
  if (!st) return { serverNowMs: now, play: null, lyrics: null, notes: null, skip: false }
  const rows = db
    .select()
    .from(learnPlays)
    .where(and(eq(learnPlays.userId, user.id), eq(learnPlays.stationId, st.id), inArray(learnPlays.status, ['playing', 'intro'])))
    .all()
  // a song already playing wins over a stale intro row
  const row = rows.find((r) => r.status === 'playing') ?? rows.find((r) => r.status === 'intro')
  if (!row) return { serverNowMs: now, play: null, lyrics: null, notes: null, skip: false }
  const track = db.select().from(tracks).where(eq(tracks.id, row.trackId)).get()
  if (!track) return { serverNowMs: now, play: null, lyrics: null, notes: null, skip: false }
  const parts = songParts(db, row.trackId, user.lang)
  return {
    serverNowMs: now,
    play: {
      trackId: row.trackId,
      artist: track.artist,
      title: track.title,
      startedAtMs: row.status === 'playing' ? row.startedAt : null,
      state: row.status,
    },
    lyrics: parts.lyrics,
    notes: parts.noteView,
    skip: skipOf(db, user.id, row.trackId),
  }
}

const PAGE = 30

// the user's own played songs: one entry per track, the latest play first. cursor = offset into that order.
export function learnArchive(db: Db, user: UserRow, q: { cursor?: string; q?: string; lang?: string }) {
  const offset = Math.max(0, Number.parseInt(q.cursor ?? '0', 10) || 0)
  const search = (q.q ?? '').trim().toLowerCase()
  const rows = db
    .select({
      trackId: learnPlays.trackId,
      lastPlayedMs: sql<number>`max(coalesce(${learnPlays.startedAt}, ${learnPlays.plannedAt}))`,
      plays: sql<number>`count(*)`,
      title: tracks.title,
      artist: tracks.artist,
      lang: songLyrics.lang,
    })
    .from(learnPlays)
    .innerJoin(tracks, eq(tracks.id, learnPlays.trackId))
    .leftJoin(songLyrics, eq(songLyrics.trackId, learnPlays.trackId))
    .where(and(eq(learnPlays.userId, user.id), inArray(learnPlays.status, HEARD)))
    .groupBy(learnPlays.trackId)
    .orderBy(sql`max(coalesce(${learnPlays.startedAt}, ${learnPlays.plannedAt})) desc`, learnPlays.trackId)
    .all()
  const langs = new Map<string, number>()
  for (const r of rows) if (r.lang) langs.set(r.lang, (langs.get(r.lang) ?? 0) + 1)
  const hit = rows.filter((r) => (!q.lang || r.lang === q.lang) && (!search || `${r.title} ${r.artist}`.toLowerCase().includes(search)))
  const page = hit.slice(offset, offset + PAGE)
  return {
    songs: page.map((r) => ({
      trackId: r.trackId,
      title: r.title,
      artist: r.artist,
      lang: r.lang,
      lastPlayedAt: new Date(r.lastPlayedMs).toISOString(),
      plays: r.plays,
    })),
    total: hit.length,
    // for the language chips (all of the user's songs, not only the filtered ones)
    langs: [...langs.entries()].map(([lang, count]) => ({ lang, count })).sort((a, b) => b.count - a.count),
    all: rows.length,
    nextCursor: offset + PAGE < hit.length ? String(offset + PAGE) : null,
  }
}

// the card of a song the user has heard; null for any other track (the library is shared, the plays are not)
export function learnSong(db: Db, user: UserRow, trackId: string) {
  const plays = db
    .select()
    .from(learnPlays)
    .where(and(eq(learnPlays.userId, user.id), eq(learnPlays.trackId, trackId), inArray(learnPlays.status, HEARD)))
    .all()
  if (!plays.length) return null
  const track = db.select().from(tracks).where(eq(tracks.id, trackId)).get()
  if (!track) return null
  const parts = songParts(db, trackId, user.lang)
  const last = Math.max(...plays.map((p) => p.startedAt ?? p.plannedAt))
  const aired = plays.some((p) => !!p.introMsg)
  return {
    trackId,
    artist: track.artist,
    title: track.title,
    plays: plays.length,
    lastPlayedAt: new Date(last).toISOString(),
    skip: skipOf(db, user.id, trackId),
    lang: parts.lyrics.origLang,
    targetLang: user.lang,
    summary: parts.noteView?.summary ?? null,
    hooks: parts.noteView?.hooks ?? [],
    // the spoken intro, only when it really aired before one of the user's plays
    intro: aired ? (parts.noteView?.intro ?? null) : null,
    lyrics: parts.lyrics,
    credits: { lyrics: parts.lyr?.status === 'found' ? parts.lyr.source : null, model: parts.notes?.model ?? null },
  }
}

// "processed N of M songs" of the playlist the station plays: M = its tracks, N = those with notes in the user's language
export function learnProgress(db: Db, user: UserRow) {
  const st = db.select({ source: stations.source }).from(stations).where(eq(stations.userId, user.id)).get()
  const src = st ? parseSource(st.source) : null
  if (src?.type !== 'userplaylist') return { processed: 0, total: 0 }
  const row = db
    .select({
      total: sql<number>`count(distinct ${playlistTracks.trackId})`,
      processed: sql<number>`count(distinct ${songNotes.trackId})`,
    })
    .from(playlistTracks)
    .leftJoin(songNotes, and(eq(songNotes.trackId, playlistTracks.trackId), eq(songNotes.lang, user.lang)))
    .where(eq(playlistTracks.playlistId, src.playlistId))
    .get()
  return { processed: row?.processed ?? 0, total: row?.total ?? 0 }
}
