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
// a GPU machine on the LAN may be off: a short synthesis timeout lets the message fall back to another voice soon
export const REMOTE_SYNTH_TIMEOUT_MS = 20_000
const PROBE_TIMEOUT_MS = 3000

export class LocalProvider implements TtsProvider {
  readonly name: 'local' | 'remote'
  // the provider applies the rate itself (natively in the engine or with atempo): the service must not do it twice
  readonly nativeRate = true

  constructor(
    name: 'local' | 'remote',
    private baseUrl: string | null,
    private token: string | null = null,
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = name === 'remote' ? REMOTE_SYNTH_TIMEOUT_MS : SYNTH_TIMEOUT_MS,
  ) {
    this.name = name
  }

  // the token is only ever put into this header (never logged, never returned by an API)
  private auth(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {}
  }

  get enabled(): boolean {
    return !!this.baseUrl
  }

  // null = the sidecar is not reachable
  async engines(): Promise<LocalEngineInfo[] | null> {
    if (!this.baseUrl) return null
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/voices`, { headers: this.auth(), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (!res.ok) return null
      return ((await res.json()) as { engines: LocalEngineInfo[] }).engines
    } catch {
      return null
    }
  }

  async synthesize(req: TtsRequest, outBase: string): Promise<string> {
    if (!this.baseUrl) throw new Error(`${this.name} voices are not configured`)
    const voice = req.voice ?? ''
    const i = voice.indexOf('/')
    if (i <= 0) throw new Error(`invalid ${this.name} voice id: ${voice}`)
    const engine = voice.slice(0, i)
    const rate = req.rate && req.rate !== 1 ? req.rate : 1
    const res = await this.fetchImpl(`${this.baseUrl}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.auth() },
      body: JSON.stringify({ engine, voice: voice.slice(i + 1), text: req.text, rate, lang: req.lang }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw new Error(`tts-${this.name} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const file = `${outBase}.wav`
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    return await applyTempo(file, rate, res.headers.get('x-rate-native') === '1', outBase)
  }
}
