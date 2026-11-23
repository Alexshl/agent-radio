// Admin API (cookie session + admin role): /api/admin/*
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq, gte, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { apiKeys, messages, presets, stations, users } from '../db/schema'
import type { FullDeps } from '../deps'
import type { AppEnv } from '../env'
import { csrfGuard, dropUserSessions, requireAdmin, requireSession } from '../lib/auth'
import { HttpError, badRequest, notFound } from '../lib/http'
import { newId } from '../lib/ids'
import { type Resolver, type Transport, UrlBlockedError, parseExternalUrl, safeGet } from '../lib/safe-fetch'
import { INVITE_DAYS, createInvite, createReset, deleteInvite, listPendingInvites } from '../lib/invites'
import { type SettingKey, getSetting, setSetting } from '../lib/settings'
import { checkAllPresets, checkPreset } from '../presets-health'
import { LEVEL_RANGES, RATE_RANGE, parseSource } from '../stations'
import { diskSpace, trashTrack } from '../uploads'
import { createPron, deletePron, listPron, pronBody, pronPatch, pronView, updatePron } from '../tts/pronunciation-store'
import { LLM_LABEL, LLM_PROVIDERS, LlmError, type LlmProvider, isLlmProvider, llmSecretName } from '../learn/llm'
import { learnAdminRoutes } from './admin-learn'
import { secretName } from '../tts/registry'
import { DEFAULT_LANGS, cap, filterLangs } from '../tts/piper-catalog'
import { PIPER_DEFAULT_BY_LANG, PROVIDER_IDS, PROVIDER_LABEL, type ProviderId } from '../tts/voices'

const providerBody = z.object({
  key: z.string().trim().min(1).max(500).optional(),
  region: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,40}$/i)
    .optional(),
  model: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9._:-]{2,80}$/)
    .optional(),
})

const settingsBody = z.object({
  allowOwnUrls: z.boolean().optional(),
  messageLimitPerHour: z.number().int().min(0).max(100000).optional(),
  maxAudioMb: z.number().int().min(1).max(2000).optional(),
  maxAudioMinutes: z.number().int().min(1).max(240).optional(),
  allowUserUploads: z.boolean().optional(),
  uploadQuotaMb: z.number().int().min(1).max(10_000_000).optional(),
  defaultMusicGainDb: z.number().min(LEVEL_RANGES.musicGainDb.min).max(LEVEL_RANGES.musicGainDb.max).optional(),
  defaultSpeechRate: z.number().min(RATE_RANGE.min).max(RATE_RANGE.max).optional(),
  defaultVoiceGainDb: z.number().min(LEVEL_RANGES.voiceGainDb.min).max(LEVEL_RANGES.voiceGainDb.max).optional(),
})

const presetBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).default(''),
  url: z.url({ protocol: /^https?$/ }).max(2000),
})

export type Reachability = { status: 'ok' | 'slow' | 'down' | 'blocked'; ms: number | null }

// GET the stream through the SSRF-safe client until the headers arrive (the body is dropped): ok < 2 s, slow up to 6 s.
export async function checkReachable(url: string, opts: { resolver?: Resolver; transport?: Transport } = {}): Promise<Reachability> {
  const started = Date.now()
  try {
    const res = await safeGet(url, { ...opts, timeoutMs: 6000, headers: { 'Icy-MetaData': '0' } })
    const ms = Date.now() - started
    res.destroy()
    if (res.status < 200 || res.status >= 300) return { status: 'down', ms }
    return { status: ms > 2000 ? 'slow' : 'ok', ms }
  } catch (e) {
    return { status: e instanceof UrlBlockedError ? 'blocked' : 'down', ms: null }
  }
}

