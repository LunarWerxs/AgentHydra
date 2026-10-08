// Connectors (server/src/connectors/): GET /api/connectors lists them with where each stands, and
// POST /api/connectors/<id>/<action> runs install, start, enable or disable. Like /dw/, only Desk 2's own page may call it.
// The first probe pass (health fetches with 1.5 s timeouts) runs after the server binds; the routes wait for it.

import type { Hono } from 'hono'
import { CONNECTORS, connectorAction, type ConnectorAction, type ConnectorsResponse } from '@shared/connectors'
import type { ServerContext } from '../context'
import { startConnectors } from '../connectors/registry'
import { notOwnPage } from '../own-page'

const ACTIONS: readonly ConnectorAction[] = ['install', 'start', 'enable', 'disable']
const WHAT = "the connectors' API"

export default function plugin(app: Hono, ctx: ServerContext): void {
  const started = startConnectors(ctx)
  started.catch((err) => console.error('[connectors] could not start:', err))

  app.get(CONNECTORS, async (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    if (why) return c.json({ error: why }, 403)
    const registry = await started
    await registry.fresh()
    const body: ConnectorsResponse = { connectors: registry.list() }
    return c.json(body)
  })

  app.post(connectorAction(':id' as never, ':action' as never), async (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    if (why) return c.json({ error: why }, 403)
    const id = c.req.param('id') ?? ''
    const action = c.req.param('action') as ConnectorAction
    if (!ACTIONS.includes(action)) return c.json({ error: `no action ${action}` }, 404)
    const res = await (await started).action(id, action)
    if (res === 'unknown') return c.json({ error: `no connector ${id}` }, 404)
    if (res === 'unsupported') return c.json({ error: `${id} has no ${action}` }, 400)
    return c.json(res)
  })
}
