import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, FolderOpen, Info, Music, Pause, Play, Radio as RadioIcon, Settings2, Volume2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { get, patch, post, put } from '../api/client'
import { useLive, useRadio } from '../api/hooks'
import type { Live, Radio, Source } from '../api/types'
import { LIVE_KEY, usePlayer } from '../components/Player'
import { Qr } from '../components/Qr'
import { ReplayButton, useReplay } from '../components/Replay'
import { useToast } from '../components/Toast'
import { ErrorBox, Loading, PageHead, Seg, Switch, copyText, useErrorToast } from '../components/ui'
import { S } from '../i18n'
import { Shell } from '../layouts/Shell'
import { fmtDb, fmtRate, fmtShortWhen, fmtTime, fmtTotal, fmtWhenInline } from '../lib/format'
import { hostOf, liveSource, sourceInfo } from '../lib/source-info'

interface FolderNode {
  path: string
  name: string
  depth: number
  count: number
}
type Tab = 'stations' | 'playlists' | 'url' | 'silence'
const WHEN = { today: S.common.today, yesterday: S.common.yesterday, never: S.common.never }

const PROVIDER_NAME: Record<string, string> = { azure: 'Azure', piper: 'Piper (локально)', openai: 'OpenAI', gemini: 'Gemini' }
const LANG_NAME: Record<string, string> = { uk: 'Українська', ru: 'Русский', en: 'English', multi: 'Многоязычный' }

// "Українська · Mykyta (Piper, high)"
const voiceLabel = (v: { label: string; provider: string; lang: string; quality?: string }) =>
  `${LANG_NAME[v.lang] ?? v.lang.toUpperCase()} · ${v.label} (${PROVIDER_NAME[v.provider] ?? v.provider}${v.quality ? `, ${v.quality}` : ''})`

// the voices of one provider, ordered by language then name
const voiceGroups = (voices: { key: string; label: string; provider: string; lang: string; quality?: string }[]) => {
  const order = ['uk', 'ru', 'en']
  const rank = (l: string) => (order.includes(l) ? order.indexOf(l) : l === 'multi' ? 50 : 99)
  const by = new Map<string, typeof voices>()
  for (const v of voices) by.set(v.provider, [...(by.get(v.provider) ?? []), v])
  return [...by.entries()].map(([provider, list]) => ({
    provider,
    list: [...list].sort((a, b) => rank(a.lang) - rank(b.lang) || a.lang.localeCompare(b.lang) || a.label.localeCompare(b.label)),
  }))
}

// A folder of the library as the music bed: an auto-generated playlist that follows the library (rewritten after every scan).
function FolderSource({ src, setSource }: { src: Source; setSource: ReturnType<typeof useSetSource> }) {
  const folders = useQuery({
    queryKey: ['library-folders'],
    queryFn: () => get<{ folders: FolderNode[]; total: number }>('/app/library/folders'),
  })
  const active = src.type === 'playlist' ? src : null
  const [dir, setDir] = useState(active?.dir ?? '')
  const [order, setOrder] = useState<'shuffle' | 'ordered'>(active?.order ?? 'shuffle')
  const list = folders.data?.folders ?? []
  return (
    <div className={`ar-src stack${active ? ' on' : ''}`} style={{ gap: 10, cursor: 'default', alignItems: 'stretch' }}>
      <div className="row" style={{ gap: 10 }}>
        <FolderOpen size={18} aria-hidden="true" style={{ flex: 'none', color: 'var(--brand-primary)' }} />
        <span style={{ flex: 1 }}>
          <span style={{ display: 'block', fontWeight: 600 }}>{S.radio.folderTitle}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            {S.radio.folderSub}
          </span>
        </span>
        <span className="tag">{S.radio.sourceTypeFolder}</span>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <select
          className="inp"
          aria-label={S.radio.folderSelect}
          style={{ flex: '1 1 200px', width: 'auto' }}
          value={dir}
          onChange={(e) => setDir(e.target.value)}
        >
          <option value="">{S.library.allTracks}</option>
          {list.map((f) => (
            <option key={f.path} value={f.path}>
              {`${'\u00a0\u00a0'.repeat(f.depth)}${f.name} (${f.count})`}
            </option>
          ))}
        </select>
        <Seg
          value={order}
          label={S.library.order}
          options={[
            { id: 'shuffle', label: S.library.shuffle },
            { id: 'ordered', label: S.library.ordered },
          ]}
          onChange={setOrder}
        />
        <button
          type="button"
          className="btn primary"
          disabled={setSource.isPending || (folders.data?.total ?? 0) === 0}
          onClick={() => setSource.mutate({ type: 'playlist', dir, order })}
        >
          {S.radio.folderOn}
        </button>
      </div>
    </div>
  )
}

