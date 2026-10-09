// Hydra Desk 2's own copy of AgentHydra's window (desk2/hydra, built into hydra/dist), at /ah/, and its API:
// /ah/api/* goes on to AgentHydra's /api/* at the bridge's address. The copy is Desk 2's to change; the
// daemon under it stays the one AgentHydra, so both windows show and act on the same sessions and accounts.
//
// Desk's localOnly guard (index.ts) runs before this on every route, so a page on another site is
// refused before anything is passed on. It lets a page on any local port in; AgentHydra lets only its own
// page in (a page on another local port is not it), so the API here asks the same: a browser request
// must come from Desk 2's own page. What goes on carries no Origin, Referer, cookies or Sec-Fetch
// headers: to AgentHydra it is a local client, the same as Desk's own bridge calls.
// /oauth/* (AgentHydra's sign-in pages) is sent to AgentHydra itself: a sign-in is a page of its own.

import { statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Hono } from 'hono'
import { bridge } from '../bridge'
import { indexReader } from '../static-index'
import { cacheControl } from '../static-cache'

const DIST = resolve(import.meta.dir, '../../../hydra/dist')
const readIndex = indexReader(join(DIST, 'index.html'))
const BASE = '/ah'
const NOT_PASSED_ON = ['origin', 'referer', 'cookie', 'host', 'connection', 'accept-encoding', 'content-length']

/** Why a request is not from Desk 2's own page, or null: an Origin must be this server's, and a browser's
 *  Sec-Fetch-Site must say same-origin (or none, typed into the address bar). */
function notOwnPage(headers: Headers): string | null {
  const origin = headers.get('origin')
  if (origin !== null) {
    let host: string | null = null
    try {
      host = new URL(origin).host
    } catch {
      // floor-ok: an Origin that is not a URL is refused below like any other
    }
    if (host === null || host !== headers.get('host')) return `AgentHydra's API is only for Desk 2's own page, not ${origin}`
  }
  const site = headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && site !== 'none') return `AgentHydra's API is only for Desk 2's own page (${site})`
  return null
}

export default function plugin(app: Hono): void {
  app.all(`${BASE}/api/*`, async (c) => {
    const why = notOwnPage(c.req.raw.headers)
    if (why) return c.json({ error: why }, 403)
    const url = new URL(c.req.url)
    const target = `${bridge().url}${url.pathname.slice(BASE.length)}${url.search}`
    const headers = new Headers(c.req.raw.headers)
    for (const h of NOT_PASSED_ON) headers.delete(h)
    const secFetch: string[] = []
    headers.forEach((_, h) => h.startsWith('sec-fetch-') && secFetch.push(h))
    for (const h of secFetch) headers.delete(h)
    const withBody = c.req.method !== 'GET' && c.req.method !== 'HEAD'
    let res: Response
    try {
      res = await fetch(target, {
        method: c.req.method,
        headers,
        body: withBody ? await c.req.arrayBuffer() : undefined,
        redirect: 'manual',
        signal: c.req.raw.signal
      })
    } catch {
      return c.json({ error: `AgentHydra is not answering at ${bridge().url}` }, 503)
    }
    // fetch has already undone any compression, so the length and encoding it was sent with no longer hold.
    const out = new Headers(res.headers)
    out.delete('content-encoding')
    out.delete('content-length')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
  })

  app.get('/oauth/*', (c) => {
    const url = new URL(c.req.url)
    return c.redirect(`${bridge().url}${url.pathname}${url.search}`, 302)
  })

  app.get(BASE, (c) => c.redirect(`${BASE}/${new URL(c.req.url).search}`, 301))
  app.get(`${BASE}/*`, async (c) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname).slice(BASE.length)
    const file = resolve(DIST, `.${path}`)
    if (file.startsWith(DIST + sep) && statSync(file, { throwIfNoEntry: false })?.isFile()) {
      return new Response(Bun.file(file), { headers: { 'cache-control': cacheControl(path) } })
    }
    // Only the fall-back needs index.html, so a file that is there costs one stat.
    const html = await readIndex()
    if (html === null) return c.text("AgentHydra's pages are not built yet: run bun run build in desk2.", 503)
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
  })
}
