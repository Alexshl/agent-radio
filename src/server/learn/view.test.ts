// Learn mode, web UI endpoints: the song on air, the archive and the song card. Everything is scoped to the signed-in user.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { learnPlays, songLyrics, songNotes, stations } from '../db/schema'
import { createPlaylist } from '../playlists'
import { type T, addUser, login, setup } from '../test-utils'
import { buildLines } from './view'

async function world() {
  const t = setup()
  for (const n of ['a1.mp3', 'a2.mp3']) writeFileSync(join(t.music, n), 'x')
  await t.library.scan()
  const ids = t.library.matching({}, 10).tracks.map((x) => x.id)
  const a = await addUser(t, 'a@x.io')
  const b = await addUser(t, 'b@x.io')
  const ca = await login(t, 'a@x.io')
  const cb = await login(t, 'b@x.io')
  return { t, ids, a, b, ca, cb }
}

const play = (t: T, userId: string, stationId: string, trackId: string, status: string, extra: Record<string, unknown> = {}) =>
  t.db
    .insert(learnPlays)
    .values({
      id: `p-${Math.random().toString(36).slice(2)}`,
      userId,
      stationId,
      trackId,
      status,
      trackMsg: `m-${Math.random()}`,
      plannedAt: 1000,
      startedAt: 5000,
      ...extra,
    })
    .run()

const get = async (t: T, cookie: string | undefined, path: string) => {
  const res = await t.req(`/api/app/learn/${path}`, cookie ? { cookie } : {})
  // biome-ignore lint/suspicious/noExplicitAny: test helper over loose JSON
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

function addSong(t: T, trackId: string, lang: string) {
  t.db
    .insert(songLyrics)
    .values({
      trackId,
      lyrics: 'one\ntwo\nthree',
      synced: JSON.stringify([
        { t: 1, text: 'one' },
        { t: 4.5, text: 'two' },
        { t: 9, text: 'three' },
      ]),
      lang: 'lv',
      source: 'lrclib',
      status: 'found',
      fetchedAt: '2026-01-01',
    })
    .run()
  t.db
    .insert(songNotes)
    .values({
      trackId,
      lang,
      pairs: JSON.stringify([
        { src: 'one', tr: 'odin' },
        { src: 'two', tr: 'dva' },
        { src: 'three', tr: 'tri' },
      ]),
      summary: 'About things',
      introText: 'Next: a song',
      hooks: JSON.stringify(['two']),
      model: 'anthropic:haiku',
      createdAt: '2026-01-01',
    })
    .run()
}

describe('GET /api/app/learn/now', () => {
  it('needs a session; nothing on air gives nulls', async () => {
    const { t, ca } = await world()
    expect((await get(t, undefined, 'now')).status).toBe(401)
    const r = await get(t, ca, 'now')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ play: null, lyrics: null, notes: null, skip: false })
    expect(typeof r.body.serverNowMs).toBe('number')
  })

  it('shows the song playing in the own station with timed lines and the translation; the other user sees nothing', async () => {
    const { t, ids, a, ca, cb } = await world()
    const id = ids[0] as string
    addSong(t, id, 'uk')
    play(t, a.user.id, a.station.id, id, 'playing', { startedAt: 123_456 })
    const r = await get(t, ca, 'now')
    expect(r.body.play).toMatchObject({ trackId: id, startedAtMs: 123_456, state: 'playing' })
    expect(r.body.lyrics).toMatchObject({ status: 'found', origLang: 'lv', synced: true })
    expect(r.body.lyrics.lines).toEqual([
      { ms: 1000, orig: 'one', tr: 'odin' },
      { ms: 4500, orig: 'two', tr: 'dva' },
      { ms: 9000, orig: 'three', tr: 'tri' },
    ])
    expect(r.body.notes).toEqual({ summary: 'About things', hooks: [{ orig: 'two', tr: 'dva' }], intro: 'Next: a song' })
    const other = await get(t, cb, 'now')
    expect(other.body.play).toBeNull()
    expect(JSON.stringify(other.body)).not.toContain('odin')
  })

  it('an intro on air has no song start yet; skip shows the flag', async () => {
    const { t, ids, a, ca } = await world()
    const id = ids[0] as string
    play(t, a.user.id, a.station.id, id, 'intro')
    t.db.$client
      .prepare("insert into learn_song_prefs (user_id, track_id, skip, created_at) values (?, ?, 1, '2026-01-01')")
      .run(a.user.id, id)
    const r = await get(t, ca, 'now')
    expect(r.body.play).toMatchObject({ state: 'intro', startedAtMs: null })
    expect(r.body.skip).toBe(true)
    expect(r.body.lyrics).toMatchObject({ status: 'pending', lines: [] })
  })
})

