// Admin section "Учи язык": the prompt template, the playground, the cache of lyrics and notes.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { songLyrics, songNotes } from '../db/schema'
import { setSetting } from '../lib/settings'
import { addUser, login, setup } from '../test-utils'
import { DEFAULT_PROMPT, buildSystem, promptProblem, renderPrompt } from './prompt'

afterEach(() => vi.unstubAllGlobals())

const NOTES = {
  original_lang: 'en',
  summary: 'A love song.',
  intro_script: 'Artist, Song. It is a love song. Listen for "hold me" which means обійми.',
  hooks: ['hold me'],
  translations: ['один', 'два'],
}
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } })

async function env() {
  const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    if (String(url).includes('lrclib.net'))
      return json({ duration: 100, plainLyrics: 'one\ntwo', syncedLyrics: '[00:01.00]one\n[00:02.00]two' })
    return json({ choices: [{ message: { content: JSON.stringify(NOTES) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } })
  })
  vi.stubGlobal('fetch', f)
  const t = setup()
  for (const n of ['a.mp3', 'b.mp3']) writeFileSync(join(t.music, n), 'x')
  await t.library.scan()
  const ids = t.library.matching({}, 10).tracks.map((x) => x.id)
  await addUser(t, 'admin@x.io', 'admin')
  await addUser(t, 'user@x.io')
  const cookie = await login(t, 'admin@x.io')
  const userCookie = await login(t, 'user@x.io')
  const call = (path: string, method = 'GET', body?: unknown) =>
    t.req(`/api/admin/learn${path}`, { method, cookie, ...(body !== undefined ? { json: body } : {}) })
  const llmCalls = () => f.mock.calls.filter((c) => !String(c[0]).includes('lrclib.net')).length
  const systemOf = (i: number) => {
    const c = f.mock.calls.filter((x) => !String(x[0]).includes('lrclib.net'))[i] as unknown as [string, RequestInit]
    return JSON.parse(String(c[1].body)).messages[0].content as string
  }
  return { t, f, ids, cookie, userCookie, call, llmCalls, systemOf, prep: t.deps.learnPrep }
}

describe('prompt template', () => {
  it('renders placeholders and both lyrics branches; the contract is always appended', () => {
    const tpl = 'Lang {{targetLanguage}} ({{targetCode}}) max {{maxIntroChars}}. {{#lyrics}}HAS{{/lyrics}}{{^lyrics}}NONE{{/lyrics}}'
    expect(renderPrompt(tpl, 'uk', true)).toBe('Lang Ukrainian (uk) max 900. HAS')
    expect(renderPrompt(tpl, 'uk', false)).toBe('Lang Ukrainian (uk) max 900. NONE')
    for (const has of [true, false]) {
      for (const t of [tpl, 'a completely custom prompt', DEFAULT_PROMPT]) {
        const s = buildSystem(t, 'uk', has)
        for (const k of ['original_lang', 'summary', 'intro_script', 'hooks', 'translations']) expect(s).toContain(`"${k}"`)
        expect(s).toContain('Answer contract')
      }
    }
    expect(buildSystem(DEFAULT_PROMPT, 'ru', false)).not.toContain('idioms')
    expect(buildSystem(DEFAULT_PROMPT, 'ru', true)).toContain('idioms')
  })

  it('the default is valid; unknown placeholders and empty text are not', () => {
    expect(promptProblem(DEFAULT_PROMPT)).toBeNull()
    expect(promptProblem('hello {{nope}}')).toMatch(/placeholder/)
    expect(promptProblem('  ')).toMatch(/empty/)
  })
})

describe('admin access', () => {
  it('401 without a session, 403 for an ordinary user', async () => {
    const e = await env()
    const routes: [string, string][] = [
      ['GET', '/prompt'],
      ['PUT', '/prompt'],
      ['DELETE', '/prompt'],
      ['POST', '/playground'],
      ['GET', '/songs'],
      ['GET', `/songs/${e.ids[0]}`],
      ['POST', `/songs/${e.ids[0]}/regenerate`],
      ['DELETE', `/songs/${e.ids[0]}/notes`],
      ['DELETE', '/notes'],
      ['POST', '/regenerate-all'],
      ['GET', '/regenerate-all'],
    ]
    for (const [m, p] of routes) {
      const path = `/api/admin/learn${p}`
      const body = m === 'GET' ? {} : { json: {} }
      expect((await e.t.req(path, { method: m, ...body })).status, `${m} ${p}`).toBe(401)
      expect((await e.t.req(path, { method: m, ...body, cookie: e.userCookie })).status, `${m} ${p}`).toBe(403)
    }
    expect(e.llmCalls()).toBe(0)
  })
})

