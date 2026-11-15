import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config'
import { openDb } from './db/client'
import { SecretStore } from './lib/secrets'
import { TtsRegistry } from './tts'
import { PiperProvider, splitVoice } from './tts/piper'
import { PiperCatalog, filterLangs, parseCatalog } from './tts/piper-catalog'

const md5 = (b: string) => createHash('md5').update(b).digest('hex')
const entry = (id: string, fam: string, extra: Record<string, unknown> = {}) => {
  const [loc = '', name = '', q = ''] = id.split('-')
  const base = `${fam}/${loc}/${name}/${q}/${id}`
  return {
    key: id,
    name,
    quality: q,
    language: { code: loc, family: fam },
    num_speakers: 1,
    speaker_id_map: {},
    files: {
      [`${base}.onnx`]: { size_bytes: 1234, md5_digest: md5('ONNX') },
      [`${base}.onnx.json`]: { size_bytes: 10, md5_digest: md5('JSON') },
      [`${fam}/${loc}/${name}/${q}/MODEL_CARD`]: { size_bytes: 5, md5_digest: 'x' },
    },
    ...extra,
  }
}
const CATALOG = {
  'uk_UA-oleksa-high': entry('uk_UA-oleksa-high', 'uk'),
  'uk_UA-tetiana-high': entry('uk_UA-tetiana-high', 'uk'),
  'ru_RU-irina-medium': entry('ru_RU-irina-medium', 'ru'),
  'de_DE-thorsten-medium': entry('de_DE-thorsten-medium', 'de'),
  'en_GB-vctk-medium': entry('en_GB-vctk-medium', 'en', { num_speakers: 3, speaker_id_map: { p226: 1, p225: 0, p227: 2 } }),
  broken: { files: {} },
}

describe('piper catalog', () => {
  it('parses voices.json: ids, sizes, md5, language filter, multi-speaker speakers', () => {
    const all = parseCatalog(CATALOG)
    expect(all.map((v) => v.id)).toEqual([
      'de_DE-thorsten-medium',
      'en_GB-vctk-medium',
      'ru_RU-irina-medium',
      'uk_UA-oleksa-high',
      'uk_UA-tetiana-high',
    ])
    const o = all.find((v) => v.id === 'uk_UA-oleksa-high')
    expect(o).toMatchObject({ lang: 'uk', langCode: 'uk_UA', quality: 'high', sizeBytes: 1234, onnxMd5: md5('ONNX'), jsonMd5: md5('JSON') })
    expect(o?.onnxPath).toBe('uk/uk_UA/oleksa/high/uk_UA-oleksa-high.onnx')
    expect(filterLangs(all, ['uk', 'ru', 'en']).map((v) => v.lang)).toEqual(['en', 'ru', 'uk', 'uk'])
    expect(filterLangs(all, 'all')).toHaveLength(5)
    expect(all.find((v) => v.id === 'en_GB-vctk-medium')?.speakers).toEqual([
      { name: 'p225', id: 0 },
      { name: 'p226', id: 1 },
      { name: 'p227', id: 2 },
    ])
  })

  it('caches the catalog, refreshes it when it is a day old, keeps the cache when the fetch fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-'))
    let clock = 1_000_000_000_000
    const f = vi.fn(async () => new Response(JSON.stringify(CATALOG)))
    const cat = new PiperCatalog(join(dir, 'cat.json'), join(dir, 'models'), f as unknown as typeof fetch, () => clock)
    await cat.refresh()
    expect(f).toHaveBeenCalledTimes(1)
    expect(cat.voices()).toHaveLength(5)
    await cat.refresh()
    expect(f).toHaveBeenCalledTimes(1)
    f.mockRejectedValueOnce(new Error('offline'))
    await expect(cat.refresh(true)).rejects.toThrow('offline')
    expect(cat.voices()).toHaveLength(5)
    // a new process reads the cache file
    const again = new PiperCatalog(join(dir, 'cat.json'), join(dir, 'models'), f as unknown as typeof fetch)
    expect(again.voices()).toHaveLength(5)
    clock += 25 * 3600_000
  })

  it('downloaded voices that the catalog does not know are listed too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-'))
    const models = join(dir, 'models')
    mkdirSync(models)
    writeFileSync(join(models, 'uk_UA-mykyta-high.onnx'), 'x')
    writeFileSync(join(models, 'uk_UA-mykyta-high.onnx.json'), '{}')
    writeFileSync(join(models, 'ru_RU-half-low.onnx'), 'x')
    const cat = new PiperCatalog(join(dir, 'cat.json'), models)
    expect(cat.voices().map((v) => v.id)).toEqual(['uk_UA-mykyta-high'])
    expect(cat.isDownloaded('uk_UA-mykyta-high')).toBe(true)
    expect(cat.isDownloaded('ru_RU-half-low')).toBe(false)
  })
})

