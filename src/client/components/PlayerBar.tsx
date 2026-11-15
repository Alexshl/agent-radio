import { useQuery } from '@tanstack/react-query'
import { Loader2, Mic, Music, Pause, Play, Radio, Square, Volume1, Volume2, VolumeX } from 'lucide-react'
import { Link } from 'react-router'
import { get } from '../api/client'
import type { Live, Radio as RadioData } from '../api/types'
import { S } from '../i18n'
import { fmtDuration } from '../lib/format'
import { LAG_SHOW_S, type SourceKind } from '../lib/player-controller'
import { sourceInfo } from '../lib/source-info'
import { usePlayer } from './Player'

const ICON: Record<SourceKind, typeof Music> = { live: Radio, track: Music, voice: Mic }

// The sticky bar of the global player: visible on every page while something is loaded.
export function PlayerBar() {
  const p = usePlayer()
  const cur = p.current
  const live = cur?.kind === 'live'
  // the live title follows the station source and the ICY title of the moment (both queries are shared with the radio page)
  const radio = useQuery({ queryKey: ['radio'], queryFn: () => get<RadioData>('/app/radio'), enabled: live })
  const liveQ = useQuery({
    queryKey: ['live'],
    queryFn: () => get<Live>('/app/live'),
    refetchInterval: 5000,
    enabled: live,
    staleTime: 2000,
  })
  if (!cur) return null

  const Icon = ICON[cur.kind]
  const title = live ? S.player.liveTitle(radio.data ? sourceInfo(radio.data).name : '', liveQ.data?.title) : cur.title
  const sub = live ? (p.reconnecting ? S.player.reconnecting : S.player.live) : cur.subtitle
  const busy = p.loading && !p.playing
  const toggle = () => (p.playing || p.loading ? (live ? p.stop() : p.pause()) : p.resume())
  const pct = !live && p.duration > 0 ? Math.min(100, (p.position / p.duration) * 100) : 0
  const VolIcon = p.muted || p.volume === 0 ? VolumeX : p.volume < 0.5 ? Volume1 : Volume2

  return (
    <section className="ar-pbar" aria-label={S.player.region}>
      {!live && <div className="pb-line" aria-hidden="true" style={{ width: `${pct}%` }} />}
      <div className="pb-info">
        <span className="pb-ico">
          <Icon size={18} aria-hidden="true" />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="ell pb-title" title={title}>
            {title}
          </div>
          {sub && <div className="ell muted pb-sub">{sub}</div>}
        </div>
      </div>
      <div className="pb-ctl">
        <button type="button" className="btn icon sm" aria-label={p.playing ? S.player.pause : S.player.play} onClick={toggle}>
          {busy ? (
            <Loader2 size={16} className="spin" aria-hidden="true" />
          ) : p.playing ? (
            <Pause size={16} aria-hidden="true" />
          ) : (
            <Play size={16} aria-hidden="true" />
          )}
        </button>
        <button type="button" className="btn icon ghost sm" aria-label={S.player.stop} title={S.player.stop} onClick={p.stop}>
          <Square size={14} aria-hidden="true" />
        </button>
        {live ? (
          p.lag > LAG_SHOW_S ? (
            <span className="bdg pb-live" title={S.player.behindHint}>
              {S.player.behind(Math.round(p.lag))}
            </span>
          ) : (
            <span className="bdg t-danger pb-live">{S.player.liveBadge}</span>
          )
        ) : (
          <div className="pb-seek">
            <span className="mono tnum muted pb-time">{fmtDuration(p.position)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(p.duration, 1)}
              step={0.5}
              value={Math.min(p.position, Math.max(p.duration, 1))}
              aria-label={S.player.seek}
              onChange={(e) => p.seek(Number(e.target.value))}
            />
            <span className="mono tnum muted pb-time">{fmtDuration(p.duration)}</span>
          </div>
        )}
      </div>
      <div className="pb-vol">
        <button
          type="button"
          className="btn icon ghost sm"
          aria-label={p.muted ? S.player.unmute : S.player.mute}
          aria-pressed={p.muted}
          onClick={() => p.setMuted(!p.muted)}
        >
          <VolIcon size={16} aria-hidden="true" />
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={p.muted ? 0 : p.volume}
          aria-label={S.player.volume}
          onChange={(e) => p.setVolume(Number(e.target.value))}
        />
        {cur.href && (
          <Link className="pb-go" to={cur.href}>
            {S.player.goto}
          </Link>
        )}
      </div>
    </section>
  )
}
