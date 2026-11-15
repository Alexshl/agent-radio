// TTS provider interface. Adding azure / openai / gemini later = one more file implementing TtsProvider + a line in tts/index.ts.
export interface TtsRequest {
  text: string
  // provider specific voice id; null = the provider's default for `lang`
  voice: string | null
  // ISO 639-1 code: uk, en, ru, ...
  lang: string
  // speech rate multiplier (1 = normal); providers with `nativeRate` apply it themselves, the service uses ffmpeg atempo for the others
  rate?: number
}

export interface TtsProvider {
  readonly name: string
  // true when synthesize() honours TtsRequest.rate natively
  readonly nativeRate?: boolean
  // Synthesizes into `outBase` + any extension the provider likes (wav, mp3, ...) and returns the file path; ffmpeg reads it afterwards.
  synthesize(req: TtsRequest, outBase: string): Promise<string>
  // optional: fetch heavy assets ahead of the first request
  warmUp?(req: Pick<TtsRequest, 'voice' | 'lang'>): Promise<void>
}
