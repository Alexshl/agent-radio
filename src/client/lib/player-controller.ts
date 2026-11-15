// The one audio controller of the app: a single audio element, one source at a time. Plain TypeScript (no React, no DOM types beyond the
// small AudioLike surface), so it is tested with a fake element; components read it through useSyncExternalStore (components/Player.tsx).

export type SourceKind = 'live' | 'track' | 'voice'

export interface PlayerSource {
  // identity: playing the same key again toggles instead of restarting
  key: string
  kind: SourceKind
  // same-origin URL of the stream / file
  src: string
  title: string
  subtitle?: string
  // the page the source belongs to (shown as the "перейти" link of the bar)
  href?: string
}

export interface PlayerState {
  current: PlayerSource | null
  playing: boolean
  // a source was chosen and has not started yet (or is buffering)
  loading: boolean
  position: number
  // 0 for a live stream
  duration: number
  volume: number
  muted: boolean
  // a live stream dropped and is being re-opened (the user's play intent is kept)
  reconnecting: boolean
  // live stream only: seconds the audio is behind the live edge (buffered end - current time); 0 when unknown
  lag: number
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(id: unknown): void
  now(): number
}

// pauses before the 1st, 2nd, 3rd reconnect attempt, then every 10 s; given up after 5 minutes
export const RECONNECT_DELAYS_MS = [1000, 2000, 5000]
export const RECONNECT_EVERY_MS = 10_000
export const RECONNECT_GIVE_UP_MS = 5 * 60_000
// an external pause of a live stream (a system interruption, e.g. iOS dictation or a call) is NOT resumed on a timer (that broke
// dictation); returning to the tab resumes it within INTERRUPT_GIVE_UP_MS. INTERRUPT_FIRST_MS / _EVERY_MS are kept for compatibility.
export const INTERRUPT_FIRST_MS = 1500
export const INTERRUPT_EVERY_MS = 3000
export const INTERRUPT_GIVE_UP_MS = 15 * 60_000
// a 'stalled' event only counts when the stream shows no progress for this long
export const STALL_GRACE_MS = 8000
// "stay at the live edge": every EDGE_CHECK_MS a live stream that is more than EDGE_MAX_LAG_S behind (a backlog kept by the browser or an
// edge proxy after a stall / background suspend) is moved to EDGE_TARGET_S before the end of the buffer, or re-opened when it cannot seek
export const EDGE_CHECK_MS = 2000
export const EDGE_MAX_LAG_S = 6
export const EDGE_TARGET_S = 1.5
// the bar shows the lag only above this
export const LAG_SHOW_S = 3

export interface RangesLike {
  readonly length: number
  end(index: number): number
}

export interface AudioLike {
  src: string
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  readonly paused: boolean
  readonly buffered?: RangesLike
  readonly seekable?: RangesLike
  play(): Promise<void>
  pause(): void
  load(): void
  removeAttribute(name: string): void
  addEventListener(type: string, listener: () => void): void
}

// the page events the controller listens to (document and window); injectable for tests
export interface PageEvents {
  doc: { visibilityState?: string; addEventListener(type: string, listener: () => void): void } | null
  win: { addEventListener(type: string, listener: () => void): void } | null
  // navigator.audioSession (Safari 16.4+): its 'statechange' to 'active' means the system gave the audio back
  session?: { state?: string; addEventListener(type: string, listener: () => void): void } | null
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const VOLUME_KEY = 'ar-player-volume'

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1)

function loadVolume(storage: StorageLike | null): { volume: number; muted: boolean } {
  try {
    const raw = storage?.getItem(VOLUME_KEY)
    if (raw) {
      const j = JSON.parse(raw) as { volume?: unknown; muted?: unknown }
      return { volume: typeof j.volume === 'number' ? clamp01(j.volume) : 1, muted: j.muted === true }
    }
  } catch {
    // unreadable storage: defaults
  }
  return { volume: 1, muted: false }
}

// a fresh URL on every reconnect: no browser or proxy cache can hand back the dead response
export function withCacheBust(src: string, n: number): string {
  return `${src}${src.includes('?') ? '&' : '?'}_r=${n}`
}

