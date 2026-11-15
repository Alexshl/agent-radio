import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Folder, FolderOpen, GripVertical, ListMusic, Music, Pause, Play, Plus, Search, Trash2, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { del, get, post, put } from '../api/client'
import { useMe } from '../api/hooks'
import { usePlayer } from '../components/Player'
import type { PlaylistSummary, Track } from '../api/types'
import { useToast } from '../components/Toast'
import { DropZone, UPLOAD_ACCEPT, UploadList, useFileDrag, useUploader } from '../components/Upload'
import { ErrorBox, Loading, PageHead, Seg, useErrorToast } from '../components/ui'
import { S } from '../i18n'
import { Shell } from '../layouts/Shell'
import { fmtBytes, fmtDuration, fmtNumber, fmtTotal, fmtWhenInline } from '../lib/format'

interface FolderNode {
  path: string
  name: string
  depth: number
  count: number
}
interface PlaylistFull {
  id: string
  name: string
  orderMode: 'shuffle' | 'ordered'
  tracks: Track[]
}
type View = 'tracks' | 'albums' | 'artists'

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

interface Draft {
  id: string | null
  name: string
  orderMode: 'shuffle' | 'ordered'
  tracks: Track[]
  dirty: boolean
}
// the draft of a playlist can hold thousands of tracks: only the first ones are drawn
const DRAFT_SHOWN = 200
const EMPTY: Draft = { id: null, name: '', orderMode: 'shuffle', tracks: [], dirty: false }

