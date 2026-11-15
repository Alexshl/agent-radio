// Local neural voices: the `tts-local` sidecar (python, CPU) behind a small HTTP API (GET /voices, POST /synthesize -> WAV).
// A voice id is '<engine>/<voice>' (e.g. 'styletts2/Денис Денисенко'); the sidecar loads its models on first start, so an engine is
// only usable when its status is 'ready'.
import { writeFileSync } from 'node:fs'
import { applyTempo } from './index'
import type { TtsProvider, TtsRequest } from './types'

export interface LocalEngineInfo {
  id: string
  label: string
  lang: string
  license: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  nativeRate: boolean
  voices: { id: string; label: string; lang: string }[]
}

export const SYNTH_TIMEOUT_MS = 240_000

export class LocalProvider implements TtsProvider {
  readonly name = 'local'
  // the provider applies the rate itself (natively in the engine or with atempo): the service must not do it twice
  readonly nativeRate = true

  constructor(
    private baseUrl: string | null,
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = SYNTH_TIMEOUT_MS,
  ) {}

  get enabled(): boolean {
    return !!this.baseUrl
  }

  // null = the sidecar is not reachable
  async engines(): Promise<LocalEngineInfo[] | null> {
    if (!this.baseUrl) return null
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/voices`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return null
      return ((await res.json()) as { engines: LocalEngineInfo[] }).engines
    } catch {
      return null
    }
  }

  async synthesize(req: TtsRequest, outBase: string): Promise<string> {
    if (!this.baseUrl) throw new Error('local voices are not configured')
    const voice = req.voice ?? ''
    const i = voice.indexOf('/')
    if (i <= 0) throw new Error(`invalid local voice id: ${voice}`)
    const engine = voice.slice(0, i)
    const rate = req.rate && req.rate !== 1 ? req.rate : 1
    const res = await this.fetchImpl(`${this.baseUrl}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine, voice: voice.slice(i + 1), text: req.text, rate }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw new Error(`tts-local ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const file = `${outBase}.wav`
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    return await applyTempo(file, rate, res.headers.get('x-rate-native') === '1', outBase)
  }
}
