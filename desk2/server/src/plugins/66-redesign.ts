// GET /api/redesign/image/:run/:file: a ReDesign option picture for the chat's ReDesign card (connectors/redesign-images.ts).

import { join } from 'node:path'
import type { Hono } from 'hono'
import type { ServerContext } from '../context'
import { serveDesignImage } from '../connectors/redesign-images'

export default function plugin(app: Hono, ctx: ServerContext): void {
  const dir = join(ctx.home, 'design-options')
  app.get('/api/redesign/image/:run/:file', (c) => serveDesignImage(dir, c.req.param('run'), c.req.param('file')))
}
