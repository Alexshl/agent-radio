import { describe, expect, it, vi } from 'vitest'
import { type AudioLike, EDGE_CHECK_MS, LAG_SHOW_S, PlayerController, type PlayerSource, VOLUME_KEY } from './player-controller'

class FakeAudio implements AudioLike {
  src = ''
  currentTime = 0
  duration = Number.NaN
  volume = 1
  muted = false
  paused = true
  // end of the downloaded data / of the seekable range, in seconds (null = no range)
  bufferedEnd: number | null = null
  seekableEnd: number | null = null
  get buffered() {
    return { length: this.bufferedEnd === null ? 0 : 1, end: () => this.bufferedEnd ?? 0 }
  }
  get seekable() {
    return { length: this.seekableEnd === null ? 0 : 1, end: () => this.seekableEnd ?? 0 }
  }
  playCalls = 0
  fail = false
  private handlers = new Map<string, (() => void)[]>()
  play() {
    this.playCalls++
    if (this.fail) return Promise.reject(new Error('NotSupportedError'))
    this.paused = false
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
  load() {}
  removeAttribute(name: string) {
    if (name === 'src') this.src = ''
  }
  addEventListener(type: string, fn: () => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn])
  }
  emit(type: string) {
    for (const fn of this.handlers.get(type) ?? []) fn()
  }
}

const track = (id: string): PlayerSource => ({
  key: `track:${id}`,
  kind: 'track',
  src: `/t/${id}`,
  title: `Track ${id}`,
  subtitle: 'Artist',
})
const live: PlayerSource = { key: 'live', kind: 'live', src: '/stream/x.mp3', title: 'Live' }
const tick = () => new Promise((r) => setTimeout(r, 0))

function make(stored?: string) {
  const audio = new FakeAudio()
  const store = new Map<string, string>(stored ? [[VOLUME_KEY, stored]] : [])
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  return { audio, store, ctl: new PlayerController(audio, storage) }
}

