// Playlist files for the engine: the music library (read-only volume) -> .m3u in the shared volume.
import { mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Config } from './config'
import { HttpError, badRequest } from './lib/http'

const AUDIO = /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav)$/i

export function walkAudio(dir: string, out: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walkAudio(p, out)
    else if (e.isFile() && AUDIO.test(e.name)) out.push(p)
  }
}

// Resolves a path relative to the library root; throws when it would leave the root (.. segments, absolute paths, symlinks out).
export function resolveInside(root: string, rel: string): string {
  if (rel.includes('\0')) throw badRequest('invalid_path', 'Invalid path')
  const base = resolve(root)
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) throw badRequest('invalid_path', 'Path is outside the music library')
  try {
    const real = realpathSync(full)
    const realBase = realpathSync(base)
    if (real !== realBase && !real.startsWith(realBase + sep)) throw badRequest('invalid_path', 'Path is outside the music library')
  } catch (e) {
    if (e instanceof HttpError) throw e
    // not there: the caller deals with a missing file
  }
  return full
}

function writeM3u(config: Config, stationId: string, engineFiles: string[]): string {
  const plDir = join(config.sharedDir, 'playlists')
  mkdirSync(plDir, { recursive: true })
  const tmp = join(plDir, `.${stationId}.m3u.tmp`)
  writeFileSync(tmp, `${engineFiles.join('\n')}\n`, { mode: 0o644 })
  renameSync(tmp, join(plDir, `${stationId}.m3u`))
  return join(config.engineSharedDir, 'playlists', `${stationId}.m3u`)
}

// An explicit track list (paths relative to the library, in play order) -> <shared>/playlists/<stationId>.m3u.
export function writeTrackList(config: Config, stationId: string, relPaths: string[]): string {
  if (relPaths.length === 0) throw badRequest('empty_playlist', 'The playlist has no tracks')
  const root = resolve(config.musicDir)
  const lines = relPaths.map((p) => join(config.engineMusicDir, relative(root, resolveInside(root, p))))
  return writeM3u(config, stationId, lines)
}

// Writes <shared>/playlists/<stationId>.m3u for the folder `dir` (relative to the library, '' = everything) and returns the path the
// engine sees it under.
export function writePlaylist(config: Config, stationId: string, dir: string): string {
  const root = resolve(config.musicDir)
  const base = resolve(root, dir)
  if (base !== root && !base.startsWith(root + sep)) throw badRequest('invalid_dir', 'Folder is outside the music library')
  const files: string[] = []
  try {
    walkAudio(base, files)
  } catch {
    throw badRequest('invalid_dir', 'Folder not found in the music library')
  }
  if (files.length === 0) throw badRequest('empty_playlist', 'No audio files in that folder')
  files.sort()
  const lines = files.map((f) => join(config.engineMusicDir, relative(root, f)))
  return writeM3u(config, stationId, lines)
}
