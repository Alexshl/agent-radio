// "Быстрые команды iPhone": a control token and ready URLs for the Shortcuts app ("Get Contents of URL"). The secret is shown once, right
// after it is created; the server keeps only its hash.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, Copy, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { del, get, post } from '../api/client'
import { useRadio } from '../api/hooks'
import type { ControlTokenInfo } from '../api/types'
import { S } from '../i18n'
import { fmtWhenInline } from '../lib/format'
import { useToast } from './Toast'
import { copyText, useErrorToast } from './ui'

interface Row {
  key: string
  title: string
  kind: string
  method: 'GET' | 'POST'
  url: string
}

export function ShortcutsCard() {
  const qc = useQueryClient()
  const toast = useToast()
  const fail = useErrorToast()
  const radio = useRadio()
  const folders = useQuery({
    queryKey: ['library-folders'],
    queryFn: () => get<{ folders: { path: string }[]; total: number }>('/app/library/folders'),
  })
  const info = useQuery({ queryKey: ['control-token'], queryFn: () => get<{ token: ControlTokenInfo | null }>('/app/control-token') })
  // the secret exists only here, right after create / regenerate
  const [secret, setSecret] = useState<string | null>(null)

  const issue = useMutation({
    mutationFn: () => post<{ secret: string; token: ControlTokenInfo }>('/app/control-token'),
    onSuccess: (r) => {
      setSecret(r.secret)
      qc.invalidateQueries({ queryKey: ['control-token'] })
    },
    onError: fail,
  })
  const reveal = useMutation({
    mutationFn: () => post<{ secret: string }>('/app/control-token/reveal'),
    onSuccess: (r) => setSecret(r.secret),
    onError: fail,
  })
  const revoke = useMutation({
    mutationFn: () => del('/app/control-token'),
    onSuccess: () => {
      setSecret(null)
      qc.invalidateQueries({ queryKey: ['control-token'] })
    },
    onError: fail,
  })

  const token = info.data?.token ?? null
  const copy = async (text: string) => toast((await copyText(text)) ? S.common.copied : S.common.error)
  const T = S.shortcuts

  const rows: Row[] = (() => {
    if (!secret) return []
    const base = `${window.location.origin}/api/control`
    const k = encodeURIComponent(secret)
    const src = (kind: string, id?: string) =>
      `${base}/source?k=${k}&kind=${kind}${id === undefined ? '' : `&id=${encodeURIComponent(id)}`}`
    const post_ = (key: string, title: string, kind: string, url: string): Row => ({ key, title, kind, method: 'POST', url })
    return [
      post_('r1', T.replay1, T.kinds.replay, `${base}/replay?k=${k}&count=1`),
      post_('r2', T.replay2, T.kinds.replay, `${base}/replay?k=${k}&count=2`),
      post_('r3', T.replay3, T.kinds.replay, `${base}/replay?k=${k}&count=3`),
      post_('silence', T.silence, T.kinds.source, src('silence')),
      post_('all', T.library, T.kinds.folder, src('all')),
      ...(radio.data?.playlists ?? []).map((p) => post_(`pl:${p.id}`, p.name, T.kinds.playlist, src('playlist', p.id))),
      ...(folders.data?.folders ?? []).map((f) => post_(`dir:${f.path}`, f.path, T.kinds.folder, src('folder', f.path))),
      ...(radio.data?.presets ?? []).map((p) => post_(`st:${p.id}`, p.name, T.kinds.station, src('station', p.id))),
      { key: 'status', title: T.statusTitle, kind: T.kinds.status, method: 'GET', url: `${base}/status?k=${k}` },
    ]
  })()

  return (
    <section className="card">
      <div className="card-h" style={{ justifyContent: 'space-between' }}>
        {T.title}
      </div>
      <div className="card-b stack" style={{ gap: 16 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          {T.sub}
        </div>

        {!token && (
          <div className="stack" style={{ gap: 10, alignItems: 'flex-start' }}>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {T.noToken}
            </div>
            <button type="button" className="btn primary" disabled={issue.isPending} onClick={() => issue.mutate()}>
              {T.create}
            </button>
          </div>
        )}

        {token && (
          <div className="row between wrap" style={{ gap: 10 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {token.lastUsedAt ? T.lastUsed(fmtWhenInline(token.lastUsedAt)) : T.neverUsed}
            </span>
            <div className="row wrap" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn sc-btn"
                disabled={issue.isPending}
                onClick={() => confirm(T.regenerateConfirm) && issue.mutate()}
              >
                {T.regenerate}
              </button>
              <button
                type="button"
                className="btn sc-btn danger"
                disabled={revoke.isPending}
                onClick={() => confirm(T.revokeConfirm) && revoke.mutate()}
              >
                {T.revoke}
              </button>
            </div>
          </div>
        )}

        {token && !secret && (
          <div className="stack" style={{ gap: 10, alignItems: 'flex-start' }}>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {T.hiddenNote}
            </div>
            <button type="button" className="btn primary sc-btn" disabled={reveal.isPending} onClick={() => reveal.mutate()}>
              {T.show}
            </button>
          </div>
        )}

        {token && secret && (
          <>
            <div className="banner t-success" role="status" style={{ alignItems: 'flex-start' }}>
              <CircleCheck size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
              <div className="stack" style={{ gap: 8, minWidth: 0, flex: 1 }}>
                <div>{T.createdNote}</div>
                <div className="sc-copyline">
                  <span className="muted" style={{ fontSize: 12, flex: 'none' }}>
                    {T.tokenLabel}
                  </span>
                  <code className="mono sc-url">{secret}</code>
                  <button type="button" className="btn icon sc-copy" aria-label={T.copyToken} onClick={() => copy(secret)}>
                    <Copy size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>

            <div className="stack" style={{ gap: 0 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{T.actions}</div>
              <div className="sc-list">
                {rows.map((row) => (
                  <div className="sc-row" key={row.key}>
                    <div className="sc-main">
                      <div className="sc-title">{row.title}</div>
                      <div className="muted sc-meta">
                        {row.method} · {row.kind}
                      </div>
                      <code className="mono sc-url">{row.url}</code>
                    </div>
                    <button
                      type="button"
                      className="btn icon sc-copy"
                      aria-label={`${T.copyLink}: ${row.title}`}
                      onClick={() => copy(row.url)}
                    >
                      <Copy size={16} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="stack" style={{ gap: 8 }}>
          <div style={{ fontWeight: 600 }}>{T.stepsTitle}</div>
          <ol className="sc-steps">
            {T.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {T.menuTip}
          </div>
        </div>

        <div className="banner t-warning" role="note" style={{ alignItems: 'flex-start' }}>
          <TriangleAlert size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
          <div style={{ minWidth: 0 }}>{T.warn}</div>
        </div>
      </div>
    </section>
  )
}
