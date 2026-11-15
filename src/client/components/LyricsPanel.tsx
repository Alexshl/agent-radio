import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { put } from '../api/client'
import { useLearnNow, useLive } from '../api/hooks'
import type { LearnLine } from '../api/types'
import { S } from '../i18n'
import { langName } from '../lib/lang-name'
import { currentLineIndex, SYNC_RANGE_S, songPositionMs } from '../lib/lyrics-sync'
import { LIVE_KEY, usePlayer } from './Player'
import { Seg, useErrorToast } from './ui'

type Mode = 'both' | 'orig' | 'tr'
const OFFSET_KEY = 'ar.lyricsOffset'

// the sync correction of this device (seconds), kept in localStorage
function useOffset(): [number, (v: number) => void] {
  const [v, setV] = useState(() => {
    try {
      const n = Number(window.localStorage.getItem(OFFSET_KEY))
      return Number.isFinite(n) ? Math.max(-SYNC_RANGE_S, Math.min(SYNC_RANGE_S, n)) : 0
    } catch {
      return 0
    }
  })
  const set = (n: number) => {
    setV(n)
    try {
      window.localStorage.setItem(OFFSET_KEY, String(n))
    } catch {
      // storage is not available: the correction lasts until the page is closed
    }
  }
  return [v, set]
}

