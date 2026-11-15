import { describe, expect, it } from 'vitest'
import { clockOffset, currentLineIndex, songPositionMs } from './lyrics-sync'

const L = (...ms: (number | null)[]) => ms.map((m) => ({ ms: m }))

describe('currentLineIndex', () => {
  const lines = L(1000, 4000, 9000, 12000)
  it('is -1 before the first line and with no lines', () => {
    expect(currentLineIndex(lines, 0)).toBe(-1)
    expect(currentLineIndex(lines, 999)).toBe(-1)
    expect(currentLineIndex([], 5000)).toBe(-1)
  })
  it('picks the last line that has started', () => {
    expect(currentLineIndex(lines, 1000)).toBe(0)
    expect(currentLineIndex(lines, 3999)).toBe(0)
    expect(currentLineIndex(lines, 4000)).toBe(1)
    expect(currentLineIndex(lines, 11999)).toBe(2)
    expect(currentLineIndex(lines, 999999)).toBe(3)
  })
  it('has no current line when the text has no timing', () => {
    expect(currentLineIndex(L(null, null, null), 5000)).toBe(-1)
  })
  it('ignores untimed lines among timed ones', () => {
    expect(currentLineIndex(L(1000, null, 5000), 6000)).toBe(2)
    expect(currentLineIndex(L(1000, null, 5000), 2000)).toBe(0)
  })
})

describe('clock and position', () => {
  it('estimates the offset from the middle of the round trip', () => {
    // the server says 10_000 at the moment the local clock reads 1_050 on average (sent 1_000, got 1_100)
    expect(clockOffset(10_000, 1000, 1100)).toBe(8950)
  })
  it('subtracts the lag, the default delay and the user correction', () => {
    const base = { nowMs: 100_000, clockOffsetMs: 500, startedAtMs: 90_000, lagS: 2, userOffsetS: 0 }
    expect(songPositionMs(base)).toBe(100_500 - 90_000 - 5000)
    expect(songPositionMs({ ...base, userOffsetS: 1.5 })).toBe(100_500 - 90_000 - 6500)
    expect(songPositionMs({ ...base, userOffsetS: -2 })).toBe(100_500 - 90_000 - 3000)
  })
})
