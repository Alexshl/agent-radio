import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { messages } from './db/schema'
import { newId, nowIso } from './lib/ids'
import { LiveBus, type LiveTopic, MAX_LIVE_CONNECTIONS_PER_USER, liveBus } from './live'
import { type T, addUser, login, setup, userWithKey } from './test-utils'

describe('LiveBus', () => {
  it('delivers to the subscribers of one user only and stops after unsubscribe', () => {
    const bus = new LiveBus()
    const a: LiveTopic[] = []
    const b: LiveTopic[] = []
    const offA = bus.subscribe('a', (t) => a.push(t))
    bus.subscribe('b', (t) => b.push(t))
    bus.emit('a', 'messages', 'live')
    expect(a).toEqual(['messages', 'live'])
    expect(b).toEqual([])
    offA?.()
    bus.emit('a', 'station')
    expect(a).toHaveLength(2)
    expect(bus.count('a')).toBe(0)
    expect(bus.count('b')).toBe(1)
  })

  it('caps the connections per user and survives a throwing subscriber', () => {
    const bus = new LiveBus()
    const got: LiveTopic[] = []
    bus.subscribe('a', () => {
      throw new Error('broken')
    })
    bus.subscribe('a', (t) => got.push(t))
    bus.emit('a', 'learn')
    expect(got).toEqual(['learn'])
    for (let i = 0; i < MAX_LIVE_CONNECTIONS_PER_USER; i++) bus.subscribe('x', () => {})
    expect(bus.subscribe('x', () => {})).toBeNull()
  })
})

// collects the topics of one user while the test runs
function spy(userId: string) {
  const topics: LiveTopic[] = []
  const off = liveBus.subscribe(userId, (t) => topics.push(t))
  return { topics, off: () => off?.() }
}

describe('GET /api/app/events', () => {
  it('needs a session', async () => {
    const t = setup()
    expect((await t.req('/api/app/events')).status).toBe(401)
  })

  it('streams only the events of the signed-in user, with SSE headers, and cleans up on cancel', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const { user: other } = await addUser(t, 'b@x.io')
    const cookie = await login(t, 'a@x.io')
    const res = await t.req('/api/app/events', { cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    expect(res.headers.get('content-encoding')).toBeNull()
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    let text = dec.decode((await reader.read()).value)
    expect(text).toContain('retry: 3000')
    expect(liveBus.count(user.id)).toBe(1)
    liveBus.emit(other.id, 'station')
    liveBus.emit(user.id, 'messages')
    text = dec.decode((await reader.read()).value)
    expect(text).toBe('event: messages\ndata: {}\n\n')
    await reader.cancel()
    expect(liveBus.count(user.id)).toBe(0)
  })
})

describe('emit points', () => {
  const say = (t: T, token: string) =>
    t.req('/api/say', { method: 'POST', json: { session: 's', text: 'hello' }, headers: { Authorization: `Bearer ${token}` } })

  it('say tells the owner (and nobody else) about the new message', async () => {
    const t = setup()
    const { user, token } = await userWithKey(t, 'a@x.io')
    const { user: other } = await addUser(t, 'b@x.io')
    const mine = spy(user.id)
    const theirs = spy(other.id)
    expect((await say(t, token)).status).toBe(200)
    mine.off()
    theirs.off()
    expect(mine.topics).toContain('messages')
    expect(theirs.topics).toEqual([])
  })

  it('a delivery status change (tick) emits messages', async () => {
    const t = setup()
    const { user, token } = await userWithKey(t, 'a@x.io')
    await say(t, token)
    const mine = spy(user.id)
    t.engine.msgStates.mockResolvedValue([
      { id: (t.db.$client.prepare('select id from messages').get() as { id: string }).id, state: 'done', started: 1, ended: 2 },
    ])
    await t.delivery.tick()
    mine.off()
    expect(mine.topics).toContain('messages')
  })

  it('changing the source from the browser and from the iOS control endpoint emits station', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const mine = spy(user.id)
    expect((await t.req('/api/app/station/source', { method: 'PUT', cookie, json: { type: 'silence' } })).status).toBe(200)
    expect(mine.topics).toContain('station')
    mine.topics.length = 0
    const { secret } = (await (await t.req('/api/app/control-token', { method: 'POST', cookie })).json()) as { secret: string }
    expect((await t.req(`/api/control/source?k=${encodeURIComponent(secret)}&kind=silence`, { method: 'POST' })).status).toBe(200)
    mine.off()
    expect(mine.topics).toContain('station')
  })

  it('settings emit station', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const mine = spy(user.id)
    expect((await t.req('/api/app/settings', { method: 'PATCH', cookie, json: { chime: false } })).status).toBe(200)
    expect(mine.topics).toContain('station')
    mine.off()
  })

  it('replay emits messages', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const clip = join(t.dir, 'c.mp3')
    writeFileSync(clip, 'x')
    t.db
      .insert(messages)
      .values({
        id: newId(),
        userId: user.id,
        session: 's',
        host: null,
        text: 'hi',
        status: 'aired',
        clipPath: clip,
        type: 'voice',
        createdAt: nowIso(),
      })
      .run()
    const mine = spy(user.id)
    expect((await t.req('/api/app/history/replay', { method: 'POST', cookie, json: { count: 1 } })).status).toBe(200)
    mine.off()
    expect(mine.topics).toContain('messages')
  })
})
