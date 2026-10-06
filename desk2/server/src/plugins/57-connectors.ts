// Connectors (server/src/connectors/): GET /api/connectors lists them with where each stands, and
// POST /api/connectors/<id>/<action> runs install, start, enable or disable. Like /dw/, only Desk 2's own page may call it.

import type { Hono } from 'hono'
import { CONNECTORS, connectorAction, type ConnectorAction, type ConnectorsResponse } from '@shared/connectors'
import type { ServerContext } from '../context'
import { startConnectors } from '../connectors/registry'
import { notOwnPage } from '../own-page'

const ACTIONS: readonly ConnectorAction[] = ['install', 'start', 'enable', 'disable']
const WHAT = "the connectors' API"

export default async function plugin(app: Hono, ctx: ServerContext): Promise<void> {
  const registry = await startConnectors(ctx)

  app.get(CONNECTORS, (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    if (why) return c.json({ error: why }, 403)
    const body: ConnectorsResponse = { connectors: registry.list() }
    return c.json(body)
  })

  app.post(connectorAction(':id' as never, ':action' as never), async (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    if (why) return c.json({ error: why }, 403)
    const id = c.req.param('id') ?? ''
    const action = c.req.param('action') as ConnectorAction
    if (!ACTIONS.includes(action)) return c.json({ error: `no action ${action}` }, 404)
    const res = await registry.action(id, action)
    if (res === 'unknown') return c.json({ error: `no connector ${id}` }, 404)
    if (res === 'unsupported') return c.json({ error: `${id} has no ${action}` }, 400)
    return c.json(res)
  })
}
