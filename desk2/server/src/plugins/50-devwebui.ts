// The servers pane's side of Desk 2 (SPEC-less, see README "What Desk 2 adds"): /dw/api/* goes on to the DevWebUI
// daemon (../devwebui) that lists, starts and stops this chat's localhost servers, and GET /dw/status says whether
// that daemon answers. POST /dw/start brings one up when none does (hidden, see devwebui/daemon.ts).
//
// Desk's localOnly guard (index.ts) runs first on every route. Like /ah/, a browser request here must come from
// Desk 2's own page, and what goes on carries no Origin, Referer, cookies or Sec-Fetch headers: to DevWebUI it is a
// local client, which it answers (its own page-vs-script guard refuses browser provenance headers). The daemon's
// local credential is added here when its data dir has one, and the page's own Authorization never goes on.

import type { Hono } from 'hono'
import { DW_API, DW_BASE, DW_STATUS } from '@shared/devwebui'
import type { ServerContext } from '../context'
import { daemonAuth, DevWebDaemon, findDaemon } from '../devwebui/daemon'

const NOT_PASSED_ON = ['origin', 'referer', 'cookie', 'host', 'connection', 'accept-encoding', 'content-length', 'authorization']

/** Why a request is not from Desk 2's own page, or null (the same rule as /ah/). */
function notOwnPage(headers: Headers): string | null {
  const origin = headers.get('origin')
  if (origin !== null) {
    let host: string | null = null
    try {
      host = new URL(origin).host
    } catch {
      // floor-ok: an Origin that is not a URL is refused below like any other
    }
    if (host === null || host !== headers.get('host')) return `the server manager's API is only for Desk 2's own page, not ${origin}`
  }
  const site = headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && site !== 'none') return `the server manager's API is only for Desk 2's own page (${site})`
  return null
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const daemon = (ctx.deps.devwebui as DevWebDaemon | undefined) ?? new DevWebDaemon({ home: ctx.home })

  app.get(DW_STATUS, async (c) => {
    const why = notOwnPage(c.req.raw.headers)
    if (why) return c.json({ error: why }, 403)
    return c.json(await daemon.status())
  })

  app.post(`${DW_BASE}/start`, async (c) => {
    const why = notOwnPage(c.req.raw.headers)
    if (why) return c.json({ error: why }, 403)
    return c.json(await daemon.ensure())
  })

  app.all(`${DW_API}/*`, async (c) => {
    const why = notOwnPage(c.req.raw.headers)
    if (why) return c.json({ error: why }, 403)
    const base = await findDaemon()
    if (!base) return c.json({ error: 'the server manager is not running' }, 503)
    const url = new URL(c.req.url)
    const headers = new Headers(c.req.raw.headers)
    for (const h of NOT_PASSED_ON) headers.delete(h)
    const secFetch: string[] = []
    headers.forEach((_, h) => h.startsWith('sec-fetch-') && secFetch.push(h))
    for (const h of secFetch) headers.delete(h)
    const auth = daemonAuth(base)
    if (auth) headers.set('authorization', auth)
    const withBody = c.req.method !== 'GET' && c.req.method !== 'HEAD'
    let res: Response
    try {
      res = await fetch(`${base}/api${url.pathname.slice(DW_API.length)}${url.search}`, {
        method: c.req.method,
        headers,
        body: withBody ? await c.req.arrayBuffer() : undefined,
        redirect: 'manual',
        signal: c.req.raw.signal
      })
    } catch {
      return c.json({ error: `the server manager is not answering at ${base}` }, 503)
    }
    // fetch has already undone any compression, so the length and encoding it was sent with no longer hold.
    const out = new Headers(res.headers)
    out.delete('content-encoding')
    out.delete('content-length')
    out.delete('set-cookie')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
  })
}
