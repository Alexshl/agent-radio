import { writeFile } from 'node:fs/promises'
import type { TtsProvider, TtsRequest } from './types'

// OpenAI /v1/audio/speech (gpt-4o-mini-tts and friends): JSON in, mp3 out.
export class OpenAiProvider implements TtsProvider {
  readonly name = 'openai'
  readonly nativeRate = true
  constructor(
    private cfg: () => Promise<{ key: string; model: string }>,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async synthesize(req: TtsRequest, outBase: string): Promise<string> {
    const { key, model } = await this.cfg()
    const res = await this.fetchImpl('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        voice: req.voice ?? 'alloy',
        input: req.text,
        response_format: 'mp3',
        ...(req.rate && req.rate !== 1 ? { speed: Math.min(4, Math.max(0.25, req.rate)) } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`openai tts: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const out = `${outBase}.mp3`
    await writeFile(out, Buffer.from(await res.arrayBuffer()))
    return out
  }
}
