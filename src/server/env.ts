import type { AuthedKey } from './lib/api-keys'
import type { UserRow } from './lib/auth'

// auth: set by the API key middleware (agent routes); user: set by the session middleware (browser routes)
export type AppEnv = { Variables: { auth: AuthedKey; user: UserRow } }
