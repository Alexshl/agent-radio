import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config'
import { eq } from 'drizzle-orm'
import { openDb } from '../db/client'
import { stations } from '../db/schema'
import { EngineClient } from './client'
import { createUser, syncEngine } from '../stations'

describe('syncEngine', () => {
  it('pushes every station after an engine restart and removes unknown mounts', async () => {
    const db = openDb(':memory:')
    const config = loadConfig({})
    const a = createUser(db, { email: 'a@x.io' }).station
    const b = createUser(db, { email: 'b@x.io' }).station
    db.update(stations).set({ musicGainDb: -8, voiceGainDb: 4, trackGainDb: -2 }).where(eq(stations.id, b.id)).run()
    const engine = {
      list: vi.fn(async () => ['stale1']),
      add: vi.fn(async () => {}),
      setSource: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      push: vi.fn(async () => {}),
      pushTrack: vi.fn(async () => {}),
      setDuck: vi.fn(async () => {}),
      setLevels: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
    }
    expect(await syncEngine(db, config, engine)).toEqual({ added: 2, removed: 1 })
    expect(engine.add).toHaveBeenCalledWith(a.id, 14, { musicDb: 0, voiceDb: 0, trackDb: 0 })
    // the saved levels are restored together with the station
    expect(engine.add).toHaveBeenCalledWith(b.id, 14, { musicDb: -8, voiceDb: 4, trackDb: -2 })
    expect(engine.setSource).toHaveBeenCalledWith(b.id, { type: 'silence' })
    expect(engine.remove).toHaveBeenCalledWith('stale1')
  })
})

describe('EngineClient levels', () => {
  it('posts set_levels and add with the dB fields', async () => {
    const calls: { url: string; body: unknown }[] = []
    const f = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ ok: true }))
    }) as unknown as typeof fetch
    const c = new EngineClient('http://engine', f)
    await c.setLevels('s1', { musicDb: -10 })
    await c.add('s1', 14, { musicDb: -8, voiceDb: 4, trackDb: 0 })
    expect(calls[0]).toEqual({ url: 'http://engine/station/set_levels', body: { id: 's1', music_db: -10 } })
    expect(calls[1]).toEqual({ url: 'http://engine/station/add', body: { id: 's1', duck_db: 14, music_db: -8, voice_db: 4, track_db: 0 } })
  })
})
