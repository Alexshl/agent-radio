// Diagnostic event log of the web player (what iOS Safari reports around dictation): one JSON line per event, one file per user.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export const DIAG_MAX_BODY = 8 * 1024
export const DIAG_MAX_EVENTS = 100
export const DIAG_MAX_FILE = 1024 * 1024
export const DIAG_TAIL_LINES = 200

export const diagBody = z.object({
  events: z
    .array(
      z.object({
        t: z.number().finite(),
        type: z.string().min(1).max(64),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(DIAG_MAX_EVENTS),
})

const fileOf = (dataDir: string, userId: string) => join(dataDir, 'diag', `${userId.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`)

export function appendDiag(dataDir: string, userId: string, events: z.infer<typeof diagBody>['events'], userAgent: string) {
  if (events.length === 0) return
  const file = fileOf(dataDir, userId)
  mkdirSync(join(dataDir, 'diag'), { recursive: true })
  const receivedAt = Date.now()
  const ua = userAgent.slice(0, 300)
  appendFileSync(file, `${events.map((e) => JSON.stringify({ ...e, receivedAt, ua })).join('\n')}\n`)
  if (statSync(file).size > DIAG_MAX_FILE) {
    // drop the oldest half, starting at a line boundary
    const buf = readFileSync(file)
    const cut = buf.indexOf(10, Math.floor(buf.length / 2))
    writeFileSync(file, cut < 0 ? Buffer.alloc(0) : buf.subarray(cut + 1))
  }
}

export function tailDiag(dataDir: string, userId: string, lines = DIAG_TAIL_LINES): unknown[] {
  const file = fileOf(dataDir, userId)
  if (!existsSync(file)) return []
  const out: unknown[] = []
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lines)) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // a torn line
    }
  }
  return out
}
