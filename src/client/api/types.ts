export type Role = 'admin' | 'user'
export interface Me {
  id: string
  email: string
  name: string
  role: Role
  lang: string
}
export type Source =
  | { type: 'relay'; url: string; name?: string }
  | { type: 'playlist'; dir: string; order?: 'shuffle' | 'ordered' }
  | { type: 'userplaylist'; playlistId: string }
  | { type: 'silence' }
export interface Preset {
  id: string
  name: string
  description: string
  url: string
}
export interface PlaylistSummary {
  id: string
  name: string
  orderMode: 'shuffle' | 'ordered'
  count: number
  durationSec: number
}
export interface Voice {
  key: string
  provider: string
  id: string
  label: string
  lang: string
  quality?: string
}
export interface HistoryMessage {
  id: string
  session: string
  host: string | null
  text: string
  status: 'aired' | 'skipped' | 'failed' | 'queued' | 'waiting' | 'onair' | 'playing'
  type: 'voice' | 'audio'
  durationSec: number | null
  hasClip: boolean
  note: string | null
  createdAt: string
}
export interface Radio {
  user: { name: string; email: string; role: Role }
  station: {
    id: string
    source: Source
    duckDb: number
    musicGainDb: number
    voiceGainDb: number
    trackGainDb: number
    chime: boolean
    listenUrl: string
    m3uUrl: string
    webStreamPath: string
  }
  settings: { voice: string | null; lang: 'uk' | 'ru' | 'en'; speakSession: boolean; speechRate: number }
  allowOwnUrls: boolean
  defaultVoice: string
  presets: Preset[]
  playlists: PlaylistSummary[]
  voices: Voice[]
  messages: HistoryMessage[]
  keys: { count: number; lastUsedAt: string | null; lastName: string | null }
}
export interface Live {
  up: boolean
  listeners: number
  title: string | null
  file: boolean
}
export interface Track {
  id: string
  path: string
  dir: string
  title: string
  artist: string
  album: string
  durationSec: number
}
export interface ApiKey {
  id: string
  name: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
  lastSession: string | null
  revokedAt: string | null
}

export interface ReplayResult {
  status: 'aired' | 'waiting' | 'skipped'
  listeners: number
  ids: string[]
}