export const fmtOffset = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} ${S.learn.sec}`

// "I know this song / not interesting": no spoken intro before it any more
export function KnowButton({ trackId, skip, onDone }: { trackId: string; skip: boolean; onDone?: (skip: boolean) => void }) {
  const fail = useErrorToast()
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: (next: boolean) => put(`/app/learn/songs/${trackId}/skip`, { skip: next }),
    onSuccess: (_r, next) => {
      onDone?.(next)
      qc.invalidateQueries({ queryKey: ['learn-now'] })
      qc.invalidateQueries({ queryKey: ['learn-song', trackId] })
    },
    onError: fail,
  })
  return (
    <button
      type="button"
      className={`btn ln-know${skip ? ' soft' : ''}`}
      aria-pressed={skip}
      disabled={m.isPending}
      onClick={() => m.mutate(!skip)}
      style={{ height: 44 }}
    >
      {skip && <Check size={16} aria-hidden="true" />}
      {skip ? S.learn.knowOn : S.learn.know}
    </button>
  )
}

export function Summary({ summary, hooks }: { summary: string; hooks: { orig: string; tr: string | null }[] }) {
  return (
    <div className="ln-body">
      <p>{summary || S.learn.noNotes}</p>
      {hooks.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="lbl">{S.learn.listen}</div>
          {hooks.map((h) => (
            <div className="ln-hook" key={h.orig}>
              <b>{h.orig}</b>
              {h.tr && <span className="muted">— {h.tr}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Lines({ lines, mode, cur, follow }: { lines: LearnLine[]; mode: Mode; cur: number; follow: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const refs = useRef<(HTMLDivElement | null)[]>([])
  // the current line is kept in the middle of the box (only the box scrolls, not the page)
  useEffect(() => {
    const el = refs.current[cur]
    const b = box.current
    if (!follow || cur < 0 || !el || !b) return
    b.scrollTo({ top: el.offsetTop - b.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' })
  }, [cur, follow])
  return (
    <div className="ln-lines" ref={box}>
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines are fixed for a song, repeated lines are common
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          className={`ln-line${i === cur ? ' cur' : i < cur ? ' past' : ''}`}
          aria-current={i === cur ? 'true' : undefined}
        >
          {mode !== 'tr' && <div className="o">{l.orig}</div>}
          {mode !== 'orig' && (l.tr || mode === 'tr') && <div className="t">{l.tr ?? l.orig}</div>}
        </div>
      ))}
    </div>
  )
}

// Learn mode, under the player: the song on air with its summary, lyrics in time with the stream and the translation.
// Shown only while the live stream plays in this browser.
export function LyricsPanel({ on, lang }: { on: boolean; lang: string }) {
  const player = usePlayer()
  const listening = player.isPlaying(LIVE_KEY)
  const show = on && listening
  const now = useLearnNow(show)
  const live = useLive(show)
  const qc = useQueryClient()
  const [open, setOpen] = useState(true)
  const [mode, setMode] = useState<Mode>('both')
  const [offset, setOffset] = useOffset()
  const [tick, setTick] = useState(() => Date.now())

  // the title in the stream changed: a new song, ask at once
  const title = live.data?.title
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (title !== undefined) qc.invalidateQueries({ queryKey: ['learn-now'] })
  }, [title, qc])

  const d = now.data
  const lines = d?.lyrics?.lines ?? []
  const timed = !!d?.lyrics?.synced && d.play?.startedAtMs != null
  useEffect(() => {
    if (!show || !timed) return
    const t = setInterval(() => setTick(Date.now()), 250)
    return () => clearInterval(t)
  }, [show, timed])

  const cur = useMemo(() => {
    if (!timed || !d?.play || d.play.startedAtMs == null) return -1
    const pos = songPositionMs({
      nowMs: tick,
      clockOffsetMs: d.clockOffsetMs,
      startedAtMs: d.play.startedAtMs,
      lagS: player.lag,
      userOffsetS: offset,
    })
    return currentLineIndex(lines, pos)
  }, [timed, d, tick, player.lag, offset, lines])

  if (!show || !d?.play) return null
  const p = d.play
  const lyr = d.lyrics
  const hasLines = lines.length > 0
  const hasTr = lines.some((l) => l.tr)
  const intro = p.state === 'intro'
  const empty = intro
    ? S.learn.introNow
    : lyr?.status === 'instrumental'
      ? S.learn.instrumental
      : lyr?.status === 'pending'
        ? S.learn.pending
        : S.learn.noLyrics

  return (
    <section className="ln-panel" aria-label={S.learn.panelAria}>
      <section className="card card-b stack" style={{ gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 16, overflowWrap: 'anywhere' }}>{p.title}</div>
        <div className="muted" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
          {p.artist}
        </div>
        <div className="ln-chips">
          {lyr?.origLang && <span className="ln-chip">{langName(lyr.origLang)}</span>}
          {hasTr && <span className="ln-chip">{S.learn.translation(langName(lang))}</span>}
        </div>
        <KnowButton key={p.trackId} trackId={p.trackId} skip={d.skip} />
      </section>

      {d.notes && !intro && (
        <section className="card card-b stack" style={{ gap: 4 }}>
          <button type="button" className={`ln-fold${open ? ' open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
            <span style={{ flex: 1 }}>{S.learn.about}</span>
            <ChevronDown size={18} aria-hidden="true" />
          </button>
          {open && <Summary summary={d.notes.summary} hooks={d.notes.hooks} />}
        </section>
      )}

      <section className="card card-b stack" style={{ gap: 8 }}>
        <div className="row between" style={{ gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{S.learn.text}</h2>
          {hasLines && hasTr && (
            <Seg
              className="ln-seg"
              value={mode}
              label={S.learn.show}
              options={[
                { id: 'both', label: S.learn.modeBoth },
                { id: 'orig', label: S.learn.modeOrig },
                { id: 'tr', label: S.learn.modeTr },
              ]}
              onChange={setMode}
            />
          )}
        </div>
        {hasLines && !intro ? (
          <>
            <Lines lines={lines} mode={hasTr ? mode : 'orig'} cur={cur} follow={timed} />
            {!timed && (
              <div className="muted" style={{ fontSize: 12.5 }}>
                {S.learn.noTiming}
              </div>
            )}
          </>
        ) : (
          <div className="muted" style={{ fontSize: 13.5 }}>
            {empty}
          </div>
        )}
      </section>

      {timed && !intro && (
        <section className="stack" style={{ gap: 6, padding: '0 4px' }}>
          <label htmlFor="ln-sync" className="row between" style={{ fontSize: 13, color: 'var(--muted-foreground)', gap: 10 }}>
            <span>{S.learn.syncHint}</span>
            <span className="mono" style={{ color: 'var(--foreground)', fontWeight: 600, flex: 'none' }}>
              {fmtOffset(offset)}
            </span>
          </label>
          <input
            id="ln-sync"
            type="range"
            min={-SYNC_RANGE_S}
            max={SYNC_RANGE_S}
            step={0.5}
            value={offset}
            style={{ minHeight: 44 }}
            onChange={(e) => setOffset(Number(e.target.value))}
          />
        </section>
      )}
    </section>
  )
}