describe('archive and song card', () => {
  it('lists only the own heard songs, once per track, with the filters', async () => {
    const { t, ids, a, b, ca, cb } = await world()
    const [x, y] = ids as [string, string]
    addSong(t, x, 'uk')
    play(t, a.user.id, a.station.id, x, 'done', { startedAt: 1000 })
    play(t, a.user.id, a.station.id, x, 'done', { startedAt: 9000 })
    play(t, a.user.id, a.station.id, y, 'done', { startedAt: 3000 })
    // not heard: planned / only the intro
    play(t, a.user.id, a.station.id, y, 'intro')
    play(t, b.user.id, b.station.id, y, 'done', { startedAt: 4000 })
    const r = await get(t, ca, 'archive')
    expect(r.body.songs.map((s: { trackId: string }) => s.trackId)).toEqual([x, y])
    expect(r.body.songs[0]).toMatchObject({ plays: 2, lang: 'lv' })
    expect(r.body.all).toBe(2)
    expect(r.body.langs).toEqual([{ lang: 'lv', count: 1 }])
    expect((await get(t, ca, 'archive?lang=lv')).body.songs).toHaveLength(1)
    expect((await get(t, ca, 'archive?q=zzzz')).body.songs).toHaveLength(0)
    const q = (await get(t, ca, `archive?q=${encodeURIComponent('a1')}`)).body.songs as { trackId: string }[]
    expect(q.length).toBeLessThanOrEqual(1)
    const mine = await get(t, cb, 'archive')
    expect(mine.body.songs.map((s: { trackId: string }) => s.trackId)).toEqual([y])
    expect((await get(t, undefined, 'archive')).status).toBe(401)
  })

  it('the card opens only for a song the user has heard; the intro text only when it aired', async () => {
    const { t, ids, a, ca, cb } = await world()
    const [x, y] = ids as [string, string]
    addSong(t, x, 'uk')
    play(t, a.user.id, a.station.id, x, 'done')
    const r = await get(t, ca, `songs/${x}`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      title: expect.any(String),
      summary: 'About things',
      intro: null,
      plays: 1,
      skip: false,
      credits: { lyrics: 'lrclib', model: 'anthropic:haiku' },
    })
    expect(r.body.lyrics.lines).toHaveLength(3)
    play(t, a.user.id, a.station.id, x, 'done', { introMsg: 'i1' })
    expect((await get(t, ca, `songs/${x}`)).body.intro).toBe('Next: a song')
    expect((await get(t, cb, `songs/${x}`)).status).toBe(404)
    expect((await get(t, ca, `songs/${y}`)).status).toBe(404)
    expect((await get(t, undefined, `songs/${x}`)).status).toBe(401)
  })
})

describe('buildLines', () => {
  const lyr = (o: Partial<typeof songLyrics.$inferSelect>) => ({
    trackId: 't',
    lyrics: 'a\nb',
    synced: null,
    lang: 'lv',
    source: 'lrclib',
    status: 'found',
    fetchedAt: 'x',
    ...o,
  })
  it('nothing without found lyrics', () => {
    expect(buildLines(undefined, null)).toEqual([])
    expect(buildLines(lyr({ status: 'not_found' }), null)).toEqual([])
  })
  it('plain lyrics: untimed lines, with the pairs when there are some', () => {
    expect(buildLines(lyr({}), null)).toEqual([
      { ms: null, orig: 'a', tr: null },
      { ms: null, orig: 'b', tr: null },
    ])
    expect(buildLines(lyr({}), [{ src: 'a', tr: 'A' }])).toEqual([{ ms: null, orig: 'a', tr: 'A' }])
  })
  it('synced lines take the translation by text, else by index when the counts agree', () => {
    const synced = JSON.stringify([
      { t: 1, text: 'Hello  World' },
      { t: 2, text: 'Other' },
    ])
    expect(buildLines(lyr({ synced }), [{ src: 'hello world', tr: 'H' }])).toEqual([
      { ms: 1000, orig: 'Hello  World', tr: 'H' },
      { ms: 2000, orig: 'Other', tr: null },
    ])
    expect(
      buildLines(lyr({ synced }), [
        { src: 'x', tr: 'X' },
        { src: 'y', tr: 'Y' },
      ]).map((l) => l.tr),
    ).toEqual(['X', 'Y'])
  })
})

describe('learn settings view', () => {
  it('reports the model, the language and the progress of the playlist', async () => {
    const { t, ids, a, ca } = await world()
    const pl = createPlaylist(t.db, a.user.id, { name: 'Mine', orderMode: 'shuffle', trackIds: ids })
    t.db
      .update(stations)
      .set({ source: JSON.stringify({ type: 'userplaylist', playlistId: pl.id }) })
      .where(eq(stations.id, a.station.id))
      .run()
    addSong(t, ids[0] as string, a.user.lang)
    const res = await t.req('/api/app/radio', { cookie: ca })
    const learn = ((await res.json()) as { learn: Record<string, unknown> }).learn
    expect(typeof learn.configured).toBe('boolean')
    expect(learn).toMatchObject({ mode: false, available: true, lang: a.user.lang, processed: 1, total: 2 })
  })
})