export function Library() {
  const qc = useQueryClient()
  const toast = useToast()
  const fail = useErrorToast()
  const status = useQuery({
    queryKey: ['library-status'],
    queryFn: () =>
      get<{
        total: number
        scanning: boolean
        lastScan: { at: string } | null
        upload: { allowed: boolean; maxFileMb: number; quotaBytes: number | null; usedBytes: number }
      }>('/app/library/status'),
    refetchInterval: (query) => (query.state.data?.scanning ? 2000 : false),
  })
  const { data: me } = useMe()
  const isAdmin = me?.role === 'admin'
  const upload = status.data?.upload
  const canUpload = !!upload?.allowed
  const uploader = useUploader(upload?.maxFileMb ?? 95)
  const fileInput = useRef<HTMLInputElement>(null)
  const addFiles = useCallback((files: File[]) => files.length > 0 && uploader.add(files), [uploader.add])
  const dragging = useFileDrag(addFiles, canUpload)
  const removeTrack = useMutation({
    mutationFn: (id: string) => del(`/admin/library/tracks/${id}`),
    onSuccess: () => {
      toast(S.library.trackDeleted)
      for (const key of ['library-status', 'library-folders', 'library-tracks', 'playlists']) qc.invalidateQueries({ queryKey: [key] })
    },
    onError: fail,
  })
  const askDelete = (t: Track) => confirm(S.library.deleteTrackConfirm(t.title)) && removeTrack.mutate(t.id)
  const foldersQ = useQuery({
    queryKey: ['library-folders'],
    queryFn: () => get<{ folders: FolderNode[]; total: number }>('/app/library/folders'),
  })
  const playlistsQ = useQuery({ queryKey: ['playlists'], queryFn: () => get<{ playlists: PlaylistSummary[] }>('/app/playlists') })

  const [dir, setDir] = useState('')
  const [params] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const [view, setView] = useState<View>('tracks')
  const dq = useDebounced(q)
  const tracksQ = useQuery({
    queryKey: ['library-tracks', dir, dq],
    queryFn: () =>
      get<{ tracks: Track[]; total: number }>(`/app/library/tracks?limit=300&dir=${encodeURIComponent(dir)}&q=${encodeURIComponent(dq)}`),
    placeholderData: (prev) => prev,
  })
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  // preview goes through the global player (the bar stays when the user leaves the page)
  const player = usePlayer()
  const trackKey = (t: Track) => `track:${t.id}`
  const preview = (t: Track) =>
    player.toggle({
      key: trackKey(t),
      kind: 'track',
      src: `/api/app/library/tracks/${t.id}/audio`,
      title: t.title,
      subtitle: [t.artist, t.album].filter(Boolean).join(' · '),
      href: `/library?q=${encodeURIComponent(t.title)}`,
    })
  const isPreviewing = (t: Track) => player.isPlaying(trackKey(t))

  // adds every track of a folder (recursive) / search: all of them, not just the page that is loaded
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [adding, setAdding] = useState(false)
  const addMatching = async (p: { dir: string; q: string }, label: string) => {
    setAdding(true)
    try {
      const r = await get<{ tracks: Track[]; truncated: boolean }>(
        `/app/library/track-ids?dir=${encodeURIComponent(p.dir)}&q=${encodeURIComponent(p.q)}`,
      )
      const have = new Set(draftRef.current.tracks.map((t) => t.id))
      const fresh = r.tracks.filter((t) => !have.has(t.id))
      setDraft((d) => ({ ...d, dirty: true, tracks: [...d.tracks, ...fresh.filter((t) => !d.tracks.some((x) => x.id === t.id))] }))
      toast(S.library.addedFrom(fresh.length, label, r.tracks.length - fresh.length, r.truncated))
    } catch (e) {
      fail(e)
    } finally {
      setAdding(false)
    }
  }

  const picked = useMemo(() => new Set(draft.tracks.map((t) => t.id)), [draft.tracks])
  const toggle = (t: Track) =>
    setDraft((d) => ({
      ...d,
      dirty: true,
      tracks: d.tracks.some((x) => x.id === t.id) ? d.tracks.filter((x) => x.id !== t.id) : [...d.tracks, t],
    }))

  const openPlaylist = async (id: string) => {
    try {
      const pl = await get<PlaylistFull>(`/app/playlists/${id}`)
      setDraft({ id: pl.id, name: pl.name, orderMode: pl.orderMode, tracks: pl.tracks, dirty: false })
    } catch (e) {
      fail(e)
    }
  }

  const save = useMutation({
    mutationFn: async (air: boolean) => {
      const body = {
        name: draft.name.trim() || S.library.namePlaceholder,
        orderMode: draft.orderMode,
        trackIds: draft.tracks.map((t) => t.id),
      }
      const pl = draft.id ? await put<PlaylistFull>(`/app/playlists/${draft.id}`, body) : await post<PlaylistFull>('/app/playlists', body)
      if (air) await put('/app/station/source', { type: 'userplaylist', playlistId: pl.id })
      return { pl, air }
    },
    onSuccess: ({ pl, air }) => {
      setDraft({ id: pl.id, name: pl.name, orderMode: pl.orderMode, tracks: pl.tracks, dirty: false })
      toast(air ? S.library.onAirToast : S.library.savedToast)
      qc.invalidateQueries({ queryKey: ['playlists'] })
      qc.invalidateQueries({ queryKey: ['radio'] })
    },
    onError: fail,
  })

  const remove = useMutation({
    mutationFn: (id: string) => del(`/app/playlists/${id}`),
    onSuccess: () => {
      setDraft(EMPTY)
      qc.invalidateQueries({ queryKey: ['playlists'] })
      qc.invalidateQueries({ queryKey: ['radio'] })
    },
    onError: fail,
  })

  // drag & drop reorder of the draft
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const move = (from: number, to: number) =>
    setDraft((d) => {
      if (from === to || to < 0 || to >= d.tracks.length) return d
      const next = [...d.tracks]
      const [item] = next.splice(from, 1)
      if (item) next.splice(to, 0, item)
      return { ...d, tracks: next, dirty: true }
    })

  const total = status.data?.total ?? 0
  const scanned = status.data?.lastScan ? S.library.updated(fmtWhenInline(status.data.lastScan.at)) : ''
  const tracks = tracksQ.data?.tracks ?? []
  const durationTotal = draft.tracks.reduce((a, t) => a + t.durationSec, 0)
  const where = dir ? (foldersQ.data?.folders.find((f) => f.path === dir)?.name ?? dir) : S.library.allTracks

  const groups = useMemo(() => {
    if (view === 'tracks') return []
    const m = new Map<string, number>()
    for (const t of tracks) {
      const k = view === 'albums' ? t.album : t.artist
      if (k) m.set(k, (m.get(k) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [view, tracks])

  const gsearch = (
    <label className="gsearch" style={{ cursor: 'text' }}>
      <Search size={14} aria-hidden="true" />
      <input
        ref={searchRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={S.library.searchGlobal}
        aria-label={S.library.searchGlobal}
        style={{ border: 0, background: 'transparent', outline: 'none', font: 'inherit', color: 'inherit', flex: 1, minWidth: 0 }}
      />
      <span className="kbd">⌘K</span>
    </label>
  )

  const cols = `36px minmax(160px,1.4fr) minmax(120px,1fr) minmax(110px,1fr) 64px ${isAdmin ? '80px' : '44px'}`
  return (
    <Shell crumb={S.nav.library} wide extra={gsearch}>
      <PageHead
        title={S.library.title}
        sub={S.library.sub(total, scanned)}
        actions={
          <div className="row wrap" style={{ gap: 8 }}>
            {canUpload && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  accept={UPLOAD_ACCEPT}
                  onChange={(e) => {
                    addFiles([...(e.target.files ?? [])])
                    e.target.value = ''
                  }}
                />
                <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
                  <Upload size={16} aria-hidden="true" />
                  {S.library.upload}
                </button>
              </>
            )}
            <button type="button" className="btn primary" onClick={() => setDraft({ ...EMPTY })}>
              <Plus size={16} aria-hidden="true" />
              {S.library.newPlaylist}
            </button>
          </div>
        }
      />
      {canUpload && (dragging || uploader.items.length > 0) && (
        <DropZone over={dragging} maxMb={upload?.maxFileMb ?? 95} compact onPick={() => fileInput.current?.click()} />
      )}
      {canUpload && upload?.quotaBytes != null && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          {S.library.quota(fmtBytes(upload.usedBytes), fmtBytes(upload.quotaBytes))}
        </div>
      )}
      <UploadList items={uploader.items} onClear={uploader.clearDone} />
      {status.data && total === 0 && !tracksQ.isLoading && (
        <div className="card">
          <div className="empty">
            <Music size={28} aria-hidden="true" />
            <div className="t">{S.library.emptyTitle}</div>
            <div>{isAdmin ? S.library.emptyAdmin : canUpload ? S.library.emptyUserCanUpload : S.library.emptyUser}</div>
            {canUpload && (
              <div style={{ width: '100%', maxWidth: 480 }}>
                <DropZone over={dragging} maxMb={upload?.maxFileMb ?? 95} onPick={() => fileInput.current?.click()} />
              </div>
            )}
          </div>
        </div>
      )}
      {(foldersQ.isError || tracksQ.isError) && <ErrorBox error={foldersQ.error ?? tracksQ.error} onRetry={() => tracksQ.refetch()} />}
      {status.data?.scanning && <div className="banner">{S.library.scanning}</div>}

      <div className="ar-lib">
        <section className="card">
          <div className="card-h">{S.library.folders}</div>
          <div className="card-b ar-tree stack" style={{ gap: 2, padding: 8 }}>
            <button type="button" className={`ti${dir === '' ? ' on' : ''}`} onClick={() => setDir('')}>
              <FolderOpen size={15} aria-hidden="true" />
              {S.library.allTracks}
              <span className="cnt">{fmtNumber(foldersQ.data?.total ?? 0)}</span>
            </button>
            {foldersQ.data?.folders.map((f) => (
              <div className="ti-row" key={f.path}>
                <button
                  type="button"
                  className={`ti${dir === f.path ? ' on' : ''}`}
                  style={{ paddingLeft: 10 + f.depth * 14 }}
                  onClick={() => setDir(f.path)}
                  title={f.path}
                >
                  <Folder size={15} aria-hidden="true" style={{ flex: 'none' }} />
                  <span className="ell">{f.name}</span>
                  <span className="cnt">{f.count}</span>
                </button>
                <button
                  type="button"
                  className="btn icon ghost sm ti-add"
                  aria-label={S.library.addFolder(f.name)}
                  title={S.library.addFolder(f.name)}
                  disabled={adding}
                  onClick={() => addMatching({ dir: f.path, q: '' }, f.name)}
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
              </div>
            ))}
            <div className="lbl" style={{ padding: '12px 10px 4px' }}>
              {S.library.myPlaylists}
            </div>
            {playlistsQ.data?.playlists.map((p) => (
              <button type="button" key={p.id} className={`ti${draft.id === p.id ? ' on' : ''}`} onClick={() => openPlaylist(p.id)}>
                <ListMusic size={15} aria-hidden="true" style={{ flex: 'none' }} />
                <span className="ell">{p.name}</span>
                <span className="cnt">{p.count}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="stack" style={{ gap: 12, minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <label
              className="inp"
              style={{ flex: '1 1 240px', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--faint-foreground)' }}
            >
              <Search size={14} aria-hidden="true" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={S.library.searchPlaceholder(where)}
                aria-label={S.library.searchPlaceholder(where)}
                style={{
                  border: 0,
                  background: 'transparent',
                  outline: 'none',
                  font: 'inherit',
                  color: 'var(--foreground)',
                  flex: 1,
                  minWidth: 0,
                }}
              />
            </label>
            <Seg
              value={view}
              options={[
                { id: 'tracks', label: S.library.views.tracks },
                { id: 'albums', label: S.library.views.albums },
                { id: 'artists', label: S.library.views.artists },
              ]}
              onChange={setView}
            />
          </div>

          {view !== 'tracks' ? (
            <div className="card">
              <div className="card-b row wrap" style={{ gap: 8 }}>
                {groups.length === 0 && <span className="muted">{S.library.empty}</span>}
                {groups.map(([name, n]) => (
                  <button
                    type="button"
                    key={name}
                    className="btn sm"
                    onClick={() => {
                      setQ(name)
                      setView('tracks')
                    }}
                  >
                    {name} <span className="muted mono">{n}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="d-only" style={{ overflowX: 'auto' }}>
              <div className="tbl" style={{ minWidth: 560 }}>
                <div className="thead" style={{ gridTemplateColumns: cols }}>
                  <span />
                  <span>{S.library.track}</span>
                  <span>{S.library.artist}</span>
                  <span>{S.library.album}</span>
                  <span className="right">{S.library.duration}</span>
                  <span />
                </div>
                {tracksQ.isLoading && <Loading />}
                {tracksQ.data && tracks.length === 0 && (
                  <div className="muted" style={{ padding: 16 }}>
                    {total === 0 ? S.library.emptyLibrary : S.library.empty}
                  </div>
                )}
                {tracks.map((t) => (
                  <div key={t.id} className={`trow${picked.has(t.id) ? ' is-sel' : ''}`} style={{ gridTemplateColumns: cols }}>
                    <span style={{ display: 'flex', justifyContent: 'center' }}>
                      <button
                        type="button"
                        className="btn icon ghost sm"
                        aria-label={isPreviewing(t) ? S.library.stopPreview : S.library.preview}
                        onClick={() => preview(t)}
                      >
                        {isPreviewing(t) ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                      </button>
                    </span>
                    <span className="ell" style={{ fontWeight: 550 }} title={t.title}>
                      {t.title}
                    </span>
                    <span className="ell muted">{t.artist}</span>
                    <span className="ell muted">{t.album}</span>
                    <span className="num">{fmtDuration(t.durationSec)}</span>
                    <span style={{ display: 'flex', justifyContent: 'center', gap: 2 }}>
                      <button
                        type="button"
                        className="btn icon ghost sm"
                        aria-label={picked.has(t.id) ? S.library.removeFromPlaylist : S.library.addToPlaylist}
                        onClick={() => toggle(t)}
                      >
                        {picked.has(t.id) ? <Check size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
                      </button>
                      {isAdmin && (
                        <button
                          type="button"
                          className="btn icon ghost sm"
                          aria-label={S.library.deleteTrack}
                          title={S.library.deleteTrack}
                          disabled={removeTrack.isPending}
                          onClick={() => askDelete(t)}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      )}
                    </span>
                  </div>
                ))}
                <div className="tfoot">
                  <span className="tnum">{S.library.shown(tracks.length, tracksQ.data?.total ?? 0)}</span>
                  {tracks.length > 0 && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={adding}
                      onClick={() => addMatching({ dir, q: dq }, dq ? `«${dq}»` : where)}
                    >
                      <Plus size={14} aria-hidden="true" />
                      {S.library.addAllCount(tracksQ.data?.total ?? tracks.length)}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          {view === 'tracks' && (
            // phones: compact rows instead of a table that scrolls sideways
            <div className="m-only m-tracks card" style={{ flexDirection: 'column', overflow: 'hidden' }}>
              {tracksQ.data && tracks.length === 0 && (
                <div className="muted" style={{ padding: 14 }}>
                  {total === 0 ? S.library.emptyLibrary : S.library.empty}
                </div>
              )}
              {tracks.map((t) => (
                <div key={t.id} className={`m-track${picked.has(t.id) ? ' is-sel' : ''}`}>
                  <button
                    type="button"
                    className="btn icon ghost sm"
                    aria-label={isPreviewing(t) ? S.library.stopPreview : S.library.preview}
                    onClick={() => preview(t)}
                  >
                    {isPreviewing(t) ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                  </button>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="ell" style={{ display: 'block', fontWeight: 600 }}>
                      {t.title}
                    </span>
                    <span className="ell muted" style={{ display: 'block', fontSize: 12 }}>
                      {[t.artist, t.album].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="mono muted" style={{ fontSize: 12 }}>
                    {fmtDuration(t.durationSec)}
                  </span>
                  <button
                    type="button"
                    className="btn icon ghost sm"
                    aria-label={picked.has(t.id) ? S.library.removeFromPlaylist : S.library.addToPlaylist}
                    onClick={() => toggle(t)}
                  >
                    {picked.has(t.id) ? <Check size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
                  </button>
                  {isAdmin && (
                    <button
                      type="button"
                      className="btn icon ghost sm"
                      aria-label={S.library.deleteTrack}
                      disabled={removeTrack.isPending}
                      onClick={() => askDelete(t)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
              <div className="tfoot" style={{ position: 'static' }}>
                <span className="tnum">{S.library.shown(tracks.length, tracksQ.data?.total ?? 0)}</span>
              </div>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-h" style={{ justifyContent: 'space-between' }}>
            {S.library.playlist}
            <span className="bdg t-primary">{draft.id && !draft.dirty ? S.library.saved : S.library.draft}</span>
          </div>
          <div className="card-b stack" style={{ gap: 12, borderBottom: '1px solid var(--border)' }}>
            <div className="field">
              <label htmlFor="ar-plname">{S.library.name}</label>
              <input
                id="ar-plname"
                className="inp"
                placeholder={S.library.namePlaceholder}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value, dirty: true })}
              />
            </div>
            <div className="row between">
              <span className="muted">{S.library.order}</span>
              <Seg
                value={draft.orderMode}
                options={[
                  { id: 'shuffle', label: S.library.shuffle },
                  { id: 'ordered', label: S.library.ordered },
                ]}
                onChange={(orderMode) => setDraft({ ...draft, orderMode, dirty: true })}
                label={S.library.order}
              />
            </div>
            <div className="row between">
              <span className="muted">{S.library.countDuration}</span>
              <span className="mono tnum">
                {draft.tracks.length} · {fmtTotal(durationTotal)}
              </span>
            </div>
          </div>
          <div>
            {draft.tracks.length === 0 && (
              <div className="muted" style={{ padding: '14px 16px', fontSize: 12.5 }}>
                {S.library.emptyPlaylist}
              </div>
            )}
            {draft.tracks.slice(0, DRAFT_SHOWN).map((t, i) => (
              // biome-ignore lint/a11y/noStaticElementInteractions: drag and drop reorder; the keyboard way is the arrows on the handle
              <div
                key={t.id}
                className={`ar-pl${dragOver === i ? ' drag-over' : ''}`}
                draggable
                onDragStart={() => setDragFrom(i)}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(i)
                }}
                onDragLeave={() => setDragOver((o) => (o === i ? null : o))}
                onDrop={() => {
                  if (dragFrom !== null) move(dragFrom, i)
                  setDragFrom(null)
                  setDragOver(null)
                }}
                onDragEnd={() => {
                  setDragFrom(null)
                  setDragOver(null)
                }}
              >
                <button
                  type="button"
                  className="ar-handle"
                  aria-label={S.library.reorder}
                  title={S.library.reorder}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      e.preventDefault()
                      move(i, e.key === 'ArrowUp' ? i - 1 : i + 1)
                    }
                  }}
                >
                  <GripVertical size={16} />
                </button>
                <button
                  type="button"
                  className="btn icon ghost sm"
                  aria-label={isPreviewing(t) ? S.library.stopPreview : S.library.preview}
                  onClick={() => preview(t)}
                >
                  {isPreviewing(t) ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                </button>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="ell" style={{ display: 'block', fontWeight: 550 }}>
                    {t.title}
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {t.artist}
                  </span>
                </span>
                <span className="mono muted" style={{ fontSize: 12 }}>
                  {fmtDuration(t.durationSec)}
                </span>
                <button type="button" className="btn icon ghost sm" aria-label={S.library.removeFromPlaylist} onClick={() => toggle(t)}>
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
            ))}
            {draft.tracks.length > DRAFT_SHOWN && (
              <div className="muted" style={{ padding: '10px 16px', fontSize: 12.5 }}>
                {S.library.andMore(draft.tracks.length - DRAFT_SHOWN)}
              </div>
            )}
          </div>
          <div className="card-b row wrap" style={{ gap: 8, borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
              className="btn primary"
              disabled={draft.tracks.length === 0 || save.isPending}
              onClick={() => save.mutate(true)}
            >
              {S.library.saveAndAir}
            </button>
            <button type="button" className="btn" disabled={draft.tracks.length === 0 || save.isPending} onClick={() => save.mutate(false)}>
              {S.library.save}
            </button>
            {draft.id && (
              <button
                type="button"
                className="btn icon ghost"
                aria-label={S.library.deletePlaylist}
                title={S.library.deletePlaylist}
                onClick={() => confirm(S.library.deleteConfirm) && draft.id && remove.mutate(draft.id)}
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        </section>
      </div>
    </Shell>
  )
}
