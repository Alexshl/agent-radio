import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiError, del, get, post, put } from '../api/client'
import { useMe } from '../api/hooks'
import { useToast } from '../components/Toast'
import { ErrorBox, Loading, Switch, useErrorToast } from '../components/ui'
import { LANGS, LANG_NAMES, S } from '../i18n'
import type { Lang } from '../i18n'
import { fmtDate } from '../lib/format'
import { bulkPercent, mergeSongs, noteLangs, placeholderChip } from '../lib/learn-admin'

interface PromptState {
  prompt: string
  isDefault: boolean
  default: string
  placeholders: { name: string; description: string }[]
  alwaysFresh: boolean
}
interface PlayResult {
  originalLang: string
  summary: string
  introScript: string
  hooks: string[]
  translations: string[]
  problems: string[]
  model: string
  tokensIn: number
  tokensOut: number
  ms: number
}
interface SongRow {
  trackId: string
  artist: string
  title: string
  lyrics: { status: string; hasText: boolean; source: string | null; lang: string | null; fetchedAt: string | null }
  notes: { lang: string; model: string | null; createdAt: string }[]
}
interface SongsPage {
  songs: SongRow[]
  nextCursor: string | null
  totals: { songs: number; withLyrics: number; withNotes: number; notes: number }
}
interface SongDetail {
  trackId: string
  artist: string
  title: string
  lyrics: { status: string; source: string | null; lang: string | null; fetchedAt: string | null; text: string | null }
  notes: {
    lang: string
    summary: string | null
    introText: string | null
    hooks: string[]
    pairs: { src: string; tr: string }[] | null
    model: string | null
    createdAt: string
  }[]
}
interface Bulk {
  running: boolean
  total: number
  done: number
  failed: number
  capped: boolean
}
interface PlayDraft {
  artist: string
  title: string
  lyrics: string
}

const L = () => S.admin.learn
const caption = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--muted-foreground)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
} as const

function useLearnError() {
  const fail = useErrorToast()
  const toast = useToast()
  return (e: unknown) => {
    if (e instanceof ApiError && e.code === 'cap') return toast(L().capErr, 'danger')
    if (e instanceof ApiError && e.code === 'no_provider') return toast(L().noProviderErr, 'danger')
    fail(e)
  }
}