export function adminRoutes(deps: FullDeps) {
  const { db, config, engine, icecast, registry, library } = deps
  const r = new Hono<AppEnv>()
  r.use('*', csrfGuard(config))
  r.use('*', requireSession(db))
  r.use('*', requireAdmin)

  const link = (path: string, token: string) => `${config.publicUrl}${path}${token}`

  // ---- users ----

  r.get('/users', async (c) => {
    const rows = db.select().from(users).orderBy(users.createdAt).all()
    const sts = new Map(
      db
        .select()
        .from(stations)
        .all()
        .map((s) => [s.userId, s]),
    )
    const keyCounts = new Map(
      db
        .select({ userId: apiKeys.userId, n: sql<number>`count(*)` })
        .from(apiKeys)
        .where(isNull(apiKeys.revokedAt))
        .groupBy(apiKeys.userId)
        .all()
        .map((k) => [k.userId, k.n]),
    )
    const out = await Promise.all(
      rows.map(async (u) => {
        const st = sts.get(u.id)
        const listeners = st ? ((await icecast.listeners(st.id)) ?? 0) : 0
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          disabled: !!u.disabledAt,
          lastLoginAt: u.lastLoginAt,
          createdAt: u.createdAt,
          keys: keyCounts.get(u.id) ?? 0,
          sourceType: st ? parseSource(st.source).type : 'silence',
          listeners,
        }
      }),
    )
    return c.json({
      users: out,
      invites: listPendingInvites(db)
        .filter((i) => i.kind === 'invite')
        .map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt, createdAt: i.createdAt })),
    })
  })

  r.patch('/users/:id', async (c) => {
    const body = z
      .object({ role: z.enum(['admin', 'user']).optional(), disabled: z.boolean().optional() })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    const id = c.req.param('id')
    const target = db.select().from(users).where(eq(users.id, id)).get()
    if (!target) throw notFound('User not found')
    const me = c.get('user')
    if (id === me.id && (body.data.disabled || body.data.role === 'user'))
      throw badRequest('self_lockout', 'You cannot demote or disable yourself')
    const set: Partial<typeof users.$inferInsert> = {}
    if (body.data.role) set.role = body.data.role
    if (body.data.disabled !== undefined) set.disabledAt = body.data.disabled ? new Date().toISOString() : null
    if (Object.keys(set).length) db.update(users).set(set).where(eq(users.id, id)).run()
    if (body.data.disabled) dropUserSessions(db, id)
    return c.json({ ok: true })
  })

  r.post('/users/:id/reset', async (c) => {
    const target = db
      .select()
      .from(users)
      .where(eq(users.id, c.req.param('id')))
      .get()
    if (!target) throw notFound('User not found')
    const { token, invite } = await createReset(db, target, c.get('user').id)
    return c.json({ url: link('/reset/', token), expiresAt: invite.expiresAt })
  })

  r.post('/invites', async (c) => {
    const body = z
      .object({ email: z.string().trim().max(320), role: z.enum(['admin', 'user']).default('user'), days: z.number().int().default(7) })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body', `Expected {email, role, days: ${INVITE_DAYS.join('|')}}`)
    const { token, invite } = await createInvite(db, { ...body.data, createdBy: c.get('user').id })
    return c.json({ url: link('/invite/', token), expiresAt: invite.expiresAt, id: invite.id }, 201)
  })

  r.delete('/invites/:id', (c) => {
    deleteInvite(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  // ---- global pronunciation dictionary ----

  r.get('/pronunciations', (c) => c.json({ items: listPron(db, 'global', null).map(pronView) }))

  r.post('/pronunciations', async (c) => {
    const body = pronBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body', 'Expected {match, replacement, lang?, note?}')
    return c.json(pronView(createPron(db, 'global', null, body.data)), 201)
  })

  r.patch('/pronunciations/:id', async (c) => {
    const body = pronPatch.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    const row = updatePron(db, c.req.param('id'), 'global', null, body.data)
    if (!row) throw notFound('Entry not found')
    return c.json(pronView(row))
  })

  r.delete('/pronunciations/:id', (c) => {
    if (!deletePron(db, c.req.param('id'), 'global', null)) throw notFound('Entry not found')
    return c.json({ ok: true })
  })

  // ---- TTS ----

  r.get('/tts', (c) => {
    const defaultVoice = getSetting(db, 'defaultVoice') ?? registry.defaultVoiceKey('uk')
    const byLang = getSetting(db, 'defaultVoiceByLang')
    return c.json({
      providers: PROVIDER_IDS.filter((id) => id !== 'local').map((id) => ({
        id,
        label: PROVIDER_LABEL[id],
        configured: registry.isConfigured(id),
        region: id === 'azure' ? getSetting(db, 'tts.azure.region') : undefined,
        model: id === 'openai' ? getSetting(db, 'tts.openai.model') : id === 'gemini' ? getSetting(db, 'tts.gemini.model') : undefined,
      })),
      voices: registry.allVoices().map((v) => ({
        ...v,
        enabled: registry.voiceEnabled(v.key),
        providerConfigured: registry.isConfigured(v.provider),
        // a voice of one language is the default of that language; a multilingual one of the languages without their own
        isDefault: v.lang !== 'multi' ? byLang[v.lang] === v.key : v.key === defaultVoice,
        // a local voice is listed only while its engine is switched on (the engine switch lives in the local voices card)
        engineOn: v.provider === 'local' ? registry.voiceEnabled(v.key.split('/')[0] ?? v.key) : undefined,
      })),
      defaultVoice,
      defaultVoiceByLang: byLang,
    })
  })

  // ---- AI models (learn mode) ----
  const { llm } = deps

  const llmState = () => ({
    provider: llm.provider(),
    model: llm.model(),
    webSearch: getSetting(db, 'learn.webSearch'),
    dailyLimit: getSetting(db, 'learn.dailyLlmCalls'),
    usage: llm.usage(),
    localUrl: llm.baseUrl('local'),
    providers: LLM_PROVIDERS.map((id) => ({ id, label: LLM_LABEL[id], hasKey: llm.hasKey(id), configured: llm.configured(id) })),
  })

  r.get('/llm', (c) => c.json(llmState()))

  r.put('/llm', async (c) => {
    const body = z
      .object({
        provider: z.enum(LLM_PROVIDERS).optional(),
        model: z.string().trim().min(1).max(200).optional(),
        webSearch: z.boolean().optional(),
        dailyLimit: z.number().int().min(0).max(1_000_000).optional(),
        localUrl: z
          .url({ protocol: /^https?$/ })
          .max(500)
          .optional(),
      })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    const b = body.data
    if (b.provider) setSetting(db, 'learn.provider', b.provider)
    if (b.model) setSetting(db, 'learn.model', b.model)
    if (b.webSearch !== undefined) setSetting(db, 'learn.webSearch', b.webSearch)
    if (b.dailyLimit !== undefined) setSetting(db, 'learn.dailyLlmCalls', b.dailyLimit)
    if (b.localUrl) setSetting(db, 'learn.localUrl', b.localUrl.replace(/\/+$/, ''))
    return c.json(llmState())
  })

  const llmProviderParam = (id: string): LlmProvider => {
    if (!isLlmProvider(id)) throw notFound('Unknown provider')
    return id
  }

  r.put('/llm/:id/key', async (c) => {
    const id = llmProviderParam(c.req.param('id'))
    const body = z.object({ key: z.string().trim().min(1).max(500) }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    await llm.secrets.put(llmSecretName(id), body.data.key)
    return c.json({ ok: true })
  })

  r.delete('/llm/:id/key', (c) => {
    llm.secrets.delete(llmSecretName(llmProviderParam(c.req.param('id'))))
    return c.json({ ok: true })
  })

  // model ids of the provider (its /models); an empty list = type the name by hand
  r.get('/llm/:id/models', async (c) => c.json({ models: (await llm.listModels(llmProviderParam(c.req.param('id')))) ?? [] }))

  // a tiny call with the chosen provider and model
  r.post('/llm/test', async (c) => {
    const started = Date.now()
    try {
      const r = await llm.chatJson('You are a test.', 'Reply with {"ok": true}.', z.object({ ok: z.boolean() }), { maxTokens: 50 })
      return c.json({ ok: true, ms: Date.now() - started, model: r.model, provider: r.provider })
    } catch (e) {
      const error = e instanceof LlmError ? e.message : 'failed'
      return c.json({ ok: false, error: error.slice(0, 300) }, 200)
    }
  })

  r.route('/learn', learnAdminRoutes(deps))

  // ---- local neural voices (tts-local sidecar) ----

  const localState = () => {
    const engines = registry.localEngineList()
    return {
      configured: !!config.ttsLocalUrl,
      reachable: engines !== null,
      engines: (engines ?? []).map((e) => ({
        ...e,
        enabled: registry.voiceEnabled(`local:${e.id}`),
        voices: e.voices.map((v) => ({ ...v, key: `local:${e.id}/${v.id}`, enabled: registry.voiceEnabled(`local:${e.id}/${v.id}`) })),
      })),
    }
  }

  r.get('/tts/local', async (c) => {
    await registry.refreshLocal()
    return c.json(localState())
  })

  r.put('/tts/local/:engine', async (c) => {
    const engine = c.req.param('engine')
    if (!registry.localEngineList()?.some((e) => e.id === engine)) throw notFound('Unknown engine')
    const body = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    registry.setVoiceEnabled(`local:${engine}`, body.data.enabled)
    return c.json({ ok: true })
  })

  r.put('/tts/providers/:id', async (c) => {
    const id = c.req.param('id') as ProviderId
    if (!PROVIDER_IDS.includes(id) || id === 'piper' || id === 'local') throw notFound('Unknown provider')
    const body = providerBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    if (body.data.key) await registry.secrets.put(secretName(id), body.data.key)
    if (body.data.region && id === 'azure') setSetting(db, 'tts.azure.region', body.data.region)
    if (body.data.model && id === 'openai') setSetting(db, 'tts.openai.model', body.data.model)
    if (body.data.model && id === 'gemini') setSetting(db, 'tts.gemini.model', body.data.model)
    return c.json({ ok: true })
  })

  r.delete('/tts/providers/:id', (c) => {
    const id = c.req.param('id') as ProviderId
    if (!PROVIDER_IDS.includes(id) || id === 'piper' || id === 'local') throw notFound('Unknown provider')
    registry.secrets.delete(secretName(id))
    return c.json({ ok: true })
  })

  // Synthesizes a short sample with the provider itself (no fallback) and returns it for playback.
  r.post('/tts/providers/:id/test', async (c) => {
    const id = c.req.param('id') as ProviderId
    if (!PROVIDER_IDS.includes(id)) throw notFound('Unknown provider')
    const body = z.object({ voice: z.string().max(200).optional() }).safeParse(await c.req.json().catch(() => ({})))
    const voice = (body.success && body.data.voice) || registry.allVoices().find((v) => v.provider === id)?.key
    const v = voice ? registry.findVoice(voice) : undefined
    if (!v || v.provider !== id) throw badRequest('invalid_voice')
    if (!registry.isConfigured(id)) throw badRequest('not_configured', 'Provider is not configured')
    const dir = mkdtempSync(join(tmpdir(), 'tts-test-'))
    const started = Date.now()
    try {
      const sample =
        { uk: 'Привіт! Це перевірка голосу.', ru: 'Привет! Это проверка голоса.', en: 'Hello! This is a voice check.' }[
          v.lang === 'multi' ? 'uk' : v.lang
        ] ?? 'Hello'
      const file = await registry
        .provider(id)
        .synthesize({ text: sample, voice: v.id, lang: v.lang === 'multi' ? 'uk' : v.lang }, join(dir, 'sample'))
      const buf = readFileSync(file)
      return c.json({
        ok: true,
        ms: Date.now() - started,
        bytes: buf.length,
        mime: file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg',
        audio: buf.toString('base64'),
      })
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message.slice(0, 300) : 'failed' }, 200)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ---- Piper catalog ----

  const piperRow = (c: ReturnType<typeof registry.catalog.voices>[number]) => {
    const key = `piper:${c.id}`
    return {
      id: c.id,
      key,
      name: cap(c.name),
      lang: c.lang,
      langCode: c.langCode,
      quality: c.quality,
      sizeBytes: c.sizeBytes,
      speakers: c.speakers.length,
      downloaded: registry.catalog.isDownloaded(c.id),
      downloading: registry.piper.isDownloading(c.id) ? (registry.piper.progress.get(c.id) ?? { received: 0, total: c.sizeBytes }) : null,
      enabled: registry.voiceEnabled(key),
      // the language defaults are the fallback voices: they stay
      builtin: PIPER_DEFAULT_BY_LANG[c.lang] === c.id,
    }
  }

  // ?lang=uk,ru,en (default) | all | any comma separated list of language families
  r.get('/tts/piper', (c) => {
    void registry.catalog.refresh().catch(() => {})
    const q = c.req.query('lang')
    const langs = q === 'all' ? 'all' : q ? q.split(',').filter((x) => /^[a-z]{2,3}$/.test(x)) : DEFAULT_LANGS
    const all = registry.catalog.voices()
    return c.json({
      voices: filterLangs(all, langs).map(piperRow),
      languages: [...new Set(all.map((v) => v.lang))].sort(),
      lastFetched: registry.catalog.lastFetched,
    })
  })

  r.post('/tts/piper/refresh', async (c) => {
    try {
      await registry.catalog.refresh(true)
    } catch (e) {
      console.error('piper catalog refresh failed:', e instanceof Error ? e.message : e)
      throw new HttpError(502, 'catalog_unavailable', 'Could not fetch the Piper voice catalog')
    }
    return c.json({ ok: true })
  })

  const piperVoiceOr404 = (id: string) => {
    const v = registry.catalog.get(id)
    if (!v) throw notFound('Unknown voice')
    return v
  }

  // starts the download in the background; the table polls for progress
  r.post('/tts/piper/:id/download', (c) => {
    const v = piperVoiceOr404(c.req.param('id'))
    if (!registry.catalog.isDownloaded(v.id) && !registry.piper.isDownloading(v.id)) {
      registry.piper.ensureModel(v.id).catch((e) => console.error(`piper download ${v.id} failed:`, e instanceof Error ? e.message : e))
    }
    return c.json({ ok: true }, 202)
  })

  r.delete('/tts/piper/:id', (c) => {
    const v = piperVoiceOr404(c.req.param('id'))
    if (PIPER_DEFAULT_BY_LANG[v.lang] === v.id) throw new HttpError(409, 'builtin_voice', 'This voice is the fallback for its language')
    if (getSetting(db, 'defaultVoice') === `piper:${v.id}`)
      throw new HttpError(409, 'default_voice', 'This voice is the default for new users')
    if (registry.piper.isDownloading(v.id)) throw new HttpError(409, 'downloading', 'The voice is being downloaded')
    registry.piper.remove(v.id)
    return c.json({ ok: true })
  })

  r.put('/tts/voices/:key', async (c) => {
    const key = decodeURIComponent(c.req.param('key'))
    if (!registry.findVoice(key)) throw notFound('Unknown voice')
    const body = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    registry.setVoiceEnabled(key, body.data.enabled)
    return c.json({ ok: true })
  })

  r.put('/tts/default', async (c) => {
    const body = z.object({ voice: z.string().max(200).nullable() }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    const v = body.data.voice ? registry.findVoice(body.data.voice) : null
    if (body.data.voice && !v) throw notFound('Unknown voice')
    if (v && v.lang !== 'multi') setSetting(db, 'defaultVoiceByLang', { ...getSetting(db, 'defaultVoiceByLang'), [v.lang]: v.key })
    else setSetting(db, 'defaultVoice', body.data.voice)
    return c.json({ ok: true })
  })

  // ---- settings ----

  const settingKeys: SettingKey[] = [
    'allowOwnUrls',
    'messageLimitPerHour',
    'maxAudioMb',
    'maxAudioMinutes',
    'allowUserUploads',
    'uploadQuotaMb',
    'defaultMusicGainDb',
    'defaultVoiceGainDb',
    'defaultSpeechRate',
  ]
  r.get('/settings', (c) => c.json(Object.fromEntries(settingKeys.map((k) => [k, getSetting(db, k)]))))
  r.put('/settings', async (c) => {
    const body = settingsBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    for (const [k, v] of Object.entries(body.data)) setSetting(db, k as SettingKey, v as never)
    return c.json({ ok: true })
  })

  // ---- library ----

  r.get('/library', (c) =>
    c.json({
      dir: config.musicDir,
      total: library.count(),
      totalSize: library.totalSize(),
      scanning: library.scanning,
      lastScan: library.last,
      disk: diskSpace(config.musicDir),
    }),
  )
  // Deleting a track moves its file to MUSIC_DIR/.trash.
  r.delete('/library/tracks/:id', (c) => {
    trashTrack(deps, c.req.param('id'))
    return c.json({ ok: true })
  })
  r.post('/library/rescan', (c) => {
    if (library.scanning) return c.json({ started: false, scanning: true })
    void library.scan().catch((e) => console.error('library scan failed:', e instanceof Error ? e.message : e))
    return c.json({ started: true, scanning: true })
  })

  // ---- presets ----

  r.get('/presets', async (c) => {
    const rows = db.select().from(presets).orderBy(presets.position).all()
    const sts = db.select().from(stations).all()
    const out = await Promise.all(
      rows.map(async (p) => {
        const on = sts.filter((s) => {
          const src = parseSource(s.source)
          return src.type === 'relay' && src.url === p.url
        })
        const counts = await Promise.all(on.map((s) => icecast.listeners(s.id)))
        return { ...p, listeners: counts.reduce<number>((a, n) => a + (n ?? 0), 0) }
      }),
    )
    return c.json({ presets: out })
  })

  r.post('/presets', async (c) => {
    const body = presetBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body', 'Expected {name, description?, url}')
    parseExternalUrl(body.data.url)
    const position =
      (db
        .select({ n: sql<number>`coalesce(max(${presets.position}), 0)` })
        .from(presets)
        .get()?.n ?? 0) + 1
    const row = db
      .insert(presets)
      .values({ id: newId(), ...body.data, position })
      .returning()
      .get()
    return c.json(row, 201)
  })

  r.put('/presets/:id', async (c) => {
    const body = presetBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw badRequest('invalid_body')
    parseExternalUrl(body.data.url)
    const row = db
      .update(presets)
      .set(body.data)
      .where(eq(presets.id, c.req.param('id')))
      .returning()
      .get()
    if (!row) throw notFound('Preset not found')
    return c.json(row)
  })

  r.delete('/presets/:id', (c) => {
    db.delete(presets)
      .where(eq(presets.id, c.req.param('id')))
      .run()
    return c.json({ ok: true })
  })

  r.post('/presets/check', async (c) => {
    const body = z.object({ url: z.string().max(2000) }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      // no url: the health check of every preset, in the background
      void checkAllPresets(db, deps.presetProbe)
      return c.json({ started: true }, 202)
    }
    return c.json(await checkReachable(body.data.url, { resolver: deps.resolver, transport: deps.transport }))
  })

  r.post('/presets/:id/check', async (c) => {
    const row = await checkPreset(db, c.req.param('id'), deps.presetProbe)
    if (!row) throw notFound('Preset not found')
    return c.json({ id: row.id, status: row.status, failCount: row.failCount, checkedAt: row.checkedAt })
  })

  // ---- server ----

  r.get('/server', async (c) => {
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    const since = dayStart.toISOString()
    const today = db
      .select({
        n: sql<number>`count(*)`,
        skipped: sql<number>`coalesce(sum(case when ${messages.status} = 'skipped' then 1 else 0 end), 0)`,
      })
      .from(messages)
      .where(gte(messages.createdAt, since))
      .get()
    let engineUp = false
    let live: string[] = []
    try {
      live = await engine.list()
      engineUp = true
    } catch {
      // engine down
    }
    const allSt = db.select().from(stations).all()
    const listeners = engineUp
      ? (await Promise.all(allSt.map((s) => icecast.listeners(s.id)))).reduce<number>((a, n) => a + (n ?? 0), 0)
      : 0
    const userCount = db.select({ n: sql<number>`count(*)` }).from(users).get()?.n ?? 0
    const active =
      db
        .select({ n: sql<number>`count(*)` })
        .from(users)
        .where(and(isNull(users.disabledAt)))
        .get()?.n ?? 0
    return c.json({
      engine: { up: engineUp, stations: live.length },
      listeners,
      publicUrl: config.publicUrl,
      messagesToday: today?.n ?? 0,
      skippedToday: today?.skipped ?? 0,
      users: userCount,
      activeUsers: active,
      version: '0.1.0',
    })
  })

  r.post('/engine/restart', async (c) => {
    try {
      await engine.restart()
    } catch (e) {
      throw new HttpError(503, 'engine_unavailable', e instanceof Error ? e.message : 'engine unavailable')
    }
    return c.json({ ok: true })
  })

  r.get('/backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-'))
    const file = join(dir, 'radio.db')
    try {
      await db.$client.backup(file)
      const buf = readFileSync(file)
      return new Response(buf, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="agent-radio-${new Date().toISOString().slice(0, 10)}.db"`,
          'Cache-Control': 'no-store',
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  return r
}
