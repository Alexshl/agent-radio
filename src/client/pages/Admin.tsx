import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, MoreHorizontal, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { del, get, post, put, patch } from '../api/client'
import { useMe } from '../api/hooks'
import { usePlayer } from '../components/Player'
import { useToast } from '../components/Toast'
import { ErrorBox, Loading, PageHead, Seg, Switch, copyText, useErrorToast } from '../components/ui'
import { LANGS, LANG_NAMES, S } from '../i18n'
import type { Lang } from '../i18n'
import { Shell } from '../layouts/Shell'
import { LearnTab } from './AdminLearn'
import { fmtBytes, fmtDate, fmtDb, fmtRate, fmtWhen, initials } from '../lib/format'

type Tab = 'users' | 'tts' | 'llm' | 'learn' | 'lib' | 'presets' | 'server'
const WHEN = { today: S.common.today, yesterday: S.common.yesterday, never: S.common.never }

interface AdminUser {
  id: string
  name: string
  email: string
  role: 'admin' | 'user'
  disabled: boolean
  lastLoginAt: string | null
  keys: number
  sourceType: string
  listeners: number
}
interface PendingInvite {
  id: string
  email: string
  role: string
  expiresAt: string
}

function LinkBanner({ text, url }: { text: string; url: string }) {
  const toast = useToast()
  return (
    <div className="banner t-success" role="status" style={{ alignItems: 'flex-start' }}>
      <div className="stack" style={{ gap: 6, minWidth: 0, flex: 1 }}>
        <div>{text}</div>
        <div className="row" style={{ gap: 8 }}>
          <code
            className="mono"
            style={{
              fontSize: 12,
              padding: '6px 10px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              overflowWrap: 'anywhere',
              color: 'var(--foreground)',
            }}
          >
            {url}
          </code>
          <button
            type="button"
            className="btn icon sm"
            aria-label={S.common.copy}
            onClick={async () => toast((await copyText(url)) ? S.common.copied : S.common.error)}
          >
            <Copy size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}

function RowMenu({ user, me, onReset }: { user: AdminUser; me: string; onReset: (url: string) => void }) {
  const qc = useQueryClient()
  const fail = useErrorToast()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const mut = useMutation({
    mutationFn: (b: { role?: string; disabled?: boolean }) => patch(`/admin/users/${user.id}`, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: fail,
  })
  const reset = useMutation({
    mutationFn: () => post<{ url: string }>(`/admin/users/${user.id}/reset`),
    onSuccess: (r) => onReset(r.url),
    onError: fail,
  })
  const item = (label: string, fn: () => void, danger = false) => (
    <button
      type="button"
      className={`dd-i${danger ? ' t-danger' : ''}`}
      style={{ background: 'none', border: 0, width: '100%', font: 'inherit', textAlign: 'left' }}
      onClick={() => {
        setOpen(false)
        fn()
      }}
    >
      {label}
    </button>
  )
  return (
    <div className={`dd${open ? ' open' : ''}`} ref={ref}>
      <button
        type="button"
        className="btn icon ghost sm"
        aria-label={S.admin.users.actions}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      <div className="dd-m" style={{ right: 0, left: 'auto', minWidth: 210 }}>
        {user.id !== me &&
          item(user.role === 'admin' ? S.admin.users.makeUser : S.admin.users.makeAdmin, () =>
            mut.mutate({ role: user.role === 'admin' ? 'user' : 'admin' }),
          )}
        {item(S.admin.users.reset, () => reset.mutate())}
        {user.id !== me && (
          <>
            <div className="dd-sep" />
            {item(
              user.disabled ? S.admin.users.enable : S.admin.users.disable,
              () => mut.mutate({ disabled: !user.disabled }),
              !user.disabled,
            )}
          </>
        )}
      </div>
    </div>
  )
}

function UsersTab() {
  const qc = useQueryClient()
  const fail = useErrorToast()
  const { data: me } = useMe()
  const q = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => get<{ users: AdminUser[]; invites: PendingInvite[] }>('/admin/users'),
    refetchInterval: 15_000,
  })
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'user' | 'admin'>('user')
  const [days, setDays] = useState(7)
  const [link, setLink] = useState<string | null>(null)
  const [resetLink, setResetLink] = useState<string | null>(null)
  const invite = useMutation({
    mutationFn: () => post<{ url: string }>('/admin/invites', { email, role, days }),
    onSuccess: (r) => {
      setLink(r.url)
      setEmail('')
      qc.invalidateQueries({ queryKey: ['admin-users'] })
    },
    onError: fail,
  })
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/admin/invites/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  })
  const cols = 'ar-row ar-users'
  return (
    <div className="stack" style={{ gap: 16 }}>
      <section className="card">
        <div className="card-h">{S.admin.users.invite}</div>
        <form
          className="card-b"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault()
            invite.mutate()
          }}
        >
          <div className="field" style={{ flex: '1 1 200px', minWidth: 0 }}>
            <label htmlFor="ar-inv">{S.admin.users.email}</label>
            <input
              id="ar-inv"
              className="inp"
              type="email"
              required
              placeholder="colleague@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: '1 1 200px', minWidth: 0 }}>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: caption of the segmented control below */}
            <label>{S.admin.users.roleLabel}</label>
            <Seg
              value={role}
              onChange={setRole}
              options={[
                { id: 'user', label: S.admin.users.user },
                { id: 'admin', label: S.admin.users.admin },
              ]}
            />
          </div>
          <div className="field" style={{ flex: '1 1 200px', minWidth: 0 }}>
            <label htmlFor="ar-exp">{S.admin.users.expiry}</label>
            <select id="ar-exp" className="inp" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 1, 30].map((d) => (
                <option key={d} value={d}>
                  {S.admin.users.days(d)}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn primary" disabled={invite.isPending}>
            {S.admin.users.createLink}
          </button>
          {link && (
            <div style={{ flexBasis: '100%' }}>
              <LinkBanner text={S.admin.users.linkReady} url={link} />
            </div>
          )}
          <div className="muted" style={{ fontSize: 12, flexBasis: '100%' }}>
            {S.admin.users.linkHint}
          </div>
        </form>
      </section>
      <section className="card" style={{ overflow: 'hidden' }}>
        <div className="card-h">{S.admin.users.title}</div>
        {resetLink && (
          <div className="card-b" style={{ borderBottom: '1px solid var(--border)' }}>
            <LinkBanner text={S.admin.users.resetReady} url={resetLink} />
          </div>
        )}
        {q.isLoading && <Loading />}
        {q.isError && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 780 }}>
            <div className={`${cols} ar-head`}>
              <span>{S.admin.users.name}</span>
              <span>{S.admin.users.role}</span>
              <span>{S.admin.users.station}</span>
              <span>{S.admin.users.keys}</span>
              <span>{S.admin.users.lastLogin}</span>
              <span />
            </div>
            {q.data?.users.map((u) => (
              <div className={cols} key={u.id}>
                <span className="row" style={{ gap: 8 }}>
                  <span className="avatar" style={{ width: 26, height: 26, fontSize: 10.5 }}>
                    {initials(u.name)}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span className="ell" style={{ display: 'block', fontWeight: 600 }}>
                      {u.name}
                    </span>
                    <span className="muted ell" style={{ fontSize: 12, display: 'block' }}>
                      {u.email}
                    </span>
                  </span>
                </span>
                <span>
                  {u.disabled ? (
                    <span className="bdg t-danger">{S.admin.users.disabledBadge}</span>
                  ) : (
                    <span className={`bdg${u.role === 'admin' ? ' t-primary' : ''}`}>
                      {u.role === 'admin' ? S.admin.users.admin : S.admin.users.user}
                    </span>
                  )}
                </span>
                <span>
                  {u.listeners > 0 ? (
                    <span className="bdg t-success">{S.admin.users.onAir(u.listeners)}</span>
                  ) : (
                    <span className="bdg">{u.sourceType === 'silence' ? S.admin.users.silence : S.admin.users.playing}</span>
                  )}
                </span>
                <span className="mono">{u.keys}</span>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {u.lastLoginAt ? fmtWhen(u.lastLoginAt, WHEN) : S.admin.users.invitePending}
                </span>
                <RowMenu user={u} me={me?.id ?? ''} onReset={setResetLink} />
              </div>
            ))}
            {q.data && q.data.invites.length > 0 && (
              <>
                <div className="ar-row ar-head" style={{ gridTemplateColumns: '1fr' }}>
                  <span>{S.admin.users.pending}</span>
                </div>
                {q.data.invites.map((i) => (
                  <div className="ar-row" style={{ gridTemplateColumns: '1fr auto auto' }} key={i.id}>
                    <span>{i.email}</span>
                    <span className="muted mono" style={{ fontSize: 12 }}>
                      {fmtDate(i.expiresAt)}
                    </span>
                    <button type="button" className="btn sm danger" onClick={() => revoke.mutate(i.id)}>
                      {S.admin.users.revokeInvite}
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

interface TtsData {
  providers: { id: string; label: string; configured: boolean; region?: string; model?: string }[]
  voices: {
    key: string
    provider: string
    id: string
    label: string
    lang: string
    enabled: boolean
    providerConfigured: boolean
    isDefault: boolean
    engineOn?: boolean
  }[]
  defaultVoice: string
}
interface LocalEngine {
  id: string
  label: string
  lang: string
  license: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  enabled: boolean
  voices: { id: string; key: string; label: string; lang: string; enabled: boolean }[]
}
interface LocalData {
  configured: boolean
  reachable: boolean
  engines: LocalEngine[]
}
interface AdminSettings {
  allowOwnUrls: boolean
  messageLimitPerHour: number
  maxAudioMb: number
  maxAudioMinutes: number
  allowUserUploads: boolean
  uploadQuotaMb: number
  defaultMusicGainDb: number
  defaultVoiceGainDb: number
  defaultSpeechRate: number
}

const PROVIDER_DESC: Record<string, string> = {
  azure: S.admin.tts.descAzure,
  piper: S.admin.tts.descPiper,
  openai: S.admin.tts.descOpenai,
  gemini: S.admin.tts.descGemini,
}
const LANG_TAG: Record<string, string> = { uk: 'uk-UA', ru: 'ru-RU', en: 'en', multi: '' }

function ProviderRow({ p, voices }: { p: TtsData['providers'][number]; voices: TtsData['voices'] }) {
  const qc = useQueryClient()
  const player = usePlayer()
  const toast = useToast()
  const fail = useErrorToast()
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [region, setRegion] = useState(p.region ?? '')
  const [model, setModel] = useState(p.model ?? '')
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-tts'] })
  const saveM = useMutation({
    mutationFn: () =>
      put(`/admin/tts/providers/${p.id}`, { key: key || undefined, region: region || undefined, model: model || undefined }),
    onSuccess: () => {
      setKey('')
      setOpen(false)
      refresh()
    },
    onError: fail,
  })
  const removeM = useMutation({ mutationFn: () => del(`/admin/tts/providers/${p.id}`), onSuccess: refresh, onError: fail })
  const testM = useMutation({
    mutationFn: () =>
      post<{ ok: boolean; ms?: number; error?: string; audio?: string; mime?: string }>(`/admin/tts/providers/${p.id}/test`, {
        voice: voices.find((v) => v.provider === p.id)?.key,
      }),
    onSuccess: (r) => {
      if (!r.ok) return toast(`${S.admin.tts.testFail}: ${r.error ?? ''}`, 'danger')
      toast(S.admin.tts.testOk(r.ms ?? 0))
      if (r.audio)
        player.start({
          key: `tts-test:${p.id}`,
          kind: 'voice',
          src: `data:${r.mime};base64,${r.audio}`,
          title: S.admin.tts.testSample(p.label),
        })
    },
    onError: fail,
  })
  const isPiper = p.id === 'piper'
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="ar-prov" style={{ borderBottom: 0 }}>
        <div className="grow" style={{ flex: 1 }}>
          <div className="row" style={{ gap: 8 }}>
            <span style={{ fontWeight: 600 }}>{p.label}</span>
            {isPiper ? (
              <span className="bdg t-success">{S.admin.tts.local}</span>
            ) : p.configured ? (
              <span className="bdg t-success">{S.admin.tts.connected}</span>
            ) : (
              <span className="bdg">{S.admin.tts.notConfigured}</span>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {p.id === 'azure' && p.region ? `${S.admin.tts.region} ${p.region} · ` : ''}
            {PROVIDER_DESC[p.id]}
          </div>
        </div>
        {p.configured && (
          <button type="button" className="btn sm" disabled={testM.isPending} onClick={() => testM.mutate()}>
            {testM.isPending ? S.admin.tts.testing : S.admin.tts.test}
          </button>
        )}
        {!isPiper && (
          <button type="button" className="btn sm" onClick={() => setOpen(!open)}>
            {p.configured ? S.admin.tts.edit : S.admin.tts.connect}
          </button>
        )}
      </div>
      {open && (
        <form
          className="stack"
          style={{ gap: 10, padding: '0 16px 14px' }}
          onSubmit={(e) => {
            e.preventDefault()
            saveM.mutate()
          }}
        >
          <div className="field">
            <label htmlFor={`k-${p.id}`}>{S.admin.tts.apiKey}</label>
            <input
              id={`k-${p.id}`}
              className="inp mono"
              type="password"
              autoComplete="off"
              required={!p.configured}
              placeholder={p.configured ? '••••••••' : ''}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <span className="msg muted">{S.admin.tts.keyHint}</span>
          </div>
          {p.id === 'azure' && (
            <div className="field">
              <label htmlFor="az-region">{S.admin.tts.region}</label>
              <input id="az-region" className="inp mono" value={region} onChange={(e) => setRegion(e.target.value)} />
            </div>
          )}
          {(p.id === 'openai' || p.id === 'gemini') && (
            <div className="field">
              <label htmlFor={`m-${p.id}`}>{S.admin.tts.model}</label>
              <input id={`m-${p.id}`} className="inp mono" value={model} onChange={(e) => setModel(e.target.value)} />
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn primary sm" disabled={saveM.isPending}>
              {S.common.save}
            </button>
            {p.configured && (
              <button type="button" className="btn sm danger" onClick={() => removeM.mutate()}>
                {S.admin.tts.removeKey}
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  )
}

interface LlmData {
  provider: string
  model: string
  webSearch: boolean
  dailyLimit: number
  usage: { calls: number; tokensIn: number; tokensOut: number; cap: number }
  localUrl: string
  providers: { id: string; label: string; hasKey: boolean; configured: boolean }[]
}

// what a provider starts with when the admin switches to it (they can pick another one from the list)
const LLM_DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-haiku-5-5',
  local: 'gemma4-e4b',
}

function LlmTab() {
  const qc = useQueryClient()
  const toast = useToast()
  const fail = useErrorToast()
  const q = useQuery({ queryKey: ['admin-llm'], queryFn: () => get<LlmData>('/admin/llm') })
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [url, setUrl] = useState('')
  const [limit, setLimit] = useState('')
  const [key, setKey] = useState('')
  useEffect(() => {
    if (!q.data) return
    setProvider(q.data.provider)
    setModel(q.data.model)
    setUrl(q.data.localUrl)
    setLimit(String(q.data.dailyLimit))
  }, [q.data])
  const models = useQuery({
    queryKey: ['admin-llm-models', provider, q.data?.providers.find((p) => p.id === provider)?.configured, q.data?.localUrl],
    queryFn: () => get<{ models: string[] }>(`/admin/llm/${provider}/models`),
    enabled: !!provider && !!q.data?.providers.find((p) => p.id === provider)?.configured,
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-llm'] })
  const saveM = useMutation({
    mutationFn: async () => {
      if (key) await put(`/admin/llm/${provider}/key`, { key })
      await put('/admin/llm', {
        provider,
        model: model || undefined,
        dailyLimit: Number(limit) >= 0 && limit !== '' ? Number(limit) : undefined,
        localUrl: provider === 'local' && url ? url : undefined,
      })
    },
    onSuccess: () => {
      setKey('')
      refresh()
      qc.invalidateQueries({ queryKey: ['admin-llm-models'] })
    },
    onError: fail,
  })
  const removeM = useMutation({ mutationFn: () => del(`/admin/llm/${provider}/key`), onSuccess: refresh, onError: fail })
  const webM = useMutation({ mutationFn: (v: boolean) => put('/admin/llm', { webSearch: v }), onSuccess: refresh, onError: fail })
  const testM = useMutation({
    mutationFn: () => post<{ ok: boolean; ms?: number; error?: string }>('/admin/llm/test'),
    onSuccess: (r) => (r.ok ? toast(S.admin.llm.testOk(r.ms ?? 0)) : toast(`${S.admin.llm.testFail}: ${r.error ?? ''}`, 'danger')),
    onError: fail,
  })
  if (q.isLoading) return <Loading />
  if (q.isError || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />
  const cur = q.data.providers.find((p) => p.id === provider)
  const isLocal = provider === 'local'
  // a select of the provider's models; the current one stays listed even when the provider does not report it
  const listed = models.data?.models ?? []
  const modelOptions = listed.length && model && !listed.includes(model) ? [model, ...listed] : listed
  return (
    <div className="ar-two">
      <section className="card">
        <div className="card-h">{S.admin.llm.title}</div>
        <form
          className="card-b stack"
          style={{ gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault()
            saveM.mutate()
          }}
        >
          <div className="muted" style={{ fontSize: 12.5 }}>
            {S.admin.llm.hint}
          </div>
          <div className="field">
            <label htmlFor="llm-provider">{S.admin.llm.provider}</label>
            <select
              id="llm-provider"
              className="inp"
              value={provider}
              onChange={(e) => {
                const v = e.target.value
                setProvider(v)
                // the saved model belongs to the saved provider; another provider starts from its own default
                setModel(v === q.data?.provider ? (q.data?.model ?? '') : (LLM_DEFAULT_MODEL[v] ?? ''))
              }}
            >
              {q.data.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <div className="row" style={{ gap: 8 }}>
              <span className={`bdg${cur?.configured ? ' t-success' : ''}`}>
                {cur?.configured ? S.admin.tts.connected : S.admin.tts.notConfigured}
              </span>
            </div>
          </div>
          {isLocal && (
            <div className="field">
              <label htmlFor="llm-url">{S.admin.llm.baseUrl}</label>
              <input id="llm-url" className="inp mono" value={url} onChange={(e) => setUrl(e.target.value)} />
              <span className="msg muted">{S.admin.llm.baseUrlHint}</span>
            </div>
          )}
          <div className="field">
            <label htmlFor="llm-key">{S.admin.llm.apiKey}</label>
            <input
              id="llm-key"
              className="inp mono"
              type="password"
              autoComplete="off"
              placeholder={cur?.hasKey ? '••••••••' : ''}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <span className="msg muted">
              {cur?.hasKey ? `${S.admin.llm.keySet}. ` : ''}
              {S.admin.llm.keyHint}
            </span>
          </div>
          <div className="field">
            <label htmlFor="llm-model">{S.admin.llm.model}</label>
            {modelOptions.length > 0 ? (
              <select id="llm-model" className="inp mono" value={model} onChange={(e) => setModel(e.target.value)}>
                {!model && <option value="">—</option>}
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input id="llm-model" className="inp mono" value={model} onChange={(e) => setModel(e.target.value)} />
            )}
            <span className="msg muted">{S.admin.llm.modelHint}</span>
          </div>
          <div className="field">
            <label htmlFor="llm-limit">{S.admin.llm.dailyLimit}</label>
            <input id="llm-limit" className="inp mono" type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} />
            <span className="msg muted">{S.admin.llm.usage(q.data.usage.calls, q.data.usage.cap)}</span>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="submit" className="btn primary sm" disabled={saveM.isPending}>
              {S.admin.llm.save}
            </button>
            <button type="button" className="btn sm" disabled={testM.isPending} onClick={() => testM.mutate()}>
              {testM.isPending ? S.admin.llm.testing : S.admin.llm.test}
            </button>
            {cur?.hasKey && (
              <button type="button" className="btn sm danger" onClick={() => removeM.mutate()}>
                {S.admin.llm.removeKey}
              </button>
            )}
          </div>
        </form>
      </section>
      <section className="card">
        <div className="card-b stack" style={{ gap: 12 }}>
          <div className="row between" style={{ gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 550 }}>{S.admin.llm.webSearch}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {S.admin.llm.webSearchHint}
              </div>
            </div>
            <Switch
              on={q.data.webSearch}
              onChange={(v) => webM.mutate(v)}
              label={S.admin.llm.webSearch}
              disabled={q.data.provider !== 'anthropic'}
            />
          </div>
        </div>
      </section>
    </div>
  )
}

function DefaultLevel(p: {
  id: string
  label: string
  min: number
  max: number
  value: number
  onSave: (v: number) => void
  step?: number
  format?: (v: number) => string
}) {
  const [v, setV] = useState(p.value)
  useEffect(() => setV(p.value), [p.value])
  const commit = () => v !== p.value && p.onSave(v)
  return (
    <div className="field">
      <label htmlFor={p.id}>
        {p.label} <span className="mono">{(p.format ?? fmtDb)(v)}</span>
      </label>
      <input
        id={p.id}
        type="range"
        min={p.min}
        max={p.max}
        step={p.step ?? 1}
        value={v}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </div>
  )
}

function LocalEngineRow({ e }: { e: LocalEngine }) {
  const qc = useQueryClient()
  const player = usePlayer()
  const toast = useToast()
  const fail = useErrorToast()
  const [voice, setVoice] = useState(e.voices[0]?.key ?? '')
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-local'] })
    qc.invalidateQueries({ queryKey: ['admin-tts'] })
  }
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => put(`/admin/tts/local/${e.id}`, { enabled }),
    onSuccess: refresh,
    onError: fail,
  })
  const testM = useMutation({
    mutationFn: () =>
      post<{ ok: boolean; ms?: number; error?: string; audio?: string; mime?: string }>('/admin/tts/providers/local/test', { voice }),
    onSuccess: (r) => {
      if (!r.ok) return toast(`${S.admin.tts.testFail}: ${r.error ?? ''}`, 'danger')
      toast(S.admin.tts.testOk(r.ms ?? 0))
      player.start({
        key: `tts-test:${voice}`,
        kind: 'voice',
        src: `data:${r.mime};base64,${r.audio}`,
        title: S.admin.tts.testSample(e.label),
      })
    },
    onError: fail,
  })
  const ready = e.status === 'ready'
  return (
    <div className="card-b stack" style={{ gap: 8, borderTop: '1px solid var(--border, rgba(128,128,128,.2))' }}>
      <div className="row between" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 550 }}>{e.label}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            <span className={`bdg ${ready ? 't-success' : e.status === 'error' ? 't-danger' : ''}`}>
              {S.admin.tts.localVoices.statuses[e.status] ?? e.status}
            </span>
            {' · '}
            {S.admin.tts.localVoices.license}: {e.license}
          </div>
          {e.error ? (
            <div className="muted" style={{ fontSize: 12, wordBreak: 'break-word' }}>
              {e.error}
            </div>
          ) : null}
        </div>
        <Switch
          on={e.enabled && ready}
          disabled={!ready}
          onChange={(v) => toggle.mutate(v)}
          label={`${S.admin.tts.localVoices.enabled}: ${e.label}`}
        />
      </div>
      {ready && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select
            className="inp"
            aria-label={S.admin.tts.localVoices.voice}
            style={{ maxWidth: 260 }}
            value={voice}
            onChange={(ev) => setVoice(ev.target.value)}
          >
            {e.voices.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
          <button type="button" className="btn" disabled={testM.isPending || !voice} onClick={() => testM.mutate()}>
            {testM.isPending ? S.admin.tts.localVoices.testing : S.admin.tts.localVoices.test}
          </button>
        </div>
      )}
    </div>
  )
}

function LocalCard() {
  const q = useQuery({
    queryKey: ['admin-local'],
    queryFn: () => get<LocalData>('/admin/tts/local'),
    // models load for minutes on the first start: poll while something is not ready
    refetchInterval: (query) => (query.state.data?.engines.some((e) => e.status === 'loading' || e.status === 'idle') ? 5000 : 30000),
  })
  return (
    <section className="card" style={{ overflow: 'hidden' }}>
      <div className="card-h">{S.admin.tts.localVoices.title}</div>
      <div className="card-b">
        <div className="muted" style={{ fontSize: 12.5 }}>
          {S.admin.tts.localVoices.hint}
        </div>
        {q.data && !q.data.configured ? <div className="muted">{S.admin.tts.localVoices.notConfigured}</div> : null}
        {q.data?.configured && !q.data.reachable ? <div className="muted">{S.admin.tts.localVoices.unavailable}</div> : null}
      </div>
      {q.data?.engines.map((e) => (
        <LocalEngineRow key={e.id} e={e} />
      ))}
    </section>
  )
}

interface PiperRow {
  id: string
  key: string
  name: string
  lang: string
  langCode: string
  quality: string
  sizeBytes: number
  speakers: number
  downloaded: boolean
  downloading: { received: number; total: number } | null
  enabled: boolean
  builtin: boolean
}

function PiperCard() {
  const qc = useQueryClient()
  const toast = useToast()
  const player = usePlayer()
  const fail = useErrorToast()
  const [lang, setLang] = useState('uk')
  const q = useQuery({
    queryKey: ['admin-piper'],
    queryFn: () => get<{ voices: PiperRow[]; languages: string[]; lastFetched: number | null }>('/admin/tts/piper?lang=all'),
    // progress bars while something is being downloaded
    refetchInterval: (query) => (query.state.data?.voices.some((v) => v.downloading) ? 1500 : false),
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-piper'] })
    qc.invalidateQueries({ queryKey: ['admin-tts'] })
  }
  const reload = useMutation({
    mutationFn: () => post('/admin/tts/piper/refresh'),
    onSuccess: () => {
      toast(S.admin.tts.piper.refreshed)
      refresh()
    },
    onError: fail,
  })
  const download = useMutation({ mutationFn: (id: string) => post(`/admin/tts/piper/${id}/download`), onSuccess: refresh, onError: fail })
  const remove = useMutation({ mutationFn: (id: string) => del(`/admin/tts/piper/${id}`), onSuccess: refresh, onError: fail })
  const toggle = useMutation({
    mutationFn: (v: { key: string; enabled: boolean }) => put(`/admin/tts/voices/${encodeURIComponent(v.key)}`, { enabled: v.enabled }),
    onSuccess: refresh,
    onError: fail,
  })
  const test = useMutation({
    mutationFn: (key: string) =>
      post<{ ok: boolean; error?: string; audio?: string; mime?: string }>('/admin/tts/providers/piper/test', { voice: key }),
    onSuccess: (r, key) => {
      if (!r.ok) return toast(`${S.admin.tts.testFail}: ${r.error ?? ''}`, 'danger')
      if (r.audio)
        player.start({ key: `tts-test:${key}`, kind: 'voice', src: `data:${r.mime};base64,${r.audio}`, title: S.admin.tts.testSample(key) })
    },
    onError: fail,
  })
  const [other, setOther] = useState('')
  const tabs = [...LANGS, 'all'].map((id) => ({ id, label: S.admin.tts.piper.langs[id] ?? LANG_NAMES[id as Lang] ?? id }))
  const voices = (q.data?.voices ?? []).filter((v) => (lang === 'all' ? !other || v.lang === other : v.lang === lang))
  return (
    <section className="card">
      <div className="card-h" style={{ justifyContent: 'space-between' }}>
        {S.admin.tts.piper.title}
        <button type="button" className="btn sm" disabled={reload.isPending} onClick={() => reload.mutate()}>
          {S.admin.tts.piper.refresh}
        </button>
      </div>
      <div className="card-b stack" style={{ gap: 12 }}>
        <div className="muted" style={{ fontSize: 12.5 }}>
          {S.admin.tts.piper.hint}
        </div>
        <Seg value={lang} options={tabs} onChange={setLang} label={S.admin.tts.piper.title} style={{ flexWrap: 'wrap' }} />
        {lang === 'all' && (
          <select className="inp" aria-label={S.admin.tts.piper.langs.all} value={other} onChange={(e) => setOther(e.target.value)}>
            <option value="">{S.admin.tts.piper.langs.all}</option>
            {(q.data?.languages ?? []).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        )}
        {q.isLoading ? (
          <Loading />
        ) : voices.length === 0 ? (
          <div className="muted">{S.admin.tts.piper.empty}</div>
        ) : (
          voices.map((v) => {
            const pct = v.downloading?.total ? Math.min(99, Math.round((v.downloading.received / v.downloading.total) * 100)) : 0
            return (
              <div className="row between" style={{ gap: 10, flexWrap: 'wrap' }} key={v.id}>
                <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                  <div style={{ fontWeight: 550 }}>
                    {v.name}{' '}
                    <span className="mono muted">
                      {v.langCode} · {v.quality}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {fmtBytes(v.sizeBytes)}
                    {v.speakers > 0 ? ` · ${S.admin.tts.piper.speakers(v.speakers)}` : ''}
                    {' · '}
                    {v.downloading
                      ? S.admin.tts.piper.downloading(pct)
                      : v.downloaded
                        ? S.admin.tts.piper.downloaded
                        : S.admin.tts.piper.notDownloaded}
                    {v.builtin ? ` · ${S.admin.tts.piper.builtin}` : ''}
                  </div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {v.downloaded ? (
                    <>
                      <button type="button" className="btn sm" disabled={test.isPending} onClick={() => test.mutate(v.key)}>
                        {S.admin.tts.piper.test}
                      </button>
                      {!v.builtin && (
                        <button
                          type="button"
                          className="btn sm danger"
                          onClick={() => confirm(S.admin.tts.piper.removeConfirm(v.name)) && remove.mutate(v.id)}
                        >
                          {S.admin.tts.piper.remove}
                        </button>
                      )}
                      <Switch
                        on={v.enabled}
                        onChange={(enabled) => toggle.mutate({ key: v.key, enabled })}
                        label={`${S.admin.tts.piper.enabled}: ${v.name}`}
                      />
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={!!v.downloading || download.isPending}
                      onClick={() => download.mutate(v.id)}
                    >
                      {S.admin.tts.piper.download}
                    </button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}

// 'Piper', 'Gemini', ... ; a local voice shows its engine ('local:silero/xenia' -> 'Silero')
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const voiceSource = (v: { provider: string; key: string }) =>
  v.provider === 'local' ? cap1(v.key.slice('local:'.length).split('/')[0] ?? 'local') : cap1(v.provider)

function TtsTab() {
  const qc = useQueryClient()
  const fail = useErrorToast()
  const q = useQuery({ queryKey: ['admin-tts'], queryFn: () => get<TtsData>('/admin/tts') })
  const st = useQuery({ queryKey: ['admin-settings'], queryFn: () => get<AdminSettings>('/admin/settings') })
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-tts'] })
  const toggle = useMutation({
    mutationFn: (v: { key: string; enabled: boolean }) => put(`/admin/tts/voices/${encodeURIComponent(v.key)}`, { enabled: v.enabled }),
    onSuccess: refresh,
    onError: fail,
  })
  const makeDefault = useMutation({
    mutationFn: (voice: string) => put('/admin/tts/default', { voice }),
    onSuccess: refresh,
    onError: fail,
  })
  const setS = useMutation({
    mutationFn: (b: Partial<AdminSettings>) => put('/admin/settings', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-settings'] }),
    onError: fail,
  })
  if (q.isLoading) return <Loading />
  if (q.isError || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />
  const limit = st.data?.messageLimitPerHour ?? 60
  return (
    <div className="ar-two">
      <div className="stack" style={{ gap: 16 }}>
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="card-h" style={{ justifyContent: 'space-between' }}>
            {S.admin.tts.providers}
            <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>
              {S.admin.tts.keysEncrypted}
            </span>
          </div>
          {q.data.providers.map((p) => (
            <ProviderRow key={p.id} p={p} voices={q.data.voices} />
          ))}
        </section>
        <PiperCard />
        <LocalCard />
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <section className="card">
          <div className="card-h">{S.admin.tts.voices}</div>
          <div className="card-b stack" style={{ gap: 12 }}>
            {q.data.voices
              .filter((v) => !v.id.includes('#') && (v.provider !== 'local' || v.engineOn))
              .map((v) => (
                <div className="row between" style={{ gap: 12 }} key={v.key}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 550 }}>
                      {v.label} · {voiceSource(v)}
                      {LANG_TAG[v.lang] ? ` · ${LANG_TAG[v.lang]}` : ''}
                    </div>
                    {v.isDefault ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {S.admin.tts.defaultForNew}
                      </div>
                    ) : !v.providerConfigured ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {S.admin.tts.providerOff}
                      </div>
                    ) : v.enabled ? (
                      <button
                        type="button"
                        style={{
                          fontSize: 12,
                          background: 'none',
                          border: 0,
                          padding: 0,
                          color: 'var(--brand-primary)',
                          cursor: 'pointer',
                        }}
                        onClick={() => makeDefault.mutate(v.key)}
                      >
                        {S.admin.tts.makeDefault}
                      </button>
                    ) : null}
                  </div>
                  <Switch
                    on={v.enabled && v.providerConfigured}
                    disabled={!v.providerConfigured}
                    onChange={(enabled) => toggle.mutate({ key: v.key, enabled })}
                    label={v.label}
                  />
                </div>
              ))}
            <div className="field">
              {/* biome-ignore lint/a11y/noLabelWithoutControl: caption of the two sliders below */}
              <label>{S.admin.tts.levelsDefaults}</label>
            </div>
            <DefaultLevel
              id="ar-def-music"
              label={S.admin.tts.defaultMusic}
              min={-30}
              max={6}
              value={st.data?.defaultMusicGainDb ?? 0}
              onSave={(defaultMusicGainDb) => setS.mutate({ defaultMusicGainDb })}
            />
            <DefaultLevel
              id="ar-def-voice"
              label={S.admin.tts.defaultVoiceLevel}
              min={-12}
              max={12}
              value={st.data?.defaultVoiceGainDb ?? 0}
              onSave={(defaultVoiceGainDb) => setS.mutate({ defaultVoiceGainDb })}
            />
            <DefaultLevel
              id="ar-def-rate"
              label={S.admin.tts.defaultRate}
              min={0.8}
              max={1.6}
              step={0.05}
              format={fmtRate}
              value={st.data?.defaultSpeechRate ?? 1}
              onSave={(defaultSpeechRate) => setS.mutate({ defaultSpeechRate })}
            />
            <div className="field">
              <label htmlFor="ar-lim">{S.admin.tts.limit}</label>
              <select
                id="ar-lim"
                className="inp"
                value={[20, 60, 0].includes(limit) ? limit : 60}
                onChange={(e) => setS.mutate({ messageLimitPerHour: Number(e.target.value) })}
              >
                {[60, 20, 0].map((n) => (
                  <option key={n} value={n}>
                    {S.admin.tts.limits[n]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>
        <section className="card">
          <div className="card-h">{S.admin.tts.audioLimits}</div>
          <div className="card-b stack" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="ar-mb">{S.admin.tts.maxMb}</label>
              <input
                id="ar-mb"
                className="inp"
                type="number"
                min={1}
                max={2000}
                defaultValue={st.data?.maxAudioMb}
                key={st.data?.maxAudioMb}
                onBlur={(e) => e.target.value && setS.mutate({ maxAudioMb: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label htmlFor="ar-min">{S.admin.tts.maxMin}</label>
              <input
                id="ar-min"
                className="inp"
                type="number"
                min={1}
                max={240}
                defaultValue={st.data?.maxAudioMinutes}
                key={st.data?.maxAudioMinutes}
                onBlur={(e) => e.target.value && setS.mutate({ maxAudioMinutes: Number(e.target.value) })}
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

interface LibStatus {
  dir: string
  total: number
  totalSize: number
  scanning: boolean
  lastScan: { added: number; updated: number; removed: number } | null
  disk: { freeBytes: number; totalBytes: number } | null
}

function LibTab() {
  const qc = useQueryClient()
  const fail = useErrorToast()
  const q = useQuery({
    queryKey: ['admin-lib'],
    queryFn: () => get<LibStatus>('/admin/library'),
    refetchInterval: (query) => (query.state.data?.scanning ? 1500 : 15_000),
  })
  const rescan = useMutation({
    mutationFn: () => post('/admin/library/rescan'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-lib'] }),
    onError: fail,
  })
  const st = useQuery({ queryKey: ['admin-settings'], queryFn: () => get<AdminSettings>('/admin/settings') })
  const setS = useMutation({
    mutationFn: (b: Partial<AdminSettings>) => put('/admin/settings', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-settings'] }),
    onError: fail,
  })
  const [quota, setQuota] = useState<string | null>(null)
  if (q.isLoading) return <Loading />
  if (q.isError || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />
  const l = q.data
  const low = l.disk ? l.disk.freeBytes < 2 * 1024 ** 3 || l.disk.freeBytes / l.disk.totalBytes < 0.05 : false
  return (
    <section className="card">
      <div className="card-h">{S.admin.lib.title}</div>
      <div className="ar-prov">
        <div className="grow" style={{ flex: 1 }}>
          <div className="mono" style={{ fontSize: 12.5 }}>
            {l.dir}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {S.admin.lib.scanned(l.total, fmtBytes(l.totalSize))}
            {l.lastScan ? ` · ${S.admin.lib.lastScan(l.lastScan.added, l.lastScan.updated, l.lastScan.removed)}` : ''}
          </div>
        </div>
        <span className={`bdg${l.scanning ? '' : ' t-success'}`}>{l.scanning ? S.admin.lib.scanning : S.admin.lib.ready}</span>
        <button type="button" className="btn sm" disabled={l.scanning || rescan.isPending} onClick={() => rescan.mutate()}>
          {S.admin.lib.rescan}
        </button>
      </div>
      <div className="ar-prov">
        <div className="grow" style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{S.admin.lib.disk}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {l.disk ? S.admin.lib.diskFree(fmtBytes(l.disk.freeBytes), fmtBytes(l.disk.totalBytes)) : S.admin.lib.diskUnknown}
          </div>
        </div>
        {l.disk && <span className={`bdg ${low ? 't-danger' : 't-success'}`}>{fmtBytes(l.disk.freeBytes)}</span>}
      </div>
      <div className="ar-prov">
        <div className="grow" style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{S.admin.lib.allowUserUploads}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {S.admin.lib.allowUserUploadsHint}
          </div>
        </div>
        {st.data && (
          <Switch
            on={st.data.allowUserUploads}
            label={S.admin.lib.allowUserUploads}
            disabled={setS.isPending}
            onChange={(v) => setS.mutate({ allowUserUploads: v })}
          />
        )}
      </div>
      {st.data && (
        <div className="ar-prov">
          <label htmlFor="up-quota" className="grow" style={{ flex: 1, fontWeight: 600 }}>
            {S.admin.lib.quotaMb}
          </label>
          <input
            id="up-quota"
            className="inp mono"
            type="number"
            min={1}
            style={{ width: 120 }}
            value={quota ?? st.data.uploadQuotaMb}
            onChange={(e) => setQuota(e.target.value)}
            onBlur={() => {
              const n = Math.round(Number(quota))
              if (quota !== null && n >= 1 && n !== st.data?.uploadQuotaMb) setS.mutate({ uploadQuotaMb: n })
              setQuota(null)
            }}
          />
        </div>
      )}
      <div className="card-b">
        <div className="banner" role="status">
          <div>{S.admin.lib.banner}</div>
        </div>
      </div>
    </section>
  )
}

interface PresetRow {
  id: string
  name: string
  description: string
  url: string
  listeners: number
}

function PresetsTab() {
  const qc = useQueryClient()
  const fail = useErrorToast()
  const q = useQuery({ queryKey: ['admin-presets'], queryFn: () => get<{ presets: PresetRow[] }>('/admin/presets') })
  const st = useQuery({ queryKey: ['admin-settings'], queryFn: () => get<AdminSettings>('/admin/settings') })
  const [health, setHealth] = useState<Record<string, 'ok' | 'slow' | 'down' | 'checking'>>({})
  const [form, setForm] = useState<{ id: string | null; name: string; description: string; url: string } | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-presets'] })

  const checkAll = (rows: PresetRow[]) => {
    setHealth(Object.fromEntries(rows.map((r) => [r.id, 'checking' as const])))
    for (const r of rows) {
      post<{ status: 'ok' | 'slow' | 'down' }>('/admin/presets/check', { url: r.url }).then(
        (res) => setHealth((h) => ({ ...h, [r.id]: res.status })),
        () => setHealth((h) => ({ ...h, [r.id]: 'down' })),
      )
    }
  }
  const firstLoad = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: checkAll only sets state; it must run once per fresh list
  useEffect(() => {
    if (q.data && firstLoad.current) {
      firstLoad.current = false
      checkAll(q.data.presets)
    }
  }, [q.data])

  const save = useMutation({
    mutationFn: () => {
      if (!form) return Promise.resolve({})
      const body = { name: form.name, description: form.description, url: form.url }
      return form.id ? put(`/admin/presets/${form.id}`, body) : post('/admin/presets', body)
    },
    onSuccess: () => {
      setForm(null)
      firstLoad.current = true
      refresh()
    },
    onError: fail,
  })
  const remove = useMutation({ mutationFn: (id: string) => del(`/admin/presets/${id}`), onSuccess: refresh, onError: fail })
  const setS = useMutation({
    mutationFn: (b: Partial<AdminSettings>) => put('/admin/settings', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-settings'] }),
    onError: fail,
  })

  if (q.isLoading) return <Loading />
  if (q.isError || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />
  const badge = (id: string) => {
    const h = health[id]
    if (!h || h === 'checking') return <span className="bdg">{S.admin.presets.checking}</span>
    if (h === 'ok') return <span className="bdg t-success">{S.admin.presets.ok}</span>
    if (h === 'slow') return <span className="bdg t-warning">{S.admin.presets.slow}</span>
    return <span className="bdg t-danger">{S.admin.presets.down}</span>
  }
  return (
    <section className="card" style={{ overflow: 'hidden' }}>
      <div className="card-h" style={{ justifyContent: 'space-between' }}>
        {S.admin.presets.title}
        <span className="row" style={{ gap: 8 }}>
          <button type="button" className="btn sm" onClick={() => checkAll(q.data.presets)}>
            {S.admin.presets.checkAll}
          </button>
          <button type="button" className="btn sm" onClick={() => setForm({ id: null, name: '', description: '', url: '' })}>
            <Plus size={14} aria-hidden="true" />
            {S.admin.presets.add}
          </button>
        </span>
      </div>
      {form && (
        <form
          className="card-b stack"
          style={{ gap: 10, borderBottom: '1px solid var(--border)' }}
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <div className="field">
            <label htmlFor="pr-name">{S.admin.presets.name}</label>
            <input id="pr-name" className="inp" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pr-desc">{S.admin.presets.description}</label>
            <input
              id="pr-desc"
              className="inp"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="pr-url">{S.admin.presets.url}</label>
            <input
              id="pr-url"
              className="inp mono"
              type="url"
              required
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn primary sm" disabled={save.isPending}>
              {S.common.save}
            </button>
            <button type="button" className="btn sm" onClick={() => setForm(null)}>
              {S.common.cancel}
            </button>
          </div>
        </form>
      )}
      {q.data.presets.map((p) => (
        <div className="ar-prov" key={p.id}>
          <div className="grow" style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{p.name}</div>
            <div className="mono muted ell" style={{ fontSize: 12 }}>
              {p.url}
            </div>
          </div>
          {badge(p.id)}
          <span className="muted" style={{ fontSize: 12, minWidth: 64, textAlign: 'right' }}>
            {S.admin.presets.listening(p.listeners)}
          </span>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => setForm({ id: p.id, name: p.name, description: p.description, url: p.url })}
          >
            {S.admin.presets.edit}
          </button>
          <button
            type="button"
            className="btn sm danger"
            onClick={() => confirm(`${S.admin.presets.remove}: ${p.name}?`) && remove.mutate(p.id)}
          >
            {S.admin.presets.remove}
          </button>
        </div>
      ))}
      <div className="card-b row between" style={{ gap: 12 }}>
        <div>
          <div style={{ fontWeight: 550 }}>{S.admin.presets.allowOwn}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {S.admin.presets.allowOwnHint}
          </div>
        </div>
        <Switch
          on={st.data?.allowOwnUrls ?? true}
          onChange={(allowOwnUrls) => setS.mutate({ allowOwnUrls })}
          label={S.admin.presets.allowOwn}
        />
      </div>
    </section>
  )
}

interface ServerInfo {
  engine: { up: boolean; stations: number }
  listeners: number
  publicUrl: string
  messagesToday: number
  skippedToday: number
  users: number
  version: string
}

function ServerTab() {
  const toast = useToast()
  const fail = useErrorToast()
  const q = useQuery({ queryKey: ['admin-server'], queryFn: () => get<ServerInfo>('/admin/server'), refetchInterval: 10_000 })
  const restart = useMutation({
    mutationFn: () => post('/admin/engine/restart'),
    onSuccess: () => toast(S.admin.server.restarted),
    onError: fail,
  })
  if (q.isLoading) return <Loading />
  if (q.isError || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />
  const s = q.data
  return (
    <div className="ar-two">
      <section className="card">
        <div className="card-h">{S.admin.server.state}</div>
        <div className="card-b stack" style={{ gap: 10 }}>
          <div className="row between">
            <span className="muted">{S.admin.server.engine}</span>
            <span className={`bdg ${s.engine.up ? 't-success' : 't-danger'}`}>
              {s.engine.up ? S.admin.server.engineUp(s.engine.stations) : S.admin.server.engineDown}
            </span>
          </div>
          <div className="row between">
            <span className="muted">{S.admin.server.address}</span>
            <span className="mono" style={{ fontSize: 12.5 }}>
              {s.publicUrl}
            </span>
          </div>
          <div className="row between">
            <span className="muted">{S.admin.server.messagesToday}</span>
            <span className="mono">{S.admin.server.messagesLine(s.messagesToday, s.skippedToday)}</span>
          </div>
        </div>
      </section>
      <section className="card">
        <div className="card-h">{S.admin.server.maintenance}</div>
        <div className="card-b stack" style={{ gap: 10 }}>
          <button
            type="button"
            className="btn"
            style={{ alignSelf: 'flex-start' }}
            disabled={restart.isPending}
            onClick={() => confirm(S.admin.server.restartConfirm) && restart.mutate()}
          >
            {S.admin.server.restart}
          </button>
          <a className="btn" style={{ alignSelf: 'flex-start' }} href="/api/admin/backup" download>
            {S.admin.server.backup}
          </a>
          <div className="muted" style={{ fontSize: 12 }}>
            {S.admin.server.restartHint}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {S.admin.server.backupHint}
          </div>
        </div>
      </section>
    </div>
  )
}

export function Admin() {
  const [tab, setTab] = useState<Tab>('users')
  const server = useQuery({ queryKey: ['admin-server'], queryFn: () => get<ServerInfo>('/admin/server'), refetchInterval: 10_000 })
  const tabs: Tab[] = ['users', 'tts', 'llm', 'learn', 'lib', 'presets', 'server']
  return (
    <Shell crumb={S.nav.admin}>
      <PageHead
        title={S.admin.title}
        sub={
          server.data ? S.admin.sub(server.data.users, server.data.engine.stations, server.data.listeners, server.data.version) : undefined
        }
      />
      <div className="ar-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            type="button"
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`ar-tab${tab === t ? ' on' : ''}`}
            onClick={() => setTab(t)}
          >
            {S.admin.tabs[t]}
          </button>
        ))}
      </div>
      {tab === 'users' && <UsersTab />}
      {tab === 'tts' && <TtsTab />}
      {tab === 'llm' && <LlmTab />}
      {tab === 'learn' && <LearnTab />}
      {tab === 'lib' && <LibTab />}
      {tab === 'presets' && <PresetsTab />}
      {tab === 'server' && <ServerTab />}
    </Shell>
  )
}
