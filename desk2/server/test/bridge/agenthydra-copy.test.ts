// plugins/45-agenthydra.ts through the real server: Desk 2's copy of AgentHydra's window asks /ah/api/*,
// and that reaches AgentHydra's /api/* as a local client, only from Desk 2's own page.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, type DeskServer } from '../../src/index'
import { deadUrl } from './fake-hydra'

const PLUGINS = join(import.meta.dir, '..', '..', 'src', 'plugins')
const temps: string[] = []
const stops: (() => unknown)[] = []

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Seen {
  method: string
  path: string
  body: string
  origin: string | null
  cookie: string | null
  site: string | null
}

/** An AgentHydra that answers every call with what it was sent. */
function startEcho(): { url: string; seen: Seen[] } {
  const seen: Seen[] = []
  const srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      const s = {
        method: req.method,
        path: u.pathname + u.search,
        body: await req.text(),
        origin: req.headers.get('origin'),
        cookie: req.headers.get('cookie'),
        site: req.headers.get('sec-fetch-site')
      }
      seen.push(s)
      return Response.json(s, { status: u.pathname === '/api/missing' ? 404 : 200 })
    }
  })
  stops.push(() => srv.stop(true))
  return { url: `http://127.0.0.1:${srv.port}`, seen }
}

async function boot(hydraUrl: string): Promise<DeskServer> {
  const home = mkdtempSync(join(tmpdir(), 'desk-ahcopy-home-'))
  const plugins = mkdtempSync(join(tmpdir(), 'desk-ahcopy-plugins-'))
  temps.push(home, plugins)
  for (const name of ['10-bridge.ts', '45-agenthydra.ts'])
    writeFileSync(join(plugins, name), `export { default } from ${JSON.stringify(pathToFileURL(join(PLUGINS, name)).href)}\n`)
  process.env.HYDRA_DESK_HOME = home
  const desk = await createServer({ port: 0, home, pluginsDir: plugins, deps: { hydraUrl, bridgePollMs: 60_000 } })
  stops.push(() => desk.stop())
  return desk
}

test("the copy's API reaches AgentHydra's as a local client, from Desk 2's own page only", async () => {
  const hydra = startEcho()
  const desk = await boot(hydra.url)
  const own = new URL(desk.url).origin

  const res = await fetch(`${desk.url}/ah/api/sessions/abc/done?source=claude`, {
    method: 'POST',
    headers: { origin: own, cookie: 'k=v', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ done: true })
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    method: 'POST',
    path: '/api/sessions/abc/done?source=claude',
    body: '{"done":true}',
    origin: null,
    cookie: null,
    site: null
  })
  // AgentHydra's own answer, refusals included, comes back as it is.
  expect((await fetch(`${desk.url}/ah/api/missing`)).status).toBe(404)

  // A page on another local port is not Desk 2's (AgentHydra refuses those itself), nor is another site.
  const foreign: Record<string, string>[] = [{ origin: 'http://127.0.0.1:5173' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://example.com' }]
  for (const headers of foreign) {
    expect((await fetch(`${desk.url}/ah/api/accounts`, { method: 'POST', headers })).status).toBe(403)
  }
  expect(hydra.seen.map((s) => s.path)).toEqual(['/api/sessions/abc/done?source=claude', '/api/missing'])
})

test('AgentHydra down is a 503 that says where it was looked for', async () => {
  const url = await deadUrl()
  const desk = await boot(url)
  const res = await fetch(`${desk.url}/ah/api/sessions`)
  expect(res.status).toBe(503)
  expect((await res.json()).error).toContain(url)
})
