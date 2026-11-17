import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser'
import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { ApiError, get, post } from '../api/client'
import { useMe } from '../api/hooks'
import type { Me } from '../api/types'
import { LanguageSwitch } from '../components/LanguageSwitch'
import { ErrorBox, Loading } from '../components/ui'
import { S, errorText } from '../i18n'
import { fmtDate } from '../lib/format'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="ar-auth">
      <div className="ar-card">
        <div className="row" style={{ gap: 10 }}>
          <img src="/logo-app.svg" width={26} height={26} alt="" style={{ borderRadius: 7 }} />
          <div>
            <div style={{ fontWeight: 650, fontSize: 15 }}>{S.appName}</div>
            <div className="muted mono" style={{ fontSize: 12 }}>
              {location.host}
            </div>
          </div>
        </div>
        {children}
      </div>
      <div className="muted" style={{ fontSize: 12 }} title={S.auth.whatIsText}>
        {S.auth.footer} · <span style={{ textDecoration: 'underline dotted' }}>{S.auth.whatIs}</span>
      </div>
      <LanguageSwitch variant="auth" />
    </div>
  )
}

function errorOf(e: unknown) {
  return e instanceof ApiError ? errorText(e.code, e.message) : S.common.error
}

// opened by the iOS app: after sign-in hand the session over to it
const appParams = () => new URLSearchParams(window.location.search)
const fromApp = () => appParams().get('app') === '1'
const appHandoff = () => `/api/auth/app-handoff?cc=${encodeURIComponent(appParams().get('cc') ?? '')}`

export function Login() {
  const { data: me, isLoading } = useMe()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const login = useMutation({
    mutationFn: () => post<{ user: Me }>('/auth/login', { email, password }),
    onSuccess: (r) => {
      qc.clear()
      qc.setQueryData(['me'], r.user)
      if (fromApp()) window.location.href = appHandoff()
      else nav('/')
    },
  })
  // usernameless sign-in: the browser offers the passkeys it holds for this site
  const passkey = useMutation({
    mutationFn: async () => {
      if (!browserSupportsWebAuthn()) throw new Error('unsupported')
      const optionsJSON = await post<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/auth/passkey/options')
      const response = await startAuthentication({ optionsJSON })
      return post<{ user: Me }>('/auth/passkey/login', { response })
    },
    onSuccess: (r) => {
      qc.clear()
      qc.setQueryData(['me'], r.user)
      if (fromApp()) window.location.href = appHandoff()
      else nav('/')
    },
  })
  if (isLoading) return <Loading />
  if (me && fromApp()) {
    window.location.href = appHandoff()
    return <Loading />
  }
  if (me) return <Navigate to="/" replace />
  const submit = (e: FormEvent) => {
    e.preventDefault()
    login.mutate()
  }
  // closing the browser dialog is not an error worth showing
  const passkeyError =
    passkey.error instanceof Error && passkey.error.name === 'NotAllowedError'
      ? null
      : passkey.error instanceof Error && passkey.error.message === 'unsupported'
        ? S.auth.passkeyUnsupported
        : passkey.isError
          ? errorOf(passkey.error)
          : null
  return (
    <Frame>
      <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 650, letterSpacing: '-0.01em' }}>{S.auth.loginTitle}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {S.auth.loginSub}
          </div>
        </div>
        <button
          type="button"
          className="btn"
          style={{ justifyContent: 'center', width: '100%' }}
          disabled={passkey.isPending}
          onClick={() => passkey.mutate()}
        >
          <KeyRound size={16} aria-hidden="true" />
          {S.auth.passkey}
        </button>
        {passkeyError && (
          <div className="ar-err" role="alert">
            {passkeyError}
          </div>
        )}
        <div className="ar-or">{S.auth.or}</div>
        <div className="field">
          <label htmlFor="ar-email">{S.auth.email}</label>
          <input
            id="ar-email"
            className="inp"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="ar-pass">{S.auth.password}</label>
          <input
            id="ar-pass"
            className="inp"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {login.isError && (
          <div className="ar-err" role="alert">
            {errorOf(login.error)}
          </div>
        )}
        <button type="submit" className="btn primary" style={{ justifyContent: 'center', width: '100%' }} disabled={login.isPending}>
          {S.auth.submit}
        </button>
        <span className="muted" style={{ fontSize: 12.5, alignSelf: 'center', textAlign: 'center' }}>
          {S.auth.forgot}
        </span>
      </form>
    </Frame>
  )
}

