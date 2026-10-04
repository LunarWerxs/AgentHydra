// GET /api/media/<sha256>.<ext>: a picture from the content-addressed cache (server/src/media). Only
// cache entries by hash; any other id, a path-looking one included, is refused.

import type { Hono } from 'hono'
import type { ServerContext } from '../context'
import { mediaCache } from '../media/cache'

export default function plugin(app: Hono, ctx: ServerContext): void {
  const cache = mediaCache(ctx.home)
  app.get('/api/media/:id', (c) => {
    const hit = cache?.lookup(c.req.param('id'))
    if (!hit) return c.json({ error: 'no such picture' }, 404)
    return new Response(Bun.file(hit.path), {
      headers: {
        'content-type': hit.contentType,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'",
      },
    })
  })
}
