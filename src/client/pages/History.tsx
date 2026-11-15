import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Music, Pause, Play } from 'lucide-react'
import { useMemo, useState } from 'react'
import { get } from '../api/client'
import type { HistoryMessage } from '../api/types'
import { ReplayButton, useReplay } from '../components/Replay'
import { ErrorBox, Loading, PageHead, Seg } from '../components/ui'
import { S } from '../i18n'
import { Shell } from '../layouts/Shell'
import { dayKey, fmtDate, fmtDuration, fmtTime } from '../lib/format'
import { StatusBadge } from './Radio'

type Filter = 'all' | 'aired' | 'skipped' | 'failed' | 'audio'

// Play button of an audio item: it goes through the global player (progress and seek are in the bar).
function AudioPlayer({ m }: { m: HistoryMessage }) {
  const { isPlaying, replay } = useReplay()
  if (!m.hasClip) {
    return (
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        {S.history.noClip}
      </div>
    )
  }
  const playing = isPlaying(m)
  return (
    <div className="ar-player">
      <button type="button" className="btn icon sm" aria-label={playing ? S.history.pause : S.history.play} onClick={() => replay(m)}>
        {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
      </button>
      <span className="mono muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
        {fmtDuration(m.durationSec ?? 0)}
      </span>
    </div>
  )
}

export function History() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['history'], queryFn: () => get<{ messages: HistoryMessage[]; retentionDays: number }>('/app/history') })
  const [filter, setFilter] = useState<Filter>('all')
  const [host, setHost] = useState('')
  const { isPlaying, busy, replay } = useReplay(() => qc.invalidateQueries({ queryKey: ['history'] }))

  const all = q.data?.messages ?? []
  const hosts = useMemo(() => [...new Set(all.map((m) => m.host).filter((h): h is string => !!h))].sort(), [all])
  const byHost = all.filter((m) => !host || m.host === host)
  const keep = (m: HistoryMessage, f: Filter) =>
    f === 'all' ? true : f === 'audio' ? m.type === 'audio' : m.type !== 'audio' && m.status === f
  const shown = byHost.filter((m) => keep(m, filter))
  const count = (f: Filter) => byHost.filter((m) => keep(m, f)).length

  const days = useMemo(() => {
    const groups: { key: string; label: string; items: HistoryMessage[] }[] = []
    const now = new Date()
    const yesterday = new Date(now.getTime() - 86400_000)
    for (const m of shown) {
      const d = new Date(m.createdAt)
      const key = dayKey(d)
      let g = groups.find((x) => x.key === key)
      if (!g) {
        const prefix = key === dayKey(now) ? `${S.history.today} · ` : key === dayKey(yesterday) ? `${S.history.yesterday} · ` : ''
        g = { key, label: `${prefix}${fmtDate(m.createdAt)}`, items: [] }
        groups.push(g)
      }
      g.items.push(m)
    }
    return groups
  }, [shown])

  const filters: Filter[] = ['all', 'aired', 'skipped', 'failed', 'audio']
  return (
    <Shell crumb={S.nav.history}>
      <PageHead
        title={S.history.title}
        sub={S.history.sub(q.data?.retentionDays ?? 30, shown.length)}
        actions={
          <div className="row wrap" style={{ gap: 8 }}>
            <select
              className="inp"
              aria-label={S.history.hostLabel}
              style={{ width: 'auto' }}
              value={host}
              onChange={(e) => setHost(e.target.value)}
            >
              <option value="">{S.history.allHosts}</option>
              {hosts.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
        }
      />
      <Seg
        value={filter}
        onChange={setFilter}
        label={S.history.statusLabel}
        style={{ alignSelf: 'flex-start', maxWidth: '100%', overflowX: 'auto' }}
        options={filters.map((f) => ({
          id: f,
          label: (
            <>
              {S.history.filters[f]} <span className="cnt">{count(f)}</span>
            </>
          ),
        }))}
      />
      {q.isLoading && <Loading />}
      {q.isError && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data && shown.length === 0 && <div className="muted">{S.history.empty}</div>}
      {days.length > 0 && (
        <section className="card" style={{ overflow: 'hidden' }}>
          {days.map((g) => (
            <div key={g.key}>
              <div className="ar-day lbl">{g.label}</div>
              {g.items.map((m) => (
                <div className="ar-msg" key={m.id}>
                  {m.type === 'audio' ? (
                    <span className="btn icon ghost sm" aria-hidden="true" style={{ pointerEvents: 'none' }}>
                      <Music size={15} />
                    </span>
                  ) : (
                    <ReplayButton playing={isPlaying(m)} busy={busy === m.id} onClick={() => replay(m)} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row wrap" style={{ gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>{m.session}</span>
                      {m.host && (
                        <>
                          <span className="faint">·</span>
                          <span className="mono muted" style={{ fontSize: 12 }}>
                            {m.host}
                          </span>
                        </>
                      )}
                      <StatusBadge m={m} />
                      {m.type === 'audio' && <span className="tag">{S.history.audioTitle}</span>}
                    </div>
                    <div style={{ marginTop: 3 }} className={m.status === 'skipped' && m.type !== 'audio' ? 'muted' : undefined}>
                      {m.text}
                      {m.type === 'audio' && m.durationSec ? (
                        <span className="mono muted" style={{ fontSize: 12, marginLeft: 8 }}>
                          {fmtDuration(m.durationSec)}
                        </span>
                      ) : null}
                    </div>
                    {m.note && (
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        {S.history.notes[m.note] ?? m.note}
                      </div>
                    )}
                    {m.type === 'audio' && <AudioPlayer m={m} />}
                  </div>
                  <span className="mono muted" style={{ fontSize: 12 }}>
                    {fmtTime(m.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
      <div className="muted" style={{ fontSize: 12 }}>
        {S.history.note}
      </div>
    </Shell>
  )
}
