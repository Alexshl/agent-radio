// scripts/watchdog.sh: failure counting, alert after 2 consecutive failures, rate limit, "recovered", healing (dry), --test-alert. Uses --simulate.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve('scripts/watchdog.sh')
let dir: string
let alerts: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ar-wd-'))
  alerts = join(dir, 'alerts.txt')
})

function pass(sim: string[], opts: { now?: number; env?: Record<string, string>; args?: string[] } = {}) {
  const r = spawnSync('bash', [SCRIPT, ...(opts.args ?? ['--simulate', sim.join(',')])], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      WATCHDOG_STATE_DIR: join(dir, 'state'),
      WATCHDOG_ENV_FILE: join(dir, 'none.env'),
      WATCHDOG_ALERT_CMD: `printf '%s\\n' "$WATCHDOG_MESSAGE" >> ${alerts}`,
      WATCHDOG_NOW: String(opts.now ?? 1_000_000),
      WATCHDOG_TTS_EVERY: '999999999',
      ...opts.env,
    },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout + r.stderr }
}
const sent = () => (existsSync(alerts) ? readFileSync(alerts, 'utf8').trim().split('\n').filter(Boolean) : [])

describe('watchdog', () => {
  it('everything fine: exit 0, no alert', () => {
    const r = pass(['front=ok', 'app=ok', 'engine=ok', 'stream=ok'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('all checks passed')
    expect(sent()).toEqual([])
  })

  it('alerts only after 2 consecutive failures, heals, then is rate limited to one per 30 minutes', () => {
    expect(pass(['app=fail']).code).toBe(1)
    expect(sent()).toEqual([])
    const second = pass(['app=fail'], { now: 1_000_060 })
    expect(second.out).toContain('would run: docker compose -p agent-radio restart app')
    expect(sent()).toHaveLength(1)
    expect(sent()[0]).toMatch(/PROBLEM: app failed 2 times in a row; restarted app/)
    pass(['app=fail'], { now: 1_000_120 })
    pass(['app=fail'], { now: 1_000_180 })
    expect(sent()).toHaveLength(1)
    pass(['app=fail'], { now: 1_000_060 + 1800 })
    expect(sent()).toHaveLength(2)
  })

  it('a single failed pass between good ones never alerts', () => {
    pass(['stream=fail'])
    pass(['stream=ok'], { now: 1_000_060 })
    pass(['stream=fail'], { now: 1_000_120 })
    expect(sent()).toEqual([])
  })

  it('sends "recovered" once when the problem clears', () => {
    pass(['engine=fail'])
    pass(['engine=fail'], { now: 1_000_060 })
    expect(pass(['engine=ok'], { now: 1_000_120 }).code).toBe(0)
    expect(sent()).toHaveLength(2)
    expect(sent()[1]).toMatch(/RECOVERED: engine is healthy again/)
    pass(['engine=ok'], { now: 1_000_180 })
    expect(sent()).toHaveLength(2)
  })

  it('problems are tracked separately', () => {
    pass(['stream=fail', 'engine=fail'])
    pass(['stream=fail', 'engine=fail'], { now: 1_000_060 })
    expect(sent()).toHaveLength(2)
    expect(sent().some((m) => m.includes('PROBLEM: stream'))).toBe(true)
    expect(sent().some((m) => m.includes('PROBLEM: engine'))).toBe(true)
  })

  it('a down front skips the checks that go through it and heals the front', () => {
    pass(['front=fail', 'app=fail'])
    const r = pass(['front=fail', 'app=fail'], { now: 1_000_060 })
    expect(r.out).toContain('restart front')
    expect(r.out).toContain('skipped')
    expect(sent()).toHaveLength(1)
    expect(sent()[0]).toContain('PROBLEM: front')
  })

  it('stream trouble escalates: liquidsoap first, then icecast, then the front', () => {
    const t = (n: number) => 1_000_000 + n * 400
    pass(['stream=fail'], { now: t(0) })
    expect(pass(['stream=fail'], { now: t(1) }).out).toContain('restart liquidsoap')
    expect(pass(['stream=fail'], { now: t(2) }).out).toContain('restart icecast')
    expect(pass(['stream=fail'], { now: t(3) }).out).toContain('restart front')
  })

  it('the alert text carries the project; --test-alert sends one and exits', () => {
    const r = pass([], { args: ['--test-alert'], env: { WATCHDOG_PROJECT: 'agent-radio-staging' } })
    expect(r.code).toBe(0)
    expect(sent()[0]).toContain('agent-radio-staging')
    expect(sent()[0]).toContain('test alert')
  })

  it('--dry-run (real checks) runs no alert command and restarts nothing', () => {
    const r = pass([], {
      args: ['--dry-run'],
      env: { WATCHDOG_BASE_URL: 'http://127.0.0.1:9', WATCHDOG_FAILS: '1' },
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain('front check failed')
    expect(r.out).toContain('dry run, would')
    expect(sent()).toEqual([])
  })

  it('without WATCHDOG_ALERT_CMD the alert is only logged', () => {
    pass(['app=fail'], { env: { WATCHDOG_ALERT_CMD: '' } })
    const r = pass(['app=fail'], { now: 1_000_060, env: { WATCHDOG_ALERT_CMD: '' } })
    expect(r.out).toContain('ALERT (no WATCHDOG_ALERT_CMD set)')
  })
})
