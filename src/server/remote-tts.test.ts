import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config'
import { openDb } from './db/client'
import { SecretStore } from './lib/secrets'
import { setSetting } from './lib/settings'
import { TtsService } from './tts'
import { LocalProvider } from './tts/local'
import { TtsRegistry } from './tts/registry'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'rt-')), 'speech')
const engine = (id: string, lang: string, voice: string) => ({
  id,
  label: id.toUpperCase(),
  lang,
  license: 'x',
  status: 'ready',
  error: '',
  nativeRate: true,
  voices: [{ id: voice, label: voice, lang }],
})
const REMOTE = { engines: [engine('xtts', 'ru', 'anna')] }
const LOCAL = { engines: [engine('silero', 'ru', 'kseniya')] }

function mockFetch(data: unknown, synth: () => Response = () => new Response('WAV', { headers: { 'x-rate-native': '1' } })) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/voices')) return Response.json(data)
    if (u.endsWith('/synthesize')) return synth()
    return new Response('nope', { status: 404 })
  })
}

const headers = (c?: [unknown, RequestInit?]) => (c?.[1]?.headers ?? {}) as Record<string, string>

describe('remote provider (mock GPU server)', () => {
  it('sends the Bearer token on both calls and lang in the body', async () => {
    const f = mockFetch(REMOTE)
    const p = new LocalProvider('remote', 'http://gpu:8795', 'sekret', f as unknown as typeof fetch)
    expect(await p.engines()).toHaveLength(1)
    const file = await p.synthesize({ text: 'Привет', voice: 'xtts/anna', lang: 'ru', rate: 1.1 }, tmp())
    expect(readFileSync(file, 'utf8')).toBe('WAV')
    const [voices, synth] = f.mock.calls
    expect(headers(voices).Authorization).toBe('Bearer sekret')
    expect(headers(synth).Authorization).toBe('Bearer sekret')
    expect(JSON.parse(String(synth?.[1]?.body))).toEqual({ engine: 'xtts', voice: 'anna', text: 'Привет', rate: 1.1, lang: 'ru' })
  })

  it('no token: no Authorization header', async () => {
    const f = mockFetch(REMOTE)
    await new LocalProvider('remote', 'http://gpu', null, f as unknown as typeof fetch).engines()
    expect(headers(f.mock.calls[0]).Authorization).toBeUndefined()
  })
})

function service(env: Record<string, string>) {
  const db = openDb(':memory:')
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'ar-')), APP_SECRET: 's', ...env })
  const registry = new TtsRegistry(db, config, new SecretStore(db, () => 's'))
  return { db, registry, svc: new TtsService(registry, config, async () => '/nope') }
}
const ENV = { TTS_LOCAL_URL: 'http://tts-local:8795', TTS_REMOTE_URL: 'http://gpu:8795', TTS_REMOTE_TOKEN: 't' }
const setFetch = (p: LocalProvider, f: unknown) => {
  ;(p as unknown as { fetchImpl: unknown }).fetchImpl = f
}