interface LinkInfo {
  kind: 'invite' | 'reset'
  email: string
  expiresAt: string
  invitedBy: string | null
}

// /invite/:token and /reset/:token
export function AcceptLink() {
  const { token = '' } = useParams()
  const qc = useQueryClient()
  const nav = useNavigate()
  const info = useQuery({
    queryKey: ['link', token],
    queryFn: () => get<LinkInfo>(`/auth/link/${encodeURIComponent(token)}`),
    retry: false,
  })
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const mismatch = confirm.length > 0 && confirm !== password
  const accept = useMutation({
    mutationFn: () => post<{ user: Me }>(`/auth/link/${encodeURIComponent(token)}`, { name: name || undefined, password }),
    onSuccess: (r) => {
      qc.clear()
      qc.setQueryData(['me'], r.user)
      if (fromApp()) window.location.href = appHandoff()
      else nav('/')
    },
  })
  if (info.isLoading) return <Loading />
  if (info.isError || !info.data) {
    return (
      <Frame>
        <div>
          <div style={{ fontSize: 18, fontWeight: 650 }}>{S.auth.linkBadTitle}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {S.auth.linkBadText}
          </div>
        </div>
        <Link className="btn" to="/login" style={{ justifyContent: 'center' }}>
          {S.auth.toLogin}
        </Link>
      </Frame>
    )
  }
  const l = info.data
  const isInvite = l.kind === 'invite'
  const until = fmtDate(l.expiresAt)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (password !== confirm) return
    accept.mutate()
  }
  return (
    <Frame>
      <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 650, letterSpacing: '-0.01em' }}>{isInvite ? S.auth.inviteTitle : S.auth.resetTitle}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {isInvite ? (l.invitedBy ? S.auth.inviteSub(l.invitedBy, until) : S.auth.inviteSubAnon(until)) : S.auth.resetSub(l.email)}
          </div>
        </div>
        {isInvite && (
          <div className="field">
            <label htmlFor="ar-iname">{S.auth.name}</label>
            <input id="ar-iname" className="inp" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="ar-imail">{S.auth.email}</label>
          <input id="ar-imail" className="inp" value={l.email} readOnly />
        </div>
        <div className="field">
          <label htmlFor="ar-ipass">{S.auth.password}</label>
          <input
            id="ar-ipass"
            className="inp"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="msg muted">{S.auth.passwordHint}</span>
        </div>
        <div className="field">
          <label htmlFor="ar-ipass2">{S.security.confirmPassword}</label>
          <input
            id="ar-ipass2"
            className={mismatch ? 'inp is-danger' : 'inp'}
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={mismatch}
            aria-describedby={mismatch ? 'ar-ipass2-msg' : undefined}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch && (
            <span id="ar-ipass2-msg" className="msg t-danger" role="alert">
              {S.security.mismatch}
            </span>
          )}
        </div>
        {accept.isError && (
          <div className="ar-err" role="alert">
            {errorOf(accept.error)}
          </div>
        )}
        <button
          type="submit"
          className="btn primary"
          style={{ justifyContent: 'center', width: '100%' }}
          disabled={accept.isPending || password.length === 0 || password !== confirm}
        >
          {isInvite ? S.auth.createAccount : S.auth.resetSubmit}
        </button>
      </form>
    </Frame>
  )
}

export function RequireAuth({ children, admin }: { children: React.ReactNode; admin?: boolean }) {
  const { data: me, isLoading, error, refetch } = useMe()
  if (isLoading) return <Loading />
  if (error) return <ErrorBox error={error} onRetry={() => refetch()} />
  if (!me) return <Navigate to="/login" replace />
  if (admin && me.role !== 'admin') return <Navigate to="/" replace />
  return <>{children}</>
}
