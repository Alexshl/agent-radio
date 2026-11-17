import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookOpen,
  FolderOpen,
  ListMusic,
  Loader2,
  Music,
  Pause,
  Play,
  Radio as RadioIcon,
  RotateCcw,
  SkipBack,
  SkipForward,
  VolumeX,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { Link } from 'react-router'
import { get, patch, post } from '../api/client'
import { useLive, useRadio } from '../api/hooks'
import type { Live, Radio, ReplayResult, Source } from '../api/types'
import { LIVE_KEY, usePlayer } from '../components/Player'
import { ErrorBox, Loading, Seg, Switch, useErrorToast } from '../components/ui'
import { S } from '../i18n'
import { Shell } from '../layouts/Shell'
import { fmtTime } from '../lib/format'
import { LAG_SHOW_S } from '../lib/player-controller'
import { hostOf, liveSource, sourceInfo } from '../lib/source-info'
import { LevelSlider, useSetSource } from './Radio'

type Tab = 'silence' | 'playlists' | 'folders' | 'stations'

interface FolderNode {
  path: string
  name: string
  depth: number
  count: number
}

interface Item {
  id: string
  name: string
  meta: string
  active: boolean
  source: Source
  icon: ReactNode
}

const ICON = { size: 20, 'aria-hidden': true } as const

export function tabOf(src: Source): Tab {
  if (src.type === 'silence') return 'silence'
  if (src.type === 'userplaylist') return 'playlists'
  if (src.type === 'playlist') return 'folders'
  return 'stations'
}

export function replayMessage(res: ReplayResult, asked: { count: number } | { id: string }): { text: string; warn: boolean } {
  if (res.status === 'skipped') return { text: S.remote.replayNobody, warn: true }
  if (res.status === 'waiting') return { text: S.remote.replayWaiting, warn: true }
  if ('id' in asked) return { text: S.remote.replayedId, warn: false }
  if (res.ids.length < asked.count) return { text: S.remote.replayedFew(res.ids.length), warn: false }
  return { text: asked.count === 1 ? S.remote.replayedOne : S.remote.replayedMany(asked.count), warn: false }
}

function StatusPill({ live, listening }: { live?: Live; listening: boolean }) {
  if (!live?.up) return <span className="rc-pill off">{S.remote.statusOffline}</span>
  const n = live.listeners + (listening && live.listeners === 0 ? 1 : 0)
  return n === 0 ? (
    <span className="rc-pill off">{S.remote.statusNobody}</span>
  ) : (
    <span className="rc-pill on">
      <i className="rc-dot" />
      {S.remote.statusLive(n)}
    </span>
  )
}

// next / previous song: only for a station that plays a playlist or a folder
const skippable = (src: Source) => src.type === 'userplaylist' || src.type === 'playlist'

function SkipButtons({ r }: { r: Radio }) {
  const fail = useErrorToast()
  const [pending, setPending] = useState<'previous' | 'next' | null>(null)
  const ok = skippable(r.station.source)
  const send = useMutation({
    mutationFn: (dir: 'previous' | 'next') => post(`/app/station/${dir}`),
    onMutate: (dir) => setPending(dir),
    onError: fail,
    onSettled: () => setPending(null),
  })
  const btn = (dir: 'previous' | 'next', label: string, icon: ReactNode) => (
    <button
      type="button"
      className="rc-rbtn"
      disabled={send.isPending || !ok}
      title={ok ? undefined : S.remote.skipDisabled}
      aria-label={label}
      onClick={() => send.mutate(dir)}
    >
      {pending === dir ? <Loader2 size={20} className="spin" aria-hidden="true" /> : icon}
      <span>{label}</span>
    </button>
  )
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="rc-skip">
        {btn('previous', S.remote.prevTrack, <SkipBack size={20} aria-hidden="true" />)}
        {btn('next', S.remote.nextTrack, <SkipForward size={20} aria-hidden="true" />)}
      </div>
      {!ok && <div className="muted rc-now-hint">{S.remote.skipDisabled}</div>}
    </div>
  )
}

