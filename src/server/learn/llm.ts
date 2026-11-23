// AI models for learn mode ("ИИ-модели" in the admin): one call `chatJson` over two API styles, the native Anthropic Messages API and the
// OpenAI-compatible one (OpenAI, OpenRouter, Gemini's compatible endpoint, a local llama.cpp / Ollama server). Keys live in the secret store
// and never leave this file except in the request header; calls are counted per UTC day against learn.dailyLlmCalls.
import type { z } from 'zod'
import type { Config } from '../config'
import type { Db } from '../db/client'
import type { SecretStore } from '../lib/secrets'
import { getSetting, setSetting } from '../lib/settings'

export const LLM_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'gemini', 'local'] as const
export type LlmProvider = (typeof LLM_PROVIDERS)[number]
export const isLlmProvider = (s: string): s is LlmProvider => (LLM_PROVIDERS as readonly string[]).includes(s)

export const LLM_LABEL: Record<LlmProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
  local: 'Local (OpenAI-compatible)',
}

const BASE: Record<Exclude<LlmProvider, 'local'>, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
}

export const LLM_TIMEOUT_MS = 120_000
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_TOKENS = 4096

export const llmSecretName = (p: LlmProvider) => `llm.${p}.key`

// code: no_provider (no key / nothing chosen) | cap (daily limit reached) | http | bad_json
export class LlmError extends Error {
  constructor(
    readonly code: 'no_provider' | 'cap' | 'http' | 'bad_json',
    message: string,
  ) {
    super(message)
  }
}

export interface ChatResult<T> {
  data: T
  provider: LlmProvider
  model: string
  tokensIn: number
  tokensOut: number
}

export interface ChatOpts {
  // Anthropic only: let the model search the web (the web_search server tool)
  webSearch?: boolean
  maxTokens?: number
  // request timeout, default LLM_TIMEOUT_MS
  timeoutMs?: number
}

// The JSON object inside a model answer: plain, in a ``` fence, or surrounded by prose.
export function extractJson(text: string): unknown {
  const t = text.trim()
  const attempts: string[] = [t]
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (fence?.[1]) attempts.push(fence[1].trim())
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) attempts.push(t.slice(a, b + 1))
  for (const s of attempts) {
    try {
      return JSON.parse(s)
    } catch {
      // next attempt
    }
  }
  throw new LlmError('bad_json', 'The model did not return JSON')
}

const today = () => new Date().toISOString().slice(0, 10)

