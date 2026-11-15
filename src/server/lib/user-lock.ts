import { HttpError } from './http'

// At most one slow job (TTS, ffmpeg) per user at a time; a second one is refused with 429 instead of piling up.
export class UserLock {
  private busy = new Set<string>()

  acquire(userId: string): () => void {
    if (this.busy.has(userId)) throw new HttpError(429, 'busy', 'Another message is still being processed', { 'Retry-After': '3' })
    this.busy.add(userId)
    let released = false
    return () => {
      if (released) return
      released = true
      this.busy.delete(userId)
    }
  }
}
