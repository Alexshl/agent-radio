import { describe, expect, it } from 'vitest'
import { addUser, login, setup } from './test-utils'
import { TtsService } from './tts'
import { type PronEntry, applyPronunciations, effectiveEntries, prepareSpeech, renderStress, stressTarget } from './tts/pronunciation'
import { loadEntries } from './tts/pronunciation-store'

const g = (lang: string, match: string, replacement: string): PronEntry => ({ scope: 'global', lang, match, replacement })
const u = (lang: string, match: string, replacement: string): PronEntry => ({ scope: 'user', lang, match, replacement })

describe('matcher', () => {
  it('matches whole words only (Cyrillic boundaries)', () => {
    const e = [g('ru', 'баг', 'б+аг')]
    expect(applyPronunciations('это баг.', e, 'ru')).toBe('это б+аг.')
    expect(applyPronunciations('багаж и багровый', e, 'ru')).toBe('багаж и багровый')
    expect(applyPronunciations('небаг', e, 'ru')).toBe('небаг')
  })

  it('is case-insensitive and handles punctuation around the word', () => {
    const e = [g('*', 'api', 'а-пэ-+и')]
    expect(applyPronunciations('(API), Api! "api"', e, 'ru')).toBe('(а-пэ-+и), а-пэ-+и! "а-пэ-+и"')
    expect(applyPronunciations('rapid apis', e, 'ru')).toBe('rapid apis')
  })

  it('stems match every word form and keep the ending', () => {
    const e = [g('ru', 'закоммит*', 'закомм+ит*')]
    expect(applyPronunciations('Я закоммитил, она закоммитила, закоммитить', e, 'ru')).toBe('Я закомм+итил, она закомм+итила, закомм+итить')
    expect(applyPronunciations('коммит', e, 'ru')).toBe('коммит')
  })

  it('phrases with a hyphen or spaces', () => {
    const e = [g('ru', 'пулл-реквест*', 'пулл-рекв+ест*'), g('ru', 'гит хаб', 'г+ит х+аб')]
    expect(applyPronunciations('Открыл Пулл-Реквест, два пулл-реквестов', e, 'ru')).toBe('Открыл пулл-рекв+ест, два пулл-рекв+естов')
    expect(applyPronunciations('гит   хаб', e, 'ru')).toBe('г+ит х+аб')
  })

  it('does not match inside its own replacement and keeps $ and regex chars literal', () => {
    const e = [g('ru', 'тест*', 'т+ест*'), g('*', 'c++', 'си плюс плюс'), g('*', 'cost', '$& $1')]
    expect(applyPronunciations('тесты', e, 'ru')).toBe('т+есты')
    expect(applyPronunciations('c++ cost', e, 'ru')).toBe('си плюс плюс $& $1')
  })

  it('respects the language of the entry', () => {
    const e = [g('uk', 'тест', 'т+ест'), g('ru', 'тест', 'т+ЕСТ')]
    expect(applyPronunciations('тест', e, 'uk')).toBe('т+ест')
    expect(applyPronunciations('тест', e, 'ru')).toBe('т+ЕСТ')
    expect(applyPronunciations('тест', e, 'en')).toBe('тест')
  })

  it('a user entry overrides a global one with the same match', () => {
    const e = [g('ru', 'Claude', 'Кл+од'), u('ru', 'claude', 'Кл+ауд')]
    expect(effectiveEntries(e, 'ru')).toHaveLength(1)
    expect(applyPronunciations('Claude', e, 'ru')).toBe('Кл+ауд')
    // a more specific (longer) entry wins over a shorter one
    const f = [g('ru', 'пулл', 'п+улл'), g('ru', 'пулл реквест', 'пулл-рекв+ест')]
    expect(applyPronunciations('пулл реквест', f, 'ru')).toBe('пулл-рекв+ест')
  })
})

