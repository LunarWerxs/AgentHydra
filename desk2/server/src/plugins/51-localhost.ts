// GET /dw/localhost: the localhost servers on this machine that no project lists, for the servers pane's "Other
// localhost servers" (server/src/localhost). Desk 2's own route beside /dw/status, not under /dw/api, which goes on
// to the dev-servers service. Own page only, like the rest of /dw: Desk's localOnly guard runs first, then notOwnPage.
// The service says which ports and pids are its own (GET /api/owned), so the list leaves those out; with no service
// running there are none to leave out, and this list never starts it.

import type { Hono } from 'hono'
import { DW_LOCALHOST } from '@shared/devwebui'
import type { ServerContext } from '../context'
import { type DevServicesClient, devServicesClient } from '../devservers/client'
import { Localhost, type DevWebOwned, type LocalhostDeps } from '../localhost/servers'
import { notOwnPage } from '../own-page'

export default function plugin(app: Hono, ctx: ServerContext): void {
  const client = (ctx.deps.devservers as DevServicesClient | undefined) ?? devServicesClient(ctx.home)
  const owned = async (): Promise<DevWebOwned | null> => {
    const res = await client.peek('/api/owned')
    if (!res?.ok) return null
    try {
      return (await res.json()) as DevWebOwned
    } catch {
      return null
    }
  }
  const deps = (ctx.deps.localhost as LocalhostDeps | undefined) ?? {}
  const localhost = new Localhost({ owned, ...deps })

  app.get(DW_LOCALHOST, async (c) => {
    const why = notOwnPage(c.req.raw.headers, 'the localhost list')
    if (why) return c.json({ error: why }, 403)
    return c.json(await localhost.list(c.req.query('all') === '1'))
  })
}
