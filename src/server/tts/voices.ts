// Static voice catalog of the cloud providers (Piper voices are dynamic, see piper-catalog.ts). A voice key is '<provider>:<provider voice id>'.
export type ProviderId = 'azure' | 'openai' | 'gemini' | 'piper' | 'local'
export const PROVIDER_IDS: ProviderId[] = ['azure', 'piper', 'local', 'openai', 'gemini']

export interface VoiceInfo {
  key: string
  provider: ProviderId
  id: string
  label: string
  // uk | ru | en | multi (piper: the language family of the model)
  lang: string
  // piper only: x_low | low | medium | high
  quality?: string
}

const v = (provider: ProviderId, id: string, label: string, lang: string): VoiceInfo => ({
  key: `${provider}:${id}`,
  provider,
  id,
  label,
  lang,
})

export const VOICES: VoiceInfo[] = [
  v('azure', 'uk-UA-OstapNeural', 'Ostap', 'uk'),
  v('azure', 'uk-UA-PolinaNeural', 'Polina', 'uk'),
  v('azure', 'ru-RU-SvetlanaNeural', 'Svetlana', 'ru'),
  v('azure', 'ru-RU-DmitryNeural', 'Dmitry', 'ru'),
  v('azure', 'en-US-AriaNeural', 'Aria', 'en'),
  v('azure', 'en-GB-RyanNeural', 'Ryan', 'en'),
  ...['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'].map((id) =>
    v('openai', id, id.charAt(0).toUpperCase() + id.slice(1), 'multi'),
  ),
  ...['Kore', 'Puck', 'Charon', 'Zephyr', 'Aoede', 'Fenrir', 'Leda', 'Orus'].map((id) => v('gemini', id, id, 'multi')),
]

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  azure: 'Azure Neural',
  piper: 'Piper',
  local: 'Локальные нейро-голоса',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
}

// Static (cloud) voices only; Piper voices come from the catalog: see TtsRegistry.findVoice / allVoices.
export const findStaticVoice = (key: string) => VOICES.find((x) => x.key === key)

export const PIPER_DEFAULT_BY_LANG: Record<string, string> = {
  uk: 'uk_UA-mykyta-high',
  ru: 'ru_RU-dmitri-medium',
  en: 'en_US-lessac-medium',
}
