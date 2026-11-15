import { describe, expect, it, vi } from 'vitest'
import { DIAG_KEY, Diag, type DiagEnv, FLUSH_MS, diagEnabled, resumeOnActiveEnabled } from './diag'

class Page {
  handlers = new Map<string, (() => void)[]>()
  visibilityState = 'visible'
  type = 'auto'
  state = 'active'
  addEventListener(type: string, fn: () => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn])
  }
  emit(type: string) {
    for (const fn of this.handlers.get(type) ?? []) fn()
  }
}

const store = () => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

type Sent = { url: string; init: RequestInit }

function make(sessionOn = true) {
  const doc = new Page()
  const win = new Page()
  const session = sessionOn ? new Page() : null
  const audio = Object.assign(new Page(), { paused: true, currentTime: 1.2345 })
  const sent: Sent[] = []
  const timers: (() => void)[] = []
  const env: DiagEnv = {
    search: '',
    storage: store(),
    doc,
    win,
    session,
    fetch: async (url, init) => void sent.push({ url, init }),
    setInterval: (fn) => void timers.push(fn),
    now: () => 1_700_000_000_000,
    perf: () => 12.6,
  }
  const diag = new Diag(env)
  diag.attach(audio)
  const bodies = () =>
    sent.flatMap((s) => (JSON.parse(s.init.body as string) as { events: { type: string; data: Record<string, unknown> }[] }).events)
  return { diag, doc, win, session, audio, sent, timers, bodies }
}

describe('diag flags', () => {
  it('?diag=1 sets the flag, ?diag=0 clears it, the stored flag works alone', () => {
    const s = store()
    expect(diagEnabled('', s)).toBe(false)
    expect(diagEnabled('?diag=1', s)).toBe(true)
    expect(s.getItem(DIAG_KEY)).toBe('1')
    expect(diagEnabled('', s)).toBe(true)
    expect(diagEnabled('?diag=0', s)).toBe(false)
    expect(diagEnabled('', s)).toBe(false)
  })
  it('resumeOnActive is a separate flag', () => {
    const s = store()
    expect(resumeOnActiveEnabled('?diag=1', s)).toBe(false)
    expect(resumeOnActiveEnabled('?resumeOnActive=1', s)).toBe(true)
    expect(resumeOnActiveEnabled('', s)).toBe(true)
    expect(diagEnabled('', s)).toBe(false)
  })
})

describe('Diag', () => {
  it('records the initial audioSession, audio, page and audioSession events', async () => {
    const { diag, doc, win, session, audio, bodies } = make()
    audio.paused = false
    audio.emit('pause')
    session?.emit('statechange')
    doc.visibilityState = 'hidden'
    doc.emit('visibilitychange')
    win.emit('blur')
    await diag.flush()
    const ev = bodies()
    expect(ev.map((e) => e.type)).toEqual(['start', 'audio:pause', 'audioSession:statechange', 'visibilitychange', 'blur'])
    expect(ev[0]?.data).toMatchObject({ audioSession: true, sessionType: 'auto', sessionState: 'active', perf: 13 })
    expect(ev[1]?.data).toMatchObject({ paused: false, currentTime: 1.23 })
    expect(ev[3]?.data).toMatchObject({ state: 'hidden' })
  })
  it('works without navigator.audioSession and reports it', async () => {
    const { diag, bodies } = make(false)
    await diag.flush()
    expect(bodies()[0]?.data).toMatchObject({ audioSession: false, sessionState: null })
  })
  it('flushes on the timer and on pagehide, with keepalive', async () => {
    const { timers, win, sent, diag } = make()
    expect(timers).toHaveLength(1)
    timers[0]?.()
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]?.init).toMatchObject({ method: 'POST', keepalive: true })
    expect(FLUSH_MS).toBe(5000)
    diag.record('x')
    win.emit('pagehide')
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(JSON.stringify(sent.map((s) => s.init.body))).not.toContain('http')
  })
  it('splits batches under 100 events / 7 KB', async () => {
    const { diag, sent } = make()
    for (let i = 0; i < 250; i++) diag.record('e', { i })
    await diag.flush()
    expect(sent.length).toBeGreaterThanOrEqual(3)
    for (const s of sent) {
      expect((s.init.body as string).length).toBeLessThanOrEqual(8 * 1024)
      expect((JSON.parse(s.init.body as string) as { events: unknown[] }).events.length).toBeLessThanOrEqual(100)
    }
  })
  it('keeps the events when a send fails and sends them next time', async () => {
    let fail = true
    const counts: number[] = []
    const d = new Diag({
      search: '',
      storage: null,
      doc: null,
      win: null,
      session: null,
      fetch: async (_u, init) => {
        if (fail) throw new Error('offline')
        counts.push((JSON.parse(init.body as string) as { events: unknown[] }).events.length)
      },
      setInterval: () => {},
      now: () => 1,
      perf: () => 1,
    })
    d.record('a')
    d.record('b')
    await d.flush()
    expect(counts).toEqual([])
    fail = false
    await d.flush()
    expect(counts).toEqual([2])
  })
})
