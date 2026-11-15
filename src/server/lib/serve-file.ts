import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { extname } from 'node:path'
import type { Context } from 'hono'
import { HttpError, notFound } from './http'

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
}

// Serves a file with HTTP Range support (seeking in <audio>). The caller has already checked access and the path.
export function serveFile(c: Context, file: string): Response {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    throw notFound('File not found')
  }
  const headers: Record<string, string> = {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  }
  const range = c.req.header('range')
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!m || (m[1] === '' && m[2] === '')) throw new HttpError(416, 'bad_range', 'Bad range', { 'Content-Range': `bytes */${size}` })
    let start: number
    let end: number
    if (m[1] === '') {
      // suffix: the last N bytes
      start = Math.max(size - Number(m[2]), 0)
      end = size - 1
    } else {
      start = Number(m[1])
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
    }
    if (start >= size || start > end) throw new HttpError(416, 'bad_range', 'Range not satisfiable', { 'Content-Range': `bytes */${size}` })
    return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    })
  }
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    status: 200,
    headers: { ...headers, 'Content-Length': String(size) },
  })
}