export class LlmService {
  constructor(
    private db: Db,
    private config: Pick<Config, 'learnLlmUrl'>,
    readonly secrets: SecretStore,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  provider(): LlmProvider {
    const p = getSetting(this.db, 'learn.provider')
    return isLlmProvider(p) ? p : 'local'
  }

  model(): string {
    return getSetting(this.db, 'learn.model')
  }

  baseUrl(p: LlmProvider): string {
    if (p === 'local') return (getSetting(this.db, 'learn.localUrl') || this.config.learnLlmUrl).replace(/\/+$/, '')
    return BASE[p]
  }

  hasKey(p: LlmProvider): boolean {
    return this.secrets.has(llmSecretName(p))
  }

  // a model can be called: the local server needs no key, the others do
  configured(p: LlmProvider = this.provider()): boolean {
    return p === 'local' || this.hasKey(p)
  }

  canSearchWeb(): boolean {
    return this.provider() === 'anthropic' && getSetting(this.db, 'learn.webSearch') === true && this.configured()
  }

  usage() {
    const u = getSetting(this.db, 'learn.usage')
    const cap = getSetting(this.db, 'learn.dailyLlmCalls')
    const calls = u.day === today() ? u.calls : 0
    return {
      calls,
      tokensIn: u.day === today() ? u.tokensIn : 0,
      tokensOut: u.day === today() ? u.tokensOut : 0,
      cap,
    }
  }

  // counts the call before it is made (a failed call also costs); false = the daily limit is reached
  private take(): boolean {
    const u = getSetting(this.db, 'learn.usage')
    const day = today()
    const cur = u.day === day ? u : { day, calls: 0, tokensIn: 0, tokensOut: 0 }
    if (cur.calls >= getSetting(this.db, 'learn.dailyLlmCalls')) return false
    setSetting(this.db, 'learn.usage', { ...cur, calls: cur.calls + 1 })
    return true
  }

  private addTokens(tin: number, tout: number) {
    const u = getSetting(this.db, 'learn.usage')
    if (u.day !== today()) return
    setSetting(this.db, 'learn.usage', { ...u, tokensIn: u.tokensIn + tin, tokensOut: u.tokensOut + tout })
  }

  private async headers(p: LlmProvider): Promise<Record<string, string>> {
    const key = await this.secrets.get(llmSecretName(p))
    if (!key && p !== 'local') throw new LlmError('no_provider', `${p} has no key`)
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (p === 'anthropic') {
      h['x-api-key'] = key as string
      h['anthropic-version'] = ANTHROPIC_VERSION
    } else if (key) h.authorization = `Bearer ${key}`
    return h
  }

  // Model ids of the provider (GET /models); null when it has no such list or is unreachable.
  async listModels(p: LlmProvider = this.provider()): Promise<string[] | null> {
    try {
      if (!this.configured(p)) return null
      const url = p === 'anthropic' ? `${BASE.anthropic}/v1/models?limit=100` : `${this.baseUrl(p)}/models`
      const res = await this.fetchImpl(url, { headers: await this.headers(p), signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return null
      const body = (await res.json()) as { data?: { id?: unknown }[]; models?: { name?: unknown; id?: unknown }[] }
      const rows = body.data ?? body.models ?? []
      const ids = rows
        .map((m) => ('id' in m && typeof m.id === 'string' ? m.id : 'name' in m && typeof m.name === 'string' ? m.name : ''))
        .map((s) => s.replace(/^models\//, ''))
        .filter(Boolean)
      return ids.length ? ids.sort() : null
    } catch {
      return null
    }
  }

  // One call: the answer is a JSON object checked by `schema`.
  async chatJson<S extends z.ZodType>(system: string, user: string, schema: S, opts: ChatOpts = {}): Promise<ChatResult<z.output<S>>> {
    const p = this.provider()
    if (!this.configured(p)) throw new LlmError('no_provider', 'No AI model is configured')
    if (!this.take()) throw new LlmError('cap', 'The daily limit of model calls is reached')
    const model = this.model()
    const headers = await this.headers(p)
    const sys = `${system}\n\nAnswer with one JSON object only, no prose, no code fence.`
    let text: string
    let tin = 0
    let tout = 0
    if (p === 'anthropic') {
      const body: Record<string, unknown> = {
        model,
        max_tokens: opts.maxTokens ?? MAX_TOKENS,
        system: sys,
        messages: [{ role: 'user', content: user }],
      }
      if (opts.webSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
      const r = await this.post(`${BASE.anthropic}/v1/messages`, headers, body, opts.timeoutMs)
      const j = r as { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } }
      text = (j.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
      tin = j.usage?.input_tokens ?? 0
      tout = j.usage?.output_tokens ?? 0
    } else {
      const body = {
        model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        stream: false,
      }
      const r = await this.post(`${this.baseUrl(p)}/chat/completions`, headers, body, opts.timeoutMs)
      const j = r as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
      const c = j.choices?.[0]?.message?.content
      text = typeof c === 'string' ? c : ''
      tin = j.usage?.prompt_tokens ?? 0
      tout = j.usage?.completion_tokens ?? 0
    }
    this.addTokens(tin, tout)
    const parsed = schema.safeParse(extractJson(text))
    if (!parsed.success) throw new LlmError('bad_json', 'The model answer has the wrong shape')
    return { data: parsed.data, provider: p, model, tokensIn: tin, tokensOut: tout }
  }

  private async post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = LLM_TIMEOUT_MS): Promise<unknown> {
    let res: Response
    try {
      res = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw new LlmError('http', `The model request failed: ${e instanceof Error ? e.name : 'error'}`)
    }
    if (!res.ok) {
      // the body of an error answer is not echoed: it could carry request details
      throw new LlmError('http', `The model answered ${res.status}`)
    }
    try {
      return await res.json()
    } catch {
      throw new LlmError('bad_json', 'The model answer is not JSON')
    }
  }
}
