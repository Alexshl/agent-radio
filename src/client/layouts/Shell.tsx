import { useQueryClient } from '@tanstack/react-query'
import { Terminal, History, KeyRound, LogOut, Moon, Music, Radio, Shield, SlidersHorizontal, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, useMatch, useNavigate } from 'react-router'
import { post } from '../api/client'
import { useMe } from '../api/hooks'
import { usePlayer } from '../components/Player'
import { S } from '../i18n'
import { initials } from '../lib/format'
import { useTheme } from '../lib/theme'

const ICON = { size: 18, strokeWidth: 1.6, 'aria-hidden': true } as const

const NAV = [
  { to: '/', label: S.nav.radio, tab: S.tabs.radio, icon: <Radio {...ICON} />, end: true },
  { to: '/remote', label: S.nav.remote, tab: S.tabs.remote, icon: <SlidersHorizontal {...ICON} /> },
  { to: '/library', label: S.nav.library, tab: S.tabs.library, icon: <Music {...ICON} /> },
  { to: '/connect', label: S.nav.connect, tab: S.tabs.agents, icon: <Terminal {...ICON} /> },
  { to: '/history', label: S.nav.history, tab: S.tabs.history, icon: <History {...ICON} /> },
]

function UserMenu() {
  const { data: me } = useMe()
  const qc = useQueryClient()
  const nav = useNavigate()
  const player = usePlayer()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  if (!me) return null
  const logout = async () => {
    player.stop()
    await post('/auth/logout').catch(() => {})
    qc.clear()
    nav('/login')
  }
  return (
    <div className={`dd ar-menu-wrap${open ? ' open' : ''}`} ref={ref}>
      <button
        type="button"
        className="avatar"
        style={{ width: 30, height: 30, fontSize: 11.5, border: 0, cursor: 'pointer' }}
        aria-label={S.common.account}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {initials(me.name)}
      </button>
      <div className="dd-m" style={{ right: 0, left: 'auto', minWidth: 200 }}>
        <div style={{ padding: '6px 9px' }}>
          <div style={{ fontWeight: 600 }}>{me.name}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {me.email}
          </div>
        </div>
        <div className="dd-sep" />
        <Link className="dd-i" to="/security" onClick={() => setOpen(false)}>
          <KeyRound size={15} aria-hidden="true" />
          {S.security.menu}
        </Link>
        <button type="button" className="dd-i" style={{ background: 'none', border: 0, width: '100%', font: 'inherit' }} onClick={logout}>
          <LogOut size={15} aria-hidden="true" />
          {S.common.logout}
        </button>
      </div>
    </div>
  )
}

export function Shell({ crumb, wide, extra, children }: { crumb: string; wide?: boolean; extra?: ReactNode; children: ReactNode }) {
  const { data: me } = useMe()
  const [theme, toggle] = useTheme()
  return (
    <div className="ar-shell">
      <nav className="rail" aria-label={S.nav.sections}>
        <Link className="rail-logo" to="/" title={S.appName}>
          <img src="/logo-app.svg" alt={S.appName} />
        </Link>
        {NAV.map((n) => (
          <NavItem key={n.to} {...n} />
        ))}
        <div className="rail-spacer" />
        {me?.role === 'admin' && <NavItem to="/admin" label={S.nav.admin} icon={<Shield {...ICON} />} />}
      </nav>
      <div className="ar-main">
        <header className="topbar">
          <div className="crumbs">
            <Link to="/" style={{ fontWeight: 650, color: 'var(--foreground)' }}>
              {S.appName}
            </Link>
            <span className="sep">›</span>
            <span className="cur">{crumb}</span>
          </div>
          <div className="grow" />
          {extra}
          {me?.role === 'admin' && crumb === S.nav.admin && <span className="tag t-primary">{S.admin.badge}</span>}
          <button type="button" className="btn icon ghost" aria-label={S.common.theme} onClick={toggle}>
            {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
          </button>
          <UserMenu />
        </header>
        <main className={`ar-page${wide ? ' wide' : ''}`}>{children}</main>
      </div>
      <nav className="m-tabs" aria-label={S.nav.sections}>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `m-tab${isActive ? ' on' : ''}`}>
            {n.icon}
            {n.tab}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

function NavItem({ to, label, icon, end }: { to: string; label: string; icon: ReactNode; end?: boolean }) {
  const active = !!useMatch({ path: to, end: end ?? false })
  return (
    <div className={`rit${active ? ' on' : ''}`}>
      <Link className="rail-btn" data-tip={label} aria-label={label} to={to} aria-current={active ? 'page' : undefined}>
        {icon}
      </Link>
    </div>
  )
}
