import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, Copy } from 'lucide-react'
import { useState } from 'react'
import { del, get, post } from '../api/client'
import type { ApiKey } from '../api/types'
import { useToast } from '../components/Toast'
import { ErrorBox, Loading, PageHead, copyText, useErrorToast } from '../components/ui'
import { S } from '../i18n'
import { Shell } from '../layouts/Shell'
import { fmtDate, fmtWhen, fmtWhenInline } from '../lib/format'

const WHEN = { today: S.common.today, yesterday: S.common.yesterday, never: S.connect.noCalls }

function ago(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return S.connect.justNow
  if (min < 60) return S.connect.minAgo(min)
  return fmtWhenInline(iso)
}

export function Connect() {
  const qc = useQueryClient()
  const toast = useToast()
  const fail = useErrorToast()
  const keys = useQuery({ queryKey: ['keys'], queryFn: () => get<{ keys: ApiKey[] }>('/app/keys'), refetchInterval: 10_000 })
  const info = useQuery({ queryKey: ['connect'], queryFn: () => get<{ publicUrl: string }>('/app/connect') })
  const [name, setName] = useState('')
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null)

  const create = useMutation({
    mutationFn: () => post<{ key: ApiKey; token: string }>('/app/keys', { name: name.trim() }),
    onSuccess: (r) => {
      setCreated({ name: r.key.name, token: r.token })
      setName('')
      qc.invalidateQueries({ queryKey: ['keys'] })
      qc.invalidateQueries({ queryKey: ['radio'] })
    },
    onError: fail,
  })
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/app/keys/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['keys'] })
      qc.invalidateQueries({ queryKey: ['radio'] })
    },
    onError: fail,
  })

  const url = info.data?.publicUrl ?? location.origin
  const prompt = S.connect.prompt(url)
  const copy = async (text: string) => toast((await copyText(text)) ? S.common.copied : S.common.error)
  const list = keys.data?.keys ?? []
  const active = list.filter((k) => !k.revokedAt)
  const latest = [...active].filter((k) => k.lastUsedAt).sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))[0]

  return (
    <Shell crumb={S.nav.connect}>
      <PageHead title={S.connect.title} sub={S.connect.sub} />
      <section className="card">
        <div className="card-b stack" style={{ gap: 22 }}>
          <div className="ar-step">
            <span className="ar-num">1</span>
            <div className="stack" style={{ gap: 10, flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{S.connect.step1}</div>
              <form
                className="row wrap"
                style={{ gap: 8 }}
                onSubmit={(e) => {
                  e.preventDefault()
                  if (name.trim()) create.mutate()
                }}
              >
                <input
                  className="inp"
                  value={name}
                  placeholder={S.connect.keyNamePlaceholder}
                  aria-label={S.connect.keyName}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                  style={{ flex: '0 1 260px' }}
                />
                <button type="submit" className="btn primary" disabled={!name.trim() || create.isPending}>
                  {S.connect.createKey}
                </button>
              </form>
              {created && (
                <div className="banner t-success" role="status" style={{ alignItems: 'flex-start' }}>
                  <CircleCheck size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
                  <div className="stack" style={{ gap: 6, minWidth: 0, flex: 1 }}>
                    <div>{S.connect.keyCreated(created.name)}</div>
                    <div className="row" style={{ gap: 8 }}>
                      <code
                        className="mono"
                        style={{
                          fontSize: 12.5,
                          padding: '6px 10px',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          overflowWrap: 'anywhere',
                          color: 'var(--foreground)',
                        }}
                      >
                        {created.token}
                      </code>
                      <button type="button" className="btn icon sm" aria-label={S.connect.copyKey} onClick={() => copy(created.token)}>
                        <Copy size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="ar-step">
            <span className="ar-num">2</span>
            <div className="stack" style={{ gap: 10, flex: 1, minWidth: 0 }}>
              <div className="row between wrap" style={{ gap: 8 }}>
                <div style={{ fontWeight: 600 }}>{S.connect.step2}</div>
                <button type="button" className="btn sm" onClick={() => copy(prompt)}>
                  <Copy size={14} aria-hidden="true" />
                  {S.connect.copyPrompt}
                </button>
              </div>
              <pre className="ar-code">{prompt}</pre>
              <div className="muted" style={{ fontSize: 12 }}>
                {S.connect.promptHint}
              </div>
            </div>
          </div>

          <div className="ar-step">
            <span className="ar-num">3</span>
            <div className="stack" style={{ gap: 8, flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{S.connect.step3}</div>
              <div className="row wrap" style={{ gap: 10 }}>
                {latest?.lastUsedAt ? (
                  <>
                    <span className="bdg t-success">{S.connect.connectedAgo(latest.name, ago(latest.lastUsedAt))}</span>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      {S.connect.testHeard}
                    </span>
                  </>
                ) : (
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {S.connect.notConnected}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-h" style={{ justifyContent: 'space-between' }}>
          {S.connect.keys}
          <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>
            {S.connect.active(active.length)}
          </span>
        </div>
        {keys.isLoading && <Loading />}
        {keys.isError && <ErrorBox error={keys.error} onRetry={() => keys.refetch()} />}
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 720 }}>
            <div className="ar-keyrow ar-keyhead">
              <span>{S.connect.colComputer}</span>
              <span>{S.connect.colKey}</span>
              <span>{S.connect.colCreated}</span>
              <span>{S.connect.colLast}</span>
              <span />
            </div>
            {list.map((k) => (
              <div className="ar-keyrow" key={k.id}>
                <span style={{ fontWeight: 600 }}>{k.name}</span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {k.prefix}…
                </span>
                <span className="mono muted" style={{ fontSize: 12 }}>
                  {fmtDate(k.createdAt)}
                </span>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {k.lastUsedAt ? `${fmtWhen(k.lastUsedAt, WHEN)}${k.lastSession ? ` · ${k.lastSession}` : ''}` : S.connect.noCalls}
                </span>
                <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  {k.revokedAt ? (
                    <span className="bdg">{S.connect.revoked}</span>
                  ) : (
                    <button
                      type="button"
                      className="btn sm danger"
                      onClick={() => confirm(S.connect.revokeConfirm(k.name)) && revoke.mutate(k.id)}
                    >
                      {S.connect.revoke}
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </Shell>
  )
}
