// Tests of client/install.sh: the optional CLAUDE.md rule is appended once, only with consent.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './server/app'
import { setup } from './server/test-utils'

let server: Server
let url: string
let home: string
const MARK_RU = '# Голосовая сводка в радио agent-radio'
const MARK_EN = '# Voice summary to the agent-radio'

beforeEach(async () => {
  const t = setup({ env: { CLIENT_FILES_DIR: resolve('client') } })
  const app = createApp(t.deps)
  server = createServer(async (req, res) => {
    const r = await app.request(`http://radio.test${req.url}`)
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'text/plain' }).end(Buffer.from(await r.arrayBuffer()))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  home = mkdtempSync(join(tmpdir(), 'ar-install-'))
})
afterEach(() => new Promise<void>((r) => server.close(() => r())))

// the script as the server serves it ({{PUBLIC_URL}} filled in)
async function install(env: Record<string, string>) {
  const script = join(home, 'install.sh')
  writeFileSync(script, await (await fetch(`${url}/client/install.sh`)).text())
  // setsid: no controlling terminal, so the y/N question cannot be asked
  // (async: the server that serves the files lives in this process)
  await new Promise<void>((done) => {
    const p = spawn('setsid', ['-w', 'sh', script], {
      env: { PATH: process.env.PATH ?? '', HOME: home, AGENT_RADIO_URL: url, AGENT_RADIO_KEY: 'ar_test', ...env },
      stdio: 'ignore',
      timeout: 30_000,
    })
    p.on('close', () => done())
  })
}
const count = (text: string, mark: string) => text.split('\n').filter((l) => l === mark).length

describe('install.sh CLAUDE.md rule', () => {
  it('does not touch CLAUDE.md without consent', async () => {
    await install({})
    expect(existsSync(join(home, '.claude/CLAUDE.md'))).toBe(false)
  })

  it('appends the rule once with AGENT_RADIO_CLAUDE_MD=1 (idempotent), in the matching language', async () => {
    await install({ AGENT_RADIO_CLAUDE_MD: '1', AGENT_RADIO_LANG: 'en_US.UTF-8' })
    await install({ AGENT_RADIO_CLAUDE_MD: '1', AGENT_RADIO_LANG: 'en_US.UTF-8' })
    await install({ AGENT_RADIO_CLAUDE_MD: '1', AGENT_RADIO_LANG: 'ru_RU.UTF-8' })
    const md = readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')
    expect(count(md, MARK_EN)).toBe(1)
    expect(count(md, MARK_RU)).toBe(0)
  })

  it('appends the Russian text for a Russian locale and keeps existing content', async () => {
    await install({ AGENT_RADIO_CLAUDE_MD: '1', AGENT_RADIO_LANG: 'ru_RU.UTF-8' })
    const first = readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')
    expect(count(first, MARK_RU)).toBe(1)
    await install({ AGENT_RADIO_CLAUDE_MD: '1', AGENT_RADIO_LANG: 'ru_RU.UTF-8' })
    expect(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')).toBe(first)
  })
})
