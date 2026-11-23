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
  spokenText?: string | null
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
  settings: { voice: string | null; lang: string; speakSession: boolean; translateMessages: boolean; speechRate: number }
  learn: LearnSettings
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

export interface ControlTokenInfo {
  createdAt: string
  lastUsedAt: string | null
}

export interface LearnSettings {
  mode: boolean
  every: number
  available: boolean
  configured: boolean
  lang: string
  processed: number
  total: number
}
export interface LearnLine {
  ms: number | null
  orig: string
  tr: string | null
}
export interface LearnLyrics {
  status: string
  origLang: string | null
  synced: boolean
  lines: LearnLine[]
}
export interface LearnHook {
  orig: string
  tr: string | null
}
export interface LearnNow {
  serverNowMs: number
  play: { trackId: string; artist: string; title: string; startedAtMs: number | null; state: 'playing' | 'intro' } | null
  lyrics: LearnLyrics | null
  notes: { summary: string; hooks: LearnHook[]; intro: string | null } | null
  skip: boolean
}
export interface LearnArchiveSong {
  trackId: string
  title: string
  artist: string
  lang: string | null
  lastPlayedAt: string
  plays: number
}
export interface LearnArchive {
  songs: LearnArchiveSong[]
  total: number
  all: number
  langs: { lang: string; count: number }[]
  nextCursor: string | null
}
export interface LearnSong {
  trackId: string
  artist: string
  title: string
  plays: number
  lastPlayedAt: string
  skip: boolean
  lang: string | null
  targetLang: string
  summary: string | null
  hooks: LearnHook[]
  intro: string | null
  lyrics: LearnLyrics
  credits: { lyrics: string | null; model: string | null }
}
