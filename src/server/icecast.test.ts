import { describe, expect, it } from 'vitest'
import { IcecastStats } from './icecast'

const UA = 'Mozilla/5.0 (iPhone) Safari/604.1 pid=aaaaaaaaaaaaaaaa'
const listener = (id: number, age: number) =>
  `<listener><IP>1.1.1.1</IP><UserAgent>${UA}</UserAgent><Connected>${age}</Connected><ID>${id}</ID></listener>`

function make(ages: number[]) {
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    calls.push(url)
    if (url.includes('status-json')) {
      return new Response(JSON.stringify({ icestats: { source: { listenurl: 'http://h/x', listeners: ages.length } } }))
    }
    if (url.includes('listclients'))
      return new Response(`<icestats><source mount="/x">${ages.map((a, i) => listener(i + 1, a)).join('')}</source></icestats>`)
    return new Response('<iceresponse><return>1</return></iceresponse>')
  }) as unknown as typeof fetch
  return { calls, ice: new IcecastStats('http://ice', fetchImpl, { user: 'admin', password: 'p' }) }
}

describe('IcecastStats players', () => {
  it('listeners de-duplicates the connections of one player', async () => {
    expect(await make([226, 225, 50, 49, 4, 3]).ice.listeners('x')).toBe(1)
  })
  it('reapGhosts kills the old connections through killclient', async () => {
    const { ice, calls } = make([236, 235, 60, 59, 14, 13])
    expect(await ice.reapGhosts('x')).toBe(4)
    expect(calls.filter((u) => u.includes('killclient'))).toEqual([1, 2, 3, 4].map((i) => `http://ice/admin/killclient?mount=/x&id=${i}`))
  })
})
