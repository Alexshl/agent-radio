// Learn mode, P2: LRC, LRCLIB, the model client, the preparation of notes and the admin routes (no network: fetch is a mock).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { songLyrics, songNotes } from '../db/schema'
import { setSetting } from '../lib/settings'
import { addUser, login, setup } from '../test-utils'
import { LlmError, LlmService, extractJson, llmSecretName } from './llm'
import { parseLrc } from './lrc'
import { LrcLibClient } from './lrclib'
import { SongPreparer, introProblem } from './prepare'

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

describe('parseLrc', () => {
  it('parses stamps, several stamps per line, and the offset', () => {
    const lines = parseLrc('[ar:X]\n[offset:+500]\n[00:10.50]Hello\n[00:05.00][00:20.00]Again\n[00:30.00]\n')
    expect(lines).toEqual([
      { t: 4.5, text: 'Again' },
      { t: 10, text: 'Hello' },
      { t: 19.5, text: 'Again' },
    ])
  })
})

describe('LrcLibClient', () => {
  const q = { artist: 'Artist', title: 'Song', album: 'Alb', durationSec: 200 }
  it('uses /get when the duration matches (±2 s)', async () => {
    const f = vi.fn(async () => json({ duration: 201, plainLyrics: 'a\nb', syncedLyrics: '[00:01.00]a' }))
    const r = await new LrcLibClient(f as unknown as typeof fetch).find(q)
    expect(r).toEqual({ status: 'found', plain: 'a\nb', synced: '[00:01.00]a' })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/get?')
    expect(url).toContain('artist_name=Artist')
    expect(String((init.headers as Record<string, string>)['user-agent'])).toContain('agent-radio')
  })
  it('falls back to /search, picks a matching duration and prefers synced', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes('/api/get')) return json({ duration: 260, plainLyrics: 'wrong' })
      return json([
        { trackName: 'Song', artistName: 'Artist', duration: 230, plainLyrics: 'far' },
        { trackName: 'Song', artistName: 'Artist', duration: 199, plainLyrics: 'p' },
        { trackName: 'Song', artistName: 'Artist', duration: 202, plainLyrics: 'p2', syncedLyrics: '[00:01.00]p2' },
        { trackName: 'Other', artistName: 'Artist', duration: 200, plainLyrics: 'no' },
      ])
    })
    const r = await new LrcLibClient(f as unknown as typeof fetch).find(q)
    expect(r).toMatchObject({ status: 'found', plain: 'p2' })
  })
  it('instrumental, not found, and server errors', async () => {
    const c = (f: unknown) => new LrcLibClient(f as typeof fetch)
    expect(await c(async () => json({ duration: 200, instrumental: true })).find(q)).toEqual({ status: 'instrumental' })
    expect(await c(async () => new Response('', { status: 404 })).find(q)).toEqual({ status: 'not_found' })
    await expect(c(async () => new Response('', { status: 500 })).find(q)).rejects.toThrow()
  })
  it('one request at a time', async () => {
    let running = 0
    let max = 0
    const f = async () => {
      running++
      max = Math.max(max, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return new Response('', { status: 404 })
    }
    const c = new LrcLibClient(f as unknown as typeof fetch)
    await Promise.all([c.find(q), c.find(q)])
    expect(max).toBe(1)
  })
})

describe('extractJson', () => {
  it('plain, fenced and surrounded by prose', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 })
    expect(extractJson('Sure! Here it is: {"a":3} Hope it helps')).toEqual({ a: 3 })
    expect(() => extractJson('nothing')).toThrow(LlmError)
  })
})

describe('introProblem', () => {
  it('rejects long quotes and long intros', () => {
    expect(introProblem('Artist, Song. Listen for "one two three" which means x.')).toBeNull()
    expect(introProblem('Listen for "one two three four five six seven eight nine" now.')).toBe('quote too long')
    expect(introProblem('x'.repeat(1100))).toBe('intro too long')
  })
})

function env(fetchImpl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const t = setup()
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => fetchImpl(String(url), init))
  const llm = new LlmService(t.db, t.config, t.registry.secrets, f as unknown as typeof fetch)
  return { t, f, llm }
}

