import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config'
import { openDb } from './db/client'
import { SUMMARY_LANGS } from './lang'
import { SecretStore } from './lib/secrets'
import { TtsRegistry, TtsService, applyTempo } from './tts'
import { AzureProvider } from './tts/azure'
import { GeminiProvider, parseAudioMime } from './tts/gemini'
import { OpenAiProvider } from './tts/openai'
import { lengthScaleArgs } from './tts/piper'
import { addUser, login, setup } from './test-utils'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'tts-')), 'speech')

describe('speech rate', () => {
  it('piper: --length-scale = the voice default / rate; nothing at 1x', () => {
    const model = join(mkdtempSync(join(tmpdir(), 'pm-')), 'v.onnx')
    writeFileSync(`${model}.json`, JSON.stringify({ inference: { length_scale: 1.2 } }))
    expect(lengthScaleArgs(model, undefined)).toEqual([])
    expect(lengthScaleArgs(model, 1)).toEqual([])
    expect(lengthScaleArgs(model, 1.5)).toEqual(['--length-scale', '0.8'])
    expect(lengthScaleArgs('/missing/v.onnx', 1.25)).toEqual(['--length-scale', '0.8'])
  })

  it('azure: prosody rate in the SSML only when not 1x', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('MP3'))
    const p = new AzureProvider(async () => ({ key: 'K', region: 'r' }), fetchMock as unknown as typeof fetch)
    await p.synthesize({ text: 'Hi', voice: 'uk-UA-OstapNeural', lang: 'uk', rate: 1.25 }, tmp())
    await p.synthesize({ text: 'Hi', voice: 'uk-UA-OstapNeural', lang: 'uk', rate: 0.9 }, tmp())
    await p.synthesize({ text: 'Hi', voice: 'uk-UA-OstapNeural', lang: 'uk', rate: 1 }, tmp())
    const bodies = fetchMock.mock.calls.map((c) => c[1].body as string)
    expect(bodies[0]).toContain('<prosody rate="+25%">Hi</prosody>')
    expect(bodies[1]).toContain('<prosody rate="-10%">Hi</prosody>')
    expect(bodies[2]).not.toContain('prosody')
  })

  it('openai: speed parameter only when not 1x', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('MP3'))
    const p = new OpenAiProvider(async () => ({ key: 'k', model: 'm' }), fetchMock as unknown as typeof fetch)
    await p.synthesize({ text: 'x', voice: 'alloy', lang: 'uk', rate: 1.3 }, tmp())
    await p.synthesize({ text: 'x', voice: 'alloy', lang: 'uk' }, tmp())
    const body = (i: number) => JSON.parse(fetchMock.mock.calls[i]?.[1]?.body as string)
    expect(body(0).speed).toBe(1.3)
    expect(body(1).speed).toBeUndefined()
  })

  it('atempo fallback for providers without a native rate', async () => {
    const run = vi.fn(async () => {})
    expect(await applyTempo('/w/s.wav', 1.25, false, '/w/s', run)).toBe('/w/s-tempo.wav')
    expect(run).toHaveBeenCalledWith(['-i', '/w/s.wav', '-af', 'atempo=1.25', '/w/s-tempo.wav'])
    expect(await applyTempo('/w/s.wav', 1.25, true, '/w/s', run)).toBe('/w/s.wav')
    expect(await applyTempo('/w/s.wav', 1, false, '/w/s', run)).toBe('/w/s.wav')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('cloud providers (fetch mocked)', () => {
  it('azure: SSML with the voice, key header, region host; escapes the text', async () => {
    const fetchMock = vi.fn(async () => new Response('MP3DATA'))
    const p = new AzureProvider(async () => ({ key: 'K', region: 'westeurope' }), fetchMock as unknown as typeof fetch)
    const out = await p.synthesize({ text: 'Tom & <Jerry>', voice: 'uk-UA-OstapNeural', lang: 'uk' }, tmp())
    expect(out.endsWith('.mp3')).toBe(true)
    expect(readFileSync(out, 'utf8')).toBe('MP3DATA')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1')
    expect((init.headers as Record<string, string>)['Ocp-Apim-Subscription-Key']).toBe('K')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/ssml+xml')
    expect(init.body).toContain('<voice name="uk-UA-OstapNeural">Tom &amp; &lt;Jerry&gt;</voice>')
    expect(init.body).toContain('xml:lang="uk-UA"')
  })

  it('azure: an error status throws', async () => {
    const p = new AzureProvider(
      async () => ({ key: 'K', region: 'r1' }),
      (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch,
    )
    await expect(p.synthesize({ text: 'x', voice: null, lang: 'uk' }, tmp())).rejects.toThrow(/401/)
  })

  it('openai: model, voice, input, mp3, bearer key', async () => {
    const fetchMock = vi.fn(async () => new Response('MP3'))
    const p = new OpenAiProvider(async () => ({ key: 'sk-1', model: 'gpt-4o-mini-tts' }), fetchMock as unknown as typeof fetch)
    const out = await p.synthesize({ text: 'Привіт', voice: 'alloy', lang: 'uk' }, tmp())
    expect(readFileSync(out, 'utf8')).toBe('MP3')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/audio/speech')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-1')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: 'Привіт', response_format: 'mp3' })
  })

  it('gemini: generateContent with AUDIO modality and voice; PCM becomes a WAV', async () => {
    const pcm = Buffer.from([1, 2, 3, 4])
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { data: pcm.toString('base64'), mimeType: 'audio/L16;rate=24000' } }] } }],
          }),
        ),
    )
    const p = new GeminiProvider(async () => ({ key: 'g-key', model: 'gemini-3.8-flash-tts' }), fetchMock as unknown as typeof fetch)
    const out = await p.synthesize({ text: 'Hello', voice: 'Kore', lang: 'en' }, tmp())
    const wav = readFileSync(out)
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(24000)
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key')
    const body = JSON.parse(init.body as string)
    expect(body.generationConfig.responseModalities).toEqual(['AUDIO'])
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore')
    expect(body.contents[0].parts[0].text).toBe('Hello')
  })

  it('gemini: takes the sample rate from the mimeType, joins all parts and drops an odd trailing byte', async () => {
    const part = (b: number[], mimeType?: string) => ({ inlineData: { data: Buffer.from(b).toString('base64'), mimeType } })
    const fetchMock = async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  part([1, 2, 3, 4], 'audio/L16;codec=pcm;rate=16000'),
                  { text: 'x' },
                  part([5, 6, 7], 'audio/L16;codec=pcm;rate=16000'),
                ],
              },
            },
          ],
        }),
      )
    const p = new GeminiProvider(async () => ({ key: 'k', model: 'm' }), fetchMock as unknown as typeof fetch)
    const wav = readFileSync(await p.synthesize({ text: 'x', voice: null, lang: 'uk' }, tmp()))
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt32LE(28)).toBe(32000)
    expect(wav.readUInt32LE(40)).toBe(6)
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('parseAudioMime: rate and format', () => {
    expect(parseAudioMime('audio/L16;codec=pcm;rate=24000')).toEqual({ pcm: true, rate: 24000, ext: 'wav' })
    expect(parseAudioMime('audio/L16; rate=22050')).toMatchObject({ pcm: true, rate: 22050 })
    expect(parseAudioMime(undefined)).toMatchObject({ pcm: true, rate: 24000 })
    expect(parseAudioMime('audio/pcm;rate=999999')).toMatchObject({ rate: 24000 })
    expect(parseAudioMime('audio/mpeg')).toMatchObject({ pcm: false, ext: 'mp3' })
  })

  it('gemini: a response without audio throws', async () => {
    const p = new GeminiProvider(async () => ({ key: 'k', model: 'm' }), (async () => new Response('{}')) as unknown as typeof fetch)
    await expect(p.synthesize({ text: 'x', voice: null, lang: 'uk' }, tmp())).rejects.toThrow(/no audio/)
  })
})