function NowCard({ r, live }: { r: Radio; live?: Live }) {
  const player = usePlayer()
  const listening = player.isPlaying(LIVE_KEY)
  const info = sourceInfo(r)
  const track = live?.title ?? '—'
  const lag = listening && player.current?.kind === 'live' ? Math.round(player.lag) : 0
  const save = useMutation({ mutationFn: (b: Record<string, unknown>) => patch('/app/settings', b) })
  const qc = useQueryClient()
  const fail = useErrorToast()
  const saveLevel = (b: Record<string, unknown>) =>
    save.mutate(b, { onSuccess: () => qc.invalidateQueries({ queryKey: ['radio'] }), onError: fail })
  return (
    <section className="card rc-now">
      <div className="rc-now-top">
        <button
          type="button"
          className="rc-play"
          aria-label={listening ? S.radio.stopAria : S.radio.playAria}
          onClick={() => player.toggle(liveSource(r))}
        >
          {player.loading && !player.playing && player.current?.key === LIVE_KEY ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : listening ? (
            <Pause fill="currentColor" aria-hidden="true" />
          ) : (
            <Play fill="currentColor" aria-hidden="true" />
          )}
        </button>
        <div className="rc-now-info">
          <div className="muted rc-now-src">{S.remote.nowLabel(info.name)}</div>
          <div className="rc-now-title ell" title={track}>
            {track}
          </div>
          {listening ? (
            lag > LAG_SHOW_S ? (
              <button type="button" className="rc-live lag" aria-label={S.remote.lagAria(lag)} onClick={() => player.goLive()}>
                {S.remote.lagBadge(lag)}
              </button>
            ) : (
              <span className="rc-live">
                <i className="rc-dot" />
                {S.remote.liveBadge}
              </span>
            )
          ) : (
            <span className="muted rc-now-hint">{S.remote.notListening}</span>
          )}
        </div>
      </div>
      <SkipButtons r={r} />
      <div className="stack rc-levels" style={{ gap: 12 }}>
        <LevelSlider
          id="rc-music-gain"
          label={S.radio.musicLabel}
          min={-30}
          max={6}
          value={r.station.musicGainDb}
          onSave={(musicGainDb) => saveLevel({ musicGainDb })}
        />
        <LevelSlider
          id="rc-voice-gain"
          label={S.radio.voiceLevelLabel}
          min={-12}
          max={12}
          value={r.station.voiceGainDb}
          onSave={(voiceGainDb) => saveLevel({ voiceGainDb })}
        />
      </div>
    </section>
  )
}

