// GET /api/media/<sha256>.<ext>: a picture or video from the content-addressed cache (server/src/media).
// Only cache entries by hash; any other id, a path-looking one included, is refused. A Range request gets
// that slice (206), so a video can seek and start before it has all arrived.

import type { Hono } from 'hono'
import type { ServerContext } from '../context'
import { mediaCache } from '../media/cache'

/** One `bytes=` range of a file of `size` bytes, inclusive; null = serve the whole file, 'unsatisfiable' = 416. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '')
  if (!m || (!m[1] && !m[2])) return null // absent, malformed or several ranges: the whole file
  if (!m[1]) {
    const suffix = Number(m[2])
    if (!suffix || !size) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const cache = mediaCache(ctx.home)
  app.get('/api/media/:id', (c) => {
    const hit = cache?.lookup(c.req.param('id'))
    if (!hit) return c.json({ error: 'no such picture or video' }, 404)
    const file = Bun.file(hit.path)
    const headers: Record<string, string> = {
      'content-type': hit.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'accept-ranges': 'bytes',
    }
    const range = byteRange(c.req.header('range'), file.size)
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${file.size}` } })
    if (range) {
      const { start, end } = range
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${file.size}`, 'content-length': String(end - start + 1) },
      })
    }
    return new Response(file, { headers })
  })
}