function service() {
  const db = openDb(':memory:')
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'ar-')), APP_SECRET: 's' })
  const secrets = new SecretStore(db, () => 's')
  const registry = new TtsRegistry(db, config, secrets)
  return { db, registry, secrets, svc: new TtsService(registry, config, async () => '/nope') }
}

describe('provider choice and fallback', () => {
  it('uses the chosen cloud voice when the provider is configured', async () => {
    const { registry, secrets, svc } = service()
    await secrets.put('tts.azure.key', 'k')
    const azure = vi.spyOn(registry.provider('azure'), 'synthesize').mockResolvedValue('/a.mp3')
    const piper = vi.spyOn(registry.piper, 'synthesize').mockResolvedValue('/p.wav')
    expect(await svc.synthesize({ text: 'x', voice: 'azure:uk-UA-PolinaNeural', lang: 'uk' }, 'out')).toBe('/a.mp3')
    expect(azure).toHaveBeenCalledWith({ text: 'x', voice: 'uk-UA-PolinaNeural', lang: 'uk' }, 'out')
    expect(piper).not.toHaveBeenCalled()
  })

  it('a provider that is not configured is replaced by the default (piper)', async () => {
    const { registry, svc } = service()
    const piper = vi.spyOn(registry.piper, 'synthesize').mockResolvedValue('/p.wav')
    await svc.synthesize({ text: 'x', voice: 'openai:alloy', lang: 'uk' }, 'out')
    expect(piper.mock.calls[0]?.[0].voice).toBe('uk_UA-mykyta-high')
  })

  it('a failing cloud provider falls back to piper', async () => {
    const { registry, secrets, svc } = service()
    await secrets.put('tts.azure.key', 'k')
    vi.spyOn(registry.provider('azure'), 'synthesize').mockRejectedValue(new Error('azure down'))
    const piper = vi.spyOn(registry.piper, 'synthesize').mockResolvedValue('/p.wav')
    expect(await svc.synthesize({ text: 'x', voice: 'azure:uk-UA-OstapNeural', lang: 'ru' }, 'out')).toBe('/p.wav')
    expect(piper.mock.calls[0]?.[0].voice).toBe('ru_RU-dmitri-medium')
  })

  it('fails only when the fallback fails too', async () => {
    const { registry, secrets, svc } = service()
    await secrets.put('tts.azure.key', 'k')
    vi.spyOn(registry.provider('azure'), 'synthesize').mockRejectedValue(new Error('azure down'))
    vi.spyOn(registry.piper, 'synthesize').mockRejectedValue(new Error('piper down'))
    await expect(svc.synthesize({ text: 'x', voice: 'azure:uk-UA-OstapNeural', lang: 'uk' }, 'out')).rejects.toThrow('piper down')
  })

  it('a disabled voice is not offered and not chosen', async () => {
    const { registry, secrets } = service()
    await secrets.put('tts.azure.key', 'k')
    expect(registry.availableVoices().some((v) => v.key === 'azure:uk-UA-OstapNeural')).toBe(true)
    registry.setVoiceEnabled('azure:uk-UA-OstapNeural', false)
    expect(registry.availableVoices().some((v) => v.key === 'azure:uk-UA-OstapNeural')).toBe(false)
    expect(registry.choose('azure:uk-UA-OstapNeural', 'uk').provider).toBe('piper')
  })
})

