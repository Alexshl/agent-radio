import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { newId } from '../lib/ids'
import { prepareSpeech, stressTarget } from './pronunciation'
import { latinTarget, latinToCyrillic } from './translit'
import { loadEntries } from './pronunciation-store'
import type { TtsRegistry } from './registry'
import type { ProviderId } from './voices'

export type { TtsProvider, TtsRequest } from './types'
export { TtsRegistry } from './registry'

export function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 120_000,
      killSignal: 'SIGKILL',
    })
    let err = ''
    p.stderr.on('data', (d) => {
      err = (err + d).slice(-500)
    })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${err}`))))
  })
}

// Two soft sine notes, generated once with ffmpeg.
export async function ensureChime(dataDir: string): Promise<string> {
  const file = join(dataDir, 'chime.wav')
  if (existsSync(file)) return file
  mkdirSync(dataDir, { recursive: true })
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=0.25:sample_rate=44100',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1320:duration=0.45:sample_rate=44100',
    '-filter_complex',
    '[0:a]afade=t=out:st=0.15:d=0.1,volume=0.35[a];[1:a]afade=t=out:st=0.1:d=0.35,volume=0.35[b];[a][b]concat=n=2:v=0:a=1,aformat=channel_layouts=stereo,apad=pad_dur=0.25',
    '-ar',
    '44100',
    file,
  ])
  return file
}

// Speech post-processing, for every provider: cut leading / trailing silence and low-level noise (-45 dB, 150 ms kept), a 150 ms fade-out
// BEFORE loudnorm (so a noisy tail is never amplified), then loudness normalisation and 200 ms of digital silence at the end.
// The tail is handled by reversing the stream (silenceremove only trims the start).
const TRIM = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15'
// apad before loudnorm: loudnorm needs about 3 s of input, a shorter clip (a 2 s song intro) came out ~20 dB too quiet
export const VOICE_CHAIN = `${TRIM},areverse,${TRIM},afade=t=in:d=0.15,areverse,apad=whole_dur=3.2,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100,aformat=channel_layouts=stereo,apad=pad_dur=0.2`

export interface ClipRequest {
  text: string
  // voice key '<provider>:<id>' (a bare id is a piper voice); null = the server default
  voice: string | null
  lang: string
  chime: boolean
  rate?: number
  // whose pronunciation dictionary applies (null/undefined = the global one only)
  userId?: string
}

// Providers without a native speed option (gemini, ...): pitch-preserving ffmpeg atempo.
export async function applyTempo(file: string, rate: number | undefined, native: boolean, outBase: string, run = ffmpeg): Promise<string> {
  if (native || !rate || rate === 1) return file
  const out = `${outBase}-tempo.wav`
  await run(['-i', file, '-af', `atempo=${Math.min(2, Math.max(0.5, rate))}`, out])
  return out
}

export class TtsService {
  constructor(
    private registry: TtsRegistry,
    private config: Config,
    private chimeFile: () => Promise<string>,
    private db?: Db,
  ) {}

  warmUp() {
    const c = this.registry.fallback(this.config.ttsLang)
    return this.registry.piper.warmUp({ voice: c.voice, lang: this.config.ttsLang })
  }

  // Speech file of the chosen provider; a failing cloud provider falls back to piper (an error only when that fails too).
  async synthesize(
    req: { text: string; voice: string | null; lang: string; rate?: number; userId?: string },
    outBase: string,
  ): Promise<string> {
    const choice = this.registry.choose(req.voice, req.lang)
    // pronunciation dictionary + the stress syntax of the chosen engine (one place for every caller)
    const entries = this.db ? loadEntries(this.db, req.userId) : []
    // a voice that drops Latin words gets them in Cyrillic (by the language of the voice, not of the interface)
    const voiceLang = (c: { provider: ProviderId; voice: string | null }) => {
      const info = c.voice ? this.registry.findVoice?.(`${c.provider}:${c.voice}`) : undefined
      return info && info.lang !== 'multi' ? info.lang : req.lang
    }
    const speak = (target: ReturnType<typeof stressTarget>, c: { provider: ProviderId; voice: string | null }) => {
      const text = prepareSpeech(req.text, entries, req.lang, target)
      const to = latinTarget(c.provider, c.voice, voiceLang(c))
      return to ? latinToCyrillic(text, to) : text
    }
    try {
      const provider = this.registry.provider(choice.provider)
      const text = speak(stressTarget(choice.provider, choice.voice), choice)
      const file = await provider.synthesize({ text, voice: choice.voice, lang: req.lang, rate: req.rate }, outBase)
      return await applyTempo(file, req.rate, provider.nativeRate === true, outBase)
    } catch (e) {
      if (choice.provider === 'piper') throw e
      console.error(`tts ${choice.provider} failed, falling back to piper:`, e instanceof Error ? e.message : e)
      const fb = this.registry.fallback(req.lang)
      return await this.registry
        .provider('piper')
        .synthesize({ text: speak('plain', fb), voice: fb.voice, lang: req.lang, rate: req.rate }, outBase)
    }
  }

  // text -> mp3 clip (chime + loudness-normalised speech, 44.1k stereo 128k) in <shared>/clips; returns the file path.
  async makeClip(req: ClipRequest): Promise<string> {
    const work = await mkdtemp(join(tmpdir(), 'tts-'))
    try {
      const speech = await this.synthesize(req, join(work, 'speech'))
      const dir = join(this.config.sharedDir, 'clips')
      mkdirSync(dir, { recursive: true })
      const out = join(dir, `${newId()}.mp3`)
      const voiceChain = VOICE_CHAIN
      if (req.chime) {
        const chime = await this.chimeFile()
        await ffmpeg([
          '-i',
          chime,
          '-i',
          speech,
          '-filter_complex',
          `[1:a]${voiceChain}[v];[0:a][v]concat=n=2:v=0:a=1[o]`,
          '-map',
          '[o]',
          '-ar',
          '44100',
          '-ac',
          '2',
          '-b:a',
          '128k',
          out,
        ])
      } else {
        await ffmpeg(['-i', speech, '-af', voiceChain, '-ar', '44100', '-ac', '2', '-b:a', '128k', out])
      }
      return out
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
}
