import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { get } from '../api/client'
import type { LearnArchive, LearnSong } from '../api/types'
import { KnowButton, Summary } from '../components/LyricsPanel'
import { ErrorBox, Loading, PageHead } from '../components/ui'
import { S } from '../i18n'
import { Shell } from '../layouts/Shell'
import { fmtWhenInline } from '../lib/format'
import { langName } from '../lib/lang-name'

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

function ArchiveList() {
  const [text, setText] = useState('')
  const [lang, setLang] = useState('')
  const q = useDebounced(text.trim(), 250)
  const list = useInfiniteQuery({
    queryKey: ['learn-archive', q, lang],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams()
      if (pageParam) p.set('cursor', pageParam)
      if (q) p.set('q', q)
      if (lang) p.set('lang', lang)
      return get<LearnArchive>(`/app/learn/archive?${p}`)
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const first = list.data?.pages[0]
  const songs = list.data?.pages.flatMap((p) => p.songs) ?? []
  const filtering = !!q || !!lang
  return (
    <div className="stack" style={{ gap: 14, maxWidth: 720 }}>
      <PageHead title={S.learn.title} />
      <label className="inp" style={{ minHeight: 44 }}>
        <Search size={16} aria-hidden="true" style={{ flex: 'none', color: 'var(--muted-foreground)' }} />
        <span className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
          {S.learn.search}
        </span>
        <input
          type="search"
          value={text}
          placeholder={S.learn.searchPlaceholder}
          maxLength={200}
          onChange={(e) => setText(e.target.value)}
          style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', font: 'inherit', color: 'inherit' }}
        />
      </label>
      {first && first.langs.length > 0 && (
        <div className="ln-filters">
          <button type="button" className={`ln-chip-btn${lang === '' ? ' on' : ''}`} aria-pressed={lang === ''} onClick={() => setLang('')}>
            {S.learn.all(first.all)}
          </button>
          {first.langs.map((l) => (
            <button
              type="button"
              key={l.lang}
              className={`ln-chip-btn${lang === l.lang ? ' on' : ''}`}
              aria-pressed={lang === l.lang}
              onClick={() => setLang(lang === l.lang ? '' : l.lang)}
            >
              {langName(l.lang)} · {l.count}
            </button>
          ))}
        </div>
      )}
      {list.isLoading && <Loading />}
      {list.isError && <ErrorBox error={list.error} onRetry={() => list.refetch()} />}
      {first && songs.length === 0 && (
        <div className="muted" style={{ padding: '12px 4px' }}>
          {filtering ? S.learn.nothingFound : S.learn.empty}
        </div>
      )}
      {songs.length > 0 && (
        <section className="card ln-list" style={{ overflow: 'hidden' }}>
          {songs.map((s) => (
            <Link key={s.trackId} to={`/learn/${encodeURIComponent(s.trackId)}`} className="ln-song">
              <div className="main">
                <div style={{ fontWeight: 600, fontSize: 15 }}>{s.title}</div>
                <div className="a">
                  {s.artist ? `${s.artist} · ` : ''}
                  {fmtWhenInline(s.lastPlayedAt)}
                </div>
              </div>
              {s.lang && <span className="tag t-primary">{s.lang.toUpperCase()}</span>}
              <ChevronRight size={16} aria-hidden="true" style={{ flex: 'none', color: 'var(--faint-foreground)' }} />
            </Link>
          ))}
        </section>
      )}
      {list.hasNextPage && (
        <button
          type="button"
          className="btn"
          style={{ height: 44 }}
          disabled={list.isFetchingNextPage}
          onClick={() => list.fetchNextPage()}
        >
          {S.learn.more}
        </button>
      )}
    </div>
  )
}

function SongCard({ trackId }: { trackId: string }) {
  const song = useQuery({
    queryKey: ['learn-song', trackId],
    queryFn: () => get<LearnSong>(`/app/learn/songs/${encodeURIComponent(trackId)}`),
  })
  const s = song.data
  const lines = s?.lyrics.lines ?? []
  const hasTr = lines.some((l) => l.tr)
  const credit =
    s &&
    [
      s.credits.lyrics ? `${S.learn.creditText}: ${s.credits.lyrics === 'lrclib' ? 'LRCLIB' : s.credits.lyrics}` : '',
      s.credits.model ? `${S.learn.creditTr}: ${s.credits.model.replace(/^[^:]*:/, '')}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
  return (
    <div className="stack" style={{ gap: 14, maxWidth: 720 }}>
      <Link
        to="/learn"
        className="row"
        style={{ gap: 4, minHeight: 44, fontWeight: 550, fontSize: 13.5, color: 'var(--brand-primary)', alignSelf: 'flex-start' }}
      >
        <ChevronLeft size={18} aria-hidden="true" />
        {S.learn.back}
      </Link>
      {song.isLoading && <Loading />}
      {song.isError && <ErrorBox error={song.error} onRetry={() => song.refetch()} />}
      {s && (
        <>
          <div className="stack" style={{ gap: 6 }}>
            <h1 style={{ margin: 0, fontSize: 22, letterSpacing: '-0.01em', overflowWrap: 'anywhere' }}>{s.title}</h1>
            <div className="muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
              {[s.artist, s.lang ? langName(s.lang) : '', S.learn.playsLine(s.plays, fmtWhenInline(s.lastPlayedAt))]
                .filter(Boolean)
                .join(' · ')}
            </div>
            <KnowButton trackId={s.trackId} skip={s.skip} />
          </div>
          <section className="card card-b stack" style={{ gap: 6 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>{S.learn.about}</h2>
            <Summary summary={s.summary ?? ''} hooks={s.hooks} />
          </section>
          <section className="card card-b stack" style={{ gap: 6 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>{S.learn.aired}</h2>
            <div className="ln-body">
              <p>{s.intro ?? S.learn.noIntro}</p>
            </div>
          </section>
          <section className="card card-b stack" style={{ gap: 4 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>{S.learn.lyricsTr}</h2>
            {lines.length === 0 && (
              <div className="muted" style={{ fontSize: 13.5 }}>
                {s.lyrics.status === 'instrumental' ? S.learn.instrumental : S.learn.noLyrics}
              </div>
            )}
            {lines.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed list, lines repeat
              <div className="ln-pair" key={i}>
                <div>{l.orig}</div>
                {hasTr && l.tr && <div className="t">{l.tr}</div>}
              </div>
            ))}
            {credit && <div className="ln-credit">{credit}</div>}
          </section>
        </>
      )}
    </div>
  )
}

export function Learn() {
  const { trackId } = useParams()
  return <Shell crumb={S.learn.title}>{trackId ? <SongCard trackId={trackId} /> : <ArchiveList />}</Shell>
}
