import { writeFile } from 'node:fs/promises'
import type { TtsProvider, TtsRequest } from './types'

// 16-bit mono PCM -> WAV
export function pcmToWav(pcm: Buffer, sampleRate = 24_000): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[]
}

// "audio/L16;codec=pcm;rate=24000" -> raw 16-bit PCM at that rate. Anything else (audio/wav, audio/mpeg, ...) is a container the caller keeps as is.
export function parseAudioMime(mime: string | undefined): { pcm: boolean; rate: number; ext: string } {
  const [type = '', ...params] = (mime ?? '')
    .toLowerCase()
    .split(';')
    .map((x) => x.trim())
  const rate = Number(params.find((x) => x.startsWith('rate='))?.slice(5))
  const validRate = Number.isInteger(rate) && rate >= 8000 && rate <= 96_000 ? rate : 24_000
  if (type === '' || type === 'audio/l16' || type === 'audio/pcm' || type === 'audio/x-pcm' || type === 'audio/l16')
    return { pcm: true, rate: validRate, ext: 'wav' }
  if (type === 'audio/mpeg' || type === 'audio/mp3') return { pcm: false, rate: validRate, ext: 'mp3' }
  if (type === 'audio/ogg') return { pcm: false, rate: validRate, ext: 'ogg' }
  return { pcm: false, rate: validRate, ext: 'wav' }
}

// Gemini generateContent with responseModalities AUDIO: returns base64 PCM (16-bit mono, rate from the mimeType, 24 kHz by default),
// possibly split over several parts.
export class GeminiProvider implements TtsProvider {
  readonly name = 'gemini'
  constructor(
    private cfg: () => Promise<{ key: string; model: string }>,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async synthesize(req: TtsRequest, outBase: string): Promise<string> {
    const { key, model } = await this.cfg()
    const res = await this.fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: req.text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voice ?? 'Kore' } } },
          },
        }),
        signal: AbortSignal.timeout(60_000),
      },
    )
    if (!res.ok) throw new Error(`gemini tts: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const json = (await res.json()) as GeminiResponse
    const parts = (json.candidates?.[0]?.content?.parts ?? []).filter((p) => p.inlineData?.data)
    const first = parts[0]?.inlineData
    if (!first?.data) throw new Error('gemini tts: no audio in the response')
    const fmt = parseAudioMime(first.mimeType)
    const out = `${outBase}.${fmt.ext}`
    if (!fmt.pcm) {
      await writeFile(out, Buffer.from(first.data, 'base64'))
      return out
    }
    let pcm = Buffer.concat(parts.map((p) => Buffer.from(p.inlineData?.data ?? '', 'base64')))
    // samples are 16-bit: a stray odd byte would be played as a click / noise at the very end
    if (pcm.length % 2) pcm = pcm.subarray(0, pcm.length - 1)
    await writeFile(out, pcmToWav(pcm, fmt.rate))
    return out
  }
}
