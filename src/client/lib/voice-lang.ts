// Which voices can speak a summary language. 'multi' voices (OpenAI, Gemini) speak any of them.
export interface LangVoice {
  key: string
  label: string
  provider: string
  lang: string
  quality?: string
}

export const voiceSpeaks = (voiceLang: string, lang: string) => voiceLang === 'multi' || voiceLang === lang

// voices for the picker: the ones that speak `lang`, plus `keep` (the voice already chosen) so the select never loses its value
export const voicesForLang = <V extends LangVoice>(voices: V[], lang: string, keep?: string | null): V[] =>
  voices.filter((v) => voiceSpeaks(v.lang, lang) || v.key === keep)

// the first allowed voice for the language: a voice of exactly that language wins over a multilingual one
export const firstVoiceFor = <V extends LangVoice>(voices: V[], lang: string): V | undefined =>
  voices.find((v) => v.lang === lang) ?? voices.find((v) => v.lang === 'multi')

// the voice in effect does not speak the language: the voice to suggest instead (undefined = nothing to warn about)
export function voiceMismatch<V extends LangVoice>(
  voices: V[],
  current: string | null | undefined,
  lang: string,
): { current: V; suggestion: V | undefined } | undefined {
  const v = voices.find((x) => x.key === current)
  if (!v || voiceSpeaks(v.lang, lang)) return undefined
  return { current: v, suggestion: firstVoiceFor(voices, lang) }
}
