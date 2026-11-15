// Which TTS providers are configured, which voices are on, and the choice for one message (with the piper fallback).
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { voicePrefs } from '../db/schema'
import type { SecretStore } from '../lib/secrets'
import { getSetting } from '../lib/settings'
import { AzureProvider } from './azure'
import { GeminiProvider } from './gemini'
import { type LocalEngineInfo, LocalProvider } from './local'
import { OpenAiProvider } from './openai'
import { PiperProvider } from './piper'
import { type CatalogVoice, PiperCatalog, cap } from './piper-catalog'
import type { TtsProvider } from './types'
import { PIPER_DEFAULT_BY_LANG, type ProviderId, VOICES, type VoiceInfo, findStaticVoice } from './voices'

export const secretName = (p: ProviderId) => `tts.${p}.key`

export interface Choice {
  provider: ProviderId
  // provider specific voice id (null = piper default for the language)
  voice: string | null
}

export class TtsRegistry {
  readonly piper: PiperProvider
  readonly catalog: PiperCatalog
  readonly local: LocalProvider
  // engines of the sidecar as last seen (refreshLocal); null = unreachable / not configured
  private localEngines: LocalEngineInfo[] | null = null
  private providers: Record<ProviderId, TtsProvider>

  constructor(
    private db: Db,
    private config: Config,
    readonly secrets: SecretStore,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.piper = new PiperProvider(config.piperModelsDir, config.piperBin, fetchImpl)
    this.catalog = new PiperCatalog(join(config.dataDir, 'piper-catalog.json'), config.piperModelsDir, fetchImpl)
    this.piper.lookup = (id) => this.catalog.get(id)
    this.local = new LocalProvider(config.ttsLocalUrl, fetchImpl)
    this.providers = {
      piper: this.piper,
      local: this.local,
      azure: new AzureProvider(
        async () => ({ key: await this.requireKey('azure'), region: getSetting(db, 'tts.azure.region') }),
        fetchImpl,
      ),
      openai: new OpenAiProvider(
        async () => ({ key: await this.requireKey('openai'), model: getSetting(db, 'tts.openai.model') }),
        fetchImpl,
      ),
      gemini: new GeminiProvider(
        async () => ({ key: await this.requireKey('gemini'), model: getSetting(db, 'tts.gemini.model') }),
        fetchImpl,
      ),
    }
  }

  private async requireKey(p: ProviderId): Promise<string> {
    const k = await this.secrets.get(secretName(p))
    if (!k) throw new Error(`${p} is not configured`)
    return k
  }

  provider(p: ProviderId): TtsProvider {
    return this.providers[p]
  }

  isConfigured(p: ProviderId): boolean {
    if (p === 'local') return this.localEngines?.some((e) => e.status === 'ready') ?? false
    return p === 'piper' || this.secrets.has(secretName(p))
  }

  // Asks the sidecar which engines / voices it has (called at start, every 30 s and by the admin page).
  async refreshLocal(): Promise<LocalEngineInfo[] | null> {
    this.localEngines = await this.local.engines()
    return this.localEngines
  }

  localEngineList(): LocalEngineInfo[] | null {
    return this.localEngines
  }

  // Voices of the engines that are loaded; the engine switch (admin) gates them, see voiceEnabled.
  localVoices(): VoiceInfo[] {
    return (this.localEngines ?? [])
      .filter((e) => e.status === 'ready')
      .flatMap((e) =>
        e.voices.map((v) => ({
          key: `local:${e.id}/${v.id}`,
          provider: 'local' as const,
          id: `${e.id}/${v.id}`,
          label: `${e.label} · ${v.label}`,
          lang: v.lang,
        })),
      )
  }