function initialTab(r: Radio): Tab {
  const src = r.station.source
  if (src.type === 'silence') return 'silence'
  if (src.type === 'userplaylist' || src.type === 'playlist') return 'playlists'
  return r.presets.some((p) => p.url === src.url) ? 'stations' : 'url'
}

function useSetSource() {
  const qc = useQueryClient()
  const toast = useToast()
  const fail = useErrorToast()
  return useMutation({
    mutationFn: (source: Source) => put('/app/station/source', source),
    onSuccess: () => {
      toast(S.radio.sourceChanged)
      qc.invalidateQueries({ queryKey: ['radio'] })
      qc.invalidateQueries({ queryKey: ['live'] })
    },
    onError: fail,
  })
}

function LiveBadge({ live, listening }: { live?: Live; listening: boolean }) {
  if (!live?.up) {
    return (
      <span className="ar-live off">
        <i />
        {S.radio.offAir}
      </span>
    )
  }
  const n = live.listeners + (listening && live.listeners === 0 ? 1 : 0)
  return (
    <span className={`ar-live${n === 0 ? ' off' : ''}`}>
      <i />
      {S.radio.liveListeners(n)}
    </span>
  )
}

const BARS = [60, 72, 55, 80, 30, 90, 70, 95, 64, 35, 62, 78, 58, 70].map((h, i) => ({ h, id: `bar-${i}` }))