describe('prompt endpoints', () => {
  it('override, reset and the alwaysFresh switch; the override reaches the model, the contract stays', async () => {
    const e = await env()
    const a = await (await e.call('/prompt')).json()
    expect(a).toMatchObject({ prompt: DEFAULT_PROMPT, isDefault: true, default: DEFAULT_PROMPT, alwaysFresh: false })
    expect(a.placeholders.length).toBeGreaterThan(2)
    expect((await e.call('/prompt', 'PUT', { prompt: 'x {{bad}}' })).status).toBe(400)
    const b = await (await e.call('/prompt', 'PUT', { prompt: 'Custom for {{targetLanguage}}', alwaysFresh: true })).json()
    expect(b).toMatchObject({ prompt: 'Custom for {{targetLanguage}}', isDefault: false, alwaysFresh: true })
    expect(await e.prep.ensurePrepared(e.ids[0] as string, 'uk')).toBe('ready')
    const sys = e.systemOf(0)
    expect(sys).toContain('Custom for Ukrainian')
    expect(sys).toContain('Answer contract')
    expect(sys).toContain('"intro_script"')
    const c = await (await e.call('/prompt', 'DELETE')).json()
    expect(c).toMatchObject({ prompt: DEFAULT_PROMPT, isDefault: true, alwaysFresh: true })
  })
})

describe('playground', () => {
  it('runs the model with the given prompt, writes nothing, counts against the cap', async () => {
    const e = await env()
    const res = await e.call('/playground', 'POST', {
      artist: 'A',
      title: 'S',
      lyrics: 'one\ntwo',
      lang: 'ru',
      prompt: 'Try {{targetCode}}',
    })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({
      summary: 'A love song.',
      hooks: ['hold me'],
      translations: ['один', 'два'],
      model: 'local:gemma4-e4b',
      tokensIn: 10,
      tokensOut: 20,
      problems: [],
    })
    expect(j.introScript).toContain('Artist, Song')
    expect(typeof j.ms).toBe('number')
    expect(e.systemOf(0)).toContain('Try ru')
    expect(e.t.db.select().from(songNotes).all()).toHaveLength(0)
    expect(e.t.db.select().from(songLyrics).all()).toHaveLength(0)
    expect(e.t.deps.llm.usage().calls).toBe(1)
    setSetting(e.t.db, 'learn.dailyLlmCalls', 1)
    const capped = await e.call('/playground', 'POST', { artist: 'A', title: 'S', lang: 'ru' })
    expect(capped.status).toBe(429)
    expect(e.llmCalls()).toBe(1)
  })
})

