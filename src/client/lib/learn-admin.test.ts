import { describe, expect, it } from 'vitest'
import { bulkPercent, mergeSongs, noteLangs, placeholderChip } from './learn-admin'

describe('learn admin helpers', () => {
  it('bulkPercent counts done and failed, caps at 100', () => {
    expect(bulkPercent({ total: 0, done: 0, failed: 0 })).toBe(0)
    expect(bulkPercent({ total: 10, done: 3, failed: 1 })).toBe(40)
    expect(bulkPercent({ total: 2, done: 3, failed: 1 })).toBe(100)
  })
  it('placeholderChip shows sections as opening tags', () => {
    expect(placeholderChip('targetCode')).toBe('{{targetCode}}')
    expect(placeholderChip('#lyrics ... /lyrics')).toBe('{{#lyrics}}')
    expect(placeholderChip('^lyrics ... /lyrics')).toBe('{{^lyrics}}')
  })
  it('mergeSongs drops duplicates, noteLangs joins', () => {
    expect(
      mergeSongs([
        [{ trackId: 'a' }, { trackId: 'b' }],
        [{ trackId: 'b' }, { trackId: 'c' }],
      ]).map((s) => s.trackId),
    ).toEqual(['a', 'b', 'c'])
    expect(noteLangs([{ lang: 'ru' }, { lang: 'uk' }])).toBe('ru, uk')
  })
})
