import { HttpError } from './http'

// Fixed-window counter in memory (one app process). `limit` hits per `windowMs` per key.
export class RateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>()

  constructor(
    private limit: number,
    private windowMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  check(key: string): void {
    const t = this.now()
    const h = this.hits.get(key)
    if (!h || t - h.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 })
      if (this.hits.size > 10_000) this.sweep(t)
      return
    }
    h.count++
    if (h.count > this.limit) {
      const retry = Math.max(1, Math.ceil((h.windowStart + this.windowMs - t) / 1000))
      throw new HttpError(429, 'rate_limited', 'Too many requests, please try again in a minute', { 'Retry-After': String(retry) })
    }
  }

  private sweep(t: number) {
    for (const [k, h] of this.hits) if (t - h.windowStart >= this.windowMs) this.hits.delete(k)
  }
}
