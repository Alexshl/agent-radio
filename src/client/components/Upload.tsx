import { useQueryClient } from '@tanstack/react-query'
import { Check, UploadCloud, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText, S } from '../i18n'
import { fmtBytes } from '../lib/format'

const EXTENSIONS = ['mp3', 'flac', 'ogg', 'opus', 'm4a', 'wav']
export const UPLOAD_ACCEPT = EXTENSIONS.map((e) => `.${e}`).join(',')

export interface UploadItem {
  id: number
  name: string
  size: number
  status: 'queued' | 'uploading' | 'processing' | 'done' | 'error'
  pct: number
  error?: string
}

function sendFile(file: File, onProgress: (pct: number, sent: boolean) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/app/library/upload')
    xhr.withCredentials = true
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100), e.loaded >= e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve()
      let code: string | undefined
      let message: string | undefined
      try {
        const j = JSON.parse(xhr.responseText) as { error?: string; message?: string }
        code = j.error
        message = j.message
      } catch {
        // not JSON (a proxy error page)
      }
      reject(new Error(xhr.status === 413 && !code ? errorText('too_large') : errorText(code, message)))
    }
    xhr.onerror = () => reject(new Error(S.common.error))
    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}

// A queue of files uploaded one after another; every item has its own progress.
export function useUploader(maxMb: number) {
  const qc = useQueryClient()
  const [items, setItems] = useState<UploadItem[]>([])
  const queue = useRef<{ id: number; file: File }[]>([])
  const running = useRef(false)
  const nextId = useRef(1)
  const patch = useCallback((id: number, p: Partial<UploadItem>) => setItems((l) => l.map((i) => (i.id === id ? { ...i, ...p } : i))), [])

  const pump = useCallback(async () => {
    if (running.current) return
    running.current = true
    for (let job = queue.current.shift(); job; job = queue.current.shift()) {
      patch(job.id, { status: 'uploading', pct: 0 })
      try {
        await sendFile(job.file, (pct, sent) => patch(job.id, { pct, status: sent ? 'processing' : 'uploading' }))
        patch(job.id, { status: 'done', pct: 100 })
      } catch (e) {
        patch(job.id, { status: 'error', error: e instanceof Error ? e.message : S.common.error })
      }
      for (const key of ['library-status', 'library-folders', 'library-tracks', 'admin-lib']) qc.invalidateQueries({ queryKey: [key] })
    }
    running.current = false
  }, [patch, qc])

  const add = useCallback(
    (files: File[]) => {
      const fresh: UploadItem[] = []
      for (const file of files) {
        const id = nextId.current++
        const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
        const base = { id, name: file.name, size: file.size, pct: 0 }
        if (!EXTENSIONS.includes(ext)) fresh.push({ ...base, status: 'error', error: S.library.notAudio })
        else if (file.size > maxMb * 1024 * 1024) fresh.push({ ...base, status: 'error', error: errorText('too_large') })
        else {
          fresh.push({ ...base, status: 'queued' })
          queue.current.push({ id, file })
        }
      }
      setItems((l) => [...l, ...fresh])
      void pump()
    },
    [maxMb, pump],
  )
  const clearDone = useCallback(() => setItems((l) => l.filter((i) => i.status !== 'done' && i.status !== 'error')), [])
  return { items, add, clearDone }
}

// True while files are dragged over the window (to show the drop zone).
export function useFileDrag(onFiles: (files: File[]) => void, enabled: boolean) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  useEffect(() => {
    if (!enabled) return
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current++
      setOver(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    }
    const dragover = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      onFiles([...(e.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', dragover)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', dragover)
      window.removeEventListener('drop', drop)
    }
  }, [enabled, onFiles])
  return over
}

export function DropZone({ over, maxMb, onPick, compact }: { over: boolean; maxMb: number; onPick: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      className="ar-drop"
      data-over={over ? 'true' : undefined}
      data-compact={compact ? 'true' : undefined}
      onClick={onPick}
    >
      <UploadCloud size={compact ? 18 : 26} aria-hidden="true" />
      <span style={{ fontWeight: 600 }}>{over ? S.library.dropActive : S.library.dropHere}</span>
      <span className="muted" style={{ fontSize: 12 }}>
        {S.library.dropHint(maxMb)}
      </span>
    </button>
  )
}

export function UploadList({ items, onClear }: { items: UploadItem[]; onClear: () => void }) {
  if (items.length === 0) return null
  const finished = items.some((i) => i.status === 'done' || i.status === 'error')
  return (
    <section className="card">
      <div className="card-h" style={{ justifyContent: 'space-between' }}>
        {S.library.uploadTitle}
        {finished && (
          <button type="button" className="btn sm ghost" onClick={onClear}>
            {S.library.clearDone}
          </button>
        )}
      </div>
      <div>
        {items.map((i) => (
          <div key={i.id} className="ar-up">
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ell" style={{ fontWeight: 550 }} title={i.name}>
                {i.name}
              </div>
              {i.status === 'error' ? (
                <div className="ar-err">{i.error}</div>
              ) : (
                <div className="prog" role="progressbar" aria-valuenow={i.pct} aria-valuemin={0} aria-valuemax={100} aria-label={i.name}>
                  <span style={{ width: `${i.pct}%` }} />
                </div>
              )}
            </div>
            <span className="muted mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {fmtBytes(i.size)}
            </span>
            <span style={{ fontSize: 12, minWidth: 92, textAlign: 'right', whiteSpace: 'nowrap' }}>
              {i.status === 'done' && (
                <span className="row" style={{ gap: 4, justifyContent: 'flex-end', color: 'var(--success)' }}>
                  <Check size={14} aria-hidden="true" />
                  {S.library.done}
                </span>
              )}
              {i.status === 'error' && (
                <span className="row" style={{ gap: 4, justifyContent: 'flex-end', color: 'var(--danger)' }}>
                  <X size={14} aria-hidden="true" />
                  {S.library.failed}
                </span>
              )}
              {(i.status === 'uploading' || i.status === 'queued') && (
                <span className="muted">{i.status === 'queued' ? '' : `${i.pct}%`}</span>
              )}
              {i.status === 'processing' && <span className="muted">{S.library.processing}</span>}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
