import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { messages, stations } from './db/schema'
import { newId } from './lib/ids'
import { addUser, login, setup, type T } from './test-utils'

// a history row N minutes ago; `clip` = a file that exists on disk
function addMsg(t: T, userId: string, o: { text: string; minutesAgo: number; type?: string; clip?: boolean; status?: string }) {
  const id = newId()
  let clipPath: string | null = null
  if (o.clip) {
    clipPath = join(t.dir, `${id}.mp3`)
    writeFileSync(clipPath, 'x')
  }
  t.db
    .insert(messages)
    .values({
      id,
      userId,
      session: 's',
      host: null,
      text: o.text,
      status: o.status ?? 'aired',
      clipPath,
      type: o.type ?? 'voice',
      durationSec: o.type === 'audio' ? 12 : null,
      createdAt: new Date(Date.now() - o.minutesAgo * 60_000).toISOString(),
    })
    .run()
  return id
}

const replay = (t: T, cookie: string, json: unknown) => t.req('/api/app/history/replay', { method: 'POST', cookie, json })
type Call = [string, string, string]
const pushCalls = (t: T) => t.engine.push.mock.calls as unknown as Call[]
const rowOf = (t: T, id: string) => t.db.select().from(messages).where(eq(messages.id, id)).get()
const pushedTexts = (t: T) => pushCalls(t).map((c) => rowOf(t, c[2])?.text)
const read = async (res: Response) => (await res.json()) as { status: string; listeners: number; ids: string[] }

