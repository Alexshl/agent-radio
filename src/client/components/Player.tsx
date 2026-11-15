import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { S } from '../i18n'
import { PlayerController, type PlayerSource, type PlayerState } from '../lib/player-controller'
import { PlayerBar } from './PlayerBar'
import { useToast } from './Toast'

export interface PlayerApi extends PlayerState {
  // starts the source (the previous one stops); the same source again toggles
  toggle: (source: PlayerSource) => void
  start: (source: PlayerSource) => void
  pause: () => void
  resume: () => void
  stop: () => void
  seek: (seconds: number) => void
  // live stream: jump to the newest audio
  goLive: () => void
  setVolume: (v: number) => void
  setMuted: (m: boolean) => void
  isPlaying: (key: string) => boolean
  // the live station stream of the user is playing
  playing: boolean
}

const EMPTY: PlayerState = {
  current: null,
  playing: false,
  loading: false,
  position: 0,
  duration: 0,
  lag: 0,
  volume: 1,
  muted: false,
  reconnecting: false,
}
const noop = () => {}
const Ctx = createContext<PlayerApi>({
  ...EMPTY,
  toggle: noop,
  start: noop,
  pause: noop,
  resume: noop,
  stop: noop,
  seek: noop,
  goLive: noop,
  setVolume: noop,
  setMuted: noop,
  isPlaying: () => false,
})
export const usePlayer = () => useContext(Ctx)

// The key of the user's live stream
export const LIVE_KEY = 'live'

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName) || t.isContentEditable || ['tab', 'switch', 'button'].includes(t.role ?? ''))

// The only <audio> of the app, kept alive while the user moves between pages, and the bar that controls it.
export function PlayerProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLAudioElement>(null)
  const ctl = useRef<PlayerController | null>(null)
  const toast = useToast()

  // one controller for the lifetime of the page (the element exists after the first render)
  const getController = useCallback(() => {
    if (!ctl.current && ref.current) {
      let storage: Storage | null = null
      try {
        storage = window.localStorage
      } catch {
        storage = null
      }
      ctl.current = new PlayerController(ref.current, storage)
      ctl.current.onError = () => toast(S.player.error, 'danger')
    }
    return ctl.current
  }, [toast])
  const subscribe = useCallback((fn: () => void) => getController()?.subscribe(fn) ?? noop, [getController])
  const state = useSyncExternalStore(
    subscribe,
    () => ctl.current?.getState() ?? EMPTY,
    () => EMPTY,
  )

  const api = useMemo<PlayerApi>(() => {
    const c = () => ctl.current
    return {
      ...state,
      toggle: (s) => c()?.toggle(s),
      start: (s) => c()?.start(s),
      pause: () => c()?.pause(),
      resume: () => c()?.resume(),
      stop: () => c()?.stop(),
      seek: (t) => c()?.seek(t),
      goLive: () => c()?.goLive(),
      setVolume: (v) => c()?.setVolume(v),
      setMuted: (m) => c()?.setMuted(m),
      isPlaying: (key) => state.current?.key === key && state.playing,
    }
  }, [state])

  // room for the bar below the page content
  useEffect(() => {
    document.body.classList.toggle('has-player', !!state.current)
    return () => document.body.classList.remove('has-player')
  }, [state.current])

  // lock screen / media keys
  const cur = state.current
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    if (!cur) {
      ms.metadata = null
      ms.playbackState = 'none'
      return
    }
    ms.metadata = new MediaMetadata({ title: cur.title, artist: cur.subtitle ?? '', album: S.appName })
    const set = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, fn)
      } catch {
        // an action this browser does not know
      }
    }
    const c = () => ctl.current
    set('play', () => c()?.resume())
    set('pause', () => c()?.userPause())
    set('stop', () => c()?.stop())
    if (cur.kind === 'live') {
      set('seekto', null)
      set('seekbackward', null)
      set('seekforward', null)
    } else {
      set('seekto', (d) => d.seekTime != null && c()?.seek(d.seekTime))
      set('seekbackward', () => c()?.seek((c()?.getState().position ?? 0) - 10))
      set('seekforward', () => c()?.seek((c()?.getState().position ?? 0) + 10))
    }
  }, [cur])
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = !state.current ? 'none' : state.playing ? 'playing' : 'paused'
  }, [state.current, state.playing])
  const fileDuration = state.current?.kind === 'live' ? 0 : state.duration
  useEffect(() => {
    if (!('mediaSession' in navigator) || !fileDuration) return
    try {
      navigator.mediaSession.setPositionState({ duration: fileDuration, position: Math.min(state.position, fileDuration), playbackRate: 1 })
    } catch {
      // not supported
    }
  }, [fileDuration, state.position])

  // Space = play / pause (not while typing or on a focused control that uses Space itself)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const c = ctl.current
      if (e.code !== 'Space' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !c?.getState().current || typing(e.target))
        return
      e.preventDefault()
      const s = c.getState()
      if (s.playing || s.loading) s.current?.kind === 'live' ? c.stop() : c.pause()
      else c.resume()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* biome-ignore lint/a11y/useMediaCaption: radio and music, no captions */}
      <audio ref={ref} preload="none" />
      <PlayerBar />
    </Ctx.Provider>
  )
}
