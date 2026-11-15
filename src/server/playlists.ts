// Per-user playlists of library tracks.
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from './db/client'
import { playlistTracks, playlists, tracks } from './db/schema'
import { assertTrackIds } from './library'
import { notFound } from './lib/http'
import { newId, nowIso } from './lib/ids'

export const playlistBody = z.object({
  name: z.string().trim().min(1).max(120),
  orderMode: z.enum(['shuffle', 'ordered']).default('shuffle'),
  trackIds: z.array(z.string().max(100)).max(5000),
})
export type PlaylistInput = z.infer<typeof playlistBody>

export function listPlaylists(db: Db, userId: string) {
  return db
    .select({
      id: playlists.id,
      name: playlists.name,
      orderMode: playlists.orderMode,
      count: sql<number>`count(${playlistTracks.trackId})`,
      durationSec: sql<number>`coalesce(sum(${tracks.durationSec}), 0)`,
    })
    .from(playlists)
    .leftJoin(playlistTracks, eq(playlistTracks.playlistId, playlists.id))
    .leftJoin(tracks, eq(tracks.id, playlistTracks.trackId))
    .where(eq(playlists.userId, userId))
    .groupBy(playlists.id)
    .orderBy(asc(playlists.createdAt))
    .all()
}

export function getPlaylist(db: Db, userId: string, id: string) {
  const pl = db
    .select()
    .from(playlists)
    .where(and(eq(playlists.id, id), eq(playlists.userId, userId)))
    .get()
  if (!pl) throw notFound('Playlist not found')
  const items = db
    .select({
      id: tracks.id,
      path: tracks.path,
      title: tracks.title,
      artist: tracks.artist,
      album: tracks.album,
      durationSec: tracks.durationSec,
    })
    .from(playlistTracks)
    .innerJoin(tracks, eq(tracks.id, playlistTracks.trackId))
    .where(eq(playlistTracks.playlistId, id))
    .orderBy(asc(playlistTracks.position))
    .all()
  return { id: pl.id, name: pl.name, orderMode: pl.orderMode, tracks: items }
}

function writeTracks(db: Db, playlistId: string, trackIds: string[]) {
  db.delete(playlistTracks).where(eq(playlistTracks.playlistId, playlistId)).run()
  const unique = [...new Set(trackIds)]
  for (const [position, trackId] of unique.entries()) db.insert(playlistTracks).values({ playlistId, trackId, position }).run()
}

export function createPlaylist(db: Db, userId: string, p: PlaylistInput) {
  assertTrackIds(db, p.trackIds)
  const now = nowIso()
  const id = newId()
  db.transaction((tx) => {
    tx.insert(playlists).values({ id, userId, name: p.name, orderMode: p.orderMode, createdAt: now, updatedAt: now }).run()
    writeTracks(tx as unknown as Db, id, p.trackIds)
  })
  return getPlaylist(db, userId, id)
}

export function updatePlaylist(db: Db, userId: string, id: string, p: PlaylistInput) {
  getPlaylist(db, userId, id)
  assertTrackIds(db, p.trackIds)
  db.transaction((tx) => {
    tx.update(playlists).set({ name: p.name, orderMode: p.orderMode, updatedAt: nowIso() }).where(eq(playlists.id, id)).run()
    writeTracks(tx as unknown as Db, id, p.trackIds)
  })
  return getPlaylist(db, userId, id)
}

export function deletePlaylist(db: Db, userId: string, id: string) {
  getPlaylist(db, userId, id)
  db.delete(playlistTracks).where(eq(playlistTracks.playlistId, id)).run()
  db.delete(playlists).where(eq(playlists.id, id)).run()
}

export const playlistTrackPaths = (db: Db, userId: string, id: string) => getPlaylist(db, userId, id).tracks.map((t) => t.path)