function SourceCard({ r }: { r: Radio }) {
  const setSource = useSetSource()
  const [tab, setTab] = useState<Tab>(() => initialTab(r))
  const src = r.station.source
  const [url, setUrl] = useState(src.type === 'relay' && !r.presets.some((p) => p.url === src.url) ? src.url : '')
  const [urlState, setUrlState] = useState<'ok' | 'bad' | 'blocked' | null>(null)
  const fail = useErrorToast()

  const check = useMutation({
    mutationFn: () => post<{ status: 'ok' | 'blocked' | 'down' }>('/app/check-url', { url }),
    onSuccess: (res) => setUrlState(res.status === 'ok' ? 'ok' : res.status === 'blocked' ? 'blocked' : 'bad'),
    onError: fail,
  })

  const tabs: { id: Tab; label: string }[] = [
    { id: 'stations', label: S.radio.sourceTabs.stations },
    { id: 'playlists', label: S.radio.sourceTabs.playlists },
    ...(r.allowOwnUrls ? [{ id: 'url' as Tab, label: S.radio.sourceTabs.url }] : []),
    { id: 'silence', label: S.radio.sourceTabs.silence },
  ]
  const pick = (id: Tab) => {
    setTab(id)
    if (id === 'silence' && src.type !== 'silence') setSource.mutate({ type: 'silence' })
  }
  const ownRelay = src.type === 'relay' && !r.presets.some((p) => p.url === src.url) ? src : null
  const relayIcon = <RadioIcon size={18} aria-hidden="true" style={{ flex: 'none', color: 'var(--brand-primary)' }} />

  return (
    <section className="card">
      <div className="card-h">{S.radio.musicTitle}</div>
      <div className="card-b stack" style={{ gap: 14 }}>
        <Seg value={tab} options={tabs} onChange={pick} label={S.radio.sourceLabel} />

        {tab === 'stations' && (
          <div className="stack" style={{ gap: 8 }}>
            {r.presets.length === 0 && !ownRelay && <div className="muted">{S.radio.noPresets}</div>}
            {r.presets.map((p) => (
              <button
                type="button"
                key={p.id}
                className={`ar-src${src.type === 'relay' && src.url === p.url ? ' on' : ''}`}
                onClick={() => setSource.mutate({ type: 'relay', url: p.url, name: p.name })}
              >
                {relayIcon}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600 }}>{p.name}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {p.description}
                  </span>
                </span>
                <span className="tag">{S.radio.presetBadge}</span>
              </button>
            ))}
            {ownRelay && (
              <button type="button" className="ar-src on" onClick={() => setTab('url')}>
                {relayIcon}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600 }}>{ownRelay.name ?? hostOf(ownRelay.url)}</span>
                  <span className="muted ell" style={{ fontSize: 12, display: 'block' }}>
                    {hostOf(ownRelay.url)}
                  </span>
                </span>
                <span className="tag">{S.radio.sourceTypeRelay}</span>
              </button>
            )}
          </div>
        )}

        {tab === 'playlists' && (
          <div className="stack" style={{ gap: 8 }}>
            {r.playlists.length === 0 && <div className="muted">{S.radio.noPlaylists}</div>}
            {r.playlists.map((p) => (
              <button
                type="button"
                key={p.id}
                className={`ar-src${src.type === 'userplaylist' && src.playlistId === p.id ? ' on' : ''}`}
                onClick={() => setSource.mutate({ type: 'userplaylist', playlistId: p.id })}
              >
                <Music size={18} aria-hidden="true" style={{ flex: 'none', color: 'var(--brand-primary)' }} />
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontWeight: 600 }}>{p.name}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {S.radio.playlistInfo(
                      p.count,
                      fmtTotal(p.durationSec),
                      p.orderMode === 'shuffle' ? S.radio.modeShuffle : S.radio.modeOrdered,
                    )}
                  </span>
                </span>
                <span className="tag">{S.radio.playlistBadge}</span>
              </button>
            ))}
            <FolderSource src={src} setSource={setSource} />
            <Link to="/library" style={{ fontSize: 12.5, fontWeight: 550 }}>
              {S.radio.buildPlaylist}
            </Link>
          </div>
        )}

        {tab === 'url' && (
          <div className="stack" style={{ gap: 10 }}>
            <div className="field">
              <label htmlFor="ar-url">{S.radio.urlLabel}</label>
              <input
                id="ar-url"
                className="inp mono"
                type="url"
                placeholder="https://"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value)
                  setUrlState(null)
                }}
              />
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                disabled={!url || setSource.isPending}
                onClick={() => setSource.mutate({ type: 'relay', url, name: hostOf(url) })}
              >
                {S.radio.urlOn}
              </button>
              <button type="button" className="btn" disabled={!url || check.isPending} onClick={() => check.mutate()}>
                {S.radio.urlCheck}
              </button>
              {urlState && (
                <span className={`bdg ${urlState === 'ok' ? 't-success' : 't-danger'}`}>
                  {urlState === 'ok' ? S.radio.urlOk : urlState === 'blocked' ? S.radio.urlBlocked : S.radio.urlBad}
                </span>
              )}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {S.radio.urlHint}
            </div>
          </div>
        )}

        {tab === 'silence' && (
          <div className="banner" role="status">
            <Info size={16} aria-hidden="true" style={{ flex: 'none' }} />
            <div>{S.radio.silenceBanner}</div>
          </div>
        )}
      </div>
    </section>
  )
}