function ReplaySection({ r }: { r: Radio }) {
  const qc = useQueryClient()
  const fail = useErrorToast()
  const [status, setStatus] = useState<{ text: string; warn: boolean } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const send = useMutation({
    mutationFn: (b: { count: number } | { id: string }) => post<ReplayResult>('/app/history/replay', b),
    onMutate: (b) => {
      setPending('id' in b ? b.id : `n${b.count}`)
      setStatus(null)
    },
    onSuccess: (res, b) => {
      setStatus(replayMessage(res, b))
      qc.invalidateQueries({ queryKey: ['radio'] })
    },
    onError: (e) => {
      setStatus(null)
      fail(e)
    },
    onSettled: () => setPending(null),
  })
  const none = r.messages.length === 0
  const counts = [1, 2, 3] as const
  return (
    <section className="stack" style={{ gap: 10 }}>
      <div className="lbl">{S.remote.replayTitle}</div>
      <div className="rc-replay">
        {counts.map((n) => (
          <button
            key={n}
            type="button"
            className="rc-rbtn"
            disabled={send.isPending || none}
            aria-label={n === 1 ? S.remote.replayLast : S.remote.replayN(n)}
            onClick={() => send.mutate({ count: n })}
          >
            {pending === `n${n}` ? <Loader2 size={20} className="spin" aria-hidden="true" /> : <RotateCcw size={20} aria-hidden="true" />}
            <span>{n === 1 ? S.remote.replayLast : S.remote.replayN(n)}</span>
          </button>
        ))}
      </div>
      <div className={`rc-status${status?.warn ? ' warn' : ''}`} role="status" aria-live="polite">
        {send.isPending ? S.remote.replayBusy : (status?.text ?? '')}
      </div>
      <div className="lbl">{S.remote.recent}</div>
      <div className="card" style={{ overflow: 'hidden' }}>
        {none && (
          <div className="muted" style={{ padding: '12px 16px' }}>
            {S.remote.noMessages}
          </div>
        )}
        {r.messages.map((m) => (
          <div className="rc-msg" key={m.id}>
            <div className="rc-msg-body">
              <div className="rc-msg-head">
                <span className="rc-msg-sess ell">{m.host ? `${m.session} · ${m.host}` : m.session}</span>
                <span className="muted tnum rc-msg-time">{fmtTime(m.createdAt)}</span>
              </div>
              <div className="rc-msg-text">{m.text}</div>
            </div>
            <button
              type="button"
              className="rc-msg-play"
              aria-label={S.remote.replayOne(m.session)}
              disabled={send.isPending}
              onClick={() => send.mutate({ id: m.id })}
            >
              {pending === m.id ? (
                <Loader2 size={16} className="spin" aria-hidden="true" />
              ) : (
                <Play size={16} fill="currentColor" aria-hidden="true" />
              )}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

function SourceSection({ r }: { r: Radio }) {
  const qc = useQueryClient()
  const src = r.station.source
  const [tab, setTab] = useState<Tab>(() => tabOf(src))
  // the source changed elsewhere (another device, an agent): follow it to its tab
  const srcTab = tabOf(src)
  const [seenTab, setSeenTab] = useState(srcTab)
  if (seenTab !== srcTab) {
    setSeenTab(srcTab)
    setTab(srcTab)
  }
  const [pendingId, setPendingId] = useState<string | null>(null)
  const setSource = useSetSource()
  const folders = useQuery({
    queryKey: ['library-folders'],
    queryFn: () => get<{ folders: FolderNode[]; total: number }>('/app/library/folders'),
  })

  const items: Item[] = (() => {
    if (tab === 'silence')
      return [
        {
          id: 'silence',
          name: S.radio.silenceName,
          meta: S.remote.silenceMeta,
          active: src.type === 'silence',
          source: { type: 'silence' },
          icon: <VolumeX {...ICON} />,
        },
      ]
    if (tab === 'playlists')
      return r.playlists.map((p) => ({
        id: p.id,
        name: p.name,
        meta: S.remote.trackCount(p.count),
        active: src.type === 'userplaylist' && src.playlistId === p.id,
        source: { type: 'userplaylist', playlistId: p.id } as Source,
        icon: <ListMusic {...ICON} />,
      }))
    if (tab === 'folders') {
      const dir = src.type === 'playlist' ? src.dir : null
      const order = src.type === 'playlist' ? (src.order ?? 'shuffle') : 'shuffle'
      return [
        {
          id: 'dir:',
          name: S.library.allTracks,
          meta: S.remote.trackCount(folders.data?.total ?? 0),
          active: dir === '',
          source: { type: 'playlist', dir: '', order } as Source,
          icon: <Music {...ICON} />,
        },
        ...(folders.data?.folders ?? []).map((f) => ({
          id: `dir:${f.path}`,
          name: f.name,
          meta: S.remote.trackCount(f.count),
          active: dir === f.path,
          source: { type: 'playlist', dir: f.path, order } as Source,
          icon: <FolderOpen {...ICON} />,
        })),
      ]
    }
    const own = src.type === 'relay' && !r.presets.some((p) => p.url === src.url) ? src : null
    return [
      ...r.presets.map((p) => ({
        id: p.id,
        name: p.name,
        meta: p.description,
        active: src.type === 'relay' && src.url === p.url,
        source: { type: 'relay', url: p.url, name: p.name } as Source,
        icon: <RadioIcon {...ICON} />,
      })),
      ...(own
        ? [
            {
              id: 'own',
              name: own.name ?? hostOf(own.url),
              meta: hostOf(own.url),
              active: true,
              source: own as Source,
              icon: <RadioIcon {...ICON} />,
            },
          ]
        : []),
    ]
  })()

  const empty = { silence: '', playlists: S.remote.noPlaylists, folders: S.remote.noFolders, stations: S.remote.noStations }[tab]

  const pick = (it: Item) => {
    if (it.active || setSource.isPending) return
    setPendingId(it.id)
    setSource.mutate(it.source, {
      onSettled: () => {
        setPendingId(null)
        qc.invalidateQueries({ queryKey: ['radio'] })
      },
    })
  }

  return (
    <section className="rc-src-sec stack" style={{ gap: 10 }}>
      <div className="lbl">{S.remote.underTitle}</div>
      <div className="card rc-src-card">
        <Seg
          className="rc-seg"
          value={tab}
          label={S.remote.tabsLabel}
          onChange={setTab}
          options={[
            { id: 'silence', label: S.remote.tabs.silence },
            { id: 'playlists', label: S.remote.tabs.playlists },
            { id: 'folders', label: S.remote.tabs.folders },
            { id: 'stations', label: S.remote.tabs.stations },
          ]}
        />
        <div className="rc-items" aria-busy={setSource.isPending}>
          {items.length === 0 && <div className="muted rc-empty">{empty}</div>}
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              className={`rc-item${it.active ? ' on' : ''}`}
              aria-pressed={it.active}
              disabled={setSource.isPending && pendingId !== it.id}
              onClick={() => pick(it)}
            >
              <span className="rc-ico">{pendingId === it.id ? <Loader2 size={20} className="spin" aria-hidden="true" /> : it.icon}</span>
              <span className="rc-item-text">
                <span className="rc-item-name">{it.name}</span>
                <span className="muted rc-item-meta">{pendingId === it.id ? S.remote.switching : it.meta}</span>
              </span>
              {it.active && pendingId !== it.id && <span className="rc-on">{S.remote.playing}</span>}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

// quick "learn a language" switch (the frequency and the rest stay in the radio settings)
function LearnQuick({ r }: { r: Radio }) {
  const qc = useQueryClient()
  const fail = useErrorToast()
  const l = r.learn
  const save = useMutation({
    mutationFn: (learnMode: boolean) => patch('/app/settings', { learnMode }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['radio'] }),
    onError: fail,
  })
  const blocked = !l.mode && (!l.available || !l.configured)
  const hint = !l.mode && !l.available ? S.learn.needPlaylist : !l.mode && !l.configured ? S.learn.noModel : null
  return (
    <section className="card">
      <div className="card-b row" style={{ gap: 12, alignItems: 'center' }}>
        <BookOpen size={20} aria-hidden="true" style={{ flex: 'none', color: 'var(--brand-primary)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{S.learn.title}</div>
          {hint && (
            <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.45, marginTop: 2 }}>
              {hint}
            </div>
          )}
        </div>
        <Switch on={l.mode} disabled={blocked || save.isPending} label={S.learn.title} onChange={(v) => save.mutate(v)} />
      </div>
    </section>
  )
}

export function Remote() {
  const radio = useRadio(10_000)
  const live = useLive(radio.isSuccess)
  const player = usePlayer()
  const r = radio.data
  return (
    <Shell crumb={S.nav.remote} wide>
      {radio.isLoading && <Loading />}
      {radio.isError && <ErrorBox error={radio.error} onRetry={() => radio.refetch()} />}
      {r && (
        <div className="rc-page">
          <header className="rc-head">
            <img className="rc-mark" src="/logo-app.svg" alt="" width={36} height={36} />
            <h1 className="rc-title">{S.remote.title}</h1>
            <span className="rc-grow" />
            <StatusPill live={live.data} listening={player.isPlaying(LIVE_KEY)} />
            <Link className="rc-full rc-full-head" to="/">
              {S.remote.fullShort}
            </Link>
          </header>
          <div className="rc-col-left">
            <NowCard r={r} live={live.data} />
            <LearnQuick r={r} />
            <ReplaySection r={r} />
          </div>
          <div className="rc-col-right">
            <SourceSection key={r.station.id} r={r} />
          </div>
          <Link className="rc-full rc-full-foot" to="/">
            {S.remote.fullLink}
          </Link>
        </div>
      )}
    </Shell>
  )
}