describe('/api/say with the cloud fallback (route level)', () => {
  it('uses the user voice, language and session phrase', async () => {
    const t = setup({ listeners: 1 })
    const { token } = await (await import('./test-utils')).userWithKey(t, 'a@x.io')
    t.db.$client.prepare("update users set lang = 'ru', voice = 'piper:ru_RU-dmitri-medium'").run()
    await t.req('/api/say', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      json: { session: 'invoa', text: 'Готово' },
      origin: null,
    })
    expect(t.makeClip).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Сессия invoa. Готово', voice: 'piper:ru_RU-dmitri-medium', lang: 'ru' }),
    )
  })

  it('a voice of another language still airs: /api/say does not fail', async () => {
    const t = setup({ listeners: 1 })
    const { token } = await (await import('./test-utils')).userWithKey(t, 'a@x.io')
    t.db.$client.prepare("update users set lang = 'lv', voice = 'piper:ru_RU-dmitri-medium'").run()
    const res = await t.req('/api/say', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      json: { session: 'invoa', text: 'Gatavs' },
      origin: null,
    })
    expect(res.status).toBe(200)
    expect(t.makeClip).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Sesija invoa. Gatavs', voice: 'piper:ru_RU-dmitri-medium', lang: 'lv' }),
    )
  })

  it('every summary language has a piper fallback voice', async () => {
    const { registry } = service()
    for (const lang of SUMMARY_LANGS) {
      expect(registry.fallback(lang).voice).toMatch(new RegExp(`^${lang}_`))
      expect(registry.defaultVoiceKey(lang)).toMatch(new RegExp(`^piper:${lang}_`))
    }
    expect(registry.piperVoices().some((v) => v.lang === 'lv')).toBe(true)
  })

  it('speakSession off: the text as is', async () => {
    const t = setup({ listeners: 1 })
    const { token } = await (await import('./test-utils')).userWithKey(t, 'a@x.io')
    t.db.$client.prepare('update users set speak_session = 0').run()
    await t.req('/api/say', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      json: { session: 'invoa', text: 'Готово' },
      origin: null,
    })
    expect(t.makeClip).toHaveBeenCalledWith(expect.objectContaining({ text: 'Готово' }))
  })

  it('admin provider test returns audio from the provider and reports failures', async () => {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    const cookie = await login(t, 'admin@x.io')
    const noKey = await t.req('/api/admin/tts/providers/openai/test', { method: 'POST', cookie, json: {} })
    expect(noKey.status).toBe(400)
    await t.req('/api/admin/tts/providers/openai', { method: 'PUT', cookie, json: { key: 'sk-x' } })
    const spy = vi.spyOn(t.registry, 'provider').mockReturnValue({
      name: 'openai',
      synthesize: async (_r, base) => {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(`${base}.mp3`, 'AUDIO')
        return `${base}.mp3`
      },
    })
    const ok = (await (await t.req('/api/admin/tts/providers/openai/test', { method: 'POST', cookie, json: {} })).json()) as {
      ok: boolean
      audio: string
    }
    expect(ok.ok).toBe(true)
    expect(Buffer.from(ok.audio, 'base64').toString()).toBe('AUDIO')
    spy.mockReturnValue({
      name: 'openai',
      synthesize: async () => {
        throw new Error('quota')
      },
    })
    const bad = (await (await t.req('/api/admin/tts/providers/openai/test', { method: 'POST', cookie, json: {} })).json()) as {
      ok: boolean
      error: string
    }
    expect(bad).toMatchObject({ ok: false, error: 'quota' })
  })
})

