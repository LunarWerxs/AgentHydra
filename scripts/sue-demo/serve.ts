#!/usr/bin/env bun
/**
 * AgentHydra's pages (desk2/hydra, AgentHydra 2.0's copy, built for Desk 2's /ah/ base) with an
 * invented world behind them, for simulated visitors (SUE) and anyone who wants to click around
 * without touching real accounts.
 *
 *   bun run build && bun scripts/sue-demo/serve.ts          # http://127.0.0.1:5197/ah/
 *   SUE_DEMO_PORT=5300 bun scripts/sue-demo/serve.ts
 *   http://127.0.0.1:5197/ah/?seat=second-pc                 # a PC that has not joined Login sync
 *
 * Why it exists: the real daemon drives real logins. A simulated visitor who presses Log out, Delete
 * or Stop syncing there signs a real account out or stops the owner's sync, so SUE never visits it.
 * Here every /api/ call is answered in the page by two fixture files (scripts/screenshots/
 * page-fixtures.js for the whole app, then cli-fixtures.js for the CLI tab's accounts, Login sync
 * and seats), and this server itself answers no /api/ route at all: a call that slipped past the
 * fixtures gets a 503 that says so, never a daemon.
 */
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

const HERE = import.meta.dir
const DIST = join(HERE, '..', '..', 'desk2', 'hydra', 'dist')
const BASE = '/ah'
const PORT = Number(process.env.SUE_DEMO_PORT ?? 5197)
/** Served as plain scripts from the page's own origin, in this order, ahead of the app's module. */
const FIXTURES: Record<string, string> = {
  '/__demo/page-fixtures.js': join(HERE, '..', 'screenshots', 'page-fixtures.js'),
  '/__demo/cli-fixtures.js': join(HERE, 'cli-fixtures.js'),
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('desk2/hydra/dist is missing: run `bun run build` first.')
  process.exit(1)
}

function page(): string {
  const tags = Object.keys(FIXTURES)
    .map((src) => `<script src="${BASE}${src}"></script>`)
    .join('\n    ')
  return readFileSync(join(DIST, 'index.html'), 'utf8').replace('<head>', `<head>\n    ${tags}`)
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  fetch(req) {
    const url = new URL(req.url)
    const path = decodeURIComponent(url.pathname)
    if (!path.startsWith(`${BASE}/`))
      return Response.redirect(new URL(`${BASE}/${url.search}`, url).toString(), 302)
    const inApp = path.slice(BASE.length)
    if (inApp.startsWith('/api/'))
      return Response.json({ error: 'demo: there is no daemon behind this page' }, { status: 503 })
    const fixture = FIXTURES[inApp]
    if (fixture)
      return new Response(Bun.file(fixture), {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
      })
    const file = join(DIST, normalize(inApp))
    if (extname(file) && file.startsWith(DIST) && existsSync(file))
      return new Response(Bun.file(file))
    return new Response(page(), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  },
})
console.log(`AgentHydra demo (invented data, no daemon) on http://127.0.0.1:${server.port}${BASE}/`)