describe('registry with remote voices', () => {
  it('lists remote voices under provider remote, apart from the local ones', async () => {
    const t = service(ENV)
    setFetch(t.registry.remote, mockFetch(REMOTE))
    setFetch(t.registry.local, mockFetch(LOCAL))
    await t.registry.refreshRemote()
    await t.registry.refreshLocal()
    expect(t.registry.isConfigured('remote')).toBe(true)
    expect(t.registry.allVoices().filter((v) => v.provider === 'remote')).toEqual([
      { key: 'remote:xtts/anna', provider: 'remote', id: 'xtts/anna', label: 'XTTS · anna', lang: 'ru' },
    ])
    expect(t.registry.localVoices().map((v) => v.key)).toEqual(['local:silero/kseniya'])
    setSetting(t.db, 'defaultVoiceByLang', { ru: 'remote:xtts/anna' })
    expect(t.registry.defaultVoiceKey('ru')).toBe('remote:xtts/anna')
    expect(t.registry.choose('remote:xtts/anna', 'ru')).toEqual({ provider: 'remote', voice: 'xtts/anna' })
  })

  it('an unreachable server lists nothing', async () => {
    const t = service(ENV)
    setFetch(t.registry.remote, async () => {
      throw new Error('EHOSTUNREACH')
    })
    expect(await t.registry.refreshRemote()).toBeNull()
    expect(t.registry.remoteVoices()).toEqual([])
    expect(t.registry.isConfigured('remote')).toBe(false)
  })

  it('not configured: nothing changes', () => {
    const t = service({})
    expect(t.registry.remote.enabled).toBe(false)
    expect(t.registry.remoteVoices()).toEqual([])
    expect(t.registry.isConfigured('remote')).toBe(false)
    expect(t.registry.defaultVoiceKey('uk')).toBe('piper:uk_UA-mykyta-high')
  })
})

describe('remote failure falls back', () => {
  async function ready() {
    const t = service(ENV)
    setFetch(t.registry.remote, mockFetch(REMOTE))
    setFetch(t.registry.local, mockFetch(LOCAL))
    await t.registry.refreshRemote()
    await t.registry.refreshLocal()
    t.registry.setVoiceEnabled('local:silero', true)
    return t
  }

  it('speaks with the global default of another provider when the language default is the remote voice', async () => {
    const t = await ready()
    setSetting(t.db, 'defaultVoiceByLang', { ru: 'remote:xtts/anna' })
    setSetting(t.db, 'defaultVoice', 'local:silero/kseniya')
    vi.spyOn(t.registry.remote, 'synthesize').mockRejectedValue(new Error('timeout'))
    const local = vi.spyOn(t.registry.local, 'synthesize').mockResolvedValue('/l.wav')
    const piper = vi.spyOn(t.registry.piper, 'synthesize').mockResolvedValue('/p.wav')
    expect(await t.svc.synthesize({ text: 'x', voice: 'remote:xtts/anna', lang: 'ru' }, 'out')).toBe('/l.wav')
    expect(local.mock.calls[0]?.[0].voice).toBe('silero/kseniya')
    expect(piper).not.toHaveBeenCalled()
  })

  it('speaks with the per-language default of another provider', async () => {
    const t = await ready()
    setSetting(t.db, 'defaultVoiceByLang', { ru: 'local:silero/kseniya' })
    vi.spyOn(t.registry.remote, 'synthesize').mockRejectedValue(new Error('down'))
    const local = vi.spyOn(t.registry.local, 'synthesize').mockResolvedValue('/l.wav')
    expect(await t.svc.synthesize({ text: 'x', voice: 'remote:xtts/anna', lang: 'ru' }, 'out')).toBe('/l.wav')
    expect(local).toHaveBeenCalled()
  })

  it('falls to piper when no other default exists or it fails too', async () => {
    const t = await ready()
    setSetting(t.db, 'defaultVoiceByLang', { ru: 'remote:xtts/anna' })
    vi.spyOn(t.registry.remote, 'synthesize').mockRejectedValue(new Error('down'))
    const piper = vi.spyOn(t.registry.piper, 'synthesize').mockResolvedValue('/p.wav')
    expect(await t.svc.synthesize({ text: 'x', voice: 'remote:xtts/anna', lang: 'ru' }, 'out')).toBe('/p.wav')
    setSetting(t.db, 'defaultVoiceByLang', { ru: 'local:silero/kseniya' })
    vi.spyOn(t.registry.local, 'synthesize').mockRejectedValue(new Error('local down'))
    expect(await t.svc.synthesize({ text: 'x', voice: 'remote:xtts/anna', lang: 'ru' }, 'out')).toBe('/p.wav')
    expect(piper).toHaveBeenCalledTimes(2)
  })
})
