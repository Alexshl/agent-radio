// Control client of the liquidsoap engine (harbor HTTP endpoints in liquidsoap/radio.liq).
export type EngineSourceSpec =
  | { type: 'relay'; url: string }
  | { type: 'playlist'; path: string; mode?: 'randomize' | 'normal' }
  // learn mode: songs queued by the app (pushMusic) go first, the playlist plays only while the queue is empty
  | { type: 'queue'; path: string; mode?: 'randomize' | 'normal' }
  | { type: 'silence' }

export interface EngineLevels {
  musicDb: number
  voiceDb: number
  trackDb: number
}

export interface EngineMsgState {
  id: string
  state: 'queued' | 'playing' | 'done'
  // unix seconds, 0 = not yet
  started: number
  ended: number
}

export interface EngineApi {
  list(): Promise<string[]>
  add(id: string, duckDb: number, levels: EngineLevels): Promise<void>
  setSource(id: string, spec: EngineSourceSpec): Promise<void>
  remove(id: string): Promise<void>
  // msgId: the message the clip belongs to; the engine reports when it starts and ends (msgStates)
  push(id: string, path: string, msgId?: string): Promise<void>
  // an uploaded file: the music bed is muted (not ducked) while it plays; voice messages wait for it
  pushTrack(id: string, path: string, msgId?: string): Promise<void>
  // learn mode ("queue" source): a song or a spoken intro for the music queue; amplifyDb levels it (an intro to the voice level)
  pushMusic(id: string, path: string, msgId: string, opts?: { title?: string; amplifyDb?: number }): Promise<void>
  // drops what is queued (not what is playing)
  flushMusic(id: string): Promise<void>
  // how many requests wait in the music queue
  musicQueue(id: string): Promise<number>
  setDuck(id: string, duckDb: number): Promise<void>
  // mix levels in dB (any subset), applied live
  setLevels(id: string, levels: Partial<EngineLevels>): Promise<void>
  restart(): Promise<void>
  // delivery state of the clips pushed with a message id (kept by the engine in memory: an engine restart empties it)
  msgStates(): Promise<EngineMsgState[]>
}

export class EngineClient implements EngineApi {
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string }
    if (!res.ok || json.ok === false) throw new Error(`engine ${path}: ${res.status} ${json.error ?? ''}`.trim())
    return json
  }

  async list(): Promise<string[]> {
    return (await this.call<{ stations: string[] }>('GET', '/station/list')).stations
  }

  async add(id: string, duckDb: number, levels: EngineLevels): Promise<void> {
    await this.call('POST', '/station/add', {
      id,
      duck_db: duckDb,
      music_db: levels.musicDb,
      voice_db: levels.voiceDb,
      track_db: levels.trackDb,
    })
  }

  async setSource(id: string, spec: EngineSourceSpec): Promise<void> {
    await this.call('POST', '/station/set_source', { id, spec })
  }

  async remove(id: string): Promise<void> {
    await this.call('POST', '/station/remove', { id })
  }

  async push(id: string, path: string, msgId?: string): Promise<void> {
    await this.call('POST', '/voice/push', { id, path, msg: msgId })
  }

  async pushTrack(id: string, path: string, msgId?: string): Promise<void> {
    await this.call('POST', '/track/push', { id, path, msg: msgId })
  }

  async pushMusic(id: string, path: string, msgId: string, opts: { title?: string; amplifyDb?: number } = {}): Promise<void> {
    await this.call('POST', '/music/push', { id, path, msg: msgId, title: opts.title, amplify_db: opts.amplifyDb })
  }

  async flushMusic(id: string): Promise<void> {
    await this.call('POST', '/music/flush', { id })
  }

  async musicQueue(id: string): Promise<number> {
    return (await this.call<{ length: number }>('GET', `/music/queue?id=${encodeURIComponent(id)}`)).length
  }

  async setDuck(id: string, duckDb: number): Promise<void> {
    await this.call('POST', '/station/set_duck', { id, duck_db: duckDb })
  }

  async setLevels(id: string, levels: Partial<EngineLevels>): Promise<void> {
    await this.call('POST', '/station/set_levels', { id, music_db: levels.musicDb, voice_db: levels.voiceDb, track_db: levels.trackDb })
  }

  async msgStates(): Promise<EngineMsgState[]> {
    return (await this.call<{ states: EngineMsgState[] }>('GET', '/msg/states')).states
  }

  // the engine exits and docker brings it back; the app re-pushes the stations afterwards (syncEngine)
  async restart(): Promise<void> {
    await this.call('POST', '/engine/restart', {})
  }
}
