import { describe, expect, it } from 'vitest'
import { cleanIcy } from './PlayerBar'

describe('cleanIcy', () => {
  it('drops the lag marker of the engine', () => {
    expect(cleanIcy('Chris de Burgh - Lady in Red [14:32]')).toBe('Chris de Burgh - Lady in Red')
    expect(cleanIcy('Song')).toBe('Song')
    expect(cleanIcy(null)).toBe('')
  })
})