function PromptCard({ onPrompt }: { onPrompt: (text: string) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const fail = useErrorToast()
  const q = useQuery({ queryKey: ['admin-learn-prompt'], queryFn: () => get<PromptState>('/admin/learn/prompt') })
  const [text, setText] = useState('')
  const [showDefault, setShowDefault] = useState(false)
  useEffect(() => {
    if (q.data) setText(q.data.prompt)
  }, [q.data])
  useEffect(() => onPrompt(text), [text, onPrompt])
  const done = (d: PromptState) => qc.setQueryData(['admin-learn-prompt'], d)
  const save = useMutation({
    mutationFn: () => put<PromptState>('/admin/learn/prompt', { prompt: text }),
    onSuccess: (d) => {
      done(d)
      toast(L().saved)
    },
    onError: fail,
  })
  const reset = useMutation({ mutationFn: () => del<PromptState>('/admin/learn/prompt'), onSuccess: done, onError: fail })
  const fresh = useMutation({
    mutationFn: (v: boolean) => put<PromptState>('/admin/learn/prompt', { alwaysFresh: v }),
    onSuccess: (d) => qc.setQueryData(['admin-learn-prompt'], { ...d, prompt: q.data?.prompt ?? d.prompt }),
    onError: fail,
  })
  if (q.isLoading) return <Loading />
  if (q.isError || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />
  const d = q.data
  return (
    <section className="card">
      <div className="card-h row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span style={{ flexGrow: 1 }}>{L().promptTitle}</span>
        <span className={`bdg${d.isDefault ? '' : ' t-warning'}`}>{d.isDefault ? L().isDefault : L().changed}</span>
      </div>
      <div className="card-b stack" style={{ gap: 12 }}>
        <div className="muted" style={{ fontSize: 12.5 }}>
          {L().promptHint}
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {d.placeholders.map((p) => (
            <code key={p.name} className="bdg nodot mono" title={p.description}>
              {placeholderChip(p.name)}
            </code>
          ))}
        </div>
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
          {d.placeholders.map((p) => (
            <li key={p.name}>
              <span className="mono">{placeholderChip(p.name)}</span>: {p.description}
            </li>
          ))}
        </ul>
        <div className="field">
          <label htmlFor="learn-prompt">{L().promptLabel}</label>
          <textarea
            id="learn-prompt"
            className="inp mono"
            rows={14}
            style={{ fontSize: 12.5 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn primary sm" disabled={save.isPending || text === d.prompt} onClick={() => save.mutate()}>
            {L().save}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={reset.isPending || (d.isDefault && text === d.default)}
            onClick={() => confirm(L().resetConfirm) && reset.mutate()}
          >
            {L().reset}
          </button>
          <button type="button" className="btn sm" aria-pressed={showDefault} onClick={() => setShowDefault(!showDefault)}>
            {showDefault ? L().hideDefault : L().showDefault}
          </button>
        </div>
        {showDefault && (
          <div className="field">
            <label htmlFor="learn-default">{L().defaultTitle}</label>
            <textarea id="learn-default" className="inp mono" rows={10} readOnly style={{ fontSize: 12.5 }} value={d.default} />
          </div>
        )}
        <div className="row" style={{ gap: 10, alignItems: 'flex-start', paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <Switch on={d.alwaysFresh} label={L().alwaysFresh} disabled={fresh.isPending} onChange={(v) => fresh.mutate(v)} />
          <div className="stack" style={{ gap: 2 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{L().alwaysFresh}</span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {L().alwaysFreshHint}
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

function Speak({ text, lang }: { text: string; lang: string }) {
  const fail = useLearnError()
  const audio = useRef<HTMLAudioElement | null>(null)
  const url = useRef<string | null>(null)
  useEffect(
    () => () => {
      audio.current?.pause()
      if (url.current) URL.revokeObjectURL(url.current)
    },
    [],
  )
  const m = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admin/learn/playground/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text, lang }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
        throw new ApiError(res.status, j.error ?? 'error', j.message)
      }
      return res.blob()
    },
    onSuccess: (blob) => {
      audio.current?.pause()
      if (url.current) URL.revokeObjectURL(url.current)
      url.current = URL.createObjectURL(blob)
      audio.current = new Audio(url.current)
      void audio.current.play().catch(() => {})
    },
    onError: fail,
  })
  return (
    <button type="button" className="btn sm" disabled={m.isPending} onClick={() => m.mutate()}>
      {m.isPending ? L().speaking : L().speak}
    </button>
  )
}

function PlayCard({ prompt, draft, setDraft }: { prompt: string; draft: PlayDraft; setDraft: (d: PlayDraft) => void }) {
  const { data: me } = useMe()
  const toast = useToast()
  const fail = useLearnError()
  const [lang, setLang] = useState<string>('')
  const cur = lang || me?.lang || 'uk'
  const [res, setRes] = useState<PlayResult | null>(null)
  const [resLang, setResLang] = useState(cur)
  const run = useMutation({
    mutationFn: () =>
      post<PlayResult>('/admin/learn/playground', {
        artist: draft.artist,
        title: draft.title,
        lyrics: draft.lyrics || null,
        lang: cur,
        prompt: prompt || undefined,
      }),
    onSuccess: (r) => {
      setRes(r)
      setResLang(cur)
    },
    onError: fail,
  })
  const field = (k: keyof PlayDraft) => (v: string) => setDraft({ ...draft, [k]: v })
  return (
    <section className="card">
      <div className="card-h">{L().playTitle}</div>
      <form
        className="card-b stack"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault()
          if (!draft.title.trim()) return toast(L().needTitle, 'danger')
          run.mutate()
        }}
      >
        <div className="muted" style={{ fontSize: 12.5 }}>
          {L().playHint}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <div className="field">
            <label htmlFor="pl-artist">{L().artist}</label>
            <input id="pl-artist" className="inp" value={draft.artist} onChange={(e) => field('artist')(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pl-title">{L().song}</label>
            <input id="pl-title" className="inp" value={draft.title} onChange={(e) => field('title')(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="pl-lyrics">{L().lyrics}</label>
          <textarea
            id="pl-lyrics"
            className="inp"
            rows={6}
            placeholder={L().lyricsPh}
            value={draft.lyrics}
            onChange={(e) => field('lyrics')(e.target.value)}
          />
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field">
            <label htmlFor="pl-lang">{L().storyLang}</label>
            <select id="pl-lang" className="inp" value={cur} onChange={(e) => setLang(e.target.value)}>
              {LANGS.map((l: Lang) => (
                <option key={l} value={l}>
                  {LANG_NAMES[l]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn primary" disabled={run.isPending}>
            {run.isPending ? L().generating : L().generate}
          </button>
        </div>
        {res && (
          <div
            className="stack"
            style={{
              gap: 8,
              background: 'var(--surface-muted)',
              borderRadius: 'var(--radius-md)',
              padding: 12,
              fontSize: 13.5,
              lineHeight: 1.5,
            }}
          >
            {res.problems.length > 0 && (
              <div className="banner t-warning" role="alert">
                <div className="stack" style={{ gap: 2 }}>
                  <b>{L().problems}</b>
                  {res.problems.map((p) => (
                    <span key={p}>{p}</span>
                  ))}
                </div>
              </div>
            )}
            <div style={caption}>{L().intro}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{res.introScript}</div>
            <div style={caption}>{L().summary}</div>
            <div>{res.summary}</div>
            {res.hooks.length > 0 && (
              <>
                <div style={caption}>{L().hooks}</div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {res.hooks.map((h) => (
                    <span key={h} className="bdg nodot">
                      {h}
                    </span>
                  ))}
                </div>
              </>
            )}
            {res.translations.length > 0 && (
              <details>
                <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{L().translationsN(res.translations.length)}</summary>
                <div style={{ whiteSpace: 'pre-wrap', paddingTop: 6 }}>{res.translations.join('\n')}</div>
              </details>
            )}
            <div className="row muted" style={{ gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
              <span>{L().stats(res.model, res.tokensIn, res.tokensOut, (res.ms / 1000).toFixed(1))}</span>
              <Speak text={res.introScript} lang={resLang} />
            </div>
          </div>
        )}
      </form>
    </section>
  )
}

function lyricsChip(s: { hasText: boolean; status: string }) {
  if (s.hasText) return { label: L().lyrFound, cls: ' t-success' }
  if (s.status === 'instrumental') return { label: L().lyrInstr, cls: '' }
  if (s.status === 'error') return { label: L().lyrError, cls: ' t-danger' }
  if (s.status === 'not_found') return { label: L().lyrNotFound, cls: '' }
  return { label: L().lyrNone, cls: '' }
}

function DetailCard({ trackId, onClose, onPlay }: { trackId: string; onClose: () => void; onPlay: (d: PlayDraft) => void }) {
  const q = useQuery({ queryKey: ['admin-learn-song', trackId], queryFn: () => get<SongDetail>(`/admin/learn/songs/${trackId}`) })
  const ref = useRef<HTMLElement>(null)
  useEffect(() => ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), [])
  const d = q.data
  return (
    <section className="card" ref={ref}>
      <div className="card-h row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span style={{ flexGrow: 1 }}>{d ? `${d.artist ? `${d.artist} — ` : ''}${d.title}` : L().detailTitle}</span>
        {d && (
          <button
            type="button"
            className="btn sm"
            onClick={() => onPlay({ artist: d.artist, title: d.title, lyrics: d.lyrics.text ?? '' })}
          >
            {L().toPlay}
          </button>
        )}
        <button type="button" className="btn sm" onClick={onClose}>
          {L().close}
        </button>
      </div>
      <div className="card-b stack" style={{ gap: 12 }}>
        {q.isLoading && <Loading />}
        {q.isError && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
        {d && (
          <div className="ar-two">
            <div className="stack" style={{ gap: 6, minWidth: 0 }}>
              <div style={caption}>
                {L().lyrics}
                {d.lyrics.source ? ` · ${L().source}: ${d.lyrics.source}` : ''}
              </div>
              {d.lyrics.text?.trim() ? (
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, maxHeight: 360, overflow: 'auto' }}>
                  {d.lyrics.text}
                </pre>
              ) : (
                <div className="muted">{L().noLyrics}</div>
              )}
            </div>
            <div className="stack" style={{ gap: 12, minWidth: 0 }}>
              <div style={caption}>{L().savedNotes}</div>
              {d.notes.length === 0 && <div className="muted">{L().noNotes}</div>}
              {d.notes.map((n) => (
                <div
                  key={n.lang}
                  className="stack"
                  style={{ gap: 6, background: 'var(--surface-muted)', borderRadius: 'var(--radius-md)', padding: 12, fontSize: 13 }}
                >
                  <div className="muted" style={{ fontSize: 12 }}>
                    {LANG_NAMES[n.lang as Lang] ?? n.lang} · {fmtDate(n.createdAt)}
                    {n.model ? ` · ${n.model}` : ''}
                  </div>
                  {n.introText && <div style={{ whiteSpace: 'pre-wrap' }}>{n.introText}</div>}
                  {n.summary && (
                    <>
                      <div style={caption}>{L().summary}</div>
                      <div>{n.summary}</div>
                    </>
                  )}
                  {n.hooks.length > 0 && (
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {n.hooks.map((h) => (
                        <span key={h} className="bdg nodot">
                          {h}
                        </span>
                      ))}
                    </div>
                  )}
                  {n.pairs && n.pairs.length > 0 && (
                    <details>
                      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                        {L().pairs} ({n.pairs.length})
                      </summary>
                      <div style={{ paddingTop: 6 }}>
                        {n.pairs.map((p, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: lines repeat, the order is fixed
                          <div key={i}>
                            {p.src} <span className="muted">→ {p.tr}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function SongsCard({ onPlay }: { onPlay: (d: PlayDraft) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const fail = useLearnError()
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])
  const songs = useInfiniteQuery({
    queryKey: ['admin-learn-songs', term],
    queryFn: ({ pageParam }) => get<SongsPage>(`/admin/learn/songs?q=${encodeURIComponent(term)}&cursor=${pageParam}`),
    initialPageParam: '0',
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  })
  const prog = useQuery({
    queryKey: ['admin-learn-progress'],
    queryFn: () => get<Bulk>('/admin/learn/regenerate-all'),
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
  })
  const wasRunning = useRef(false)
  const running = !!prog.data?.running
  useEffect(() => {
    // the run ended: the table shows the new notes
    if (wasRunning.current && !running) qc.invalidateQueries({ queryKey: ['admin-learn-songs'] })
    wasRunning.current = running
  }, [running, qc])
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-learn-songs'] })
    qc.invalidateQueries({ queryKey: ['admin-learn-song'] })
    qc.invalidateQueries({ queryKey: ['admin-learn-progress'] })
  }
  const regen = useMutation({
    mutationFn: (id: string) => post<{ queued: string[] }>(`/admin/learn/songs/${id}/regenerate`),
    onSuccess: (r) => {
      toast(L().queued(r.queued.length))
      refresh()
    },
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: (id: string) => del<{ deleted: number }>(`/admin/learn/songs/${id}/notes`),
    onSuccess: (r) => {
      toast(L().deleted(r.deleted))
      refresh()
    },
    onError: fail,
  })
  const regenAll = useMutation({ mutationFn: () => post('/admin/learn/regenerate-all'), onSuccess: refresh, onError: fail })
  const removeAll = useMutation({
    mutationFn: () => del<{ deleted: number }>('/admin/learn/notes'),
    onSuccess: (r) => {
      toast(L().deleted(r.deleted))
      refresh()
    },
    onError: fail,
  })
  const rows = mergeSongs((songs.data?.pages ?? []).map((p) => p.songs))
  const totals = songs.data?.pages[0]?.totals
  const b = prog.data
  const showBar = !!b && (b.running || b.total > 0)
  return (
    <>
      <section className="card">
        <div className="card-h row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <span style={{ flexGrow: 1 }}>{L().songsTitle(totals?.withLyrics ?? 0, totals?.withNotes ?? 0)}</span>
          <button
            type="button"
            className="btn sm"
            disabled={regenAll.isPending || running}
            onClick={() => confirm(L().regenAllConfirm) && regenAll.mutate()}
          >
            {L().regenAll}
          </button>
          <button
            type="button"
            className="btn sm danger"
            disabled={removeAll.isPending || running}
            onClick={() => confirm(L().deleteAllConfirm) && removeAll.mutate()}
          >
            {L().deleteAll}
          </button>
        </div>
        <div className="card-b stack" style={{ gap: 12 }}>
          {showBar && b && (
            <div className="stack" style={{ gap: 6 }}>
              <div role="status" className="row muted" style={{ gap: 10, fontSize: 13, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 160px', height: 6, borderRadius: 9, background: 'var(--surface-muted)' }}>
                  <div style={{ width: `${bulkPercent(b)}%`, height: 6, borderRadius: 9, background: 'var(--brand-primary)' }} />
                </div>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{L().progress(b.done, b.total, b.failed)}</span>
              </div>
              {b.capped && !b.running && (
                <div className="banner t-warning" role="alert">
                  {L().capped}
                </div>
              )}
            </div>
          )}
          <input
            type="search"
            className="inp"
            aria-label={L().search}
            placeholder={L().search}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {songs.isLoading && <Loading />}
          {songs.isError && <ErrorBox error={songs.error} onRetry={() => songs.refetch()} />}
          {!songs.isLoading && !songs.isError && rows.length === 0 && <div className="muted">{L().empty}</div>}
          {rows.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--muted-foreground)', fontSize: 12.5 }}>
                    <th style={{ padding: '8px 10px' }}>{L().colSong}</th>
                    <th style={{ padding: '8px 10px' }}>{L().colLyrics}</th>
                    <th style={{ padding: '8px 10px' }}>{L().colNotes}</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>{L().colActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => {
                    const chip = lyricsChip(s.lyrics)
                    const last = [...s.notes.map((n) => n.createdAt)].sort().at(-1) ?? ''
                    return (
                      <tr key={s.trackId} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: 10 }}>
                          <div style={{ fontWeight: 600 }}>{s.title}</div>
                          <div className="muted" style={{ fontSize: 13 }}>
                            {s.artist}
                          </div>
                        </td>
                        <td style={{ padding: 10 }}>
                          <span className={`bdg${chip.cls}`}>{chip.label}</span>
                        </td>
                        <td className="muted" style={{ padding: 10, fontSize: 13 }}>
                          {s.notes.length ? `${noteLangs(s.notes)} · ${fmtDate(last)}` : L().noNotes}
                        </td>
                        <td style={{ padding: 10, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            <button type="button" className="btn sm" onClick={() => setOpen(s.trackId)}>
                              {L().open}
                            </button>
                            <button
                              type="button"
                              className="btn sm"
                              disabled={running || regen.isPending}
                              onClick={() => regen.mutate(s.trackId)}
                            >
                              {L().regen}
                            </button>
                            <button
                              type="button"
                              className="btn sm danger"
                              disabled={running || s.notes.length === 0}
                              onClick={() => confirm(L().removeConfirm(s.title)) && remove.mutate(s.trackId)}
                            >
                              {L().remove}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {songs.hasNextPage && (
            <div>
              <button type="button" className="btn sm" disabled={songs.isFetchingNextPage} onClick={() => songs.fetchNextPage()}>
                {L().more}
              </button>
            </div>
          )}
          <div className="muted" style={{ fontSize: 12.5 }}>
            {L().songsHint}
          </div>
        </div>
      </section>
      {open && <DetailCard key={open} trackId={open} onClose={() => setOpen(null)} onPlay={onPlay} />}
    </>
  )
}

export function LearnTab() {
  const [prompt, setPrompt] = useState('')
  const [draft, setDraft] = useState<PlayDraft>({ artist: '', title: '', lyrics: '' })
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ar-two" style={{ gridTemplateColumns: undefined }}>
        <PromptCard onPrompt={setPrompt} />
        <PlayCard prompt={prompt} draft={draft} setDraft={setDraft} />
      </div>
      <SongsCard onPlay={setDraft} />
    </div>
  )
}
