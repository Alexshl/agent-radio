import type { Config } from './config'
import type { Db } from './db/client'
import type { EngineApi } from './engine/client'
import type { IcecastApi } from './icecast'
import { Airing } from './airing'
import { Delivery } from './delivery'
import { ListenerTracker } from './listeners'
import { Library } from './library'
import { RateLimiter } from './lib/rate-limit'
import { SecretStore, getAppSecret } from './lib/secrets'
import { UserLock } from './lib/user-lock'
import { type Resolver, type Transport, defaultResolver, nodeTransport } from './lib/safe-fetch'
import { FfmpegMedia, type MediaTools } from './media'
import { TtsRegistry, type TtsService } from './tts'

// What the request handlers work with. The first six are required; the rest has defaults (see withDefaults) and is passed in tests.
export interface Deps {
  db: Db
  config: Config
  engine: EngineApi
  icecast: IcecastApi
  tts: Pick<TtsService, 'makeClip'> & Partial<Pick<TtsService, 'synthesize'>>
  limiter: RateLimiter
  authLimiter?: RateLimiter
  media?: MediaTools
  library?: Library
  registry?: TtsRegistry
  airing?: Airing
  fetchImpl?: typeof fetch
  // SSRF-safe fetching of user-provided stream URLs (injectable for tests)
  resolver?: Resolver
  transport?: Transport
  // 10 stream-address checks per minute per user
  checkLimiter?: RateLimiter
  // one spoken message / uploaded file in flight per user
  userLock?: UserLock
  // recent-listener grace (lastListenerSeenAt) and the confirmation of what was pushed to the engine
  listeners?: ListenerTracker
  delivery?: Delivery
}

export type FullDeps = Required<Deps>

export function withDefaults(d: Deps): FullDeps {
  const airing = d.airing ?? new Airing()
  const listeners = d.listeners ?? new ListenerTracker(d.db, d.icecast)
  const secrets = new SecretStore(d.db, () => getAppSecret(d.config))
  return {
    ...d,
    // 10 login attempts per IP + email per 15 minutes
    authLimiter: d.authLimiter ?? new RateLimiter(10, 15 * 60_000),
    media: d.media ?? new FfmpegMedia(d.config.ffmpegBin, d.config.ffprobeBin),
    library: d.library ?? new Library(d.db, d.config),
    registry: d.registry ?? new TtsRegistry(d.db, d.config, secrets, d.fetchImpl),
    airing,
    listeners,
    delivery: d.delivery ?? new Delivery({ db: d.db, config: d.config, engine: d.engine, icecast: d.icecast, listeners, airing }),
    fetchImpl: d.fetchImpl ?? fetch,
    resolver: d.resolver ?? defaultResolver,
    transport: d.transport ?? nodeTransport,
    checkLimiter: d.checkLimiter ?? new RateLimiter(10),
    userLock: d.userLock ?? new UserLock(),
  }
}
