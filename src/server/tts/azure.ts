import { writeFile } from 'node:fs/promises'
import type { TtsProvider, TtsRequest } from './types'

const LOCALES: Record<string, string> = { uk: 'uk-UA', ru: 'ru-RU', en: 'en-US' }

export const xmlEscape = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c)

// 1.25 -> "+25%", 0.9 -> "-10%"; null at normal speed
export function rateSsmlPercent(rate: number | undefined): string | null {
  if (!rate || rate === 1) return null
  const pct = Math.round((rate - 1) * 100)
  return pct === 0 ? null : `${pct > 0 ? '+' : ''}${pct}%`
}

// Azure AI Speech REST: SSML in, mp3 out. Voice ids look like 'uk-UA-OstapNeural' (the locale is the first two parts).
export class AzureProvider implements TtsProvider {
  readonly name = 'azure'
  readonly nativeRate = true
  constructor(
    private cfg: () => Promise<{ key: string; region: string }>,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async synthesize(req: TtsRequest, outBase: string): Promise<string> {
    const { key, region } = await this.cfg()
    const voice = req.voice ?? 'uk-UA-OstapNeural'
    const locale = voice.split('-').slice(0, 2).join('-') || LOCALES[req.lang] || 'en-US'
    const body = rateSsmlPercent(req.rate)
      ? `<prosody rate="${rateSsmlPercent(req.rate)}">${xmlEscape(req.text)}</prosody>`
      : xmlEscape(req.text)
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${xmlEscape(voice)}">${body}</voice></speak>`
    const res = await this.fetchImpl(`https://${encodeURIComponent(region)}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
        'User-Agent': 'agent-radio',
      },
      body: ssml,
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`azure tts: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const out = `${outBase}.mp3`
    await writeFile(out, Buffer.from(await res.arrayBuffer()))
    return out
  }
}
