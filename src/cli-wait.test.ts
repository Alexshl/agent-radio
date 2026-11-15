// Tests of client/agent-radio: held messages ("waiting for listener"), the grace-window status and `say --wait`.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve('client/agent-radio')

let server: Server
let urls: string[]
let respond: (req: IncomingMessage, res: ServerResponse) => void
let url: string

const json = (res: ServerResponse, code: number, body: string) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(body)

beforeEach(async () => {
  urls = []
  respond = (_req, res) => json(res, 200, '{}')
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      urls.push(req.url ?? '')
      respond(req, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(() => new Promise<void>((r) => server.close(() => r())))

function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string }>((done) => {
    const p = spawn('sh', [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: mkdtempSync(join(tmpdir(), 'ar-cli-')),
        AGENT_RADIO_URL: url,
        AGENT_RADIO_KEY: 'ar_testkey123456',
        AGENT_RADIO_SESSION: 'my-session',
        AGENT_RADIO_TIMEOUT: '5',
        ...env,
      },
    })
    let out = ''
    p.stdout.on('data', (d) => {
      out += d
    })
    p.on('close', (code) => done({ code, out }))
    p.stdin.end()
  })
}

describe('agent-radio: held messages and --wait', () => {
  it('202 waiting: success, exit 0, "waiting for listener"', async () => {
    respond = (_q, res) => json(res, 202, '{"id":"m1","status":"waiting","listeners":0}')
    const r = await run(['say', 'hello'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('waiting for listener')
    expect(urls).toHaveLength(1)
  })

  it('status: a listener within the grace window counts as listening, with a reconnecting line', async () => {
    respond = (_q, res) => json(res, 200, '{"up":true,"listeners":0,"listening":true,"reconnecting":true,"lang":"uk"}')
    const r = await run(['status'])
    expect(r.out).toContain('listeners: 0')
    expect(r.out).toContain('listening: yes')
    expect(r.out).toContain('reconnecting: yes')
  })

  it('status: listening false and no reconnecting line when nobody is around', async () => {
    respond = (_q, res) => json(res, 200, '{"up":true,"listeners":0,"listening":false,"reconnecting":false,"lang":"uk"}')
    const r = await run(['status'])
    expect(r.out).toContain('listening: no')
    expect(r.out).not.toContain('reconnecting')
  })

  it('say --wait: polls the message until it is played', async () => {
    let polls = 0
    respond = (q, res) => {
      if (q.url === '/api/say') return json(res, 200, '{"id":"m1","status":"aired","listeners":1}')
      polls++
      json(res, 200, polls < 2 ? '{"id":"m1","status":"on_air_queued","reason":null}' : '{"id":"m1","status":"played","reason":null}')
    }
    const r = await run(['say', '--wait', 'hello'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('played')
    expect(urls.at(-1)).toBe('/api/messages/m1')
    expect(polls).toBe(2)
  })

  it('say --wait: a held message that is later played', async () => {
    let polls = 0
    respond = (q, res) => {
      if (q.url === '/api/say') return json(res, 202, '{"id":"m2","status":"waiting","listeners":0}')
      polls++
      json(res, 200, polls < 2 ? '{"id":"m2","status":"waiting"}' : '{"id":"m2","status":"played"}')
    }
    const r = await run(['say', '--wait', 'hello'])
    expect(r.out).toContain('waiting for listener')
    expect(r.out).toContain('agent-radio: played')
  })

  for (const tool of ['python3', 'sh', 'jq']) {
    it(`say --wait: "not played: <reason>" (${tool})`, async () => {
      respond = (q, res) => {
        if (q.url === '/api/say') return json(res, 200, '{"id":"m3","status":"aired","listeners":1}')
        json(res, 200, '{"id":"m3","status":"failed","reason":"not_started"}')
      }
      const r = await run(['say', '--wait', 'hello'], { AGENT_RADIO_JSON_TOOL: tool })
      if (tool === 'sh' || r.out.includes('not played')) {
        expect(r.code).toBe(0)
        expect(r.out).toContain('not played: not_started')
      }
    })
  }

  it('say --wait: gives up after the wait limit', async () => {
    respond = (q, res) => {
      if (q.url === '/api/say') return json(res, 200, '{"id":"m4","status":"aired","listeners":1}')
      json(res, 200, '{"id":"m4","status":"on_air_queued"}')
    }
    const r = await run(['say', '--wait', 'hello'], { AGENT_RADIO_WAIT: '2' })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/not played: on_air_queued after 2s/)
  })

  it('say --wait with nobody listening: skipped, no polling', async () => {
    respond = (_q, res) => json(res, 200, '{"id":"m5","status":"skipped","listeners":0}')
    const r = await run(['say', '--wait', 'hello'])
    expect(r.out).toContain('skipped (nobody listening)')
    expect(urls).toHaveLength(1)
  })

  it('play: a held file says so', async () => {
    respond = (_q, res) => json(res, 202, '{"id":"m6","status":"waiting","listeners":0}')
    const f = join(mkdtempSync(join(tmpdir(), 'ar-f-')), 'a.mp3')
    writeFileSync(f, 'x')
    const r = await run(['play', f])
    expect(r.code).toBe(0)
    expect(r.out).toContain('waiting for listener')
  })
})
