import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app'
import { loadConfig } from './config'
import { openDb } from './db/client'
import type { EngineApi } from './engine/client'
import type { IcecastApi } from './icecast'
import type { LlmService } from './learn/llm'
import { createApiKey } from './lib/api-keys'
import { RateLimiter } from './lib/rate-limit'
import { createUser } from './stations'
import { needsTranslation } from './translate'

describe('needsTranslation', () => {
  it.each([
    ['Привіт, завдання виконано успішно', 'ru', 'yes'],
    ['Задача выполнена, тесты проходят', 'ru', 'no'],
    ['The build finished and all tests pass', 'ru', 'yes'],
    ['Задача завершена, это хорошо', 'uk', 'yes'],
    ['Системна помилка виправлена', 'uk', 'maybe'],
    ['Збірка завершена, є помилка', 'uk', 'no'],
    ['Задача выполнена, всё это хорошо', 'uk', 'yes'],
    ['The build finished and all tests pass', 'en', 'maybe'],
    ['Збірка завершена, усі тести пройшли', 'en', 'yes'],
    ['Die Aufgabe ist erledigt', 'en', 'maybe'],
    ['12345 6789 000', 'ru', 'no'],
    ['Привіт', 'ru', 'no'],
    ['Привіт усім колеги', 'ru', 'yes'],
  ])('%s (%s) = %s', (text, lang, want) => {
    expect(needsTranslation(text, lang)).toBe(want)
  })
})

function setup(chat: ReturnType<typeof vi.fn>, configured = true) {
  const dir = mkdtempSync(join(tmpdir(), 'ar-tr-'))
  const config = loadConfig({ SHARED_DIR: dir, DATA_DIR: dir, PUBLIC_URL: 'http://radio.test', ICECAST_URL: 'http://icecast.test' })
  const db = openDb(':memory:')
  const engine = {
    push: vi.fn(async () => {}),
    msgStates: vi.fn(async () => []),
    list: vi.fn(async () => []),
  } as unknown as EngineApi
  const icecast: IcecastApi = { listeners: async () => 1, isUp: async () => true }
  const makeClip = vi.fn(async (_p: { text: string }) => {
    const f = join(dir, 'clip.mp3')
    writeFileSync(f, 'x')
    return f
  })
  const llm = { configured: () => configured, chatJson: chat } as unknown as LlmService
  const app = createApp({ db, config, engine, icecast, tts: { makeClip }, limiter: new RateLimiter(10), llm })
  return { app, db, makeClip }
}

async function air(t: ReturnType<typeof setup>, text: string, opts: { translate?: boolean } = {}) {
  const { user } = createUser(t.db, { email: 'a@x.io' })
  t.db.$client
    .prepare('update users set lang = ?, translate_messages = ?, speak_session = 0 where id = ?')
    .run('ru', opts.translate === false ? 0 : 1, user.id)
  const { token } = await createApiKey(t.db, { userId: user.id, name: 't' })
  return t.app.request('/api/say', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ session: 's1', host: 'h', text }),
  })
}

const UK = 'Збірка завершена, усі тести пройшли'
const RU = 'Сборка завершена, все тесты прошли'
const row = (t: ReturnType<typeof setup>) => t.db.$client.prepare('select text, spoken_text as spoken from messages').get()

describe('airMessage translation', () => {
  it('speaks the translation and stores it', async () => {
    const chat = vi.fn(async () => ({ data: { lang: 'uk', text: RU } }))
    const t = setup(chat)
    expect((await air(t, UK)).status).toBe(200)
    expect(t.makeClip.mock.calls[0]?.[0].text).toBe(RU)
    expect(row(t)).toEqual({ text: UK, spoken: RU })
  })

  it('does not call the model for Russian text', async () => {
    const chat = vi.fn()
    const t = setup(chat)
    await air(t, RU)
    expect(chat).not.toHaveBeenCalled()
    expect(row(t)).toMatchObject({ spoken: null })
  })

  it('speaks the original when the model fails', async () => {
    const chat = vi.fn(async () => {
      throw new Error('boom')
    })
    const t = setup(chat)
    expect((await air(t, UK)).status).toBe(200)
    expect(t.makeClip.mock.calls[0]?.[0].text).toBe(UK)
    expect(row(t)).toEqual({ text: UK, spoken: null })
  })

  it('skips the layer when the setting is off', async () => {
    const chat = vi.fn()
    const t = setup(chat)
    await air(t, UK, { translate: false })
    expect(chat).not.toHaveBeenCalled()
    expect(t.makeClip.mock.calls[0]?.[0].text).toBe(UK)
  })

  it('speaks the original when no model is configured', async () => {
    const chat = vi.fn()
    const t = setup(chat, false)
    await air(t, UK)
    expect(chat).not.toHaveBeenCalled()
    expect(t.makeClip.mock.calls[0]?.[0].text).toBe(UK)
  })
})
