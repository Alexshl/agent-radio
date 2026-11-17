// The shared music library: a recursive scan of MUSIC_DIR into the `tracks` table (tags via music-metadata), incremental by mtime + size.
import { statSync } from 'node:fs'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { type AnyColumn, and, eq, inArray, or, sql } from 'drizzle-orm'
import { parseFile } from 'music-metadata'
import type { Config } from './config'
import type { Db } from './db/client'
import { tracks } from './db/schema'
import { badRequest, notFound } from './lib/http'
import { newId } from './lib/ids'
import { resolveInside, walkAudio } from './music'

export interface Tags {
  title: string
  artist: string
  album: string
  durationSec: number
}
export type TagReader = (file: string) => Promise<Tags>

export const readTags: TagReader = async (file) => {
  const fallback = basename(file, extname(file))
  try {
    const m = await parseFile(file, { skipCovers: true })
    return {
      title: m.common.title?.trim() || fallback,
      artist: m.common.artist?.trim() || m.common.albumartist?.trim() || '',
      album: m.common.album?.trim() || '',
      durationSec: Math.round(m.format.duration ?? 0),
    }
  } catch {
    return { title: fallback, artist: '', album: '', durationSec: 0 }
  }
}

export interface ScanResult {
  added: number
  updated: number
  removed: number
  total: number
  at: string
}

export interface FolderNode {
  path: string
  name: string
  depth: number
  count: number
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

// a file changed less than this long ago is left for the next scan (it may still be growing)
export const FRESH_MS = 60_000

export class Library {
  scanning = false
  last: ScanResult | null = null
  // called after every finished scan (folder playlists of the stations are written again)
  afterScan: (() => void) | null = null

  constructor(
    private db: Db,
    private config: Config,
    private read: TagReader = readTags,
    private freshMs = FRESH_MS,
  ) {}

  // Rescans the library. Returns null when a scan is already running.
  async scan(): Promise<ScanResult | null> {
    if (this.scanning) return null
    this.scanning = true
    try {
      const root = resolve(this.config.musicDir)
      const files: string[] = []
      try {
        walkAudio(root, files)
      } catch {
        // missing library folder: everything indexed counts as removed
      }
      const existing = new Map(
        this.db
          .select()
          .from(tracks)
          .all()
          .map((t) => [t.path, t]),
      )
      const seen = new Set<string>()
      let added = 0
      let updated = 0
      for (const f of files) {
        const rel = relative(root, f).split(sep).join('/')
        seen.add(rel)
        let st: ReturnType<typeof statSync>
        try {
          st = statSync(f)
        } catch {
          continue
        }
        const old = existing.get(rel)
        const mtimeMs = Math.floor(st.mtimeMs)
        // still being copied in (a network share, a download): picked up by a later scan, an indexed version stays as is
        if (this.freshMs > 0 && Date.now() - mtimeMs < this.freshMs) continue
        if (old && old.mtimeMs === mtimeMs && old.size === st.size) continue
        const tags = await this.read(f)
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
        const row = { ...tags, dir, size: st.size, mtimeMs }
        if (old) {
          this.db.update(tracks).set(row).where(eq(tracks.id, old.id)).run()
          updated++
        } else {
          // an upload that landed during this scan may have inserted the row already
          this.db
            .insert(tracks)
            .values({ id: newId(), path: rel, ...row })
            .onConflictDoUpdate({ target: tracks.path, set: row })
            .run()
          added++
        }
      }
      const gone = [...existing.values()].filter((t) => !seen.has(t.path)).map((t) => t.id)
      for (let i = 0; i < gone.length; i += 500)
        this.db
          .delete(tracks)
          .where(inArray(tracks.id, gone.slice(i, i + 500)))
          .run()
      this.last = { added, updated, removed: gone.length, total: this.count(), at: new Date().toISOString() }
      try {
        this.afterScan?.()
      } catch (e) {
        console.error('after scan failed:', e instanceof Error ? e.message : e)
      }
      return this.last
    } finally {
      this.scanning = false
    }
  }

  readTags(file: string): Promise<Tags> {
    return this.read(file)
  }