describe('per-engine stress syntax', () => {
  it('silero / f5 keep + before the vowel, styletts2 gets a combining acute after it, the rest is plain', () => {
    const t = 'закомм+итил в Кл+од, C++ и 2+2'
    expect(renderStress(t, 'plus-before')).toBe(t)
    expect(renderStress(t, 'acute-after')).toBe('закомми\u0301тил в Кло\u0301д, C++ и 2+2')
    expect(renderStress(t, 'plain')).toBe('закоммитил в Клод, C++ и 2+2')
  })

  it('strips the mark before Latin vowels, including diacritic ones, for plain engines', () => {
    const vowels = 'ā ē ī ū ō õ ä ö ü å ė į ų y Ā Ä Ö Ü Å Õ'.split(' ')
    for (const v of vowels) expect(renderStress(`k+${v}ds`, 'plain')).toBe(`k${v}ds`)
    expect(renderStress('Br+ūnā, T+ür, h+öra', 'plain')).toBe('Brūnā, Tür, höra')
    expect(renderStress('C++ und 2+2', 'plain')).toBe('C++ und 2+2')
  })

  it('acute goes right after the marked vowel', () => {
    expect(renderStress('к+ом+іт', 'acute-after')).toBe('ко́мі́т')
    expect(renderStress('+эндпоинт', 'acute-after')).toBe('э́ндпоинт')
  })

  it('picks the target by provider and voice', () => {
    expect(stressTarget('local', 'silero/kseniya')).toBe('plus-before')
    expect(stressTarget('local', 'f5/ref')).toBe('plus-before')
    expect(stressTarget('local', 'styletts2/Денис Денисенко')).toBe('acute-after')
    for (const p of ['piper', 'azure', 'openai', 'gemini']) expect(stressTarget(p, 'x')).toBe('plain')
  })

  it('prepareSpeech = dictionary + engine rendering', () => {
    const e = [g('uk', 'коміт*', 'ком+іт*')]
    expect(prepareSpeech('Коміти', e, 'uk', 'acute-after')).toBe('комі́ти')
    expect(prepareSpeech('Коміти', e, 'uk', 'plain')).toBe('коміти')
  })
})

describe('db + service', () => {
  it('seeds global defaults and loadEntries merges the user over them', async () => {
    const t = setup()
    await addUser(t, 'u@x.io')
    const userId = (t.db.$client.prepare('select id from users').get() as { id: string }).id
    const globalOnly = loadEntries(t.db, undefined)
    expect(globalOnly.length).toBeGreaterThan(30)
    expect(applyPronunciations('закоммитил фронтенд', globalOnly, 'ru')).toBe('закомм+итил фр+онтенд')
    t.db.$client
      .prepare(
        "insert into pronunciations (id, scope, user_id, lang, match, replacement, note, created_at) values ('x', 'user', ?, 'ru', 'фронтенд*', 'фронт+энд*', '', '')",
      )
      .run(userId)
    expect(applyPronunciations('фронтенда', loadEntries(t.db, userId), 'ru')).toBe('фронт+энда')
    expect(applyPronunciations('фронтенда', loadEntries(t.db, undefined), 'ru')).toBe('фр+онтенда')
  })

  it('TtsService hands the provider text prepared for its engine (and plain text to the piper fallback)', async () => {
    const t = setup()
    const seen: { provider: string; text: string }[] = []
    const mk = (name: string, fail = false) => ({
      name,
      synthesize: async (req: { text: string }) => {
        seen.push({ provider: name, text: req.text })
        if (fail) throw new Error('boom')
        return '/dev/null'
      },
    })
    const registry = {
      choose: () => ({ provider: 'local', voice: 'silero/kseniya' }),
      fallback: () => ({ provider: 'piper', voice: 'v' }),
      provider: (n: string) => (n === 'local' ? mk('local', true) : mk('piper')),
    }
    const svc = new TtsService(registry as never, t.config, async () => '', t.db)
    await svc.synthesize({ text: 'закоммитил', voice: null, lang: 'ru' }, '/tmp/x')
    expect(seen).toEqual([
      { provider: 'local', text: 'закомм+итил' },
      { provider: 'piper', text: 'закоммитил' },
    ])
  })
})