describe('piper download', () => {
  const setupDl = (onnxBody: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'pd-'))
    const models = join(dir, 'models')
    const cat = new PiperCatalog(join(dir, 'cat.json'), models)
    writeFileSync(join(dir, 'cat.json'), JSON.stringify(CATALOG))
    const f = vi.fn(async (url: string) => new Response(url.endsWith('.onnx.json') ? 'JSON' : onnxBody))
    const p = new PiperProvider(models, 'piper', f as unknown as typeof fetch)
    p.lookup = (id) => cat.get(id)
    return { models, p, f, cat }
  }

  it('fetches the catalog paths and keeps the files when the md5 sums match', async () => {
    const { models, p, f } = setupDl('ONNX')
    await p.ensureModel('uk_UA-oleksa-high')
    expect(existsSync(join(models, 'uk_UA-oleksa-high.onnx'))).toBe(true)
    expect(existsSync(join(models, 'uk_UA-oleksa-high.onnx.json'))).toBe(true)
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/uk/uk_UA/oleksa/high/uk_UA-oleksa-high.onnx.json',
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/uk/uk_UA/oleksa/high/uk_UA-oleksa-high.onnx',
    ])
  })

  it('a corrupted download (wrong md5) is rejected and leaves no model behind', async () => {
    const { models, p } = setupDl('CORRUPT')
    await expect(p.ensureModel('uk_UA-oleksa-high')).rejects.toThrow(/md5/)
    expect(existsSync(join(models, 'uk_UA-oleksa-high.onnx'))).toBe(false)
    expect(existsSync(join(models, 'uk_UA-oleksa-high.onnx.part'))).toBe(false)
  })

  it('removes a voice', async () => {
    const { models, p } = setupDl('ONNX')
    await p.ensureModel('uk_UA-tetiana-high')
    p.remove('uk_UA-tetiana-high')
    expect(existsSync(join(models, 'uk_UA-tetiana-high.onnx'))).toBe(false)
  })

  it('splits "model#speaker"', () => {
    expect(splitVoice('en_GB-vctk-medium#12')).toEqual({ model: 'en_GB-vctk-medium', speaker: 12 })
    expect(splitVoice('uk_UA-mykyta-high')).toEqual({ model: 'uk_UA-mykyta-high', speaker: null })
  })
})

describe('voice list for users', () => {
  it('lists downloaded + enabled piper voices (speakers expanded) and the language defaults, hides the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pl-'))
    const config = loadConfig({ DATA_DIR: dir, APP_SECRET: 's' })
    const models = config.piperModelsDir
    mkdirSync(models, { recursive: true })
    writeFileSync(join(config.dataDir, 'piper-catalog.json'), JSON.stringify(CATALOG))
    for (const id of ['uk_UA-oleksa-high', 'en_GB-vctk-medium', 'de_DE-thorsten-medium']) {
      writeFileSync(join(models, `${id}.onnx`), 'x')
      writeFileSync(join(models, `${id}.onnx.json`), '{}')
    }
    const db = openDb(':memory:')
    const reg = new TtsRegistry(db, config, new SecretStore(db, () => 's'))
    const keys = () =>
      reg
        .availableVoices()
        .filter((v) => v.provider === 'piper')
        .map((v) => v.key)
    expect(keys()).toEqual(
      expect.arrayContaining([
        'piper:uk_UA-oleksa-high',
        'piper:en_GB-vctk-medium#0',
        'piper:en_GB-vctk-medium#1',
        'piper:en_GB-vctk-medium#2',
        'piper:de_DE-thorsten-medium',
        'piper:uk_UA-mykyta-high',
        'piper:ru_RU-dmitri-medium',
        'piper:en_US-lessac-medium',
      ]),
    )
    // not downloaded: hidden
    expect(keys()).not.toContain('piper:uk_UA-tetiana-high')
    expect(keys()).not.toContain('piper:ru_RU-irina-medium')
    reg.setVoiceEnabled('piper:en_GB-vctk-medium', false)
    reg.setVoiceEnabled('piper:uk_UA-oleksa-high', false)
    expect(keys().some((k) => k.startsWith('piper:en_GB-vctk-medium'))).toBe(false)
    expect(keys()).not.toContain('piper:uk_UA-oleksa-high')
    expect(reg.findVoice('piper:uk_UA-oleksa-high')).toMatchObject({ lang: 'uk', quality: 'high', label: 'Oleksa' })
  })
})