function Messages({ r }: { r: Radio }) {
  const qc = useQueryClient()
  const { isPlaying, busy, replay } = useReplay(() => qc.invalidateQueries({ queryKey: ['radio'] }))
  return (
    <section className="card">
      <div className="card-h" style={{ justifyContent: 'space-between' }}>
        {S.radio.lastMessages}
        <Link to="/history" style={{ fontSize: 12.5, fontWeight: 550 }}>
          {S.radio.allHistory}
        </Link>
      </div>
      <div className="stack" style={{ gap: 0 }}>
        {r.messages.length === 0 && (
          <div className="muted" style={{ padding: '12px 16px' }}>
            {S.radio.noMessagesYet}
          </div>
        )}
        {r.messages.map((m, i) => (
          <div
            key={m.id}
            className="lrow"
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
              padding: '12px 16px',
              borderBottom: i < r.messages.length - 1 ? '1px solid var(--border)' : undefined,
            }}
          >
            <ReplayButton playing={isPlaying(m)} busy={busy === m.id} onClick={() => replay(m)} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600 }}>{m.session}</span>
                {m.host && (
                  <>
                    <span className="faint">·</span>
                    <span className="muted mono" style={{ fontSize: 12 }}>
                      {m.host}
                    </span>
                  </>
                )}
                <StatusBadge m={m} />
              </div>
              <div style={{ marginTop: 3 }} className={m.status === 'skipped' ? 'muted' : undefined}>
                {m.text}
              </div>
            </div>
            <span className="mono muted" style={{ fontSize: 12 }}>
              {fmtShortWhen(m.createdAt, WHEN)}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

export function StatusBadge({ m }: { m: { status: string; type: string } }) {
  if (m.status === 'aired') return <span className="bdg t-success">{S.history.badges.aired}</span>
  if (m.status === 'failed') return <span className="bdg t-danger">{S.history.badges.failed}</span>
  return <span className="bdg">{m.type === 'audio' ? S.history.badges.audioSkipped : S.history.badges.skipped}</span>
}

function PhoneCard({ r }: { r: Radio }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [shown, setShown] = useState(false)
  const regen = useMutation({
    mutationFn: () => post('/app/station/regenerate'),
    onSuccess: () => {
      toast(S.radio.regenerated)
      qc.invalidateQueries({ queryKey: ['radio'] })
    },
  })
  const masked = r.station.listenUrl.replace(/k=.+$/, 'k=•••••••')
  const copy = async () => toast((await copyText(r.station.listenUrl)) ? S.common.copied : S.common.error)
  return (
    <section className="card">
      <div className="card-h">{S.radio.phone}</div>
      <div className="card-b stack" style={{ gap: 12 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <Qr text={r.station.listenUrl} />
          <div className="stack" style={{ gap: 6, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{S.radio.openVlc}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {S.radio.vlcHint}
            </div>
          </div>
        </div>
        <div className="field">
          <label htmlFor="ar-stream">{S.radio.streamLabel}</label>
          <div className="row" style={{ gap: 8 }}>
            <input
              id="ar-stream"
              className="inp mono"
              value={shown ? r.station.listenUrl : masked}
              readOnly
              style={{ flex: 1, minWidth: 0 }}
              onFocus={() => setShown(true)}
              onBlur={() => setShown(false)}
            />
            <button type="button" className="btn icon" aria-label={S.radio.copyLink} onClick={copy}>
              <Copy size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {S.radio.tags.map((t) =>
            t === '.m3u' ? (
              <a key={t} className="tag" href={r.station.m3uUrl} style={{ color: 'inherit' }}>
                {t}
              </a>
            ) : (
              <span key={t} className="tag">
                {t}
              </span>
            ),
          )}
        </div>
        <button
          type="button"
          style={{
            fontSize: 12.5,
            fontWeight: 550,
            alignSelf: 'flex-start',
            background: 'none',
            border: 0,
            padding: 0,
            color: 'var(--brand-primary)',
            cursor: 'pointer',
          }}
          onClick={() => confirm(S.radio.regenerateConfirm) && regen.mutate()}
        >
          {S.radio.regenerate}
        </button>
      </div>
    </section>
  )
}

// Range slider with a live value in mono; the change is sent 300 ms after the last movement and applies on air at once.
function LevelSlider({
  id,
  label,
  min,
  max,
  value,
  onSave,
  step = 1,
  format = fmtDb,
}: {
  id: string
  label: string
  min: number
  max: number
  value: number
  onSave: (v: number) => void
  step?: number
  format?: (v: number) => string
}) {
  const [v, setV] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => setV(value), [value])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const change = (n: number) => {
    setV(n)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => onSave(n), 300)
  }
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} <span className="mono">{format(v)}</span>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={v} onChange={(e) => change(Number(e.target.value))} />
    </div>
  )
}

function VoiceCard({ r }: { r: Radio }) {
  const qc = useQueryClient()
  const toast = useToast()
  const fail = useErrorToast()
  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => patch('/app/settings', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['radio'] }),
    onError: fail,
  })
  const test = useMutation({
    mutationFn: () => post<{ status: 'aired' | 'skipped' }>('/app/test'),
    onSuccess: (res) => {
      toast(res.status === 'aired' ? S.radio.testAired : S.radio.testSkipped)
      qc.invalidateQueries({ queryKey: ['radio'] })
    },
    onError: fail,
  })
  const s = r.settings
  const defaultVoice = r.voices.find((v) => v.key === r.defaultVoice)
  return (
    <section className="card">
      <div className="card-h">{S.radio.voiceMix}</div>
      <div className="card-b stack" style={{ gap: 14 }}>
        <div className="field">
          <label htmlFor="ar-voice">{S.radio.voice}</label>
          <select id="ar-voice" className="inp" value={s.voice ?? ''} onChange={(e) => save.mutate({ voice: e.target.value || null })}>
            <option value="">
              {S.radio.voiceDefault}
              {defaultVoice ? ` (${defaultVoice.label})` : ''}
            </option>
            {voiceGroups(r.voices).map((g) => (
              <optgroup key={g.provider} label={PROVIDER_NAME[g.provider] ?? g.provider}>
                {g.list.map((v) => (
                  <option key={v.key} value={v.key}>
                    {voiceLabel(v)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <LevelSlider
          id="ar-rate"
          label={S.radio.speechRate}
          min={0.8}
          max={1.6}
          step={0.05}
          format={fmtRate}
          value={r.settings.speechRate}
          onSave={(speechRate) => save.mutate({ speechRate })}
        />
        <div className="field">
          {/* biome-ignore lint/a11y/noLabelWithoutControl: caption of the segmented control below */}
          <label>{S.radio.summaryLang}</label>
          <Seg
            value={s.lang}
            options={[
              { id: 'uk', label: 'UK' },
              { id: 'ru', label: 'RU' },
              { id: 'en', label: 'EN' },
            ]}
            onChange={(lang) => save.mutate({ lang })}
            label={S.radio.summaryLang}
          />
        </div>
        <div className="stack" style={{ gap: 12 }}>
          <div className="row between" style={{ gap: 12 }}>
            <div style={{ fontWeight: 550 }}>{S.radio.levelsTitle}</div>
            <button
              type="button"
              style={{
                fontSize: 12.5,
                fontWeight: 550,
                background: 'none',
                border: 0,
                padding: 0,
                color: 'var(--brand-primary)',
                cursor: 'pointer',
              }}
              onClick={() => save.mutate({ musicGainDb: 0, voiceGainDb: 0, duckDb: 14 })}
            >
              {S.radio.levelsReset}
            </button>
          </div>
          <LevelSlider
            id="ar-music-gain"
            label={S.radio.musicLabel}
            min={-30}
            max={6}
            value={r.station.musicGainDb}
            onSave={(musicGainDb) => save.mutate({ musicGainDb })}
          />
          <LevelSlider
            id="ar-voice-gain"
            label={S.radio.voiceLevelLabel}
            min={-12}
            max={12}
            value={r.station.voiceGainDb}
            onSave={(voiceGainDb) => save.mutate({ voiceGainDb })}
          />
          <LevelSlider
            id="ar-duck"
            label={S.radio.duckLabel}
            min={-30}
            max={0}
            value={-r.station.duckDb}
            onSave={(v) => save.mutate({ duckDb: -v })}
          />
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <button type="button" className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
              <Volume2 size={16} aria-hidden="true" />
              {S.radio.levelsTest}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              {S.radio.levelsTestHint}
            </span>
          </div>
        </div>
        <div className="row between" style={{ gap: 16 }}>
          <div>
            <div style={{ fontWeight: 550 }}>{S.radio.chime}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {S.radio.chimeHint}
            </div>
          </div>
          <Switch on={r.station.chime} onChange={(chime) => save.mutate({ chime })} label={S.radio.chime} />
        </div>
        <div className="row between" style={{ gap: 16 }}>
          <div>
            <div style={{ fontWeight: 550 }}>{S.radio.speakSession}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {S.radio.speakSessionHint}
            </div>
          </div>
          <Switch on={s.speakSession} onChange={(speakSession) => save.mutate({ speakSession })} label={S.radio.speakSession} />
        </div>
      </div>
    </section>
  )
}

function NowCard({ r, live }: { r: Radio; live?: Live }) {
  const info = sourceInfo(r)
  const last = r.messages[0]
  const aired = r.messages.find((m) => m.status === 'aired')
  const badge = live?.file ? S.radio.sourceTypeFile : info.badge
  return (
    <section className="card">
      <div className="card-h" style={{ justifyContent: 'space-between' }}>
        {S.radio.onAir}
        <span className="tag t-primary">{badge}</span>
      </div>
      <div className="card-b" style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }} className="stack">
          <div style={{ fontSize: 18, fontWeight: 650, letterSpacing: '-0.01em' }}>{live?.file && live.title ? live.title : info.name}</div>
          {live?.file ? <div className="muted">{S.radio.fileOnAir}</div> : live?.title && <div className="muted">{live.title}</div>}
          <div className="muted" style={{ fontSize: 12 }}>
            {last ? S.radio.lastMessage(fmtWhenInline((aired ?? last).createdAt)) : S.radio.noMessagesYet}
          </div>
        </div>
        <div className={`ar-meter${live?.up && live.listeners > 0 ? ' live' : ''}`} style={{ flex: '0 1 220px' }} aria-hidden="true">
          {BARS.map((b, i) => (
            <span
              key={b.id}
              className={i >= 5 && i <= 8 ? 'v' : undefined}
              style={{ height: `${b.h}%`, animationDelay: `${(i % 5) * 0.15}s` }}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function MobileRadio({ r, live }: { r: Radio; live?: Live }) {
  const player = usePlayer()
  const listening = player.isPlaying(LIVE_KEY)
  const setSource = useSetSource()
  const info = sourceInfo(r)
  const src = r.station.source
  const voice = r.voices.find((v) => v.key === (r.settings.voice ?? r.defaultVoice))
  const chips: { id: string; label: string; active: boolean; source: Source }[] = [
    ...r.presets.map((p) => ({
      id: p.id,
      label: p.name.replace(/^.*·\s*/, ''),
      active: src.type === 'relay' && src.url === p.url,
      source: { type: 'relay', url: p.url, name: p.name } as Source,
    })),
    ...r.playlists.map((p) => ({
      id: p.id,
      label: p.name,
      active: src.type === 'userplaylist' && src.playlistId === p.id,
      source: { type: 'userplaylist', playlistId: p.id } as Source,
    })),
    { id: 'silence', label: S.radio.silenceName, active: src.type === 'silence', source: { type: 'silence' } },
  ]
  return (
    <div className="m-only stack" style={{ gap: 14 }}>
      <section
        className="card card-b stack m-card"
        style={{ gap: 14, alignItems: 'center', textAlign: 'center', padding: '22px 16px', position: 'relative' }}
      >
        <button
          type="button"
          className="btn icon ghost"
          aria-label={S.radio.mobileSettingsAria}
          style={{ position: 'absolute', top: 10, right: 10, width: 44, height: 44 }}
          onClick={() => document.getElementById('m-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          <Settings2 size={18} aria-hidden="true" />
        </button>
        <span className={`bdg${listening ? ' t-success' : ''}`} style={{ maxWidth: 'calc(100% - 64px)', whiteSpace: 'normal' }}>
          {listening ? S.radio.youListen : S.radio.stopped}
        </span>
        <button
          type="button"
          className="m-play"
          aria-label={listening ? S.radio.stopAria : S.radio.playAria}
          onClick={() => player.toggle(liveSource(r))}
        >
          {listening ? (
            <Pause size={34} aria-hidden="true" fill="currentColor" />
          ) : (
            <Play size={34} aria-hidden="true" fill="currentColor" />
          )}
        </button>
        <div>
          <div style={{ fontSize: 16, fontWeight: 650 }}>{live?.title && live.file ? live.title : info.name}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {S.radio.mobileVoiceLine(voice?.label ?? '—', r.station.duckDb)}
          </div>
        </div>
      </section>

      <div className="lbl">{S.radio.mobileMusic}</div>
      <div className="m-chips">
        {chips.map((c) => (
          <button type="button" key={c.id} className={`m-chip${c.active ? ' on' : ''}`} onClick={() => setSource.mutate(c.source)}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="lbl">{S.radio.lastMessages}</div>
      <section className="card" style={{ overflow: 'hidden' }}>
        {r.messages.length === 0 && (
          <div className="muted" style={{ padding: '11px 14px' }}>
            {S.radio.noMessagesYet}
          </div>
        )}
        {r.messages.map((m) => (
          <div className="m-msg" key={m.id}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row between">
                <span style={{ fontWeight: 600 }}>{m.host ? `${m.session} · ${m.host}` : m.session}</span>
                <span className="mono muted" style={{ fontSize: 11.5 }}>
                  {fmtTime(m.createdAt)}
                </span>
              </div>
              <div style={{ fontSize: 13, marginTop: 2 }}>{m.text}</div>
            </div>
          </div>
        ))}
      </section>
      <div id="m-settings" className="lbl" style={{ scrollMarginTop: 64 }}>
        {S.radio.mobileSettings}
      </div>
      <VoiceCard r={r} />
      <PhoneCard r={r} />
      <SourceCard key={r.station.id} r={r} />
    </div>
  )
}

export function RadioPage() {
  const radio = useRadio()
  const live = useLive(radio.isSuccess)
  const player = usePlayer()
  const listening = player.isPlaying(LIVE_KEY)
  const r = radio.data
  const voice = r?.voices.find((v) => v.key === (r.settings.voice ?? r.defaultVoice))

  return (
    <Shell crumb={S.nav.radio} wide extra={<LiveBadge live={live.data} listening={listening} />}>
      {radio.isLoading && <Loading />}
      {radio.isError && <ErrorBox error={radio.error} onRetry={() => radio.refetch()} />}
      {r && (
        <>
          <div className="d-only">
            <PageHead
              title={S.radio.title}
              sub={S.radio.sub(r.user.name, voice?.label ?? '—', r.station.duckDb)}
              actions={
                <button type="button" className="btn primary" onClick={() => player.toggle(liveSource(r))}>
                  {listening ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                  {listening ? S.radio.stopListen : S.radio.listen}
                </button>
              }
            />
          </div>
          <MobileRadio r={r} live={live.data} />
          <div className="ar-grid d-only">
            <div className="stack" style={{ gap: 16 }}>
              <NowCard r={r} live={live.data} />
              <SourceCard key={r.station.id} r={r} />
              <Messages r={r} />
            </div>
            <div className="stack" style={{ gap: 16 }}>
              <PhoneCard r={r} />
              <VoiceCard r={r} />
              <section className="card card-b row between">
                <div>
                  <div style={{ fontWeight: 600 }}>{S.radio.agents}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {S.radio.agentsInfo(r.keys.count, r.keys.lastUsedAt ? fmtWhenInline(r.keys.lastUsedAt) : null, r.keys.lastName)}
                  </div>
                </div>
                <Link to="/connect" style={{ fontSize: 13, fontWeight: 550 }}>
                  {S.radio.connectLink}
                </Link>
              </section>
            </div>
          </div>
        </>
      )}
    </Shell>
  )
}