describe('LlmService', () => {
  const schema = z.object({ ok: z.boolean() })
  it('OpenAI style: json_object, bearer key, tokens counted; local needs no key', async () => {
    const { t, f, llm } = env(() =>
      json({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    )
    const r = await llm.chatJson('s', 'u', schema)
    expect(r.data).toEqual({ ok: true })
    expect(r).toMatchObject({ provider: 'local', model: 'gemma4-e4b', tokensIn: 7, tokensOut: 3 })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://host.docker.internal:8091/v1/chat/completions')
    expect(JSON.parse(String(init.body)).response_format).toEqual({ type: 'json_object' })
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
    expect(llm.usage()).toMatchObject({ calls: 1, tokensIn: 7, tokensOut: 3 })

    setSetting(t.db, 'learn.provider', 'openai')
    await expect(llm.chatJson('s', 'u', schema)).rejects.toMatchObject({ code: 'no_provider' })
    await t.registry.secrets.put(llmSecretName('openai'), 'sk-secret')
    await llm.chatJson('s', 'u', schema)
    const last = f.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(last[0]).toBe('https://api.openai.com/v1/chat/completions')
    expect((last[1].headers as Record<string, string>).authorization).toBe('Bearer sk-secret')
  })

  it('Anthropic style: x-api-key, version header, text blocks, web search tool only when asked', async () => {
    const { t, f, llm } = env(() =>
      json({ content: [{ type: 'text', text: '{"ok": true}' }], usage: { input_tokens: 5, output_tokens: 2 } }),
    )
    setSetting(t.db, 'learn.provider', 'anthropic')
    await t.registry.secrets.put(llmSecretName('anthropic'), 'ak-secret')
    const r = await llm.chatJson('s', 'u', schema, { webSearch: true })
    expect(r.tokensIn).toBe(5)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers).toMatchObject({ 'x-api-key': 'ak-secret', 'anthropic-version': '2023-06-01' })
    expect(JSON.parse(String(init.body)).tools[0].name).toBe('web_search')
    await llm.chatJson('s', 'u', schema)
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body)).tools).toBeUndefined()
  })

  it('daily cap: the call is refused and no request is made', async () => {
    const { t, f, llm } = env(() => json({ choices: [{ message: { content: '{"ok":true}' } }] }))
    setSetting(t.db, 'learn.dailyLlmCalls', 2)
    await llm.chatJson('s', 'u', schema)
    await llm.chatJson('s', 'u', schema)
    await expect(llm.chatJson('s', 'u', schema)).rejects.toMatchObject({ code: 'cap' })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('error messages do not carry keys; wrong JSON shape is bad_json', async () => {
    const { t, llm } = env(() => json({ error: 'bad key sk-secret' }, 401))
    setSetting(t.db, 'learn.provider', 'openai')
    await t.registry.secrets.put(llmSecretName('openai'), 'sk-secret')
    const e = await llm.chatJson('s', 'u', schema).catch((x) => x)
    expect(e).toBeInstanceOf(LlmError)
    expect(String(e.message)).not.toContain('sk-secret')
    const b = env(() => json({ choices: [{ message: { content: '{"nope":1}' } }] }))
    await expect(b.llm.chatJson('s', 'u', schema)).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('lists models from /models', async () => {
    const { llm } = env(() => json({ data: [{ id: 'b' }, { id: 'a' }] }))
    expect(await llm.listModels('local')).toEqual(['a', 'b'])
  })
})

const NOTES = (extra: Record<string, unknown> = {}) => ({
  original_lang: 'en',
  summary: 'A love song.',
  intro_script: 'Artist, Song. It is a love song. Listen for "hold me" which means обійми.',
  hooks: ['hold me'],
  translations: ['один', 'два'],
  ...extra,
})

async function prepEnv(opts: { lrclib?: 'found' | 'none' | 'instrumental' | 'error'; notes?: unknown } = {}) {
  let notes: unknown = opts.notes ?? NOTES()
  const e = env((url) => {
    if (url.includes('lrclib.net')) {
      if (opts.lrclib === 'error') return new Response('', { status: 500 })
      if (opts.lrclib === 'none') return new Response('', { status: 404 })
      if (opts.lrclib === 'instrumental') return json({ duration: 100, instrumental: true })
      return json({ duration: 100, plainLyrics: 'one\ntwo', syncedLyrics: '[00:01.00]one\n[00:02.00]two' })
    }
    return json({ choices: [{ message: { content: JSON.stringify(notes) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } })
  })
  writeFileSync(join(e.t.music, 'a.mp3'), 'x')
  await e.t.library.scan()
  const trackId = e.t.library.matching({}, 10).tracks[0]?.id as string
  let now = Date.parse('2026-11-15T00:00:00Z')
  const prep = new SongPreparer(e.t.db, e.llm, new LrcLibClient(e.f as unknown as typeof fetch), () => now)
  return {
    ...e,
    prep,
    trackId,
    advance: (ms: number) => (now += ms),
    setNotes: (n: unknown) => {
      notes = n
    },
  }
}
const llmCalls = (e: { f: ReturnType<typeof vi.fn> }) => e.f.mock.calls.filter((c) => !String(c[0]).includes('lrclib.net')).length

describe('SongPreparer', () => {
  it('writes lyrics and notes once and serves them from the cache', async () => {
    const e = await prepEnv()
    expect(await e.prep.ensurePrepared(e.trackId, 'ru')).toBe('ready')
    expect(await e.prep.ensurePrepared(e.trackId, 'ru')).toBe('ready')
    expect(llmCalls(e)).toBe(1)
    const n = e.prep.getNotes(e.trackId, 'ru')
    expect(n?.pairs).toEqual([
      { src: 'one', tr: 'один' },
      { src: 'two', tr: 'два' },
    ])
    expect(n?.introText).toContain('Artist, Song')
    const row = e.t.db.select().from(songNotes).get()
    expect(row).toMatchObject({ model: 'local:gemma4-e4b', tokensIn: 10, tokensOut: 20 })
    expect(e.t.db.select().from(songLyrics).get()).toMatchObject({ status: 'found', lang: 'en' })
    // another language: lyrics come from the cache, one more model call
    e.setNotes(NOTES())
    expect(await e.prep.ensurePrepared(e.trackId, 'de')).toBe('ready')
    expect(e.f.mock.calls.filter((c) => String(c[0]).includes('lrclib.net'))).toHaveLength(1)
  })

  it('shares one run between simultaneous callers', async () => {
    const e = await prepEnv()
    await Promise.all([e.prep.ensurePrepared(e.trackId, 'ru'), e.prep.ensurePrepared(e.trackId, 'ru')])
    expect(llmCalls(e)).toBe(1)
  })

  it('no key for a remote provider: no_provider and nothing is called', async () => {
    const e = await prepEnv()
    setSetting(e.t.db, 'learn.provider', 'anthropic')
    expect(await e.prep.ensurePrepared(e.trackId, 'ru')).toBe('no_provider')
    expect(e.f).not.toHaveBeenCalled()
  })

  it('instrumental: no notes, no model call', async () => {
    const e = await prepEnv({ lrclib: 'instrumental' })
    expect(await e.prep.ensurePrepared(e.trackId, 'ru')).toBe('instrumental')
    expect(llmCalls(e)).toBe(0)
    expect(e.prep.getNotes(e.trackId, 'ru')).toBeNull()
  })

  it('no lyrics found: no notes and no model call; the status is cached and retried after 30 days', async () => {
    const e = await prepEnv({ lrclib: 'none', notes: NOTES({ intro_script: 'Artist, Song. A song.', translations: [] }) })
    expect(await e.prep.ensurePrepared(e.trackId, 'ru')).toBe('no_lyrics')
    expect(e.prep.getNotes(e.trackId, 'ru')).toBeNull()
    expect(e.t.db.select().from(songLyrics).get()?.status).toBe('not_found')
    expect(llmCalls(e)).toBe(0)
    const lr = () => e.f.mock.calls.filter((c) => String(c[0]).includes('lrclib.net')).length
    const n = lr()
    await e.prep.ensurePrepared(e.trackId, 'ru')
    expect(lr()).toBe(n)
    e.advance(31 * 24 * 3600_000)
    await e.prep.ensurePrepared(e.trackId, 'ru')
    expect(lr()).toBeGreaterThan(n)
    expect(llmCalls(e)).toBe(0)
  })

  it('an LRCLIB error is retried after an hour, not before', async () => {
    const e = await prepEnv({ lrclib: 'error' })
    expect(await e.prep.ensurePrepared(e.trackId, 'ru')).toBe('error')
    const n = e.f.mock.calls.length
    expect(await e.prep.ensurePrepared(e.trackId, 'ru')).toBe('error')
    expect(e.f.mock.calls.length).toBe(n)
    e.advance(3600_000 + 1000)
    await e.prep.ensurePrepared(e.trackId, 'ru')
    expect(e.f.mock.calls.length).toBeGreaterThan(n)
  })

  it('a model failure is not tried again for an hour', async () => {
    const e = await prepEnv({ notes: NOTES({ intro_script: 'Say "one two three four five six seven eight nine ten" now.' }) })
    expect(await e.prep.ensurePrepared(e.trackId, 'ru')).toBe('error')
    expect(await e.prep.ensurePrepared(e.trackId, 'ru')).toBe('error')
    expect(llmCalls(e)).toBe(1)
    e.setNotes(NOTES())
    e.advance(3600_000 + 1000)
    expect(await e.prep.ensurePrepared(e.trackId, 'ru')).toBe('ready')
  })

  it('a translation with the wrong line count keeps the summary and intro without pairs', async () => {
    const e = await prepEnv({ notes: NOTES({ translations: ['only one'] }) })
    expect(await e.prep.ensurePrepared(e.trackId, 'ru')).toBe('ready')
    const n = e.prep.getNotes(e.trackId, 'ru')
    expect(n?.pairs).toBeNull()
    expect(n?.summary).toBe('A love song.')
    expect(n?.introText).toBeTruthy()
  })

  it('the song is already in the target language: no pairs, the intro is still written', async () => {
    const e = await prepEnv({ notes: NOTES({ original_lang: 'ru', translations: ['x', 'y'] }) })
    expect(await e.prep.ensurePrepared(e.trackId, 'ru')).toBe('ready')
    const n = e.prep.getNotes(e.trackId, 'ru')
    expect(n?.pairs).toBeNull()
    expect(n?.introText).toBeTruthy()
  })

  it('the daily cap gives "capped" and writes nothing', async () => {
    const e = await prepEnv()
    setSetting(e.t.db, 'learn.dailyLlmCalls', 0)
    expect(await e.prep.ensurePrepared(e.trackId, 'ru')).toBe('capped')
    expect(e.prep.getNotes(e.trackId, 'ru')).toBeNull()
  })

  it('web search is used only with anthropic and the checkbox', async () => {
    const e = await prepEnv({ lrclib: 'none' })
    expect(e.llm.canSearchWeb()).toBe(false)
    setSetting(e.t.db, 'learn.provider', 'anthropic')
    await e.t.registry.secrets.put(llmSecretName('anthropic'), 'k')
    expect(e.llm.canSearchWeb()).toBe(false)
    setSetting(e.t.db, 'learn.webSearch', true)
    expect(e.llm.canSearchWeb()).toBe(true)
  })
})

describe('admin llm routes', () => {
  it('need the admin role and never return keys', async () => {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    await addUser(t, 'u@x.io')
    const user = await login(t, 'u@x.io')
    expect((await t.req('/api/admin/llm', { cookie: user })).status).toBe(403)
    const admin = await login(t, 'admin@x.io')
    const put = await t.req('/api/admin/llm/openai/key', { method: 'PUT', cookie: admin, json: { key: 'sk-very-secret' } })
    expect(put.status).toBe(200)
    expect(await put.text()).not.toContain('sk-very-secret')
    const get = await t.req('/api/admin/llm', { cookie: admin })
    const text = await get.text()
    expect(text).not.toContain('sk-very-secret')
    const body = JSON.parse(text)
    expect(body.provider).toBe('local')
    expect(body.model).toBe('gemma4-e4b')
    expect(body.providers.find((p: { id: string }) => p.id === 'openai')).toMatchObject({ hasKey: true })
    expect(await t.registry.secrets.get(llmSecretName('openai'))).toBe('sk-very-secret')
    const set = await t.req('/api/admin/llm', {
      method: 'PUT',
      cookie: admin,
      json: { provider: 'openai', model: 'gpt-x', dailyLimit: 50, webSearch: true },
    })
    expect(await set.json()).toMatchObject({ provider: 'openai', model: 'gpt-x', dailyLimit: 50, webSearch: true })
    expect((await t.req('/api/admin/llm/nope/key', { method: 'PUT', cookie: admin, json: { key: 'x' } })).status).toBe(404)
    await t.req('/api/admin/llm/openai/key', { method: 'DELETE', cookie: admin })
    expect(t.registry.secrets.has(llmSecretName('openai'))).toBe(false)
    // the test route answers 200 with an error text when the provider is not set up
    const test = await t.req('/api/admin/llm/test', { method: 'POST', cookie: admin })
    expect(await test.json()).toMatchObject({ ok: false })
  })
})
