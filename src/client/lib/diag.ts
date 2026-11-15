// Diagnostic event log of the player (what iOS Safari reports around dictation). Off unless localStorage `agent-radio.diag` is '1' or the
// page was opened with ?diag=1 (?diag=0 turns it off). Events are buffered and posted to /api/app/diag. No URLs are ever recorded.

export const DIAG_KEY = 'agent-radio.diag'
export const RESUME_ON_ACTIVE_KEY = 'agent-radio.resume-on-active'
export const FLUSH_MS = 5000
// the server takes 100 events / 8 KB per request
const MAX_BATCH_EVENTS = 100
const MAX_BATCH_BYTES = 7000
const MAX_BUFFER = 500

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface DiagEvent {
  t: number
  type: string
  data?: Record<string, unknown>
}

type Target = { addEventListener(type: string, listener: () => void): void }

export interface DiagEnv {
  search: string
  storage: StorageLike | null
  doc: (Target & { visibilityState?: string }) | null
  win: Target | null
  session: (Target & { type?: string; state?: string }) | null
  fetch: ((url: string, init: RequestInit) => Promise<unknown>) | null
  setInterval: (fn: () => void, ms: number) => unknown
  now: () => number
  perf: () => number
}

// a flag in the URL (?name=1 / ?name=0) wins and is remembered; otherwise the stored value decides
// TEMPORARY (iOS dictation investigation, 2026-11-15): both flags default to ON for everyone; ?name=0 opts out. Set back to false after.
export const FLAGS_DEFAULT_ON = true

export function readFlag(search: string, storage: StorageLike | null, param: string, key: string, defaultOn = FLAGS_DEFAULT_ON): boolean {
  const fromUrl = new URLSearchParams(search).get(param)
  try {
    if (fromUrl === '1') storage?.setItem(key, '1')
    else if (fromUrl === '0') storage?.setItem(key, '0')
  } catch {
    // storage blocked
  }
  if (fromUrl === '1') return true
  if (fromUrl === '0') return false
  try {
    const v = storage?.getItem(key)
    return v == null ? defaultOn : v === '1'
  } catch {
    return defaultOn
  }
}

export const diagEnabled = (search: string, storage: StorageLike | null) => readFlag(search, storage, 'diag', DIAG_KEY)
export const resumeOnActiveEnabled = (search: string, storage: StorageLike | null) =>
  readFlag(search, storage, 'resumeOnActive', RESUME_ON_ACTIVE_KEY)

const AUDIO_EVENTS = ['play', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'error']

export class Diag {
  private buf: DiagEvent[] = []
  private sending = false

  constructor(private env: DiagEnv) {}

  record = (type: string, data: Record<string, unknown> = {}) => {
    this.buf.push({ t: this.env.now(), type, data: { ...data, perf: Math.round(this.env.perf()) } })
    if (this.buf.length > MAX_BUFFER) this.buf.splice(0, this.buf.length - MAX_BUFFER)
  }

  // posts the buffer in batches that fit the server limits; a failed batch goes back to the buffer
  flush = async () => {
    const send = this.env.fetch
    if (!send || this.sending || this.buf.length === 0) return
    this.sending = true
    try {
      while (this.buf.length > 0) {
        const batch: DiagEvent[] = []
        let bytes = 40
        while (batch.length < MAX_BATCH_EVENTS && this.buf.length > 0) {
          const e = this.buf[0] as DiagEvent
          const size = JSON.stringify(e).length + 1
          if (size > MAX_BATCH_BYTES) {
            this.buf.shift()
            continue
          }
          if (bytes + size > MAX_BATCH_BYTES) break
          bytes += size
          batch.push(e)
          this.buf.shift()
        }
        if (batch.length === 0) break
        try {
          await send('/api/app/diag', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: batch }),
            credentials: 'same-origin',
            keepalive: true,
          })
        } catch {
          this.buf.unshift(...batch)
          break
        }
      }
    } finally {
      this.sending = false
    }
  }

  // hooks onto the audio element and the page; call once
  attach(audio: { paused: boolean; currentTime: number; addEventListener(type: string, listener: () => void): void }) {
    const { doc, win, session } = this.env
    this.record('start', { audioSession: !!session, sessionType: session?.type ?? null, sessionState: session?.state ?? null })
    for (const type of AUDIO_EVENTS) {
      audio.addEventListener(type, () =>
        this.record(`audio:${type}`, { paused: audio.paused, currentTime: Math.round(audio.currentTime * 100) / 100 }),
      )
    }
    session?.addEventListener('statechange', () =>
      this.record('audioSession:statechange', { state: session.state ?? null, type: session.type ?? null }),
    )
    doc?.addEventListener('visibilitychange', () => this.record('visibilitychange', { state: doc.visibilityState ?? null }))
    for (const type of ['focus', 'blur', 'pageshow', 'pagehide', 'online', 'offline']) {
      win?.addEventListener(type, () => {
        this.record(type)
        if (type === 'pagehide') void this.flush()
      })
    }
    this.env.setInterval(() => void this.flush(), FLUSH_MS)
  }
}

export function browserEnv(): DiagEnv {
  const nav = globalThis.navigator as (Navigator & { audioSession?: DiagEnv['session'] }) | undefined
  let storage: Storage | null = null
  try {
    storage = window.localStorage
  } catch {
    storage = null
  }
  return {
    search: window.location.search,
    storage,
    doc: document,
    win: window,
    session: nav?.audioSession ?? null,
    fetch: typeof fetch === 'function' ? (url, init) => fetch(url, init) : null,
    setInterval: (fn, ms) => setInterval(fn, ms),
    now: () => Date.now(),
    perf: () => performance.now(),
  }
}

let active: Diag | null = null

// null when the diagnostics are off
export function startDiag(audio: Parameters<Diag['attach']>[0], env: DiagEnv = browserEnv()): Diag | null {
  if (active) return active
  if (!diagEnabled(env.search, env.storage)) return null
  active = new Diag(env)
  active.attach(audio)
  return active
}

// for code that has no handle on the instance (Media Session handlers); a no-op while the diagnostics are off
export const diagRecord = (type: string, data?: Record<string, unknown>) => active?.record(type, data)
