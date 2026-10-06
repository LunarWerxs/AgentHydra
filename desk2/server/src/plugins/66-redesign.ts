// GET /api/redesign/image/:run/:file: a ReDesign option picture for the chat's ReDesign card (connectors/redesign-images.ts).
// POST /api/redesign/keys/hswarm: copies a small working set of HSwarm's keys into ReDesign's pools (connectors/redesign-keys.ts);
// the answer is counts and fingerprints, never a key.

import { join } from 'node:path'
import type { Hono } from 'hono'
import type { ServerContext } from '../context'
import { serveDesignImage } from '../connectors/redesign-images'
import { copyHswarmKeys } from '../connectors/redesign-keys'
import { runningRedesignUrl } from '../connectors/defs/redesign'
import { notOwnPage } from '../own-page'

export default function plugin(app: Hono, ctx: ServerContext): void {
  const dir = join(ctx.home, 'design-options')
  app.get('/api/redesign/image/:run/:file', (c) => serveDesignImage(dir, c.req.param('run'), c.req.param('file')))
  app.post('/api/redesign/keys/hswarm', async (c) => {
    const why = notOwnPage(c.req.raw.headers, 'the ReDesign keys API')
    if (why) return c.json({ error: why }, 403)
    const url = await runningRedesignUrl()
    if (!url) return c.json({ error: 'ReDesign is not running' }, 409)
    const result = await copyHswarmKeys({ redesignUrl: url })
    return c.json(result, result.ok ? 200 : 502)
  })
}