  // Indexes a file the app has just put into the library itself (an upload); the scan that follows finds it up to date.
  upsertUploaded(file: string, tags: Tags, uploadedBy: string, sha256: string) {
    const root = resolve(this.config.musicDir)
    const rel = relative(root, file).split(sep).join('/')
    const st = statSync(file)
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    const row = { ...tags, dir, size: st.size, mtimeMs: Math.floor(st.mtimeMs), uploadedBy, sha256 }
    this.db
      .insert(tracks)
      .values({ id: newId(), path: rel, ...row })
      .onConflictDoUpdate({ target: tracks.path, set: row })
      .run()
    const saved = this.db.select().from(tracks).where(eq(tracks.path, rel)).get()
    if (!saved) throw new Error('track row missing')
    return saved
  }

  count(): number {
    return this.db.select({ n: sql<number>`count(*)` }).from(tracks).get()?.n ?? 0
  }

  totalSize(): number {
    return this.db.select({ n: sql<number>`coalesce(sum(size), 0)` }).from(tracks).get()?.n ?? 0
  }

  // Folder tree with cumulative track counts, depth first.
  folders(): FolderNode[] {
    const rows = this.db.select({ dir: tracks.dir, n: sql<number>`count(*)` }).from(tracks).groupBy(tracks.dir).all()
    const counts = new Map<string, number>()
    for (const r of rows) {
      if (!r.dir) continue
      const parts = r.dir.split('/')
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join('/')
        counts.set(p, (counts.get(p) ?? 0) + r.n)
      }
    }
    return [...counts.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((path) => ({
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
        depth: path.split('/').length - 1,
        count: counts.get(path) ?? 0,
      }))
  }

  private where(p: { dir?: string; q?: string }) {
    const conds = []
    if (p.dir) {
      // validated: only folders inside the library
      resolveInside(this.config.musicDir, p.dir)
      conds.push(or(eq(tracks.dir, p.dir), sql`${tracks.dir} like ${`${escapeLike(p.dir)}/%`} escape '\\'`))
    }
    const q = p.q?.trim().toLowerCase()
    if (q) {
      const pat = `%${escapeLike(q)}%`
      const l = (c: AnyColumn) => sql`lower(${c}) like ${pat} escape '\\'`
      conds.push(or(l(tracks.title), l(tracks.artist), l(tracks.album)))
    }
    return conds.length ? and(...conds) : undefined
  }

  // Every track of a folder (recursive) / search, for "add all to the playlist": id and the fields the draft list shows. Capped.
  matching(p: { dir?: string; q?: string }, cap = 5000) {
    const where = this.where(p)
    const rows = this.db
      .select({
        id: tracks.id,
        path: tracks.path,
        dir: tracks.dir,
        title: tracks.title,
        artist: tracks.artist,
        album: tracks.album,
        durationSec: tracks.durationSec,
      })
      .from(tracks)
      .where(where)
      .orderBy(tracks.path)
      .limit(cap + 1)
      .all()
    return { tracks: rows.slice(0, cap), truncated: rows.length > cap }
  }

  search(p: { dir?: string; q?: string; limit?: number; offset?: number }) {
    const where = this.where(p)
    const limit = Math.min(Math.max(p.limit ?? 100, 1), 500)
    const rows = this.db
      .select()
      .from(tracks)
      .where(where)
      .orderBy(tracks.artist, tracks.album, tracks.title)
      .limit(limit)
      .offset(Math.max(p.offset ?? 0, 0))
      .all()
    const total = this.db.select({ n: sql<number>`count(*)` }).from(tracks).where(where).get()?.n ?? 0
    return { tracks: rows.map(({ mtimeMs: _m, size: _s, ...t }) => t), total }
  }

  // Absolute file of a track for streaming; throws not_found / invalid_path.
  fileOf(trackId: string): { file: string; size: number } {
    const t = this.db.select().from(tracks).where(eq(tracks.id, trackId)).get()
    if (!t) throw notFound('Track not found')
    const file = resolveInside(this.config.musicDir, t.path)
    try {
      return { file, size: statSync(file).size }
    } catch {
      throw notFound('File is gone')
    }
  }
}

export function assertTrackIds(db: Db, ids: string[]) {
  if (ids.length === 0) return
  const found = new Set(
    db
      .select({ id: tracks.id })
      .from(tracks)
      .where(inArray(tracks.id, ids))
      .all()
      .map((r) => r.id),
  )
  if (ids.some((id) => !found.has(id))) throw badRequest('unknown_track', 'Some tracks are not in the library')
}