describe('pronunciation API', () => {
  async function two() {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    await addUser(t, 'a@x.io')
    await addUser(t, 'b@x.io')
    return { t, admin: await login(t, 'admin@x.io'), a: await login(t, 'a@x.io'), b: await login(t, 'b@x.io') }
  }

  it('requires a session; the admin API requires an admin', async () => {
    const { t, a } = await two()
    expect((await t.req('/api/app/pronunciations')).status).toBe(401)
    expect((await t.req('/api/admin/pronunciations', { cookie: a })).status).toBe(403)
    expect((await t.req('/api/admin/pronunciations', { cookie: a, method: 'POST', json: { match: 'x', replacement: 'y' } })).status).toBe(
      403,
    )
  })

  it('users manage their own entries and cannot touch other users or the global ones', async () => {
    const { t, a, b } = await two()
    const made = await t.req('/api/app/pronunciations', {
      cookie: a,
      method: 'POST',
      json: { match: 'Claude', replacement: 'Кл+од', lang: 'ru' },
    })
    expect(made.status).toBe(201)
    const row = (await made.json()) as { id: string; scope: string }
    expect(row.scope).toBe('user')
    const listA = (await (await t.req('/api/app/pronunciations', { cookie: a })).json()) as { mine: unknown[]; global: { id: string }[] }
    expect(listA.mine).toHaveLength(1)
    expect(listA.global.length).toBeGreaterThan(30)
    const listB = (await (await t.req('/api/app/pronunciations', { cookie: b })).json()) as { mine: unknown[] }
    expect(listB.mine).toHaveLength(0)
    // isolation
    expect((await t.req(`/api/app/pronunciations/${row.id}`, { cookie: b, method: 'PATCH', json: { replacement: 'z' } })).status).toBe(404)
    expect((await t.req(`/api/app/pronunciations/${row.id}`, { cookie: b, method: 'DELETE' })).status).toBe(404)
    const globalId = listA.global[0]?.id
    expect((await t.req(`/api/app/pronunciations/${globalId}`, { cookie: a, method: 'DELETE' })).status).toBe(404)
    // own edit + delete
    const patched = await t.req(`/api/app/pronunciations/${row.id}`, { cookie: a, method: 'PATCH', json: { replacement: 'Кл+ауд' } })
    expect(await patched.json()).toMatchObject({ replacement: 'Кл+ауд' })
    expect((await t.req(`/api/app/pronunciations/${row.id}`, { cookie: a, method: 'DELETE' })).status).toBe(200)
    expect((await t.req('/api/app/pronunciations', { cookie: a, method: 'POST', json: { match: '', replacement: 'x' } })).status).toBe(400)
  })

  it('the admin edits global entries; users see them', async () => {
    const { t, admin, a } = await two()
    const made = await t.req('/api/admin/pronunciations', {
      cookie: admin,
      method: 'POST',
      json: { match: 'линукс', replacement: 'л+инукс', lang: 'ru' },
    })
    expect(made.status).toBe(201)
    const row = (await made.json()) as { id: string; scope: string }
    expect(row.scope).toBe('global')
    const seen = (await (await t.req('/api/app/pronunciations', { cookie: a })).json()) as { global: { match: string }[] }
    expect(seen.global.map((x) => x.match)).toContain('линукс')
    expect((await t.req(`/api/admin/pronunciations/${row.id}`, { cookie: admin, method: 'PATCH', json: { note: 'n' } })).status).toBe(200)
    expect((await t.req(`/api/admin/pronunciations/${row.id}`, { cookie: admin, method: 'DELETE' })).status).toBe(200)
    expect((await t.req(`/api/admin/pronunciations/${row.id}`, { cookie: admin, method: 'DELETE' })).status).toBe(404)
  })

  it('preview returns audio with the user id (for the dictionary) and is rate-limited', async () => {
    const { t, a } = await two()
    t.makeClip.mockImplementation(async () => {
      const { writeFileSync } = await import('node:fs')
      const f = `${t.dir}/prev-${Math.random()}.mp3`
      writeFileSync(f, 'mp3')
      return f
    })
    const r = await t.req('/api/app/pronunciations/preview', { cookie: a, method: 'POST', json: { text: 'закомм+итил' } })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('audio/mpeg')
    expect(t.makeClip).toHaveBeenCalledWith(expect.objectContaining({ text: 'закомм+итил', userId: expect.any(String), chime: false }))
    let last = 200
    for (let i = 0; i < 11; i++)
      last = (await t.req('/api/app/pronunciations/preview', { cookie: a, method: 'POST', json: { text: 'x' } })).status
    expect(last).toBe(429)
  })
})
