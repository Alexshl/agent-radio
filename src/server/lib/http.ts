import type { ContentfulStatusCode } from 'hono/utils/http-status'

export class HttpError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message?: string,
    // response headers
    public headers?: Record<string, string>,
  ) {
    super(message ?? code)
  }
}

export const badRequest = (code: string, message?: string) => new HttpError(400, code, message)
export const notFound = (message?: string) => new HttpError(404, 'not_found', message)
