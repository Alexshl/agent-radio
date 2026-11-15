// The official Piper voice catalog (rhasspy/piper-voices voices.json): cached in the data volume, refreshed daily, plus whatever is already
// downloaded into the models directory (voices that are not in the catalog, or the catalog was never fetched).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PIPER_HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'
export const CATALOG_URL = `${PIPER_HF}/voices.json`
const MAX_AGE_MS = 24 * 3600_000

export interface CatalogVoice {
  // 'uk_UA-mykyta-high'
  id: string
  name: string
  // language family: uk, ru, en, ...
  lang: string
  // locale: uk_UA
  langCode: string
  quality: string
  sizeBytes: number
  // paths inside the HF repo, null for a voice known only from its files on disk
  onnxPath: string | null
  jsonPath: string | null
  onnxMd5: string | null
  jsonMd5: string | null
  // speaker name -> id of a multi-speaker model (empty for single-speaker)
  speakers: { name: string; id: number }[]
}

const ID_RE = /^([a-z]{2,3})_([A-Z]{2})-([a-zA-Z0-9_]+)-(x_low|low|medium|high)$/

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function parseCatalog(raw: unknown): CatalogVoice[] {
  const out: CatalogVoice[] = []
  if (!raw || typeof raw !== 'object') return out
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const m = ID_RE.exec(key)
    const e = val as {
      name?: string
      quality?: string
      language?: { family?: string; code?: string }
      num_speakers?: number
      speaker_id_map?: Record<string, number>
      files?: Record<string, { size_bytes?: number; md5_digest?: string }>
    } | null
    if (!m || !e || typeof e !== 'object') continue
    const files = e.files ?? {}
    const onnxPath = Object.keys(files).find((f) => f.endsWith('.onnx'))
    if (!onnxPath) continue
    const jsonPath = Object.keys(files).find((f) => f.endsWith('.onnx.json')) ?? null
    const map = e.speaker_id_map ?? {}
    out.push({
      id: key,
      name: e.name ?? m[3] ?? key,
      lang: e.language?.family ?? m[1] ?? '',
      langCode: e.language?.code ?? `${m[1]}_${m[2]}`,
      quality: e.quality ?? m[4] ?? '',
      sizeBytes: files[onnxPath]?.size_bytes ?? 0,
      onnxPath,
      jsonPath,
      onnxMd5: files[onnxPath]?.md5_digest ?? null,
      jsonMd5: jsonPath ? (files[jsonPath]?.md5_digest ?? null) : null,
      speakers:
        (e.num_speakers ?? 1) > 1
          ? Object.entries(map)
              .map(([name, id]) => ({ name, id }))
              .sort((a, b) => a.id - b.id)
          : [],
    })
  }
  return out.sort(
    (a, b) =>
      a.lang.localeCompare(b.lang) || a.langCode.localeCompare(b.langCode) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  )
}

// Languages shown by default.
export const DEFAULT_LANGS = ['uk', 'ru', 'en']
export const filterLangs = (voices: CatalogVoice[], langs: string[] | 'all') =>
  langs === 'all' ? voices : voices.filter((v) => langs.includes(v.lang))

export class PiperCatalog {
  private cached: CatalogVoice[] | null = null
  private fetchedAt = 0
  private refreshing: Promise<void> | null = null

  constructor(
    private cacheFile: string,
    private modelsDir: string,
    private fetchImpl: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  private load() {
    if (this.cached) return
    this.cached = []
    try {
      this.cached = parseCatalog(JSON.parse(readFileSync(this.cacheFile, 'utf8')))
      this.fetchedAt = statSync(this.cacheFile).mtimeMs
    } catch {
      // no cache yet
    }
  }

  get lastFetched(): number | null {
    this.load()
    return this.fetchedAt || null
  }

  // Fetches voices.json when the cache is older than a day (or `force`). A failure keeps the old cache; with `force` it is rethrown.
  refresh(force = false): Promise<void> {
    this.load()
    if (!force && this.fetchedAt && this.now() - this.fetchedAt < MAX_AGE_MS) return Promise.resolve()
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const res = await this.fetchImpl(CATALOG_URL, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`piper catalog: ${res.status}`)
      const text = await res.text()
      const parsed = parseCatalog(JSON.parse(text))
      if (!parsed.length) throw new Error('piper catalog: empty')
      mkdirSync(join(this.cacheFile, '..'), { recursive: true })
      const tmp = `${this.cacheFile}.part`
      writeFileSync(tmp, text)
      renameSync(tmp, this.cacheFile)
      this.cached = parsed
      this.fetchedAt = this.now()
    })().finally(() => {
      this.refreshing = null
    })
    if (!force) this.refreshing.catch((e) => console.error('piper catalog refresh failed:', e instanceof Error ? e.message : e))
    return this.refreshing
  }

  // Voices whose model and config are both on disk.
  downloadedIds(): string[] {
    try {
      return readdirSync(this.modelsDir)
        .filter((f) => f.endsWith('.onnx') && existsSync(join(this.modelsDir, `${f}.json`)))
        .map((f) => f.slice(0, -5))
    } catch {
      return []
    }
  }

  isDownloaded(id: string): boolean {
    return existsSync(join(this.modelsDir, `${id}.onnx`)) && existsSync(join(this.modelsDir, `${id}.onnx.json`))
  }

  // The catalog plus downloaded voices the catalog does not know.
  voices(): CatalogVoice[] {
    this.load()
    const known = new Set((this.cached ?? []).map((v) => v.id))
    const extra: CatalogVoice[] = []
    for (const id of this.downloadedIds()) {
      const m = ID_RE.exec(id)
      if (known.has(id) || !m) continue
      let sizeBytes = 0
      try {
        sizeBytes = statSync(join(this.modelsDir, `${id}.onnx`)).size
      } catch {
        // gone meanwhile
      }
      extra.push({
        id,
        name: m[3] ?? id,
        lang: m[1] ?? '',
        langCode: `${m[1]}_${m[2]}`,
        quality: m[4] ?? '',
        sizeBytes,
        onnxPath: null,
        jsonPath: null,
        onnxMd5: null,
        jsonMd5: null,
        speakers: speakersFromConfig(join(this.modelsDir, `${id}.onnx.json`)),
      })
    }
    return [...(this.cached ?? []), ...extra]
  }

  get(id: string): CatalogVoice | undefined {
    return this.voices().find((v) => v.id === id)
  }
}

function speakersFromConfig(file: string): CatalogVoice['speakers'] {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { num_speakers?: number; speaker_id_map?: Record<string, number> }
    if ((j.num_speakers ?? 1) <= 1) return []
    return Object.entries(j.speaker_id_map ?? {}).map(([name, id]) => ({ name, id }))
  } catch {
    return []
  }
}
