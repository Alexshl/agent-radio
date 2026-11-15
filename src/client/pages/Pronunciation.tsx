import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router'
import { ApiError, del, get, patch, post } from '../api/client'
import { useMe } from '../api/hooks'
import { usePlayer } from '../components/Player'
import { useToast } from '../components/Toast'
import { ErrorBox, Loading, PageHead, Seg, useErrorToast } from '../components/ui'
import { LANGS as SUMMARY_LANGS, S } from '../i18n'
import type { Lang as SummaryLang } from '../i18n'
import { Shell } from '../layouts/Shell'

interface Entry {
  id: string
  scope: 'global' | 'user'
  lang: SummaryLang | '*'
  match: string
  replacement: string
  note: string
}
type Lang = Entry['lang']
type Scope = 'mine' | 'shared'

const LANGS: { id: Lang; label: string }[] = [
  { id: '*', label: S.pron.anyLang },
  ...SUMMARY_LANGS.map((id) => ({ id, label: id.toUpperCase() })),
]
const langLabel = (l: string) => (l === '*' ? S.pron.anyLang : l.toUpperCase())

// Synthesizes one phrase with the user's current voice and plays it through the global player (blob URL, one clip at a time).
function usePreview() {
  const player = usePlayer()
  const fail = useErrorToast()
  const [busy, setBusy] = useState<string | null>(null)
  const url = useRef<string | null>(null)
  useEffect(
    () => () => {
      if (url.current) URL.revokeObjectURL(url.current)
    },
    [],
  )
  const preview = async (key: string, text: string, lang: Lang) => {
    const k = `pron:${key}`
    if (player.isPlaying(k)) return player.stop()
    if (!text.trim()) return
    setBusy(key)
    try {
      const res = await fetch('/api/app/pronunciations/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text: text.trim(), ...(lang === '*' ? {} : { lang }) }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
        throw new ApiError(res.status, j.error ?? 'error', j.message)
      }
      if (url.current) URL.revokeObjectURL(url.current)
      url.current = URL.createObjectURL(await res.blob())
      player.start({
        key: k,
        kind: 'voice',
        src: url.current,
        title: text.trim().slice(0, 80),
        subtitle: S.pron.title,
        href: '/pronunciation',
      })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }
  return { preview, busy, isPlaying: (key: string) => player.isPlaying(`pron:${key}`) }
}

function ListenButton({ playing, busy, onClick, label }: { playing: boolean; busy: boolean; onClick: () => void; label?: string }) {
  return (
    <button type="button" className={label ? 'btn' : 'btn icon ghost sm'} aria-label={S.pron.listen} onClick={onClick} disabled={busy}>
      {busy ? (
        <Loader2 size={15} className="spin" aria-hidden="true" />
      ) : playing ? (
        <Pause size={15} aria-hidden="true" />
      ) : (
        <Play size={15} aria-hidden="true" />
      )}
      {label}
    </button>
  )
}

export function Pronunciation() {
  const { data: me } = useMe()
  const isAdmin = me?.role === 'admin'
  const [scope, setScope] = useState<Scope>('mine')
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Entry | null>(null)
  const [match, setMatch] = useState('')
  const [say, setSay] = useState('')
  const [lang, setLang] = useState<Lang>('ru')
  const [note, setNote] = useState('')
  const toast = useToast()
  const fail = useErrorToast()
  const qc = useQueryClient()
  const pv = usePreview()

  const own = useQuery({ queryKey: ['pron'], queryFn: () => get<{ mine: Entry[]; global: Entry[] }>('/app/pronunciations') })
  const adminList = useQuery({
    queryKey: ['pron-admin'],
    queryFn: () => get<{ items: Entry[] }>('/admin/pronunciations'),
    enabled: isAdmin && scope === 'shared',
  })
  // the admin edits the shared list through the admin API; everybody else sees it read-only
  const editable = scope === 'mine' || isAdmin
  const base = scope === 'mine' ? '/app/pronunciations' : '/admin/pronunciations'
  const items = scope === 'mine' ? own.data?.mine : isAdmin ? adminList.data?.items : own.data?.global
  const loading = own.isPending || (isAdmin && scope === 'shared' && adminList.isPending)
  const error = own.error ?? adminList.error

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['pron'] })
    qc.invalidateQueries({ queryKey: ['pron-admin'] })
  }
  const reset = () => {
    setEditing(null)
    setMatch('')
    setSay('')
    setNote('')
  }
  const startEdit = (e: Entry) => {
    setEditing(e)
    setMatch(e.match)
    setSay(e.replacement)
    setLang(e.lang)
    setNote(e.note)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const switchScope = (s: Scope) => {
    reset()
    setScope(s)
  }

  const submit = useMutation({
    mutationFn: () => {
      const body = { match: match.trim(), replacement: say.trim(), lang, note: note.trim() }
      return editing ? patch(`${base}/${editing.id}`, body) : post(base, body)
    },
    onSuccess: () => {
      toast(editing ? S.pron.saved : S.pron.added)
      reset()
      refresh()
    },
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: (e: Entry) => del(`${base}/${e.id}`),
    onSuccess: () => {
      toast(S.pron.removed)
      if (editing) reset()
      refresh()
    },
    onError: fail,
  })
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (match.trim() && say.trim()) submit.mutate()
  }

  const needle = q.trim().toLowerCase()
  const shown = (items ?? []).filter((e) => !needle || `${e.match} ${e.replacement} ${e.note}`.toLowerCase().includes(needle))

  return (
    <Shell crumb={S.pron.crumb}>
      <PageHead
        title={S.pron.title}
        sub={S.pron.sub}
        actions={
          <Link className="btn" to="/">
            {S.pron.back}
          </Link>
        }
      />
      <div className="banner" role="note">
        <div>
          <b>{S.pron.hintTitle}.</b> {S.pron.hintBody}
        </div>
      </div>
      {isAdmin && (
        <Seg
          value={scope}
          options={[
            { id: 'mine' as const, label: S.pron.mine },
            { id: 'shared' as const, label: S.pron.shared },
          ]}
          onChange={switchScope}
          label={S.pron.title}
        />
      )}
      {editable && (
        <section className="card">
          <div className="card-h">{editing ? S.pron.editTitle : S.pron.addTitle}</div>
          <form className="card-b stack" style={{ gap: 12 }} onSubmit={onSubmit}>
            <div className="pron-form">
              <div className="field">
                <label htmlFor="pron-match">{S.pron.match}</label>
                <input
                  id="pron-match"
                  className="inp"
                  value={match}
                  placeholder={S.pron.matchPh}
                  maxLength={100}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setMatch(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="pron-say">{S.pron.say}</label>
                <input
                  id="pron-say"
                  className="inp"
                  value={say}
                  placeholder={S.pron.sayPh}
                  maxLength={200}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setSay(e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              {/* biome-ignore lint/a11y/noLabelWithoutControl: caption of the segmented control below */}
              <label>{S.pron.lang}</label>
              <Seg value={lang} options={LANGS} onChange={setLang} label={S.pron.lang} style={{ flexWrap: 'wrap' }} />
            </div>
            <div className="field">
              <label htmlFor="pron-note">{S.pron.note}</label>
              <input id="pron-note" className="inp" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <ListenButton
                playing={pv.isPlaying('form')}
                busy={pv.busy === 'form'}
                label={S.pron.listen}
                onClick={() => pv.preview('form', say, lang)}
              />
              <button type="submit" className="btn primary" disabled={submit.isPending || !match.trim() || !say.trim()}>
                {editing ? S.pron.save : S.pron.add}
              </button>
              {editing && (
                <button type="button" className="btn" onClick={reset}>
                  {S.pron.cancel}
                </button>
              )}
            </div>
          </form>
        </section>
      )}
      <input
        className="inp"
        type="search"
        aria-label={S.pron.search}
        placeholder={S.pron.search}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {scope === 'shared' && !isAdmin && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          {S.pron.sharedHint}
        </div>
      )}
      {error ? (
        <ErrorBox error={error} onRetry={refresh} />
      ) : loading ? (
        <Loading />
      ) : !shown.length ? (
        <div className="muted" style={{ padding: 16 }}>
          {items?.length ? S.pron.noMatches : S.pron.empty}
        </div>
      ) : (
        <div className="tbl">
          <div className="thead pron-row">
            <div>{S.pron.colMatch}</div>
            <div>{S.pron.colSay}</div>
            <div>{S.pron.colLang}</div>
            <div>{S.pron.colOwner}</div>
            <div />
          </div>
          {shown.map((e) => (
            <div className="trow pron-row" key={e.id}>
              <div className="pron-cell" data-label={S.pron.colMatch}>
                <span className="mono">{e.match}</span>
                {e.note && (
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {e.note}
                  </div>
                )}
              </div>
              <div className="pron-cell" data-label={S.pron.colSay}>
                <span className="mono">{e.replacement}</span>
              </div>
              <div className="pron-cell" data-label={S.pron.colLang}>
                {langLabel(e.lang)}
              </div>
              <div className="pron-cell" data-label={S.pron.colOwner}>
                {e.scope === 'user' ? S.pron.ownerMine : S.pron.ownerShared}
              </div>
              <div className="pron-actions">
                <ListenButton
                  playing={pv.isPlaying(e.id)}
                  busy={pv.busy === e.id}
                  onClick={() => pv.preview(e.id, e.replacement, e.lang)}
                />
                {editable && (
                  <>
                    <button type="button" className="btn icon ghost sm" aria-label={S.pron.edit} onClick={() => startEdit(e)}>
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="btn icon ghost sm"
                      aria-label={S.pron.remove}
                      onClick={() => window.confirm(S.pron.removeConfirm(e.match)) && remove.mutate(e)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  )
}