describe('songs, regenerate, delete', () => {
  it('lists songs with lyrics or notes and shows one', async () => {
    const e = await env()
    await e.prep.ensurePrepared(e.ids[0] as string, 'uk')
    const l = await (await e.call('/songs')).json()
    expect(l.songs).toHaveLength(1)
    expect(l.songs[0]).toMatchObject({ trackId: e.ids[0], lyrics: { status: 'found', hasText: true, source: 'lrclib' } })
    expect(l.songs[0].notes).toMatchObject([{ lang: 'uk', model: 'local:gemma4-e4b' }])
    expect(l.totals).toMatchObject({ songs: 1, withLyrics: 1, withNotes: 1, notes: 1 })
    expect((await (await e.call('/songs?q=zzz')).json()).songs).toHaveLength(0)
    expect((await (await e.call('/songs?lang=de')).json()).songs).toHaveLength(0)
    const one = await (await e.call(`/songs/${e.ids[0]}`)).json()
    expect(one.lyrics.text).toBe('one\ntwo')
    expect(one.notes[0]).toMatchObject({
      lang: 'uk',
      hooks: ['hold me'],
      pairs: [
        { src: 'one', tr: 'один' },
        { src: 'two', tr: 'два' },
      ],
    })
    expect((await e.call('/songs/nope')).status).toBe(404)
  })

  it('regenerate one track: notes are deleted and made again, lyrics are not fetched again', async () => {
    const e = await env()
    const id = e.ids[0] as string
    await e.prep.ensurePrepared(id, 'uk')
    await e.prep.ensurePrepared(id, 'ru')
    const lrc = () => e.f.mock.calls.filter((c) => String(c[0]).includes('lrclib.net')).length
    expect(e.llmCalls()).toBe(2)
    const res = await e.call(`/songs/${id}/regenerate`, 'POST', { lang: 'uk' })
    expect((await res.json()).queued).toEqual(['uk'])
    await vi.waitFor(() => expect(e.llmCalls()).toBe(3))
    await vi.waitFor(() => expect(e.t.db.select().from(songNotes).all()).toHaveLength(2))
    expect(lrc()).toBe(1)
    expect(e.t.db.select().from(songLyrics).all()).toHaveLength(1)
    // delete only
    const del = await (await e.call(`/songs/${id}/notes`, 'DELETE')).json()
    expect(del.deleted).toBe(2)
    expect(e.t.db.select().from(songNotes).all()).toHaveLength(0)
    expect(e.t.db.select().from(songLyrics).all()).toHaveLength(1)
  })

  it('delete all notes keeps the lyrics; regenerate-all redoes the notes with progress, and stops at the cap', async () => {
    const e = await env()
    for (const id of e.ids) await e.prep.ensurePrepared(id, 'uk')
    expect(e.llmCalls()).toBe(2)
    expect((await (await e.call('/notes', 'DELETE')).json()).deleted).toBe(2)
    expect(e.t.db.select().from(songNotes).all()).toHaveLength(0)
    expect(e.t.db.select().from(songLyrics).all()).toHaveLength(2)

    for (const id of e.ids) await e.prep.ensurePrepared(id, 'uk')
    expect(e.llmCalls()).toBe(4)
    const start = await (await e.call('/regenerate-all', 'POST', {})).json()
    expect(start).toMatchObject({ ok: true, total: 2 })
    await vi.waitFor(async () =>
      expect(await (await e.call('/regenerate-all')).json()).toMatchObject({ running: false, done: 2, failed: 0, total: 2 }),
    )
    expect(e.llmCalls()).toBe(6)
    expect(e.t.db.select().from(songNotes).all()).toHaveLength(2)
    expect(e.t.db.select().from(songLyrics).all()).toHaveLength(2)

    // the cap: one call left of the day
    setSetting(e.t.db, 'learn.dailyLlmCalls', 7)
    await e.call('/regenerate-all', 'POST', {})
    await vi.waitFor(async () => expect((await (await e.call('/regenerate-all')).json()).running).toBe(false))
    const p = await (await e.call('/regenerate-all')).json()
    expect(p).toMatchObject({ total: 2, done: 1, failed: 1, capped: true })
    expect(e.llmCalls()).toBe(7)
    expect(e.t.db.select().from(songLyrics).all()).toHaveLength(2)
  })
})

describe('playground speak', () => {
  it('admin only; synthesizes with the admin voice and no chime, returns audio', async () => {
    const e = await env()
    const r = await e.call('/playground/speak', 'POST', { text: 'Hello there', lang: 'uk' })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('audio/mpeg')
    expect(e.t.makeClip).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Hello there', lang: 'uk', chime: false }))
    expect((await e.call('/playground/speak', 'POST', { text: '', lang: 'uk' })).status).toBe(400)
    const u = await e.t.req('/api/admin/learn/playground/speak', { method: 'POST', cookie: e.userCookie, json: { text: 'x', lang: 'uk' } })
    expect(u.status).toBe(403)
  })
})

describe('default prompt', () => {
  it('forbids filler phrases', () => {
    expect(DEFAULT_PROMPT).toContain('Never use filler phrases')
  })
})

describe('alwaysFresh', () => {
  it('a fresh preparation asks the model again even with cached notes; a normal one does not', async () => {
    const e = await env()
    const id = e.ids[0] as string
    await e.prep.ensurePrepared(id, 'uk')
    await e.prep.ensurePrepared(id, 'uk')
    expect(e.llmCalls()).toBe(1)
    expect(await e.prep.ensurePrepared(id, 'uk', { fresh: true })).toBe('ready')
    expect(e.llmCalls()).toBe(2)
    expect(e.t.db.select().from(songLyrics).all()).toHaveLength(1)
    // the cap applies to a fresh call as well; the old notes stay
    setSetting(e.t.db, 'learn.dailyLlmCalls', 2)
    expect(await e.prep.ensurePrepared(id, 'uk', { fresh: true })).toBe('capped')
    expect(e.prep.getNotes(id, 'uk')).not.toBeNull()
  })
})
