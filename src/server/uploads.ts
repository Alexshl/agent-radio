// Music uploaded through the web UI: validation (ffprobe), a tidy place in MUSIC_DIR/uploads/<artist>/<album>/, duplicates, per-user quota.
// Deleted tracks are moved to MUSIC_DIR/.trash (the scanner skips dot folders), never removed.
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, mkdirSync, renameSync, rmSync, rmdirSync, statSync, statfsSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import type { FullDeps } from './deps'
import { tracks } from './db/schema'
import { HttpError, badRequest, notFound } from './lib/http'
import { getSetting } from './lib/settings'
import { resolveInside } from './music'
import type { UserRow } from './lib/auth'

export const UPLOAD_EXT = new Set(['.mp3', '.flac', '.ogg', '.opus', '.m4a', '.wav'])
// below the 100 MB request limit of Cloudflare
export const UPLOAD_MAX_MB = 95
const MB = 1024 * 1024
// the disk keeps this much free after an upload
const DISK_RESERVE = 100 * MB

export const INCOMING_DIR = '.incoming'
export const TRASH_DIR = '.trash'

// One path segment from a tag or a file name: no separators or control characters, no leading dots (never '.' / '..'), bounded length.
export function sanitizeSegment(raw: string, fallback: string, max = 80): string {
  const clean = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, max)
    .trim()
  return clean || fallback
}

export function diskSpace(dir: string): { freeBytes: number; totalBytes: number } | null {
  try {
    const s = statfsSync(dir)
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }
  } catch {
    return null
  }
}

export function uploadedBytes(deps: Pick<FullDeps, 'db'>, userId: string): number {
  return (
    deps.db
      .select({ n: sql<number>`coalesce(sum(${tracks.size}), 0)` })
      .from(tracks)
      .where(eq(tracks.uploadedBy, userId))
      .get()?.n ?? 0
  )
}

export function uploadPolicy(deps: Pick<FullDeps, 'db'>, user: Pick<UserRow, 'id' | 'role'>) {
  const admin = user.role === 'admin'
  const allowed = admin || getSetting(deps.db, 'allowUserUploads')
  return {
    allowed,
    maxFileMb: UPLOAD_MAX_MB,
    // the admin has no quota
    quotaBytes: admin ? null : getSetting(deps.db, 'uploadQuotaMb') * MB,
    usedBytes: uploadedBytes(deps, user.id),
    extensions: [...UPLOAD_EXT].map((e) => e.slice(1)),
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const h = createHash('sha256')
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolveHash(h.digest('hex')))
  })
}

// A free file name next to `name` ("x.mp3", "x (2).mp3", ...).
function freeName(dir: string, name: string): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = name
  for (let i = 2; existsSync(join(dir, candidate)); i++) candidate = `${stem} (${i})${ext}`
  return candidate
}

export function assertMayUpload(deps: Pick<FullDeps, 'db'>, user: Pick<UserRow, 'id' | 'role'>) {
  if (!uploadPolicy(deps, user).allowed) throw new HttpError(403, 'uploads_disabled', 'Uploading music is disabled by the administrator')
}

export function assertQuota(deps: Pick<FullDeps, 'db'>, user: Pick<UserRow, 'id' | 'role'>, incomingBytes: number) {
  const p = uploadPolicy(deps, user)
  if (p.quotaBytes !== null && p.usedBytes + incomingBytes > p.quotaBytes)
    throw new HttpError(413, 'quota_exceeded', 'Upload quota exceeded')
}

export interface Ingested {
  id: string
  title: string
  artist: string
  album: string
  path: string
}

// Validates a received temp file and moves it into the library. Always removes `tmp` (or moves it).
export async function ingestFile(deps: FullDeps, user: Pick<UserRow, 'id' | 'role'>, tmp: string, originalName: string): Promise<Ingested> {
  const { db, config, media, library } = deps
  try {
    const size = statSync(tmp).size
    if (size === 0) throw badRequest('no_audio', 'The file is empty')
    assertQuota(deps, user, size)
    const disk = diskSpace(config.musicDir)
    if (disk && disk.freeBytes - size < DISK_RESERVE) throw new HttpError(507, 'disk_full', 'Not enough free disk space')

    try {
      const info = await media.probe(tmp)
      if (!info.hasAudio || !(info.durationSec > 0)) throw badRequest('no_audio', 'The file has no audio')
    } catch (e) {
      if (e instanceof HttpError) throw e
      throw new HttpError(415, 'unsupported_type', 'Could not read this file as audio')
    }

    const hash = await sha256File(tmp)
    // same size and same hash = the same file (hashes of older files are computed on demand and kept)
    const sameSize = db.select().from(tracks).where(eq(tracks.size, size)).all()
    for (const t of sameSize) {
      let h = t.sha256
      if (!h) {
        try {
          h = await sha256File(resolveInside(config.musicDir, t.path))
        } catch {
          continue
        }
        db.update(tracks).set({ sha256: h }).where(eq(tracks.id, t.id)).run()
      }
      if (h === hash) throw new HttpError(409, 'duplicate', `Already in the library: ${t.title}`)
    }

    const tags = await library.readTags(tmp)
    const ext = extname(originalName).toLowerCase()
    const artist = sanitizeSegment(tags.artist, 'Unknown artist')
    const album = sanitizeSegment(tags.album, 'Singles')
    const stem = sanitizeSegment(basename(originalName, extname(originalName)), sanitizeSegment(tags.title, 'track'), 120)
    const root = resolve(config.musicDir)
    const dir = join(root, 'uploads', artist, album)
    const name = freeName(dir, `${stem}${ext}`)
    const dest = join(dir, name)
    // belt and braces: whatever the tags said, the destination is inside the library
    if (!resolve(dest).startsWith(join(root, 'uploads') + sep)) throw badRequest('invalid_path', 'Invalid file name')
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    resolveInside(root, relative(root, dest))
    renameSync(tmp, dest)
    // the engine reads the library with another user id
    chmodSync(dest, 0o644)
    const row = library.upsertUploaded(dest, tags, user.id, hash)
    // the library index catches up with anything else that changed (a no-op for files it already knows)
    void library.scan().catch((e) => console.error('library scan failed:', e instanceof Error ? e.message : e))
    return { id: row.id, title: row.title, artist: row.artist, album: row.album, path: row.path }
  } finally {
    rmSync(tmp, { force: true })
  }
}

// Moves the track's file to MUSIC_DIR/.trash and drops it from the index (and from playlists, by the foreign key).
export function trashTrack(deps: Pick<FullDeps, 'db' | 'config'>, id: string): void {
  const { db, config } = deps
  const t = db.select().from(tracks).where(eq(tracks.id, id)).get()
  if (!t) throw notFound('Track not found')
  const file = resolveInside(config.musicDir, t.path)
  if (existsSync(file)) {
    const trash = join(resolve(config.musicDir), TRASH_DIR)
    mkdirSync(trash, { recursive: true, mode: 0o755 })
    renameSync(file, join(trash, `${Date.now()}-${t.id.slice(0, 8)}-${sanitizeSegment(basename(file), 'track', 120)}`))
  }
  db.delete(tracks)
    .where(and(eq(tracks.id, id)))
    .run()
  // an upload folder that became empty goes away (rmdir only removes empty ones)
  for (let d = dirname(file); d.startsWith(join(resolve(config.musicDir), 'uploads') + sep); d = dirname(d)) {
    try {
      rmdirSync(d)
    } catch {
      break
    }
  }
}
