import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { CatalogVoice } from './piper-catalog'
import type { TtsProvider, TtsRequest } from './types'

const DEFAULT_VOICES: Record<string, string> = {
  uk: 'uk_UA-mykyta-high',
  ru: 'ru_RU-dmitri-medium',
  en: 'en_US-lessac-medium',
  de: 'de_DE-thorsten-medium',
}
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'

// 'en_GB-vctk-medium#12' = model + speaker id of a multi-speaker model
export function splitVoice(v: string): { model: string; speaker: number | null } {
  const i = v.indexOf('#')
  if (i < 0) return { model: v, speaker: null }
  const n = Number(v.slice(i + 1))
  return { model: v.slice(0, i), speaker: Number.isInteger(n) && n >= 0 ? n : null }
}

// 'uk_UA-mykyta-high' -> 'uk/uk_UA/mykyta/high/uk_UA-mykyta-high'
export function voicePath(voice: string): string {
  const m = /^([a-z]{2})_([A-Z]{2})-([a-zA-Z0-9_]+)-(x_low|low|medium|high)$/.exec(voice)
  if (!m) throw new Error(`invalid piper voice id: ${voice}`)
  return `${m[1]}/${m[1]}_${m[2]}/${m[3]}/${m[4]}/${voice}`
}

// Faster speech = shorter phonemes: --length-scale is the voice's own default (from its .onnx.json) divided by the rate.
export function lengthScaleArgs(modelPath: string, rate: number | undefined): string[] {
  if (!rate || rate === 1) return []
  let base = 1
  try {
    const cfg = JSON.parse(readFileSync(`${modelPath}.json`, 'utf8')) as { inference?: { length_scale?: number } }
    if (typeof cfg.inference?.length_scale === 'number' && cfg.inference.length_scale > 0) base = cfg.inference.length_scale
  } catch {
    // no readable config: use 1
  }
  return ['--length-scale', String(Math.round((base / rate) * 1000) / 1000)]
}

export class PiperProvider implements TtsProvider {
  readonly name = 'piper'
  readonly nativeRate = true
  private downloads = new Map<string, Promise<string>>()
  // bytes received so far of the files being downloaded (for the admin progress bar)
  readonly progress = new Map<string, { received: number; total: number }>()
  // catalog entries give exact paths and md5 sums; set by the registry
  lookup: ((id: string) => CatalogVoice | undefined) | null = null

  constructor(
    private modelsDir: string,
    private bin = 'piper',
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private voiceFor(req: Pick<TtsRequest, 'voice' | 'lang'>): string {
    const v = req.voice ?? DEFAULT_VOICES[req.lang]
    if (!v) throw new Error(`no default piper voice for language ${req.lang}`)
    return v
  }

  // Streams a file to disk, checks its md5 (when known) and only then moves it into place.
  private async download(url: string, dest: string, md5: string | null, onBytes?: (n: number) => void) {
    const res = await this.fetchImpl(url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`voice download failed: ${res.status} ${url}`)
    const tmp = `${dest}.part`
    const hash = createHash('md5')
    const src = Readable.fromWeb(res.body as never)
    src.on('data', (c: Buffer) => {
      hash.update(c)
      onBytes?.(c.length)
    })
    try {
      await pipeline(src, createWriteStream(tmp))
      if (md5 && hash.digest('hex') !== md5.toLowerCase()) throw new Error(`voice download failed: md5 mismatch ${url}`)
      renameSync(tmp, dest)
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
  }

  isDownloaded(id: string): boolean {
    const model = join(this.modelsDir, `${id}.onnx`)
    return existsSync(model) && existsSync(`${model}.json`)
  }

  // Downloads the voice model (on first use or from the admin table) into the models volume; concurrent callers share one download.
  ensureModel(voice: string): Promise<string> {
    const id = splitVoice(voice).model
    const model = join(this.modelsDir, `${id}.onnx`)
    if (this.isDownloaded(id)) return Promise.resolve(model)
    let p = this.downloads.get(id)
    if (!p) {
      mkdirSync(this.modelsDir, { recursive: true })
      const entry = this.lookup?.(id)
      const remote = `${HF}/${voicePath(id)}`
      const jsonUrl = entry?.jsonPath ? `${HF}/${entry.jsonPath}` : `${remote}.onnx.json`
      const onnxUrl = entry?.onnxPath ? `${HF}/${entry.onnxPath}` : `${remote}.onnx`
      this.progress.set(id, { received: 0, total: entry?.sizeBytes ?? 0 })
      p = (async () => {
        await this.download(jsonUrl, `${model}.json`, entry?.jsonMd5 ?? null)
        await this.download(onnxUrl, model, entry?.onnxMd5 ?? null, (n) => {
          const pr = this.progress.get(id)
          if (pr) pr.received += n
        })
        return model
      })().finally(() => {
        this.downloads.delete(id)
        this.progress.delete(id)
      })
      this.downloads.set(id, p)
    }
    return p
  }

  isDownloading(id: string): boolean {
    return this.downloads.has(id)
  }

  remove(id: string) {
    const model = join(this.modelsDir, `${id}.onnx`)
    rmSync(model, { force: true })
    rmSync(`${model}.json`, { force: true })
  }

  async warmUp(req: Pick<TtsRequest, 'voice' | 'lang'>) {
    await this.ensureModel(this.voiceFor(req))
  }

  async synthesize(req: TtsRequest, outBase: string): Promise<string> {
    const { model: modelId, speaker } = splitVoice(this.voiceFor(req))
    const model = await this.ensureModel(modelId)
    const out = `${outBase}.wav`
    const args = ['-m', model, '-f', out, ...(speaker === null ? [] : ['--speaker', String(speaker)]), ...lengthScaleArgs(model, req.rate)]
    await new Promise<void>((resolve, reject) => {
      const p = spawn(this.bin, args, { stdio: ['pipe', 'ignore', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL' })
      let err = ''
      p.stderr.on('data', (d) => {
        err = (err + d).slice(-500)
      })
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`piper exited with ${code}: ${err}`))))
      p.stdin.end(`${req.text.replace(/\s+/g, ' ').trim()}\n`)
    })
    return out
  }
}