export class PlayerController {
  private state: PlayerState
  private listeners = new Set<() => void>()
  // bumped on every start / stop: a late answer of an older play() is ignored
  private token = 0
  private retryTimer: unknown = null
  private stallTimer: unknown = null
  private edgeTimer: unknown = null
  // a playing live stream was paused from outside (OS media keys, headset, browser): the buffered backlog is stale, play must re-open it
  private needFresh = false
  private attempts = 0
  private droppedAt = 0
  // a live stream was paused by the system (not by the user): we keep trying to resume it at the live edge
  private interrupted = false
  private interruptedAt = 0
  private resumeTimer: unknown = null
  // the token of the reopen started by the resume loop (it is in flight while it equals `token`)
  private attemptToken = -1
  private audioSessionSet = false
  onError: ((source: PlayerSource) => void) | null = null
  // diagnostics hook (lib/diag.ts): interrupt() / resumeNow() report here
  onTrace: ((type: string, data?: Record<string, unknown>) => void) | null = null
  // experimental: an audioSession change to 'active' while interrupted resumes the stream at once (off by default)
  resumeOnActive = false

  constructor(
    private audio: AudioLike,
    private storage: StorageLike | null = null,
    private timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as never), now: () => Date.now() },
    events: PageEvents = {
      doc: typeof document === 'undefined' ? null : document,
      win: typeof window === 'undefined' ? null : window,
      session: (globalThis.navigator as { audioSession?: PageEvents['session'] } | undefined)?.audioSession ?? null,
    },
  ) {
    const v = loadVolume(storage)
    this.state = {
      current: null,
      playing: false,
      loading: false,
      position: 0,
      duration: 0,
      volume: v.volume,
      muted: v.muted,
      reconnecting: false,
      lag: 0,
    }
    audio.volume = v.volume
    audio.muted = v.muted
    const on = (type: string, fn: () => void) => audio.addEventListener(type, fn)
    on('timeupdate', () => this.state.current && this.set({ position: this.audio.currentTime || 0 }))
    const duration = () => {
      const d = this.audio.duration
      if (this.state.current && Number.isFinite(d) && d > 0) this.set({ duration: d })
    }
    on('durationchange', duration)
    on('loadedmetadata', duration)
    on('playing', () => {
      if (!this.state.current) return
      this.clearRetry()
      this.attempts = 0
      this.set({ playing: true, loading: false, reconnecting: false })
      this.watchEdge()
    })
    on('play', () => {
      if (!this.state.current) return
      if (this.needFresh && this.state.current.kind === 'live') return this.reopen()
      if (this.state.reconnecting) return
      this.set({ playing: true })
    })
    on('pause', () => {
      if (!this.state.current) return
      // our own pause()/stop()/start() already cleared `playing`: only a pause from outside finds a playing live stream
      if (this.state.playing && this.state.current.kind === 'live') {
        this.needFresh = true
        return this.interrupt()
      }
      this.set({ playing: false })
    })
    on('waiting', () => this.state.current && this.set({ loading: true }))
    on('ended', () => {
      const cur = this.state.current
      if (!cur) return
      // a file stays loaded at its end (can be replayed); a stream that ended was cut by the server: reconnect
      if (cur.kind === 'live') this.dropped()
      else this.set({ playing: false, position: this.state.duration })
    })
    on('error', () => {
      const cur = this.state.current
      if (!cur) return
      if (cur.kind === 'live') return this.dropped()
      this.stop()
      this.onError?.(cur)
    })
    // a stream that stalls and does not recover by itself
    on('stalled', () => {
      if (this.state.current?.kind !== 'live' || this.stallTimer || this.state.reconnecting) return
      this.stallTimer = this.timers.set(() => {
        this.stallTimer = null
        if (this.state.current?.kind === 'live' && !this.state.playing) this.dropped()
      }, STALL_GRACE_MS)
    })
    on('timeupdate', () => {
      if (this.stallTimer) {
        this.timers.clear(this.stallTimer)
        this.stallTimer = null
      }
    })
    // back on screen / focus / network / bfcache restore: an interrupted stream is resumed at once (the system gave the audio back)
    const visible = () => events.doc?.visibilityState !== 'hidden'
    events.doc?.addEventListener('visibilitychange', () => visible() && this.recover())
    events.win?.addEventListener('online', () => this.recover())
    events.win?.addEventListener('focus', () => this.resumeNow())
    events.win?.addEventListener('pageshow', () => this.resumeNow())
    const session = events.session
    session?.addEventListener('statechange', () => {
      // iOS Safari fires statechange at the start and at the end of an interruption; `state` may be missing (seen: null) — only
      // 'interrupted' / 'inactive' mean the audio is still taken
      const st = session.state
      if (this.resumeOnActive && this.interrupted && st !== 'interrupted' && st !== 'inactive') this.resumeNow()
    })
  }

  // The pause button of the lock screen / Control Center / headset (Media Session pause and stop actions): always the user's intent,
  // never auto-resumed. A live stream is closed, a file is paused.
  userPause() {
    if (this.state.current?.kind === 'live') this.stop()
    else this.pause()
  }

  // A live stream was paused by the system: keep the source wanted ("reconnecting") and try to resume it.
  private interrupt() {
    if (this.edgeTimer) this.timers.clear(this.edgeTimer)
    this.edgeTimer = null
    this.interrupted = true
    this.onTrace?.('interrupt')
    this.interruptedAt = this.timers.now()
    // shown as paused: nothing resumes by itself while the system holds the audio (iOS dictation breaks if the radio comes back
    // mid-sentence). Play (page, lock screen, headset) or coming back to the tab re-opens it at the live edge.
    this.set({ playing: false, loading: false, reconnecting: false })
  }

  // a resume attempt was refused (the system still holds the audio): stay paused, the next user signal tries again
  private scheduleResume() {
    if (!this.interrupted) return
    this.set({ playing: false, loading: false, reconnecting: false })
  }

  // one resume attempt of the interruption loop (not while the previous one is still pending)
  private resumeNow() {
    if (!this.interrupted || this.state.current?.kind !== 'live') return
    this.onTrace?.('resumeNow')
    if (this.timers.now() - this.interruptedAt > INTERRUPT_GIVE_UP_MS) {
      // long ago: coming back to the tab does not start the radio by itself any more (play re-opens it fresh)
      this.interrupted = false
      return
    }
    if (this.attemptToken === this.token) return
    if (this.resumeTimer) this.timers.clear(this.resumeTimer)
    this.resumeTimer = null
    this.reopen()
    this.attemptToken = this.token
  }

  private endInterruption() {
    this.interrupted = false
    if (this.resumeTimer) this.timers.clear(this.resumeTimer)
    this.resumeTimer = null
  }

  // Jumps a live stream to its newest audio: the stream is simply opened again (a live mp3 has nothing to seek in).
  goLive() {
    if (this.state.current?.kind !== 'live') return
    this.clearRetry()
    this.reopen()
  }

  private clearRetry() {
    if (this.retryTimer) this.timers.clear(this.retryTimer)
    this.retryTimer = null
    if (this.stallTimer) this.timers.clear(this.stallTimer)
    this.stallTimer = null
    if (this.edgeTimer) this.timers.clear(this.edgeTimer)
    this.edgeTimer = null
    this.endInterruption()
  }

  // seconds the live audio is behind the end of what the browser has downloaded
  private measureLag(): number {
    const b = this.audio.buffered
    if (!b || b.length === 0) return 0
    return Math.max(0, b.end(b.length - 1) - (this.audio.currentTime || 0))
  }

  // the live-edge watcher: runs every EDGE_CHECK_MS while a live stream plays
  private watchEdge() {
    if (this.edgeTimer || this.state.current?.kind !== 'live') return
    const check = () => {
      this.edgeTimer = null
      const cur = this.state.current
      if (cur?.kind !== 'live' || !this.state.playing) return
      const lag = this.measureLag()
      if (Math.abs(lag - this.state.lag) >= 0.5) this.set({ lag })
      if (lag > EDGE_MAX_LAG_S) this.catchUp()
      this.edgeTimer = this.timers.set(check, EDGE_CHECK_MS)
    }
    this.edgeTimer = this.timers.set(check, EDGE_CHECK_MS)
  }

  private catchUp() {
    const b = this.audio.buffered
    const sk = this.audio.seekable
    const target = b && b.length > 0 ? b.end(b.length - 1) - EDGE_TARGET_S : 0
    if (sk && sk.length > 0 && target > 0 && sk.end(sk.length - 1) >= target) {
      this.audio.currentTime = target
      this.set({ lag: EDGE_TARGET_S })
      return
    }
    // cannot seek on this stream: a fresh connection starts at the live edge
    this.clearRetry()
    this.reopen()
  }

  // The live stream broke (server restart, network): keep the source, show "reconnecting" and try again with a growing pause.
  private dropped() {
    const cur = this.state.current
    if (cur?.kind !== 'live' || this.retryTimer || this.interrupted) return
    if (!this.state.reconnecting) {
      this.droppedAt = this.timers.now()
      this.attempts = 0
    }
    if (this.timers.now() - this.droppedAt > RECONNECT_GIVE_UP_MS) {
      this.stop()
      this.onError?.(cur)
      return
    }
    const delay = RECONNECT_DELAYS_MS[this.attempts] ?? RECONNECT_EVERY_MS
    this.attempts++
    if (this.edgeTimer) this.timers.clear(this.edgeTimer)
    this.edgeTimer = null
    this.set({ playing: false, loading: true, reconnecting: true })
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = null
      this.reopen()
    }, delay)
  }

  private reopen() {
    const cur = this.state.current
    if (cur?.kind !== 'live') return
    const token = ++this.token
    this.needFresh = false
    this.set({ lag: 0 })
    this.audio.src = withCacheBust(cur.src, this.timers.now())
    this.audio.load()
    this.audio.play().then(
      () => {
        if (token !== this.token) return
        this.attemptToken = -1
        this.endInterruption()
        this.set({ playing: true, loading: false, reconnecting: false })
      },
      () => {
        if (token !== this.token) return
        this.attemptToken = -1
        // the system may still hold the audio (NotAllowedError / AbortError): an interruption keeps trying
        if (this.interrupted) this.scheduleResume()
        else this.dropped()
      },
    )
  }

  // The tab came back to the foreground (or the network is back): a live stream is ALWAYS re-opened, never resumed from the old buffer
  // (after a background suspend the browser and the edge proxies hold minutes of stale audio).
  recover() {
    const cur = this.state.current
    if (cur?.kind !== 'live') return
    if (this.interrupted) return this.resumeNow()
    if (this.state.playing || this.state.loading || this.state.reconnecting || !this.audio.paused) {
      this.clearRetry()
      this.reopen()
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getState = () => this.state

  private set(p: Partial<PlayerState>) {
    this.state = { ...this.state, ...p }
    for (const fn of this.listeners) fn()
  }

  isPlaying(key: string): boolean {
    return this.state.current?.key === key && this.state.playing
  }

  // Starts `source`; whatever played before stops. The same source again: resume when paused, pause (a stream: stop) when playing.
  toggle(source: PlayerSource) {
    const cur = this.state.current
    if (cur?.key === source.key) {
      if (this.state.playing || this.state.loading) return cur.kind === 'live' ? this.stop() : this.pause()
      return this.resume()
    }
    this.start(source)
  }

  // Always (re)starts from the beginning.
  start(source: PlayerSource) {
    const token = ++this.token
    this.clearRetry()
    this.audio.pause()
    this.audio.src = source.src
    this.needFresh = false
    if (source.kind === 'live') this.openPlaybackSession()
    this.set({ current: source, playing: false, loading: true, position: 0, duration: 0, reconnecting: false, lag: 0 })
    this.audio.play().then(
      () => {
        if (token === this.token) this.set({ playing: true, loading: false })
      },
      () => {
        if (token !== this.token) return
        this.stop()
        this.onError?.(source)
      },
    )
  }

  // iOS Safari 16.4+: a 'playback' session is not muted by the silent switch and is the one that resumes after an interruption
  private openPlaybackSession() {
    if (this.audioSessionSet) return
    this.audioSessionSet = true
    try {
      const session = (globalThis.navigator as { audioSession?: { type: string } } | undefined)?.audioSession
      if (session) session.type = 'playback'
    } catch {
      // not supported
    }
  }

  pause() {
    if (!this.state.current) return
    this.clearRetry()
    this.audio.pause()
    this.set({ playing: false, loading: false, reconnecting: false })
  }

  resume() {
    const cur = this.state.current
    if (!cur) return
    // a paused live stream resumes at the live edge, not from the old buffer
    if (cur.kind === 'live') {
      this.clearRetry()
      this.set({ loading: true })
      return this.reopen()
    }
    const token = ++this.token
    this.set({ loading: true })
    this.audio.play().then(
      () => {
        if (token === this.token) this.set({ playing: true, loading: false })
      },
      () => {
        if (token !== this.token) return
        this.stop()
        this.onError?.(cur)
      },
    )
  }

  // Stops and closes: nothing is loaded afterwards.
  stop() {
    this.clearRetry()
    this.token++
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
    this.needFresh = false
    this.set({ current: null, playing: false, loading: false, position: 0, duration: 0, reconnecting: false, lag: 0 })
  }

  seek(seconds: number) {
    const cur = this.state.current
    if (!cur || cur.kind === 'live') return
    const max = this.state.duration || Number.POSITIVE_INFINITY
    const t = Math.min(Math.max(0, seconds), max)
    this.audio.currentTime = t
    this.set({ position: t })
  }

  setVolume(v: number) {
    const volume = clamp01(v)
    this.audio.volume = volume
    // dragging the slider up from zero un-mutes
    const muted = volume === 0 ? this.state.muted : false
    this.audio.muted = muted
    this.set({ volume, muted })
    this.persist()
  }

  setMuted(muted: boolean) {
    this.audio.muted = muted
    this.set({ muted })
    this.persist()
  }

  private persist() {
    try {
      this.storage?.setItem(VOLUME_KEY, JSON.stringify({ volume: this.state.volume, muted: this.state.muted }))
    } catch {
      // storage full or blocked: the volume just is not remembered
    }
  }
}
