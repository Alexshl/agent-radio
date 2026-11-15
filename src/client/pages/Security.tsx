import { startRegistration } from '@simplewebauthn/browser'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { del, get, post } from '../api/client'
import { useToast } from '../components/Toast'
import { ErrorBox, Loading, PageHead, useErrorToast } from '../components/ui'
import { S } from '../i18n'
import { Shell } from '../layouts/Shell'
import { fmtWhen } from '../lib/format'

interface PasskeyInfo {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

function PasswordCard() {
  const toast = useToast()
  const fail = useErrorToast()
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const change = useMutation({
    mutationFn: () => post('/auth/password', { current, password }),
    onSuccess: () => {
      setCurrent('')
      setPassword('')
      toast(S.security.passwordChanged)
    },
    onError: fail,
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    change.mutate()
  }
  return (
    <section className="card">
      <div className="card-h">{S.security.passwordTitle}</div>
      <form className="card-b stack" style={{ gap: 12, maxWidth: 420 }} onSubmit={submit}>
        <div className="field">
          <label htmlFor="sec-current">{S.security.current}</label>
          <input
            id="sec-current"
            className="inp"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="sec-new">{S.security.newPassword}</label>
          <input
            id="sec-new"
            className="inp"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="msg muted">{S.security.passwordHint}</span>
        </div>
        <div>
          <button type="submit" className="btn primary" disabled={change.isPending}>
            {S.security.changePassword}
          </button>
        </div>
      </form>
    </section>
  )
}

function PasskeysCard() {
  const qc = useQueryClient()
  const toast = useToast()
  const fail = useErrorToast()
  const [name, setName] = useState('')
  const list = useQuery({ queryKey: ['passkeys'], queryFn: () => get<{ passkeys: PasskeyInfo[] }>('/auth/passkeys') })
  const refresh = () => qc.invalidateQueries({ queryKey: ['passkeys'] })
  const add = useMutation({
    mutationFn: async () => {
      const optionsJSON = await post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/auth/passkeys/options')
      const response = await startRegistration({ optionsJSON })
      return post('/auth/passkeys', { response, name: name.trim() || S.security.defaultName })
    },
    onSuccess: () => {
      setName('')
      toast(S.security.added)
      refresh()
    },
    onError: (e) => {
      // closing the browser dialog is not an error
      if (e instanceof Error && e.name === 'NotAllowedError') return toast(S.security.cancelled)
      fail(e)
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => del(`/auth/passkeys/${id}`),
    onSuccess: () => {
      toast(S.security.removed)
      refresh()
    },
    onError: fail,
  })
  return (
    <section className="card">
      <div className="card-h">{S.security.passkeysTitle}</div>
      <div className="card-b muted" style={{ fontSize: 12.5, borderBottom: '1px solid var(--border)' }}>
        {S.security.passkeysSub}
      </div>
      {list.isLoading && <Loading />}
      {list.isError && <ErrorBox error={list.error} onRetry={() => list.refetch()} />}
      {list.data?.passkeys.length === 0 && (
        <div className="muted" style={{ padding: '14px 16px', fontSize: 12.5 }}>
          {S.security.none}
        </div>
      )}
      {list.data?.passkeys.map((p) => (
        <div className="ar-prov" key={p.id}>
          <KeyRound size={16} aria-hidden="true" style={{ flex: 'none' }} />
          <div className="grow" style={{ flex: 1, minWidth: 0 }}>
            <div className="ell" style={{ fontWeight: 600 }}>
              {p.name}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {S.security.created}: {fmtWhen(p.createdAt, S.common)} · {S.security.lastUsed}: {fmtWhen(p.lastUsedAt, S.common)}
            </div>
          </div>
          <button
            type="button"
            className="btn icon ghost sm"
            aria-label={S.common.delete}
            title={S.common.delete}
            disabled={remove.isPending}
            onClick={() => confirm(S.security.deleteConfirm(p.name)) && remove.mutate(p.id)}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      ))}
      <form
        className="card-b row wrap"
        style={{ gap: 8, borderTop: '1px solid var(--border)', alignItems: 'flex-end' }}
        onSubmit={(e) => {
          e.preventDefault()
          add.mutate()
        }}
      >
        <div className="field" style={{ flex: '1 1 220px' }}>
          <label htmlFor="sec-pkname">{S.security.name}</label>
          <input
            id="sec-pkname"
            className="inp"
            maxLength={60}
            placeholder={S.security.namePlaceholder}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button type="submit" className="btn primary" disabled={add.isPending}>
          <KeyRound size={16} aria-hidden="true" />
          {S.security.add}
        </button>
      </form>
    </section>
  )
}

export function Security() {
  return (
    <Shell crumb={S.security.title}>
      <PageHead title={S.security.title} sub={S.security.sub} />
      <PasswordCard />
      <PasskeysCard />
    </Shell>
  )
}
