// The quick-instances window (/instances, the "AgentHydra Instances" shortcut) is AgentHydra 2.0's copy of
// it, desk2/hydra/src/QuickInstancesApp.vue, served by whichever daemon the shortcut reaches: the light one
// (instance-mode.ts) or the full one (index.ts). That copy is built for Desk 2's /ah/ base, so it asks for
// its files under /ah/ and for its API under /ah/api/, and its entry picks the quick app on the exact path
// /instances (desk2/hydra/src/lib/app-mode.ts). Desk 2 hands /ah/api/* on to the daemon's /api/*
// (desk2/server/src/plugins/45-agenthydra.ts); here the daemon is the API, so the same request is answered
// by its own /api/* route and passes every /api/* guard on the way, exactly as a call to /api/* would.
import { statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Env, Hono } from 'hono'

const BASE = '/ah'
const NOT_BUILT =
  '<main style="font:16px system-ui;padding:2rem"><h1>Quick Instances is not built yet</h1><p>Run <code>bun run build</code> in <code>desk2</code>, then launch instance mode again.</p></main>'

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true

export function serveQuickInstancesPage<E extends Env>(app: Hono<E>, dist: string): void {
  const root = resolve(dist)
  app.all(`${BASE}/api/*`, (c) => {
    const url = new URL(c.req.url)
    url.pathname = url.pathname.slice(BASE.length)
    return app.fetch(new Request(url.toString(), c.req.raw), c.env)
  })
  app.get('/instances', (c) => {
    const index = join(root, 'index.html')
    if (!isFile(index)) return c.html(NOT_BUILT, 503)
    return new Response(Bun.file(index), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    })
  })
  app.get(`${BASE}/*`, (c) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname).slice(BASE.length)
    const file = resolve(root, `.${path}`)
    if (!file.startsWith(root + sep) || !isFile(file))
      return c.text('not found', 404, { 'cache-control': 'no-store' })
    // Vite names every built asset by its content, so those keep; anything else is checked each time.
    const cacheControl = path.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
    return new Response(Bun.file(file), { headers: { 'cache-control': cacheControl } })
  })
}
