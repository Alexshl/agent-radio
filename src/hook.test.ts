// Tests of client/agent-radio-hook.sh (the radio guard) and of the settings.json merge in client/install.sh.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './server/app'
import { setup } from './server/test-utils'

const HOOK = resolve('client/agent-radio-hook.sh')

describe('agent-radio-hook.sh', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ar-hook-'))
    mkdirSync(join(dir, 'bin'))
  })

  function fakeRadio(status: string) {
    const f = join(dir, 'bin/agent-radio')
    writeFileSync(f, `#!/bin/sh\ncat <<'EOT'\n${status}\nEOT\n`)
    chmodSync(f, 0o755)
  }
  const listening = (lang = 'ru') => fakeRadio(`radio: online\nlistening: yes\nlanguage: ${lang}`)
  const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
  const bash = (command: string) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] },
  })
  function run(mode: string, entries: object[], extra: object = {}) {
    const transcript = join(dir, 't.jsonl')
    writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join('\n'))
    const r = spawnSync('sh', [HOOK, mode], {
      input: JSON.stringify({ transcript_path: transcript, ...extra }),
      env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir },
      encoding: 'utf8',
    })
    return r.stdout.trim()
  }

  it('is silent when nobody listens', () => {
    fakeRadio('radio: online\nlistening: no\nlanguage: ru')
    expect(run('stop', [user('hi')])).toBe('')
  })

  it('is silent when a summary was said after the user message', () => {
    listening()
    expect(run('stop', [user('hi'), bash('agent-radio say "готово"')])).toBe('')
    expect(run('question', [user('hi'), bash('cd /x && agent-radio play a.mp3')])).toBe('')
  })

  it('blocks the stop when nothing was said', () => {
    listening()
    const out = JSON.parse(run('stop', [user('hi')]))
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('agent-radio say')
    expect(out.reason).toContain('по-русски')
  })

  it('denies the question when nothing was said', () => {
    listening()
    const out = JSON.parse(run('question', [user('hi')]))
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  })

  it('speaks the language of the radio', () => {
    listening('uk')
    expect(JSON.parse(run('stop', [user('hi')])).reason).toContain('українською')
    listening('en')
    expect(JSON.parse(run('stop', [user('hi')])).reason).toContain('in English')
  })

  it('answers in lv and de, and falls back to en for an unknown code', () => {
    listening('lv')
    const lv = JSON.parse(run('stop', [user('hi')])).reason
    expect(lv).toContain('latviešu valodā')
    expect(lv).toContain('AGENT_RADIO_SESSION="<šīs sesijas projekts un loma')
    listening('de')
    const de = JSON.parse(run('stop', [user('hi')])).reason
    expect(de).toContain('auf Deutsch')
    expect(de).toContain('AGENT_RADIO_SESSION="<Projekt und Rolle dieser Sitzung')
    listening('xx')
    expect(JSON.parse(run('stop', [user('hi')])).reason).toContain('in English')
    for (const code of ['et', 'lt', 'sv']) {
      listening(code)
      const reason = JSON.parse(run('question', [user('hi')])).hookSpecificOutput.permissionDecisionReason
      expect(reason).toContain('AGENT_RADIO_SESSION=')
      expect(reason).not.toContain('{action}')
      expect(reason).not.toContain('in English')
    }
  })

  it('does not loop when stop_hook_active', () => {
    listening()
    expect(run('stop', [user('hi')], { stop_hook_active: true })).toBe('')
  })

  it('does not count a mention inside a quoted string', () => {
    listening()
    expect(run('stop', [user('hi'), bash('echo "run agent-radio say later"')])).not.toBe('')
  })

  it('counts only summaries after the last user message', () => {
    listening()
    expect(run('stop', [user('a'), bash('agent-radio say "x"'), user('b')])).not.toBe('')
  })
})

describe('install.sh hook wiring', () => {
  let server: Server
  let url: string
  let home: string
  const settings = () => join(home, '.claude/settings.json')
  const hookCmd = (m: string) => `${join(home, '.local/share/agent-radio/agent-radio-hook.sh')} ${m}`

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

  async function install(env: Record<string, string>) {
    const script = join(home, 'install.sh')
    writeFileSync(script, await (await fetch(`${url}/client/install.sh`)).text())
    await new Promise<void>((done) => {
      const p = spawn('setsid', ['-w', 'sh', script], {
        env: { PATH: process.env.PATH ?? '', HOME: home, AGENT_RADIO_URL: url, AGENT_RADIO_KEY: 'ar_test', ...env },
        stdio: 'ignore',
        timeout: 30_000,
      })
      p.on('close', () => done())
    })
  }
  const read = () => JSON.parse(readFileSync(settings(), 'utf8'))

  it('serves the hook script', async () => {
    const r = await fetch(`${url}/client/agent-radio-hook.sh`)
    expect(r.status).toBe(200)
  })

  it('installs the script but leaves settings.json alone without consent', async () => {
    await install({})
    expect(existsSync(join(home, '.local/share/agent-radio/agent-radio-hook.sh'))).toBe(true)
    expect(existsSync(settings())).toBe(false)
  })

  it('merges both hooks idempotently and keeps existing settings and hooks', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const before = {
      theme: 'dark',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo post' }] }],
      },
    }
    writeFileSync(settings(), JSON.stringify(before))
    await install({ AGENT_RADIO_HOOKS: '1' })
    await install({ AGENT_RADIO_HOOKS: '1' })
    const s = read()
    expect(s.theme).toBe('dark')
    expect(s.hooks.PostToolUse).toEqual(before.hooks.PostToolUse)
    expect(s.hooks.Stop).toHaveLength(2)
    expect(s.hooks.Stop[0]).toEqual(before.hooks.Stop[0])
    expect(s.hooks.Stop[1].hooks[0]).toEqual({ type: 'command', command: hookCmd('stop'), timeout: 10 })
    expect(s.hooks.PreToolUse).toHaveLength(1)
    expect(s.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion')
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe(hookCmd('question'))
    expect(JSON.parse(readFileSync(`${settings()}.agent-radio.bak`, 'utf8'))).toEqual(before)
  })

  it('creates settings.json when missing', async () => {
    await install({ AGENT_RADIO_HOOKS: '1' })
    expect(read().hooks.Stop).toHaveLength(1)
  })

  it('leaves an invalid settings.json untouched', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settings(), '{ not json')
    await install({ AGENT_RADIO_HOOKS: '1' })
    expect(readFileSync(settings(), 'utf8')).toBe('{ not json')
  })
})
