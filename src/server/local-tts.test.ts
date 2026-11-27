import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalProvider } from './tts/local'
import { setup } from './test-utils'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'tl-')), 'speech')
const ENGINES = {
  engines: [
    {
      id: 'styletts2',
      label: 'StyleTTS2 Ukrainian',
      lang: 'uk',
      license: 'MIT',
      status: 'ready',
      error: '',
      nativeRate: true,
      voices: [{ id: 'Денис Денисенко', label: 'Денис Денисенко', lang: 'uk' }],
    },
    { id: 'f5', label: 'F5', lang: 'ru', license: 'Apache-2.0', status: 'loading', error: '', nativeRate: true, voices: [] },
  ],
}

function sidecar(synth: (body: Record<string, unknown>) => Response) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/voices')) return Response.json(ENGINES)
    if (u.endsWith('/synthesize')) return synth(JSON.parse(String(init?.body)))
    return new Response('nope', { status: 404 })
  })
}

describe('local provider (mock sidecar)', () => {
  it('posts engine, voice, text and rate; writes the wav; native rate is not applied twice', async () => {
    const f = sidecar(() => new Response('WAV', { headers: { 'x-rate-native': '1' } }))
    const p = new LocalProvider('local', 'http://tts-local:8795', null, f as unknown as typeof fetch)
    const base = tmp()
    const file = await p.synthesize({ text: 'Привіт', voice: 'styletts2/Денис Денисенко', lang: 'uk', rate: 1.2 }, base)
    expect(file).toBe(`${base}.wav`)
    expect(readFileSync(file, 'utf8')).toBe('WAV')
    const call = f.mock.calls[0]
    expect(call?.[0]).toBe('http://tts-local:8795/synthesize')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      engine: 'styletts2',
      voice: 'Денис Денисенко',
      text: 'Привіт',
      rate: 1.2,
      lang: 'uk',
    })
  })

  it('errors from the sidecar and bad voice ids are thrown (the service then falls back to piper)', async () => {
    const f = sidecar(() => new Response('engine loading', { status: 503 }))
    const p = new LocalProvider('local', 'http://x', null, f as unknown as typeof fetch)
    await expect(p.synthesize({ text: 'a', voice: 'styletts2/v', lang: 'uk' }, tmp())).rejects.toThrow(/503/)
    await expect(p.synthesize({ text: 'a', voice: 'novoice', lang: 'uk' }, tmp())).rejects.toThrow(/invalid local voice/)
    await expect(new LocalProvider('local', null).synthesize({ text: 'a', voice: 'e/v', lang: 'uk' }, tmp())).rejects.toThrow(
      /not configured/,
    )
  })

  it('engines() is null when the sidecar is down', async () => {
    const p = new LocalProvider('local', 'http://x', null, (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch)
    expect(await p.engines()).toBeNull()
  })
})

describe('registry with local voices', () => {
  const env = { TTS_LOCAL_URL: 'http://tts-local:8795' }

  it('lists voices of ready engines only, opt-in via the engine switch, and chooses them', async () => {
    const t = setup({ env })
    ;(t.registry.local as unknown as { fetchImpl: unknown }).fetchImpl = sidecar(() => new Response('W'))
    expect(await t.registry.refreshLocal()).toHaveLength(2)
    const key = 'local:styletts2/Денис Денисенко'
    expect(t.registry.localVoices().map((v) => v.key)).toEqual([key])
    expect(t.registry.isConfigured('local')).toBe(true)
    // off until the admin switches the engine on
    expect(t.registry.availableVoices().some((v) => v.provider === 'local')).toBe(false)
    expect(t.registry.choose(key, 'uk').provider).not.toBe('local')
    t.registry.setVoiceEnabled('local:styletts2', true)
    expect(t.registry.choose(key, 'uk')).toEqual({ provider: 'local', voice: 'styletts2/Денис Денисенко' })
    // a single voice can still be switched off
    t.registry.setVoiceEnabled(key, false)
    expect(t.registry.choose(key, 'uk').provider).not.toBe('local')
  })

  it('without a sidecar nothing is listed and the provider is not configured', () => {
    const t = setup()
    expect(t.registry.localVoices()).toEqual([])
    expect(t.registry.isConfigured('local')).toBe(false)
  })
})