describe('PlayerController', () => {
  it('starts a source and reports it as playing', async () => {
    const { ctl, audio } = make()
    ctl.toggle(track('1'))
    expect(ctl.getState()).toMatchObject({ current: { key: 'track:1' }, loading: true })
    await tick()
    expect(audio.src).toBe('/t/1')
    expect(ctl.getState()).toMatchObject({ playing: true, loading: false })
    expect(ctl.isPlaying('track:1')).toBe(true)
    expect(ctl.isPlaying('track:2')).toBe(false)
  })

  it('starting another source stops the previous one (one source at a time)', async () => {
    const { ctl, audio } = make()
    ctl.toggle(track('1'))
    await tick()
    ctl.toggle(live)
    await tick()
    expect(audio.src).toBe('/stream/x.mp3')
    expect(ctl.getState().current?.key).toBe('live')
    expect(ctl.isPlaying('track:1')).toBe(false)
    ctl.toggle(track('2'))
    await tick()
    expect(audio.src).toBe('/t/2')
    expect(ctl.isPlaying('live')).toBe(false)
    expect(ctl.isPlaying('track:2')).toBe(true)
  })

  it('the same file again pauses, then resumes; a live stream is stopped instead', async () => {
    const { ctl, audio } = make()
    ctl.toggle(track('1'))
    await tick()
    ctl.toggle(track('1'))
    expect(audio.paused).toBe(true)
    expect(ctl.getState()).toMatchObject({ playing: false, current: { key: 'track:1' } })
    ctl.toggle(track('1'))
    await tick()
    expect(ctl.getState().playing).toBe(true)
    expect(audio.src).toBe('/t/1')

    ctl.toggle(live)
    await tick()
    ctl.toggle(live)
    expect(ctl.getState().current).toBeNull()
  })

  it('stop clears the state and the source', async () => {
    const { ctl, audio } = make()
    ctl.toggle(track('1'))
    await tick()
    audio.currentTime = 12
    audio.duration = 200
    audio.emit('durationchange')
    audio.emit('timeupdate')
    expect(ctl.getState()).toMatchObject({ position: 12, duration: 200 })
    ctl.stop()
    expect(ctl.getState()).toMatchObject({ current: null, playing: false, loading: false, position: 0, duration: 0 })
    expect(audio.src).toBe('')
    expect(audio.paused).toBe(true)
  })

  it('a late answer of a replaced play() does not revive the old source', async () => {
    const { ctl } = make()
    ctl.toggle(track('1'))
    ctl.stop()
    await tick()
    expect(ctl.getState()).toMatchObject({ current: null, playing: false })
  })

  it('a refused play() (autoplay, bad file) closes the bar and reports the error', async () => {
    const { ctl, audio } = make()
    const onError = vi.fn()
    ctl.onError = onError
    audio.fail = true
    ctl.toggle(track('1'))
    await tick()
    expect(ctl.getState().current).toBeNull()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ key: 'track:1' }))
    audio.fail = false
    audio.emit('error')
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('a media error while playing stops it', async () => {
    const { ctl, audio } = make()
    const onError = vi.fn()
    ctl.onError = onError
    ctl.toggle(track('1'))
    await tick()
    audio.emit('error')
    expect(ctl.getState().current).toBeNull()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('a finished file stays loaded (replayable)', async () => {
    const { ctl, audio } = make()
    ctl.toggle(track('1'))
    await tick()
    audio.duration = 90
    audio.emit('durationchange')
    audio.emit('ended')
    expect(ctl.getState()).toMatchObject({ playing: false, position: 90, current: { key: 'track:1' } })
  })

  describe('live stream reconnect', () => {
    function makeTimed() {
      const audio = new FakeAudio()
      let now = 0
      const queue: { at: number; fn: () => void; id: number }[] = []
      let seq = 0
      const timers = {
        set: (fn: () => void, ms: number) => {
          queue.push({ at: now + ms, fn, id: ++seq })
          return seq
        },
        clear: (id: unknown) => {
          const i = queue.findIndex((q) => q.id === id)
          if (i >= 0) queue.splice(i, 1)
        },
        now: () => now,
      }
      // runs the next timer, returns the wait before it
      const next = () => {
        queue.sort((a, b) => a.at - b.at)
        const q = queue.shift()
        if (!q) return null
        const waited = q.at - now
        now = q.at
        q.fn()
        return waited
      }
      return {
        audio,
        ctl: new PlayerController(audio, null, timers),
        next,
        pending: () => queue.length,
      }
    }

    it('keeps the stream, shows "reconnecting" and retries after 1 s, 2 s, 5 s, then every 10 s', async () => {
      const { ctl, audio, next } = makeTimed()
      ctl.toggle(live)
      await tick()
      audio.emit('playing')
      audio.fail = true
      audio.emit('error')
      expect(ctl.getState()).toMatchObject({ current: { key: 'live' }, reconnecting: true, loading: true, playing: false })
      const waits: (number | null)[] = []
      for (let i = 0; i < 5; i++) {
        waits.push(next())
        await tick()
      }
      expect(waits).toEqual([1000, 2000, 5000, 10_000, 10_000])
      expect(ctl.getState().reconnecting).toBe(true)
      // the server is back
      audio.fail = false
      next()
      await tick()
      expect(ctl.getState()).toMatchObject({ playing: true, reconnecting: false, loading: false })
      expect(audio.src).toMatch(/^\/stream\/x\.mp3\?_r=\d+$/)
    })

    it('every reconnect uses a fresh URL and keeps an existing query', async () => {
      const { ctl, audio, next } = makeTimed()
      ctl.toggle({ ...live, src: '/stream/x.mp3?k=tok' })
      await tick()
      audio.fail = true
      audio.emit('error')
      next()
      await tick()
      const a = audio.src
      next()
      await tick()
      expect(a).toMatch(/^\/stream\/x\.mp3\?k=tok&_r=\d+$/)
      expect(audio.src).not.toBe(a)
    })

    it('a stream cut by the server (ended) reconnects too', async () => {
      const { ctl, audio, next } = makeTimed()
      ctl.toggle(live)
      await tick()
      audio.emit('ended')
      expect(ctl.getState().reconnecting).toBe(true)
      const calls = audio.playCalls
      next()
      await tick()
      expect(audio.playCalls).toBe(calls + 1)
      expect(ctl.getState()).toMatchObject({ playing: true, reconnecting: false })
    })

    it('gives up after about 5 minutes and reports the error', async () => {
      const { ctl, audio, next } = makeTimed()
      const onError = vi.fn()
      ctl.onError = onError
      ctl.toggle(live)
      await tick()
      audio.fail = true
      audio.emit('error')
      for (let i = 0; i < 40 && ctl.getState().current; i++) {
        next()
        await tick()
      }
      expect(ctl.getState().current).toBeNull()
      expect(onError).toHaveBeenCalledTimes(1)
    })

    it('stop and pause cancel the retries (the user intent wins)', async () => {
      const { ctl, audio, next, pending } = makeTimed()
      ctl.toggle(live)
      await tick()
      audio.emit('error')
      expect(pending()).toBe(1)
      ctl.stop()
      expect(pending()).toBe(0)
      expect(next()).toBeNull()
      expect(ctl.getState()).toMatchObject({ current: null, reconnecting: false })
    })

    it('recover() (tab back in the foreground) re-opens at once instead of waiting', async () => {
      const { ctl, audio, pending } = makeTimed()
      ctl.toggle(live)
      await tick()
      audio.emit('error')
      const calls = audio.playCalls
      ctl.recover()
      await tick()
      expect(audio.playCalls).toBe(calls + 1)
      expect(pending()).toBe(0)
      expect(ctl.getState()).toMatchObject({ playing: true, reconnecting: false })
    })

    it('a stall only counts when it lasts; a file error still stops', async () => {
      const { ctl, audio, next } = makeTimed()
      ctl.toggle(live)
      await tick()
      audio.emit('stalled')
      audio.emit('timeupdate')
      expect(next()).toBeNull()
      expect(ctl.getState().reconnecting).toBe(false)
      audio.emit('stalled')
      audio.paused = false
      ctl.getState().playing && audio.emit('pause')
      expect(next()).toBe(8000)
      expect(ctl.getState().reconnecting).toBe(true)
    })
  })

  it('seeks files only, within the duration', async () => {
    const { ctl, audio } = make()
    ctl.toggle(track('1'))
    await tick()
    audio.duration = 100
    audio.emit('durationchange')
    ctl.seek(40)
    expect(audio.currentTime).toBe(40)
    ctl.seek(500)
    expect(audio.currentTime).toBe(100)
    ctl.seek(-5)
    expect(audio.currentTime).toBe(0)
    ctl.toggle(live)
    await tick()
    audio.currentTime = 3
    ctl.seek(50)
    expect(audio.currentTime).toBe(3)
  })

  it('keeps the volume in storage and restores it, but never resumes by itself', async () => {
    const { ctl, audio, store } = make()
    ctl.setVolume(0.4)
    ctl.setMuted(true)
    expect(JSON.parse(store.get(VOLUME_KEY) ?? '{}')).toEqual({ volume: 0.4, muted: true })
    const again = make(store.get(VOLUME_KEY))
    expect(again.audio.volume).toBe(0.4)
    expect(again.audio.muted).toBe(true)
    expect(again.ctl.getState()).toMatchObject({ current: null, playing: false, volume: 0.4, muted: true })
    expect(again.audio.playCalls).toBe(0)
    // moving the slider un-mutes
    again.ctl.setVolume(0.7)
    expect(again.ctl.getState().muted).toBe(false)
    expect(audio.volume).toBe(0.4)
  })

  it('survives broken storage', () => {
    const audio = new FakeAudio()
    const ctl = new PlayerController(audio, {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    ctl.setVolume(0.2)
    expect(ctl.getState().volume).toBe(0.2)
  })

  it('notifies subscribers of changes', async () => {
    const { ctl } = make()
    const fn = vi.fn()
    const off = ctl.subscribe(fn)
    ctl.toggle(track('1'))
    await tick()
    expect(fn).toHaveBeenCalled()
    off()
    fn.mockClear()
    ctl.stop()
    expect(fn).not.toHaveBeenCalled()
  })

  it('goLive re-opens a live stream on a fresh connection and clears the lag', async () => {
    const { ctl, audio } = make()
    ctl.start(live)
    await tick()
    audio.bufferedEnd = 22.4
    ctl.goLive()
    await tick()
    expect(ctl.getState().lag).toBe(0)
    expect(audio.src).toMatch(/^\/stream\/x\.mp3\?_r=/)
    expect(ctl.getState()).toMatchObject({ current: { key: 'live' }, playing: true })
  })

  it('goLive does nothing for a file', async () => {
    const { ctl, audio } = make()
    ctl.start(track('1'))
    await tick()
    ctl.goLive()
    expect(audio.src).toBe('/t/1')
  })
})

describe('PlayerController live edge', () => {
  function makeEdge() {
    const audio = new FakeAudio()
    let now = 1000
    const queue: { at: number; fn: () => void; id: number }[] = []
    let n = 0
    const timers = {
      set: (fn: () => void, ms: number) => {
        const id = ++n
        queue.push({ at: now + ms, fn, id })
        return id
      },
      clear: (id: unknown) => {
        const i = queue.findIndex((q) => q.id === id)
        if (i >= 0) queue.splice(i, 1)
      },
      now: () => now,
    }
    // advances the clock and runs what is due
    const advance = (ms: number) => {
      const end = now + ms
      for (;;) {
        queue.sort((a, b) => a.at - b.at)
        const q = queue[0]
        if (!q || q.at > end) break
        queue.shift()
        now = q.at
        q.fn()
      }
      now = end
    }
    return { audio, ctl: new PlayerController(audio, null, timers), advance, pending: () => queue.length }
  }

  async function playing() {
    const t = makeEdge()
    t.ctl.toggle(live)
    await tick()
    t.audio.emit('playing')
    return t
  }

  it('does nothing while the lag is small, and shows it only above the threshold', async () => {
    const { ctl, audio, advance } = await playing()
    audio.currentTime = 10
    audio.bufferedEnd = 12
    advance(EDGE_CHECK_MS)
    expect(ctl.getState().lag).toBeCloseTo(2)
    expect(audio.src).toBe('/stream/x.mp3')
    audio.bufferedEnd = 14
    advance(EDGE_CHECK_MS)
    expect(ctl.getState().lag).toBeCloseTo(4)
    expect(ctl.getState().lag).toBeGreaterThan(LAG_SHOW_S)
    expect(audio.currentTime).toBe(10) // 4 s is below the 6 s limit: no jump
  })

  it('jumps to 1.5 s before the end of the buffer when more than 6 s behind (seekable stream)', async () => {
    const { ctl, audio, advance } = await playing()
    audio.currentTime = 10
    audio.bufferedEnd = 40
    audio.seekableEnd = 40
    advance(EDGE_CHECK_MS)
    expect(audio.currentTime).toBeCloseTo(38.5)
    expect(ctl.getState().lag).toBeCloseTo(1.5)
    expect(audio.src).toBe('/stream/x.mp3')
  })

  it('re-opens with a fresh URL when it cannot seek', async () => {
    const { ctl, audio, advance } = await playing()
    audio.currentTime = 10
    audio.bufferedEnd = 40
    audio.seekableEnd = null
    const calls = audio.playCalls
    advance(EDGE_CHECK_MS)
    await tick()
    expect(audio.src).toMatch(/^\/stream\/x\.mp3\?_r=\d+$/)
    expect(audio.playCalls).toBe(calls + 1)
    expect(ctl.getState().lag).toBe(0)
  })

  it('keeps checking every 2 s while playing and stops with the stream', async () => {
    const { ctl, audio, advance, pending } = await playing()
    audio.currentTime = 1
    audio.bufferedEnd = 2
    advance(EDGE_CHECK_MS * 3)
    expect(pending()).toBe(1)
    ctl.stop()
    expect(pending()).toBe(0)
  })

  it('is not used for files', async () => {
    const t = makeEdge()
    t.ctl.toggle(track('1'))
    await tick()
    t.audio.emit('playing')
    expect(t.pending()).toBe(0)
  })

  it('play after a pause from outside re-opens the stream fresh instead of resuming the buffer', async () => {
    const { ctl, audio } = await playing()
    audio.emit('pause') // OS media key / headset
    expect(ctl.getState().playing).toBe(false)
    const calls = audio.playCalls
    audio.emit('play')
    await tick()
    expect(audio.src).toMatch(/^\/stream\/x\.mp3\?_r=\d+$/)
    expect(audio.playCalls).toBe(calls + 1)
  })

  it('resume() of a live stream re-opens it fresh', async () => {
    const { ctl, audio } = await playing()
    audio.emit('pause')
    ctl.resume()
    await tick()
    expect(audio.src).toMatch(/_r=\d+$/)
    expect(ctl.getState()).toMatchObject({ playing: true, loading: false })
  })

  it('recover() always re-opens a playing live stream (never keeps the old buffer)', async () => {
    const { ctl, audio } = await playing()
    audio.paused = false
    const calls = audio.playCalls
    ctl.recover()
    await tick()
    expect(audio.src).toMatch(/_r=\d+$/)
    expect(audio.playCalls).toBe(calls + 1)
  })

  it('recover() leaves a stream the user stopped alone', async () => {
    const { ctl, audio } = await playing()
    ctl.stop()
    const calls = audio.playCalls
    ctl.recover()
    expect(audio.playCalls).toBe(calls)
  })

  it('our own stop / switch does not count as a pause from outside', async () => {
    const { ctl, audio } = await playing()
    ctl.stop()
    audio.emit('pause')
    ctl.toggle(live)
    await tick()
    const calls = audio.playCalls
    audio.emit('play')
    expect(audio.playCalls).toBe(calls)
    expect(audio.src).toBe('/stream/x.mp3')
  })
})
