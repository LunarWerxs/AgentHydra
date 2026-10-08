// The servers pane's side of Desk 2 (README "What Desk 2 adds"): the dev servers are run by AgentHydra's own
// dev-servers service (server/src/devservers), its own hidden process that Desk starts when something asks and never
// stops. GET /dw/status says where it stands (and never starts it); POST /dw/service starts, stops or restarts it
// (Settings); POST /dw/folder sets up a chat's folder in it; /dw/api/* goes on to the service's /api/* one to one;
// /dw/proxy/<id>/* shows a running server through Desk (devservers/proxy.ts). Everything but /dw/status and a read
// marked DW_NO_START (the pane's polls) starts the service first when it is not running (client.ts), once however
// many ask.
//
// Desk's localOnly guard (index.ts) runs first on every route. Like /ah/, a browser request here must come from
// Desk 2's own page, while a local client that sends no Origin or Sec-Fetch headers (the chats' dev-servers tool,
// AgentHydra's `agenthydra` tool) is accepted. What goes on to the service carries none of the page's Origin,
// Referer, cookies, Sec-Fetch headers or Authorization, and the service's own token is added there, never shown.

import type { Context, Hono } from 'hono'
import { DW_API, DW_FOLDER, DW_NO_START, DW_PROXY, DW_SERVICE, DW_STATUS } from '@shared/devwebui'
import type { ServerContext } from '../context'
import { type DevServicesClient, devServicesClient } from '../devservers/client'
import { createDevProxy } from '../devservers/proxy'
import { readSettings } from '../devservers/settings'
import { notOwnPage } from '../own-page'

const NOT_PASSED_ON = ['origin', 'referer', 'cookie', 'host', 'connection', 'accept-encoding', 'content-length', 'authorization']
const ACTIONS = ['start', 'stop', 'restart'] as const

const unavailable = (err: unknown): string => `the dev-servers service is not available: ${err instanceof Error ? err.message : String(err)}`

/** With "start when Desk starts" on, Desk brings the service (and with it the servers) up itself, once, in the background. */
function autoStart(home: string, client: DevServicesClient): void {
  try {
    if (readSettings(home, null).settings.autoStartOnLaunch) void client.ensure().catch(() => undefined)
  } catch {
    // floor-ok: an unreadable settings file just means no auto start
  }
}

/** The service's answer for the page: fetch has already undone any compression, so its length and encoding no longer hold. */
function passOn(res: Response): Response {
  const out = new Headers(res.headers)
  out.delete('content-encoding')
  out.delete('content-length')
  out.delete('set-cookie')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}

/** Passes `path` on to the service with the page's method, headers and body; its answer back without hop headers. */
async function forward(client: DevServicesClient, c: Context, path: string): Promise<Response> {
  const headers = new Headers(c.req.raw.headers)
  for (const h of NOT_PASSED_ON) headers.delete(h)
  const secFetch: string[] = []
  headers.forEach((_, h) => h.startsWith('sec-fetch-') && secFetch.push(h))
  for (const h of secFetch) headers.delete(h)
  const withBody = c.req.method !== 'GET' && c.req.method !== 'HEAD'
  let res: Response
  try {
    res = await client.request(path, { method: c.req.method, headers, body: withBody ? await c.req.arrayBuffer() : undefined, redirect: 'manual', signal: c.req.raw.signal })
  } catch (err) {
    return Response.json({ error: unavailable(err) }, { status: 503 })
  }
  return passOn(res)
}

async function serviceAction(client: DevServicesClient, c: Context): Promise<Response> {
  const why = notOwnPage(c.req.raw.headers)
  if (why) return c.json({ error: why }, 403)
  const action = ((await c.req.json().catch(() => null)) as { action?: unknown } | null)?.action
  if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) return c.json({ error: `action must be one of ${ACTIONS.join(', ')}` }, 400)
  return c.json(await (action === 'start' ? client.ensure() : action === 'stop' ? client.stop() : client.restart()))
}

async function setUpFolder(client: DevServicesClient, c: Context): Promise<Response> {
  const why = notOwnPage(c.req.raw.headers)
  if (why) return c.json({ error: why }, 403)
  const cwd = ((await c.req.json().catch(() => null)) as { cwd?: unknown } | null)?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') return c.json({ error: 'cwd required' }, 400)
  let res: Response
  try {
    res = await client.request('/api/folder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd }) })
  } catch (err) {
    return c.json({ error: unavailable(err) }, 503)
  }
  return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } })
}

async function passToApi(client: DevServicesClient, c: Context): Promise<Response> {
  const why = notOwnPage(c.req.raw.headers)
  if (why) return c.json({ error: why }, 403)
  const url = new URL(c.req.url)
  const path = `/api${url.pathname.slice(DW_API.length)}${url.search}`
  // A poll's read never starts the service: one stopped while the read was on its way stays stopped.
  if (c.req.method === 'GET' && c.req.header(DW_NO_START)) {
    const res = await client.peek(path)
    return res ? passOn(res) : c.json({ error: 'the dev-servers service is not running, or did not answer within 2 s' }, 503)
  }
  return forward(client, c, path)
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const client = (ctx.deps.devservers as DevServicesClient | undefined) ?? devServicesClient(ctx.home)
  const proxy = createDevProxy(client, DW_PROXY)
  ctx.hostRoute(proxy.hostRoute)

  // After the server has bound, not during plugin init.
  setTimeout(() => autoStart(ctx.home, client), 0)

  app.get(DW_STATUS, async (c) => {
    const why = notOwnPage(c.req.raw.headers)
    if (why) return c.json({ error: why }, 403)
    return c.json(await client.status())
  })
  app.post(DW_SERVICE, (c) => serviceAction(client, c))
  app.post(DW_FOLDER, (c) => setUpFolder(client, c))
  app.all(`${DW_API}/*`, (c) => passToApi(client, c))

  const showThrough = async (c: Parameters<typeof proxy.redirect>[0]): Promise<Response> => {
    const why = notOwnPage(c.req.raw.headers)
    return why ? c.json({ error: why }, 403) : proxy.redirect(c)
  }
  app.all(`${DW_PROXY}/:id`, showThrough)
  app.all(`${DW_PROXY}/:id/*`, showThrough)
}
