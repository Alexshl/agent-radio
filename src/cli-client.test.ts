// Tests of client/agent-radio (the sh CLI) against a stub HTTP server.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve('client/agent-radio')

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

let server: Server
let seen: Seen[]
let respond: (req: IncomingMessage, res: ServerResponse) => void
let url: string

beforeEach(async () => {
  seen = []
  respond = (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"aired","listeners":1}')
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      respond(req, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(() => new Promise<void>((r) => server.close(() => r())))

function run(args: string[], opts: { env?: Record<string, string>; stdin?: string; url?: string; key?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ar-cli-'))
  return new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const p = spawn('sh', [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        AGENT_RADIO_URL: opts.url ?? url,
        AGENT_RADIO_KEY: opts.key ?? 'ar_testkey123456',
        AGENT_RADIO_SESSION: 'my-session',
        AGENT_RADIO_TIMEOUT: '5',
        ...opts.env,
      },
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => {
      out += d
    })
    p.stderr.on('data', (d) => {
      err += d
    })
    p.on('close', (code) => done({ code, out, err }))
    // the script may exit before it reads stdin: that is not an error of the test
    p.stdin.on('error', () => {})
    p.stdin.end(opts.stdin ?? '')
  })
}

const NASTY = 'He said "hi" \\ back\\slash\nsecond line\twith tab\r\nПривіт, світе! 日本語 🎧 {"json": [1,2]} $HOME `date` \'quote\''

describe('agent-radio CLI', () => {
  it('server unreachable: "offline", exit 0', async () => {
    const dead = await new Promise<string>((r) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const u = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
        s.close(() => r(u))
      })
    })
    for (const args of [['status'], ['say', 'hello']]) {
      const r = await run(args, { url: dead })
      expect(r.code).toBe(0)
      expect(r.out).toContain('agent-radio: offline')
    }
  })

  it('503 from the server counts as offline too', async () => {
    respond = (_q, res) => res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"engine_unavailable"}')
    const r = await run(['say', 'hello'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('offline')
  })

  it('401: clear error, exit 1', async () => {
    respond = (_q, res) => res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}')
    for (const args of [['status'], ['say', 'hello']]) {
      const r = await run(args)
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/rejected the key \(401\)/)
    }
  })

  it('missing configuration: exit 1 with a hint', async () => {
    const r = await run(['status'], { url: '', key: '' })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/not configured/)
  })

  it('nobody listening: "skipped", exit 0', async () => {
    respond = (_q, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"skipped","listeners":0}')
    const r = await run(['say', 'hello'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('skipped (nobody listening)')
  })

  it('202 queued (slow voice): success, exit 0', async () => {
    respond = (_q, res) => res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"status":"queued","listeners":1}')
    const r = await run(['say', 'hello'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('queued')
  })

  for (const tool of ['python3', 'sh', 'jq']) {
    it(`say builds valid JSON with quotes, newlines, tabs, backslashes and unicode (${tool})`, async () => {
      const probe = await run(['config'], { env: { AGENT_RADIO_JSON_TOOL: tool } })
      const has =
        tool === 'sh' || (await new Promise<boolean>((r) => spawn('sh', ['-c', `command -v ${tool}`]).on('close', (c) => r(c === 0))))
      if (!has) return // that tool is not installed here
      expect(probe.code).toBe(0)
      const r = await run(['say', NASTY], { env: { AGENT_RADIO_JSON_TOOL: tool } })
      expect(r.code).toBe(0)
      expect(r.out).toContain('aired')
      const req = seen.at(-1) as Seen
      expect(req.method).toBe('POST')
      expect(req.url).toBe('/api/say')
      expect(req.headers.authorization).toBe('Bearer ar_testkey123456')
      const body = JSON.parse(req.body) as { session: string; host: string; text: string }
      // the sh fallback normalises \r\n to \n inside the text; the others keep it byte for byte
      expect(body.text).toBe(tool === 'sh' ? NASTY.replace('\r', '\r') : NASTY)
      expect(body.session).toBe('my-session')
      expect(body.host.length).toBeGreaterThan(0)
    })
  }

  it('say reads stdin when there are no arguments', async () => {
    const r = await run(['say'], { stdin: 'from stdin: "q"\nline two\n' })
    expect(r.code).toBe(0)
    expect(JSON.parse((seen.at(-1) as Seen).body).text).toBe('from stdin: "q"\nline two')
  })

  it('session defaults to the git root name or the folder, host to the short hostname', async () => {
    const r = await run(['config'], { env: { AGENT_RADIO_SESSION: '' } })
    expect(r.out).toMatch(/session: \S+/)
    expect(r.out).toMatch(/host: \S+/)
  })

  it('status prints the listeners and the summary language', async () => {
    respond = (_q, res) =>
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end('{"up":true,"listeners":2,"title":"Bonobo","lang":"ru","station":{"id":"x"}}')
    const r = await run(['status'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('listeners: 2')
    expect(r.out).toContain('listening: yes')
    expect(r.out).toContain('language: ru')
    for (const tool of ['sh']) {
      const r2 = await run(['status'], { env: { AGENT_RADIO_JSON_TOOL: tool } })
      expect(r2.out).toContain('language: ru')
      expect(r2.out).toContain('listeners: 2')
    }
  })

  it('status with nobody listening', async () => {
    respond = (_q, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"up":true,"listeners":0,"lang":"uk"}')
    const r = await run(['status'])
    expect(r.out).toContain('listening: no')
    expect(r.out).toContain('language: uk')
  })

  it('play uploads the file with the intro as multipart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-cli-f-'))
    const file = join(dir, 'mix.mp3')
    writeFileSync(file, 'FAKE-MP3')
    respond = (_q, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"aired","listeners":1}')
    const r = await run(['play', file, 'Сесія tu-mani. "Новий" мікс'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('on air')
    const req = seen.at(-1) as Seen
    expect(req.url).toBe('/api/play')
    expect(req.headers['content-type']).toMatch(/^multipart\/form-data/)
    expect(req.body).toContain('name="file"; filename="mix.mp3"')
    expect(req.body).toContain('FAKE-MP3')
    expect(req.body).toContain('Сесія tu-mani. "Новий" мікс')
    expect(req.body).toContain('name="session"')
  })

  it('play: kept in the history when nobody listens, refused files exit 1, missing file exits 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-cli-f-'))
    const file = join(dir, 'a.wav')
    writeFileSync(file, 'x')
    respond = (_q, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"skipped","listeners":0}')
    expect((await run(['play', file])).out).toContain('saved to the history')
    respond = (_q, res) =>
      res.writeHead(413, { 'Content-Type': 'application/json' }).end('{"error":"too_long","message":"Longer than 20 minutes"}')
    const big = await run(['play', file])
    expect(big.code).toBe(1)
    expect(big.err).toContain('Longer than 20 minutes')
    expect((await run(['play', join(dir, 'nope.mp3')])).code).toBe(2)
  })

  it('config shows the URL and a masked key', async () => {
    const r = await run(['config'])
    expect(r.out).toContain(`url: ${url}`)
    expect(r.out).toContain('ar_tes…(hidden)')
    expect(r.out).not.toContain('ar_testkey123456')
  })

  it('unknown command: usage, exit 2', async () => {
    const r = await run(['bogus'])
    expect(r.code).toBe(2)
  })

  it('any 5xx (Cloudflare 52x too) and any non-JSON answer count as offline: exit 0', async () => {
    for (const code of [500, 502, 520, 522, 524, 530]) {
      respond = (_q, res) => res.writeHead(code, { 'Content-Type': 'text/html' }).end('<html>error</html>')
      for (const args of [['status'], ['say', 'hi']]) {
        const r = await run(args)
        expect(r.code, `${code} ${args[0]}`).toBe(0)
        expect(r.out).toContain('offline')
      }
    }
    // an HTML page with 200 (a captive portal, a proxy error page) is not our server either
    respond = (_q, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>login</html>')
    const r = await run(['say', 'hi'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('offline')
  })

  it('cuts text over 2000 characters with an ellipsis (python3 and sh)', async () => {
    for (const tool of ['python3', 'sh']) {
      await run(['say', 'я'.repeat(3000)], { env: { AGENT_RADIO_JSON_TOOL: tool } })
      const text = JSON.parse((seen.at(-1) as Seen).body).text as string
      expect(text.endsWith('…'), tool).toBe(true)
      expect([...text].length, tool).toBeLessThanOrEqual(2000)
      expect(text, tool).not.toContain('\uFFFD')
    }
  })

  it('reads the config file as text: quotes, no execution; the environment wins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-cli-c-'))
    const file = join(dir, 'env')
    const marker = join(dir, 'executed')
    writeFileSync(
      file,
      [
        `AGENT_RADIO_URL='${url}'`,
        `AGENT_RADIO_KEY='ar_it'\\''s a key'`,
        `AGENT_RADIO_SESSION="from file"`,
        `$(touch ${marker})`,
        `touch ${marker}`,
        '',
      ].join('\n'),
    )
    const env = { AGENT_RADIO_CONFIG: file, AGENT_RADIO_URL: '', AGENT_RADIO_KEY: '', AGENT_RADIO_SESSION: '' }
    const r = await run(['say', 'hello'], { env, url: '', key: '' })
    expect(r.code).toBe(0)
    expect(seen.at(-1)?.headers.authorization).toBe("Bearer ar_it's a key")
    expect(JSON.parse((seen.at(-1) as Seen).body).session).toBe('from file')
    expect(existsSync(marker)).toBe(false)
    const over = await run(['say', 'hello'], { env: { ...env, AGENT_RADIO_KEY: 'ar_from_env' }, url: '', key: 'ar_from_env' })
    expect(over.code).toBe(0)
    expect(seen.at(-1)?.headers.authorization).toBe('Bearer ar_from_env')
  })

  it('install.sh writes a file the client reads back, also when the values hold quotes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ar-inst-'))
    const bin = join(home, 'curl')
    // a fake curl: "downloads" the CLI and the skill from local files instead of the network
    writeFileSync(bin, `#!/bin/sh\nout=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out=$2; shift; done\ncp ${SCRIPT} "$out"\n`, {
      mode: 0o755,
    })
    const key = "ar_o'brien"
    const r = await new Promise<{ code: number | null; out: string }>((done) => {
      const p = spawn('sh', [resolve('client/install.sh')], {
        env: {
          PATH: `${home}:${process.env.PATH}`,
          HOME: home,
          AGENT_RADIO_URL: "http://x.example/it's",
          AGENT_RADIO_KEY: key,
          XDG_CONFIG_HOME: join(home, 'cfg'),
        },
      })
      let out = ''
      p.stdout.on('data', (d) => {
        out += d
      })
      p.stderr.on('data', (d) => {
        out += d
      })
      p.on('close', (code) => done({ code, out }))
    })
    expect(r.code).toBe(0)
    expect(r.out).not.toContain(key)
    const conf = join(home, 'cfg', 'agent-radio', 'env')
    const shown = await run(['config'], { env: { AGENT_RADIO_CONFIG: conf, AGENT_RADIO_URL: '', AGENT_RADIO_KEY: '' }, url: '', key: '' })
    expect(shown.out).toContain("url: http://x.example/it's")
    expect(shown.out).toContain('key: ar_o')
    // a second run with a new URL keeps the key and replaces the URL
    const again = spawnSync('sh', [resolve('client/install.sh')], {
      env: { PATH: `${home}:${process.env.PATH}`, HOME: home, AGENT_RADIO_URL: 'http://new.example', XDG_CONFIG_HOME: join(home, 'cfg') },
    })
    expect(again.status).toBe(0)
    const shown2 = await run(['config'], { env: { AGENT_RADIO_CONFIG: conf, AGENT_RADIO_URL: '', AGENT_RADIO_KEY: '' }, url: '', key: '' })
    expect(shown2.out).toContain('url: http://new.example')
    expect(shown2.out).toContain('key: ar_o')
  })
})