describe('POST /api/app/history/replay', () => {
  it('puts the last N messages on air as new rows, the oldest of them first', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    addMsg(t, user.id, { text: 'old', minutesAgo: 40, clip: true })
    addMsg(t, user.id, { text: 'a', minutesAgo: 30, clip: true })
    addMsg(t, user.id, { text: 'b', minutesAgo: 20, clip: true })
    addMsg(t, user.id, { text: 'c', minutesAgo: 10, clip: true })
    const res = await replay(t, cookie, { count: 3 })
    expect(res.status).toBe(200)
    const body = await read(res)
    expect(body).toMatchObject({ status: 'aired', listeners: 1 })
    expect(body.ids).toHaveLength(3)
    expect(pushedTexts(t)).toEqual(['a', 'b', 'c'])
    // each push carries the id of its new row, so delivery confirmation tracks it
    expect(pushCalls(t).map((c) => c[2])).toEqual(body.ids)
    expect(rowOf(t, body.ids[0] as string)).toMatchObject({ note: 'replay', status: 'onair', session: 's' })
    // the originals stay as they were; history has them and the replays
    const hist = (await (await t.req('/api/app/history', { cookie })).json()) as { messages: { note: string | null }[] }
    expect(hist.messages).toHaveLength(7)
    expect(hist.messages.filter((m) => m.note === 'replay')).toHaveLength(3)
  })

  it('count 1 plays only the latest; more than 3 or a bad body is rejected', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    addMsg(t, user.id, { text: 'a', minutesAgo: 30, clip: true })
    addMsg(t, user.id, { text: 'b', minutesAgo: 20, clip: true })
    expect((await replay(t, cookie, { count: 1 })).status).toBe(200)
    expect(pushedTexts(t)).toEqual(['b'])
    expect((await replay(t, cookie, { count: 4 })).status).toBe(400)
    expect((await replay(t, cookie, { count: 0 })).status).toBe(400)
    expect((await replay(t, cookie, {})).status).toBe(400)
    expect(t.engine.push).toHaveBeenCalledTimes(1)
  })

  it('replays one message by id', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const a = addMsg(t, user.id, { text: 'a', minutesAgo: 30, clip: true })
    addMsg(t, user.id, { text: 'b', minutesAgo: 20, clip: true })
    expect((await replay(t, cookie, { id: a })).status).toBe(200)
    expect(pushedTexts(t)).toEqual(['a'])
  })

  it('replays are never replayed again and are hidden from the last messages', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    addMsg(t, user.id, { text: 'a', minutesAgo: 30, clip: true })
    addMsg(t, user.id, { text: 'b', minutesAgo: 20, clip: true })
    const first = await read(await replay(t, cookie, { count: 2 }))
    expect((await replay(t, cookie, { id: first.ids[0] as string })).status).toBe(400)
    await replay(t, cookie, { count: 1 })
    // still the originals, not their copies
    expect(pushedTexts(t)).toEqual(['a', 'b', 'b'])
    const radio = (await (await t.req('/api/app/radio', { cookie })).json()) as { messages: { text: string; note: string | null }[] }
    expect(radio.messages.map((m) => m.text)).toEqual(['b', 'a'])
    expect(radio.messages.every((m) => m.note === null)).toBe(true)
  })

  it('synthesizes a message without a clip first and stores the clip on the original', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    const a = addMsg(t, user.id, { text: 'no clip', minutesAgo: 5, status: 'skipped' })
    const res = await replay(t, cookie, { count: 1 })
    expect(res.status).toBe(200)
    expect(t.makeClip).toHaveBeenCalledTimes(1)
    expect(t.engine.push).toHaveBeenCalledTimes(1)
    expect(rowOf(t, a)).toMatchObject({ status: 'skipped' })
    expect(rowOf(t, a)?.clipPath).toBeTruthy()
  })

  it('nobody listening: a clear "skipped" answer, no rows, nothing pushed or synthesized', async () => {
    const t = setup({ listeners: 0 })
    const { user } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    addMsg(t, user.id, { text: 'a', minutesAgo: 5 })
    const res = await replay(t, cookie, { count: 1 })
    expect(res.status).toBe(200)
    expect(await read(res)).toMatchObject({ status: 'skipped', listeners: 0, ids: [] })
    expect(t.engine.push).not.toHaveBeenCalled()
    expect(t.makeClip).not.toHaveBeenCalled()
    const hist = (await (await t.req('/api/app/history', { cookie })).json()) as { messages: unknown[] }
    expect(hist.messages).toHaveLength(1)
  })

  it('a listener who dropped a moment ago (grace window): the replay is held, not lost', async () => {
    const t = setup({ listeners: 0 })
    const { user, station } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    t.db
      .update(stations)
      .set({ lastListenerSeenAt: Date.now() - 20_000 })
      .where(eq(stations.id, station.id))
      .run()
    addMsg(t, user.id, { text: 'a', minutesAgo: 5, clip: true })
    const body = await read(await replay(t, cookie, { count: 1 }))
    expect(body.status).toBe('waiting')
    expect(t.engine.push).not.toHaveBeenCalled()
    expect(rowOf(t, body.ids[0] as string)).toMatchObject({ status: 'waiting', note: 'replay' })
  })

  it("is isolated: only the user's own messages and own station", async () => {
    const t = setup()
    const { user: a, station: stA } = await addUser(t, 'a@x.io')
    const { user: b } = await addUser(t, 'b@x.io')
    const cookieA = await login(t, 'a@x.io')
    addMsg(t, a.id, { text: 'mine', minutesAgo: 20, clip: true })
    const foreign = addMsg(t, b.id, { text: 'theirs', minutesAgo: 5, clip: true })
    const res = await replay(t, cookieA, { count: 3 })
    expect((await read(res)).ids).toHaveLength(1)
    expect(pushedTexts(t)).toEqual(['mine'])
    expect(pushCalls(t)[0]?.[0]).toBe(stA.id)
    expect(rowOf(t, pushCalls(t)[0]?.[2] as string)?.userId).toBe(a.id)
    // somebody else's message by id: not found
    expect((await replay(t, cookieA, { id: foreign })).status).toBe(404)
  })

  it('audio files go through the track path, an audio item without its file is skipped over', async () => {
    const t = setup()
    const { user } = await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    addMsg(t, user.id, { text: 'v', minutesAgo: 30, clip: true })
    addMsg(t, user.id, { text: 'song', minutesAgo: 20, type: 'audio', clip: true })
    addMsg(t, user.id, { text: 'gone', minutesAgo: 10, type: 'audio' })
    const body = await read(await replay(t, cookie, { count: 2 }))
    expect(body.ids).toHaveLength(2)
    expect(t.engine.push).toHaveBeenCalledTimes(1)
    expect(t.engine.pushTrack).toHaveBeenCalledTimes(1)
    expect(rowOf(t, body.ids[1] as string)).toMatchObject({ type: 'audio', text: 'song' })
  })

  it('needs a signed-in user and a message to replay', async () => {
    const t = setup()
    await addUser(t, 'a@x.io')
    const cookie = await login(t, 'a@x.io')
    expect((await replay(t, '', { count: 1 })).status).toBe(401)
    expect((await replay(t, cookie, { count: 1 })).status).toBe(404)
  })
})
