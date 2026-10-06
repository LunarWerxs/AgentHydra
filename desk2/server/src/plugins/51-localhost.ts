// GET /dw/localhost: the localhost servers on this machine that DevWebUI did not start, for the servers pane's
// "Other localhost servers" (server/src/localhost). Desk 2's own route beside /dw/status, not under /dw/api, which
// goes on to DevWebUI. Own page only, like the rest of /dw: Desk's localOnly guard runs first, then notOwnPage.
// DevWebUI's daemon is asked which ports and pids are its own, so the list leaves those out.

import type { Hono } from 'hono'
import { DW_LOCALHOST, type DevWebProject } from '@shared/devwebui'
import type { ServerContext } from '../context'
import { daemonAuth, findDaemon } from '../devwebui/daemon'
import { Localhost, type DevWebOwned, type LocalhostDeps } from '../localhost/servers'
import { notOwnPage } from '../own-page'

/** DevWebUI's daemon port, and the pid and port of each server it lists; null when no daemon answers. */
async function devwebOwned(): Promise<DevWebOwned | null> {
  const base = await findDaemon()
  if (!base) return null
  const ports: number[] = []
  const pids: number[] = []
  const daemonPort = Number(new URL(base).port)
  if (daemonPort) ports.push(daemonPort)
  try {
    const auth = daemonAuth(base)
    const res = await fetch(`${base}/api/projects`, { headers: auth ? { authorization: auth } : {}, signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      for (const p of (await res.json()) as DevWebProject[]) {
        for (const proc of p.processes ?? []) {
          if (typeof proc.port === 'number') ports.push(proc.port)
          if (typeof proc.pid === 'number') pids.push(proc.pid)
        }
      }
    }
  } catch {
    // floor-ok: with no project list the daemon's own port is still left out, and the rest shows as other servers
  }
  return { ports, pids }
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const deps = (ctx.deps.localhost as LocalhostDeps | undefined) ?? {}
  const localhost = new Localhost({ owned: devwebOwned, ...deps })

  app.get(DW_LOCALHOST, async (c) => {
    const why = notOwnPage(c.req.raw.headers, 'the localhost list')
    if (why) return c.json({ error: why }, 403)
    return c.json(await localhost.list(c.req.query('all') === '1'))
  })
}