describe('Latin words for voices that drop them', () => {
  const MIXED = 'Я закоммитил PR в GitHub, deploy прошёл'
  const spy = (r: ReturnType<typeof service>['registry']) => vi.spyOn(r.piper, 'synthesize').mockResolvedValue('/p.wav')

  it('ru piper voice: Latin becomes Russian letters, the rest is untouched', async () => {
    const { registry, svc } = service()
    const piper = spy(registry)
    await svc.synthesize({ text: MIXED, voice: 'piper:ru_RU-dmitri-medium', lang: 'ru' }, 'out')
    expect(piper.mock.calls[0]?.[0].text).toBe('Я закоммитил ПР в Гитуб, деплой прошёл')
    await svc.synthesize({ text: 'OCARINA DREAM OPERA', voice: 'piper:ru_RU-dmitri-medium', lang: 'ru' }, 'out')
    expect(piper.mock.calls[1]?.[0].text).toBe('ОКАРИНА ДРИМ ОПЕРА')
  })

  it('uk piper voice: Ukrainian letters', async () => {
    const { registry, svc } = service()
    const piper = spy(registry)
    await svc.synthesize({ text: 'Я закомітив PR в GitHub, deploy пройшов', voice: 'piper:uk_UA-mykyta-high', lang: 'uk' }, 'out')
    expect(piper.mock.calls[0]?.[0].text).toBe('Я закомітив ПР в Гітуб, деплой пройшов')
    await svc.synthesize({ text: 'Eddy Smith', voice: 'piper:uk_UA-mykyta-high', lang: 'uk' }, 'out')
    expect(piper.mock.calls[1]?.[0].text).toBe('Едді Сміт')
  })

  it('the language of the voice decides, not the message language', async () => {
    const { registry, svc } = service()
    const piper = spy(registry)
    await svc.synthesize({ text: 'Hello Bob', voice: 'piper:en_US-lessac-medium', lang: 'ru' }, 'out')
    expect(piper.mock.calls[0]?.[0].text).toBe('Hello Bob')
  })

  it('a cloud voice reads Latin itself: the text is unchanged', async () => {
    const { registry, secrets, svc } = service()
    await secrets.put('tts.azure.key', 'k')
    const azure = vi.spyOn(registry.provider('azure'), 'synthesize').mockResolvedValue('/a.mp3')
    await svc.synthesize({ text: MIXED, voice: 'azure:ru-RU-SvetlanaNeural', lang: 'ru' }, 'out')
    expect(azure.mock.calls[0]?.[0].text).toBe(MIXED)
  })

  it('silero ru (local sidecar) gets Cyrillic only', async () => {
    const { registry, svc } = service()
    const info = {
      id: 'silero',
      label: 'Silero',
      lang: 'ru',
      license: 'x',
      status: 'ready',
      error: '',
      nativeRate: true,
      voices: [{ id: 'kseniya', label: 'Ksenia', lang: 'ru' }],
    }
    vi.spyOn(registry.local, 'engines').mockResolvedValue([info] as never)
    await registry.refreshLocal()
    registry.setVoiceEnabled('local:silero', true)
    const local = vi.spyOn(registry.local, 'synthesize').mockResolvedValue('/l.wav')
    await svc.synthesize({ text: 'OCARINA DREAM OPERA — The enduring flame', voice: 'local:silero/kseniya', lang: 'ru' }, 'out')
    const text = local.mock.calls[0]?.[0].text as string
    expect(text).not.toMatch(/[A-Za-z]/)
    expect(text).toMatch(/^ОКАРИНА ДРИМ ОПЕРА — Зе /)
  })
})
