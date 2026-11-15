export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code)
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
  if (!res.ok) throw new ApiError(res.status, json.error ?? 'error', json.message)
  return json as T
}

export const get = <T>(path: string) => api<T>(path)
export const post = <T = { ok: true }>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body })
export const put = <T = { ok: true }>(path: string, body: unknown = {}) => api<T>(path, { method: 'PUT', body })
export const patch = <T = { ok: true }>(path: string, body: unknown = {}) => api<T>(path, { method: 'PATCH', body })
export const del = <T = { ok: true }>(path: string) => api<T>(path, { method: 'DELETE' })