  // A speaker of a multi-speaker piper model follows its model ('piper:model#12' -> 'piper:model').
  voiceEnabled(key: string): boolean {
    // local voices are opt-in: the engine switch ('local:<engine>', default off) and then the voice itself
    if (key.startsWith('local:')) {
      const engine = key.includes('/') ? key.slice(0, key.indexOf('/')) : key
      const e = this.db.select().from(voicePrefs).where(eq(voicePrefs.voiceKey, engine)).get()
      if (!e?.enabled) return false
      if (engine === key) return true
    }
    const k = key.split('#')[0] ?? key
    const row = this.db.select().from(voicePrefs).where(eq(voicePrefs.voiceKey, k)).get()
    return row ? row.enabled : true
  }

  setVoiceEnabled(key: string, enabled: boolean) {
    this.db
      .insert(voicePrefs)
      .values({ voiceKey: key, enabled })
      .onConflictDoUpdate({ target: voicePrefs.voiceKey, set: { enabled } })
      .run()
  }

  // Piper voices that can be used right now: downloaded ones (every speaker of a multi-speaker model is its own voice) and the three
  // language defaults, which are fetched on first use.
  piperVoices(): VoiceInfo[] {
    const out: VoiceInfo[] = []
    for (const c of this.catalog.voices()) {
      if (!this.catalog.isDownloaded(c.id) && PIPER_DEFAULT_BY_LANG[c.lang] !== c.id) continue
      out.push(...piperInfos(c))
    }
    const have = new Set(out.map((v) => v.id))
    for (const [lang, id] of Object.entries(PIPER_DEFAULT_BY_LANG)) {
      if (!have.has(id))
        out.push({ key: `piper:${id}`, provider: 'piper', id, label: cap(id.split('-')[1] ?? id), lang, quality: id.split('-')[2] })
    }
    return out
  }

  allVoices(): VoiceInfo[] {
    return [...VOICES, ...this.piperVoices(), ...this.localVoices()]
  }

  findVoice(key: string): VoiceInfo | undefined {
    return findStaticVoice(key) ?? this.piperVoices().find((v) => v.key === key) ?? this.localVoices().find((v) => v.key === key)
  }

  // Voices a user may pick: provider configured, downloaded (piper) and not switched off.
  availableVoices(): VoiceInfo[] {
    return this.allVoices().filter((v) => this.isConfigured(v.provider) && this.voiceEnabled(v.key))
  }

  defaultVoiceKey(lang: string): string {
    const configured = getSetting(this.db, 'defaultVoice')
    if (configured && this.available(configured)) return configured
    const env = this.config.ttsVoice
    if (env) return env.includes(':') ? env : `piper:${env}`
    return `piper:${PIPER_DEFAULT_BY_LANG[lang] ?? PIPER_DEFAULT_BY_LANG.uk}`
  }

  private available(key: string): boolean {
    const v = this.findVoice(key)
    return !!v && this.isConfigured(v.provider) && this.voiceEnabled(key)
  }

  // The voice for a message: the requested key if usable, else the default. A bare id without provider is a piper voice.
  choose(requested: string | null, lang: string): Choice {
    const key = requested && (requested.includes(':') ? requested : `piper:${requested}`)
    if (key && (this.available(key) || key.startsWith('piper:'))) return splitKey(key)
    return splitKey(this.defaultVoiceKey(lang))
  }

  // What to try when the chosen provider failed.
  fallback(lang: string): Choice {
    return { provider: 'piper', voice: PIPER_DEFAULT_BY_LANG[lang] ?? PIPER_DEFAULT_BY_LANG.uk ?? null }
  }
}

// A model is one voice; a multi-speaker model is one voice per speaker.
export function piperInfos(c: CatalogVoice): VoiceInfo[] {
  const name = cap(c.name)
  if (!c.speakers.length) return [{ key: `piper:${c.id}`, provider: 'piper', id: c.id, label: name, lang: c.lang, quality: c.quality }]
  return c.speakers.map((s) => ({
    key: `piper:${c.id}#${s.id}`,
    provider: 'piper' as const,
    id: `${c.id}#${s.id}`,
    label: `${name} · ${s.name}`,
    lang: c.lang,
    quality: c.quality,
  }))
}

function splitKey(key: string): Choice {
  const i = key.indexOf(':')
  return { provider: key.slice(0, i) as ProviderId, voice: key.slice(i + 1) || null }
}
