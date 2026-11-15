import { type Strings, ru } from './ru'

// The active dictionary (Russian only for now).
export const S: Strings = ru
export function errorText(code: string | undefined, fallback?: string): string {
  return (code && S.common.errors[code]) || fallback || S.common.error
}
