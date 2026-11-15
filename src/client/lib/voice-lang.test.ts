import { describe, expect, it } from 'vitest'
import { firstVoiceFor, voiceMismatch, voiceSpeaks, voicesForLang } from './voice-lang'

const v = (key: string, lang: string) => ({ key, label: key, provider: key.split(':')[0] ?? '', lang })
const voices = [
  v('local:silero/xenia', 'ru'),
  v('piper:uk_UA-mykyta-high', 'uk'),
  v('openai:alloy', 'multi'),
  v('piper:lv_LV-aivars-medium', 'lv'),
  v('piper:de_DE-thorsten-medium', 'de'),
]

describe('voice language filter', () => {
  it('multilingual voices speak everything, others only their language', () => {
    expect(voiceSpeaks('multi', 'sv')).toBe(true)
    expect(voiceSpeaks('lv', 'lv')).toBe(true)
    expect(voiceSpeaks('ru', 'lv')).toBe(false)
  })

  it('offers the voices of the language plus multilingual ones, and keeps the chosen voice', () => {
    expect(voicesForLang(voices, 'lv').map((x) => x.key)).toEqual(['openai:alloy', 'piper:lv_LV-aivars-medium'])
    expect(voicesForLang(voices, 'lv', 'local:silero/xenia').map((x) => x.key)).toContain('local:silero/xenia')
    expect(voicesForLang(voices, 'sv').map((x) => x.key)).toEqual(['openai:alloy'])
  })

  it('suggests the first voice of exactly that language, else a multilingual one', () => {
    expect(firstVoiceFor(voices, 'de')?.key).toBe('piper:de_DE-thorsten-medium')
    expect(firstVoiceFor(voices, 'sv')?.key).toBe('openai:alloy')
    expect(firstVoiceFor(voices.slice(0, 2), 'sv')).toBeUndefined()
  })

  it('warns when the voice in effect cannot speak the language', () => {
    const m = voiceMismatch(voices, 'local:silero/xenia', 'lv')
    expect(m?.current.key).toBe('local:silero/xenia')
    expect(m?.suggestion?.key).toBe('piper:lv_LV-aivars-medium')
    expect(voiceMismatch(voices, 'local:silero/xenia', 'ru')).toBeUndefined()
    expect(voiceMismatch(voices, 'openai:alloy', 'lv')).toBeUndefined()
    expect(voiceMismatch(voices, 'unknown', 'lv')).toBeUndefined()
  })
})
