import { describe, expect, it } from 'vitest'
import { countPlayers, ghostIds, type IcecastClient, MONITOR_UA, parseListClients, pidOf } from './players'

const SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7.9 Mobile/15E148 Safari/604.1'
const c = (id: number, connected: number, ua = SAFARI): IcecastClient => ({ id: String(id), userAgent: ua, connected })

describe('pidOf', () => {
  it('reads the pid the front appends; the last suffix only', () => {
    expect(pidOf(`${SAFARI} pid=0123456789abcdef`)).toBe('0123456789abcdef')
    expect(pidOf(`${SAFARI} pid=`)).toBeNull()
    expect(pidOf(SAFARI)).toBeNull()
    expect(pidOf('x pid=aaaaaaaa pid=bbbbbbbb')).toBe('bbbbbbbb')
    expect(pidOf('x pid=aaaaaaaa y')).toBeNull()
  })
})

describe('countPlayers', () => {
  const p1 = `${SAFARI} pid=aaaaaaaaaaaaaaaa`
  it('one Safari tab with 6 connections of 3 starts is 1 player', () => {
    const six = [226, 225, 50, 49, 4, 3].map((age, i) => c(i, age, p1))
    expect(countPlayers(six)).toBe(1)
  })
  it('two devices with the same UA but different pids are 2 players', () => {
    const p2 = `${SAFARI} pid=bbbbbbbbbbbbbbbb`
    expect(countPlayers([c(1, 100, p1), c(2, 99, p1), c(3, 40, p2), c(4, 39, p2)])).toBe(2)
  })
  it('without a pid the User-Agent is the key; different UAs are different players', () => {
    expect(countPlayers([226, 225, 50, 49, 4, 3].map((a, i) => c(i, a)))).toBe(1)
    expect(countPlayers([c(1, 5), c(2, 5, 'Chrome')])).toBe(2)
  })
  it('the watchdog monitor is not a player', () => {
    expect(countPlayers([c(1, 5, p1), c(2, 5, `${MONITOR_UA}/1 pid=`)])).toBe(1)
    expect(countPlayers([])).toBe(0)
  })
})

describe('ghostIds', () => {
  const p1 = `${SAFARI} pid=aaaaaaaaaaaaaaaa`
  it('kills everything older than the newest start of a pid, keeps the start pair', () => {
    const six = [226, 225, 50, 49, 4, 3].map((age, i) => c(i, age, p1))
    // newest is 3 s old: not established yet, nothing is killed
    expect(ghostIds(six)).toEqual([])
    const later = [236, 235, 60, 59, 14, 13].map((age, i) => c(i, age, p1))
    expect(ghostIds(later)).toEqual(['0', '1', '2', '3'])
  })
  it('never touches pid-less connections, the monitor or another pid', () => {
    const p2 = `${SAFARI} pid=bbbbbbbbbbbbbbbb`
    expect(ghostIds([c(1, 300), c(2, 10), c(3, 300, `${MONITOR_UA} pid=aaaaaaaaaaaaaaaa`), c(4, 300, p2), c(5, 10, p1)])).toEqual([])
  })
})

describe('parseListClients', () => {
  it('reads icecast 2.4 listclients', () => {
    const xml = `<?xml version="1.0"?><icestats><source mount="/x"><Listeners>2</Listeners>
<listener><IP>1.2.3.4</IP><UserAgent>A &amp; B pid=aaaaaaaa</UserAgent><Connected>332</Connected><ID>7312</ID></listener>
<listener><IP>1.2.3.4</IP><UserAgent></UserAgent><Connected>5</Connected><ID>7313</ID></listener></source></icestats>`
    expect(parseListClients(xml)).toEqual([
      { id: '7312', userAgent: 'A & B pid=aaaaaaaa', connected: 332 },
      { id: '7313', userAgent: '', connected: 5 },
    ])
  })
})
