// Preset station health: a few seconds of every stream are decoded with ffmpeg (the same way the engine would play it).
// A preset that fails twice in a row is hidden from users (HIDE_AFTER_FAILS); presets are never deleted automatically.
import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import type { Db } from './db/client'
import { presets } from './db/schema'

export const CHECK_USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20'
export const CHECK_TIMEOUT_MS = 20_000
export const SILENCE_DB = -50
export const HIDE_AFTER_FAILS = 2

// runs ffmpeg for one URL and returns its stderr (what volumedetect prints); throws when ffmpeg fails or times out
export type PresetProbe = (url: string) => Promise<string>

export function ffmpegProbe(ffmpegBin = 'ffmpeg', timeoutMs = CHECK_TIMEOUT_MS): PresetProbe {
  return (url) =>
    new Promise((resolve, reject) => {
      const args = [
        '-nostdin',
        '-hide_banner',
        '-user_agent',
        CHECK_USER_AGENT,
        '-t',
        '5',
        '-i',
        url,
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-',
      ]
      const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      child.stderr.on('data', (d) => {
        err = (err + d.toString()).slice(-20_000)
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('timeout'))
      }, timeoutMs)
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(err)
        else reject(new Error(`ffmpeg exited with ${code}`))
      })
    })
}

// the max_volume (dB) that volumedetect reported, null when there is none
export function parseMaxVolume(output: string): number | null {
  const m = output.match(/max_volume:\s*(-?\d+(?:\.\d+)?|-inf)\s*dB/)
  if (!m) return null
  const v = m[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(m[1])
  return Number.isNaN(v) ? null : v
}

// ok when the stream decoded and is not silent
export async function probeUrl(url: string, probe: PresetProbe): Promise<boolean> {
  try {
    const max = parseMaxVolume(await probe(url))
    return max !== null && max > SILENCE_DB
  } catch {
    return false
  }
}

export async function checkPreset(db: Db, id: string, probe: PresetProbe, now = Date.now()) {
  const row = db.select().from(presets).where(eq(presets.id, id)).get()
  if (!row) return null
  const ok = await probeUrl(row.url, probe)
  return db
    .update(presets)
    .set(ok ? { status: 'ok', failCount: 0, checkedAt: now } : { status: 'fail', failCount: row.failCount + 1, checkedAt: now })
    .where(eq(presets.id, id))
    .returning()
    .get()
}

let running: Promise<void> | null = null

// one pass over every preset, strictly one after another; a pass that is already running is not started twice
export function checkAllPresets(db: Db, probe: PresetProbe): Promise<void> {
  if (running) return running
  const pass = (async () => {
    for (const p of db.select({ id: presets.id }).from(presets).orderBy(presets.position).all()) {
      try {
        await checkPreset(db, p.id, probe)
      } catch (e) {
        console.error('preset check failed:', e instanceof Error ? e.message : e)
      }
    }
  })().finally(() => {
    running = null
  })
  running = pass
  return pass
}

export const visibleToUsers = (p: { failCount: number }) => p.failCount < HIDE_AFTER_FAILS
