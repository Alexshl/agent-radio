// ffprobe / ffmpeg for files agents upload (/api/play). Behind an interface so tests do not need the binaries.
import { spawn } from 'node:child_process'

export interface ProbeResult {
  durationSec: number
  hasAudio: boolean
}

export interface MediaTools {
  probe(file: string): Promise<ProbeResult>
  // intro (optional mp3/wav clip) + `input`, loudness-normalised (about -14 LUFS), 44.1k stereo mp3 at `bitrateK`
  makeTrack(p: { input: string; intro: string | null; out: string; bitrateK?: number }): Promise<void>
}

// Demuxers an upload may use (mp3, wav, flac, ogg/opus, m4a/mp4/mov, aac): nothing else is probed or decoded, whatever the file claims to be.
export const INPUT_FORMATS = 'mp3,wav,flac,ogg,mov,mp4,m4a,aac'
const SAFE_INPUT = ['-protocol_whitelist', 'file', '-format_whitelist', INPUT_FORMATS]
export const PROBE_TIMEOUT_MS = 20_000
export const FFMPEG_TIMEOUT_MS = 120_000

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // a stuck or hostile file cannot hold the process for long: SIGKILL at the deadline
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL' })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => {
      out += d
    })
    p.stderr.on('data', (d) => {
      err = (err + d).slice(-500)
    })
    p.on('error', reject)
    // killed at the deadline: do not wait for pipes that a grandchild may still hold open
    p.on('exit', (_code, signal) => {
      if (signal) reject(new Error(`${bin} killed (${signal}, timeout ${timeoutMs} ms)`))
    })
    p.on('close', (code, signal) =>
      code === 0
        ? resolve(out)
        : reject(new Error(signal ? `${bin} killed (${signal}, timeout ${timeoutMs} ms)` : `${bin} exited with ${code}: ${err}`)),
    )
  })
}

export class FfmpegMedia implements MediaTools {
  constructor(
    private ffmpeg = 'ffmpeg',
    private ffprobe = 'ffprobe',
    private timeouts = { probe: PROBE_TIMEOUT_MS, ffmpeg: FFMPEG_TIMEOUT_MS },
  ) {}

  async probe(file: string): Promise<ProbeResult> {
    const out = await run(
      this.ffprobe,
      ['-v', 'error', ...SAFE_INPUT, '-print_format', 'json', '-show_format', '-show_streams', file],
      this.timeouts.probe,
    )
    const j = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type?: string; duration?: string }[] }
    const audio = (j.streams ?? []).filter((s) => s.codec_type === 'audio')
    const d = Number(j.format?.duration ?? audio[0]?.duration ?? 0)
    return { durationSec: Number.isFinite(d) ? d : 0, hasAudio: audio.length > 0 }
  }

  async makeTrack(p: { input: string; intro: string | null; out: string; bitrateK?: number }): Promise<void> {
    const norm = 'loudnorm=I=-14:TP=-1.0:LRA=15,aresample=44100,aformat=channel_layouts=stereo'
    const br = `${p.bitrateK ?? 192}k`
    const args = ['-hide_banner', '-loglevel', 'error', '-y']
    if (p.intro) {
      args.push(
        ...SAFE_INPUT,
        '-i',
        p.intro,
        ...SAFE_INPUT,
        '-i',
        p.input,
        '-filter_complex',
        `[0:a]aresample=44100,aformat=channel_layouts=stereo[i];[1:a]${norm}[t];[i][t]concat=n=2:v=0:a=1[o]`,
        '-map',
        '[o]',
      )
    } else {
      args.push(...SAFE_INPUT, '-i', p.input, '-map', '0:a:0', '-af', norm)
    }
    args.push('-vn', '-ar', '44100', '-ac', '2', '-b:a', br, p.out)
    await run(this.ffmpeg, args, this.timeouts.ffmpeg)
  }
}
