// Fetching URLs that users (or admin presets) provide, without letting them reach the internal network (SSRF):
// strict URL checks, every resolved address must be public, the connection is pinned to the address that was checked
// (no DNS rebinding), redirects are followed by hand and every hop is checked again.
import { lookup as dnsLookup } from 'node:dns/promises'
import http, { type IncomingHttpHeaders } from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import type { Readable } from 'node:stream'
import ipaddr from 'ipaddr.js'
import { HttpError } from './http'

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

export const defaultResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))

// true when the address is a public unicast address (IPv4, or IPv6 inside 2000::/3 that is not 6to4 / teredo / NAT64 / documentation ...).
export function isPublicAddress(address: string): boolean {
  let ip: ipaddr.IPv4 | ipaddr.IPv6
  try {
    ip = ipaddr.parse(address)
  } catch {
    return false
  }
  if (ip.kind() === 'ipv6') {
    const v6 = ip as ipaddr.IPv6
    // ::ffff:a.b.c.d is an IPv4 address in disguise
    if (v6.isIPv4MappedAddress()) return isPublicAddress(v6.toIPv4Address().toString())
    const first = v6.parts[0] ?? 0
    return v6.range() === 'unicast' && first >= 0x2000 && first <= 0x3fff
  }
  return ip.range() === 'unicast'
}

export class UrlBlockedError extends HttpError {
  constructor(message = 'This address is not allowed') {
    super(400, 'invalid_url', message)
  }
}

// Normalises and checks the shape of a URL (no network access). Throws UrlBlockedError.
export function parseExternalUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 2000) throw new UrlBlockedError()
  // browsers and WHATWG URL turn "\" into "/" and drop tabs / newlines: the parsers would disagree about the host, so refuse them outright
  for (const ch of raw) {
    const code = ch.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f || ch === '\\' || /\s/.test(ch)) throw new UrlBlockedError()
  }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new UrlBlockedError()
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UrlBlockedError()
  if (u.username || u.password) throw new UrlBlockedError()
  const host = u.hostname
  if (!host || host.endsWith('.')) throw new UrlBlockedError()
  return new URL(u.href)
}

// Parses the URL and resolves its host; every address must be public. Returns the checked addresses (to pin the connection to).
export async function assertPublicUrl(
  raw: string,
  resolver: Resolver = defaultResolver,
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  const url = parseExternalUrl(raw)
  const bare = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: ResolvedAddress[]
  if (isIP(bare)) {
    addresses = [{ address: bare, family: isIP(bare) === 6 ? 6 : 4 }]
  } else {
    try {
      addresses = await resolver(bare)
    } catch {
      throw new UrlBlockedError('The address could not be resolved')
    }
  }
  if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) throw new UrlBlockedError()
  return { url, addresses }
}

export interface HopResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Readable
  // stops the request / closes the socket
  destroy(): void
}

// One HTTP request to an already checked address; `url.hostname` still goes into Host and the TLS server name.
export type Transport = (
  url: URL,
  pinned: ResolvedAddress,
  headers: Record<string, string>,
  opts: { timeoutMs: number },
) => Promise<HopResponse>

export const nodeTransport: Transport = (url, pinned, headers, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers,
        // the pinned address: the name is never resolved again
        lookup: (_host, options, cb) => {
          const o = options as { all?: boolean }
          if (o.all)
            (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
              { address: pinned.address, family: pinned.family },
            ])
          else cb(null, pinned.address, pinned.family)
        },
        timeout: timeoutMs,
      },
      (res) => {
        // idle timeout once the stream runs
        res.setTimeout(30_000, () => res.destroy(new Error('stream timeout')))
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, destroy: () => req.destroy() })
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

export interface SafeFetchOptions {
  headers?: Record<string, string>
  resolver?: Resolver
  transport?: Transport
  maxRedirects?: number
  timeoutMs?: number
}

// GET with SSRF protection. Resolves to the final response (status 2xx or an error status); throws UrlBlockedError for a blocked URL or hop.
export async function safeGet(raw: string, opts: SafeFetchOptions = {}): Promise<HopResponse> {
  const transport = opts.transport ?? nodeTransport
  const max = opts.maxRedirects ?? 3
  let current = raw
  for (let hop = 0; hop <= max; hop++) {
    const { url, addresses } = await assertPublicUrl(current, opts.resolver)
    const first = addresses[0]
    if (!first) throw new UrlBlockedError()
    const res = await transport(
      url,
      first,
      { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', ...opts.headers },
      { timeoutMs: opts.timeoutMs ?? 10_000 },
    )
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      res.destroy()
      let next: string
      try {
        next = new URL(String(res.headers.location), url).href
      } catch {
        throw new UrlBlockedError()
      }
      current = next
      continue
    }
    return res
  }
  throw new HttpError(502, 'too_many_redirects', 'Too many redirects')
}
