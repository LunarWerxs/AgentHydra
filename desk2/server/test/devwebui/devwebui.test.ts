// plugins/50-devwebui.ts and devservers/client.ts against a fake dev-servers service (a Bun.serve that checks the
// token, as service.ts does): /dw/api/* and /dw/folder go on with the service's token and none of the page's
// provenance, a service that is not running is started once however many ask and never by /dw/status, a stale one is
// replaced only while it runs nothing, a dead one is replaced and the request retried, and /dw/proxy shows a running
// server through the `<id>.localhost` name with its frame-blocking headers removed. No real service process runs.

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDevServicesClient, type ClientDeps, type DevServicesClient } from '../../src/devservers/client'
import { serviceFilePath } from '../../src/devservers/service'
import { createServer, type DeskServer } from '../../src/index'

const PLUGINS = join(import.meta.dir, '..', '..', 'src', 'plugins')
const temps: string[] = []
const stops: (() => unknown)[] = []
const savedHome = process.env.HYDRA_DESK_HOME
let pids = 4200

/** Headers as a plain object (this lib has no iterable Headers). */
function plain(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((v, k) => {
    out[k] = v
  })
  return out
}

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env.HYDRA_DESK_HOME
  else process.env.HYDRA_DESK_HOME = savedHome
})

interface Seen {
  method: string
  path: string
  body: string
  headers: Record<string, string>
}

/** A dev-servers service: refuses a request without its token, answers /health, records every other request. */
function fakeService(o: { stamp?: string; running?: number; projects?: unknown[] } = {}) {
  const token = `tok-${Math.random().toString(16).slice(2)}`
  const pid = pids++
  const seen: Seen[] = []
  const projects = o.projects ?? []
  const srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      if (req.headers.get('authorization') !== `Bearer ${token}`) return Response.json({ error: 'unauthorized' }, { status: 401 })
      if (u.pathname === '/health') return Response.json({ ok: true, pid, stamp: o.stamp ?? 'new', running: o.running ?? 0 })
      seen.push({ method: req.method, path: u.pathname + u.search, body: await req.text(), headers: plain(req.headers) })
      if (u.pathname === '/api/projects') return Response.json(projects)
      const one = /^\/api\/processes\/([^/]+)$/.exec(u.pathname)
      if (one) {
        const proc = (projects as { processes: { id: string }[] }[]).flatMap((p) => p.processes).find((p) => p.id === decodeURIComponent(one[1]!))
        return proc ? Response.json(proc) : Response.json({ error: 'no such server' }, { status: 404 })
      }
      return Response.json({ echo: u.pathname + u.search })
    }
  })
  stops.push(() => srv.stop(true))
  return {
    pid,
    port: srv.port as number,
    seen,
    stop: () => srv.stop(true),
    /** service.json, as the real service writes it once it listens. */
    publish(home: string) {
      mkdirSync(join(home, 'devservers'), { recursive: true })
      writeFileSync(serviceFilePath(home), JSON.stringify({ pid, port: srv.port, token, startedAt: 1, stamp: o.stamp ?? 'new' }))
    }
  }
}

type Fake = ReturnType<typeof fakeService>

/** A client whose launch counts and brings `next` up after a moment, as a real start would. */
function newClient(home: string, next?: Fake, o: Partial<ClientDeps> = {}): { client: DevServicesClient; launches: () => number } {
  let launches = 0
  const client = createDevServicesClient({
    home,
    stamp: () => 'new',
    alive: () => false,
    kill: () => {},
    startWaitMs: 5000,
    launch: async () => {
      launches++
      await Bun.sleep(150)
      if (!next) throw new Error('no service to start in this test')
      next.publish(home)
    },
    ...o
  })
  return { client, launches: () => launches }
}

async function boot(client: DevServicesClient, home: string): Promise<DeskServer> {
  const plugins = temp('desk-dw-plugins-')
  writeFileSync(join(plugins, '50-devwebui.ts'), `export { default } from ${JSON.stringify(pathToFileURL(join(PLUGINS, '50-devwebui.ts')).href)}\n`)
  process.env.HYDRA_DESK_HOME = home
  const desk = await createServer({ port: 0, home, pluginsDir: plugins, deps: { devservers: client } })
  stops.push(() => desk.stop())
  return desk
}

const ownPage = (desk: DeskServer): Record<string, string> => ({ origin: new URL(desk.url).origin, 'sec-fetch-site': 'same-origin' })
const status = async (desk: DeskServer) => (await fetch(`${desk.url}/dw/status`)).json() as Promise<Record<string, unknown>>

test('/dw/api/* reaches the service with its path, query, body and token, and none of the page', async () => {
  const home = temp('desk-dw-home-')
  const svc = fakeService()
  svc.publish(home)
  const desk = await boot(newClient(home).client, home)
  const res = await fetch(`${desk.url}/dw/api/processes/p1.web/start?x=1`, {
    method: 'POST',
    body: '{"a":1}',
    headers: { 'content-type': 'application/json', authorization: 'Bearer from-the-page', cookie: 'a=b', referer: `${desk.url}/`, ...ownPage(desk) }
  })
  expect(res.status).toBe(200)
  const sent = svc.seen.at(-1)!
  expect(sent).toMatchObject({ method: 'POST', path: '/api/processes/p1.web/start?x=1', body: '{"a":1}' })
  expect(sent.headers.authorization).toMatch(/^Bearer tok-/)
  expect(sent.headers.authorization).not.toContain('from-the-page')
  for (const h of ['origin', 'referer', 'cookie', 'sec-fetch-site']) expect(sent.headers[h]).toBeUndefined()
})

test("the service's token never reaches the page", async () => {
  const home = temp('desk-dw-home-')
  const svc = fakeService()
  svc.publish(home)
  const desk = await boot(newClient(home).client, home)
  const res = await fetch(`${desk.url}/dw/api/projects`)
  const token = svc.seen[0]!.headers.authorization!.replace('Bearer ', '')
  const shown = JSON.stringify(plain(res.headers)) +(await res.text()) + JSON.stringify(await status(desk))
  expect(shown).not.toContain(token)
})

test('a browser request from another page is refused before anything is started or forwarded', async () => {
  const home = temp('desk-dw-home-')
  const svc = fakeService()
  const { client, launches } = newClient(home, svc)
  const desk = await boot(client, home)
  const foreign = { origin: 'http://localhost:9999' }
  for (const [path, init] of [
    ['/dw/api/projects', { headers: foreign }],
    ['/dw/api/projects', { headers: { 'sec-fetch-site': 'same-site' } }],
    ['/dw/status', { headers: foreign }],
    ['/dw/folder', { method: 'POST', headers: { ...foreign, 'content-type': 'application/json' }, body: '{"cwd":"C:/Users/me/site"}' }],
    ['/dw/service', { method: 'POST', headers: { ...foreign, 'content-type': 'application/json' }, body: '{"action":"start"}' }],
    ['/dw/proxy/p1.web/', { headers: foreign }]
  ] as const) {
    expect((await fetch(`${desk.url}${path}`, init)).status).toBe(403)
  }
  expect(launches()).toBe(0)
  expect(svc.seen).toHaveLength(0)
})

test('/dw/status says where the service stands and never starts it', async () => {
  const home = temp('desk-dw-home-')
  const svc = fakeService()
  const { client, launches } = newClient(home, svc)
  const desk = await boot(client, home)
  expect(await status(desk)).toEqual({ state: 'stopped', pid: null })
  expect(await status(desk)).toEqual({ state: 'stopped', pid: null })
  expect(launches()).toBe(0)
  svc.publish(home)
  expect(await status(desk)).toEqual({ state: 'running', pid: svc.pid, running: 0 })
  expect(launches()).toBe(0)
})

test('requests that come while the service is down start it once, and all reach it', async () => {
  const home = temp('desk-dw-home-')
  const svc = fakeService()
  const { client, launches } = newClient(home, svc)
  const desk = await boot(client, home)
  const ask = () => fetch(`${desk.url}/dw/api/projects`).then((r) => r.status)
  expect(await Promise.all([ask(), ask(), ask()])).toEqual([200, 200, 200])
  expect(launches()).toBe(1)
  expect(svc.seen.filter((s) => s.path === '/api/projects')).toHaveLength(3)
  expect(await ask()).toBe(200)
  expect(launches()).toBe(1)
})

test('a start that fails answers 503 with why, and /dw/status says failed', async () => {
  const home = temp('desk-dw-home-')
  const { client } = newClient(home, undefined, {
    launch: () => {
      throw new Error('the dev-servers service could not start')
    }
  })
  const desk = await boot(client, home)
  const res = await fetch(`${desk.url}/dw/api/projects`)
  expect(res.status).toBe(503)
  expect(((await res.json()) as { error: string }).error).toContain('the dev-servers service could not start')
  expect(await status(desk)).toEqual({ state: 'failed', pid: null, reason: 'the dev-servers service could not start' })
})

test('a service that runs older code and no server is replaced before the request is forwarded', async () => {
  const home = temp('desk-dw-home-')
  const old = fakeService({ stamp: 'old', running: 0 })
  const fresh = fakeService({ stamp: 'new' })
  old.publish(home)
  const { client, launches } = newClient(home, fresh)
  const desk = await boot(client, home)
  expect((await fetch(`${desk.url}/dw/api/projects`)).status).toBe(200)
  expect(launches()).toBe(1)
  expect(old.seen.map((s) => s.path)).toEqual(['/api/shutdown'])
  expect(fresh.seen.map((s) => s.path)).toEqual(['/api/projects'])
})

test('a stale service that runs servers is left alone, and /dw/status says stale', async () => {
  const home = temp('desk-dw-home-')
  const old = fakeService({ stamp: 'old', running: 2 })
  old.publish(home)
  const { client, launches } = newClient(home, fakeService())
  const desk = await boot(client, home)
  expect((await fetch(`${desk.url}/dw/api/projects`)).status).toBe(200)
  expect(launches()).toBe(0)
  expect(old.seen.map((s) => s.path)).toEqual(['/api/projects'])
  expect(await status(desk)).toEqual({ state: 'running', pid: old.pid, running: 2, stale: true })
})

test('a service that died after it was seen is replaced and the request is sent once more', async () => {
  const home = temp('desk-dw-home-')
  const first = fakeService()
  const second = fakeService()
  first.publish(home)
  const { client, launches } = newClient(home, second)
  const desk = await boot(client, home)
  expect((await fetch(`${desk.url}/dw/api/projects`)).status).toBe(200)
  first.stop() // its service.json stays, as after a crash
  const res = await fetch(`${desk.url}/dw/api/projects`, { method: 'POST', body: '{"b":2}', headers: { 'content-type': 'application/json' } })
  expect(res.status).toBe(200)
  expect(launches()).toBe(1)
  expect(second.seen.at(-1)).toMatchObject({ method: 'POST', path: '/api/projects', body: '{"b":2}' })
})

test('POST /dw/service starts, stops and restarts it; anything else is a 400', async () => {
  const home = temp('desk-dw-home-')
  const svc = fakeService()
  const { client, launches } = newClient(home, svc)
  const desk = await boot(client, home)
  const act = (action: string) => fetch(`${desk.url}/dw/service`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })

  expect((await act('explode')).status).toBe(400)
  expect(await (await act('start')).json()).toEqual({ state: 'running', pid: svc.pid, running: 0 })
  expect(launches()).toBe(1)

  expect(await (await act('stop')).json()).toEqual({ state: 'stopped', pid: null })
  expect(JSON.parse(svc.seen.at(-1)!.body)).toEqual({ restart: false })
  expect(svc.seen.at(-1)!.path).toBe('/api/shutdown')
  expect(existsSync(serviceFilePath(home))).toBe(false)

  svc.publish(home)
  await act('restart')
  expect(JSON.parse(svc.seen.at(-1)!.body)).toEqual({ restart: true })
})

test('/dw/folder passes the folder on, and wants a cwd', async () => {
  const home = temp('desk-dw-home-')
  const svc = fakeService()
  svc.publish(home)
  const desk = await boot(newClient(home).client, home)
  const post = (body: unknown) => fetch(`${desk.url}/dw/folder`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect(await (await post({ cwd: 'C:/Users/me/site' })).json()).toEqual({ echo: '/api/folder' })
  expect(svc.seen.at(-1)).toMatchObject({ method: 'POST', path: '/api/folder', body: '{"cwd":"C:/Users/me/site"}' })
  expect((await post({ cwd: '' })).status).toBe(400)
})

// --- /dw/proxy: a running server through Desk -----------------------------------------------------------------

/** What a dev server answers: a page that refuses framing, and a record of how it was asked. */
function fakeDevServer() {
  const seen: { host: string | null; origin: string | null; path: string }[] = []
  const srv: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req): Response {
      const u = new URL(req.url)
      seen.push({ host: req.headers.get('host'), origin: req.headers.get('origin'), path: u.pathname + u.search })
      if (u.pathname === '/moved') return new Response(null, { status: 302, headers: { location: `http://localhost:${srv.port}/landed` } })
      return new Response('hello from the dev server', {
        headers: { 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'content-type': 'text/html' }
      })
    }
  })
  stops.push(() => srv.stop(true))
  return { port: srv.port as number, seen }
}

/** A GET with a Host header of our own choosing (fetch would not take it). */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers, method: 'GET' }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

const web = (port: number, status = 'running') => ({ id: 'p1a2b3c4.Web', localId: 'Web', name: 'Web', status, port })

test('/dw/proxy/<id>/ sends the page to the server\'s own `<id>.localhost` name, and only for a server that runs', async () => {
  const home = temp('desk-dw-home-')
  const dev = fakeDevServer()
  const svc = fakeService({
    projects: [{ id: 'p1a2b3c4', name: 'Site', processes: [web(dev.port), { id: 'p1a2b3c4.idle', localId: 'idle', name: 'Idle', status: 'stopped', port: 4999 }] }]
  })
  svc.publish(home)
  const desk = await boot(newClient(home).client, home)
  const res = await fetch(`${desk.url}/dw/proxy/p1a2b3c4.Web/deep/page?x=1`, { redirect: 'manual', headers: ownPage(desk) })
  expect(res.status).toBe(307)
  expect(res.headers.get('location')).toBe(`http://p1a2b3c4.web.localhost:${new URL(desk.url).port}/deep/page?x=1`)

  expect((await fetch(`${desk.url}/dw/proxy/p1a2b3c4.idle/`, { redirect: 'manual' })).status).toBe(409)
  expect((await fetch(`${desk.url}/dw/proxy/p1a2b3c4.nope/`, { redirect: 'manual' })).status).toBe(404)
})

test('a request for `<id>.localhost` is relayed to the server with X-Frame-Options and frame-ancestors removed', async () => {
  const home = temp('desk-dw-home-')
  const dev = fakeDevServer()
  const svc = fakeService({ projects: [{ id: 'p1a2b3c4', name: 'Site', processes: [web(dev.port), { id: 'p1a2b3c4.idle', localId: 'idle', name: 'Idle', status: 'stopped', port: 4999 }] }] })
  svc.publish(home)
  const desk = await boot(newClient(home).client, home)
  const port = Number(new URL(desk.url).port)
  const host = `p1a2b3c4.web.localhost:${port}`

  const ok = await rawGet(port, '/assets/app.js?v=2', { host })
  expect(ok.status).toBe(200)
  expect(ok.body).toBe('hello from the dev server')
  expect(ok.headers['x-frame-options']).toBeUndefined()
  expect(ok.headers['content-security-policy']).toBe("default-src 'self'")
  expect(dev.seen.at(-1)).toMatchObject({ path: '/assets/app.js?v=2', host: `localhost:${dev.port}` })

  // A redirect to the server's own address stays inside the proxy name.
  const moved = await rawGet(port, '/moved', { host })
  expect(moved.headers.location).toBe('/landed')

  // Only a server the service lists as up: not a stopped one, not an unknown name, and never a page from elsewhere.
  const seenBefore = dev.seen.length
  expect((await rawGet(port, '/', { host: `p1a2b3c4.idle.localhost:${port}` })).status).toBe(404)
  expect((await rawGet(port, '/', { host: `unknown.localhost:${port}` })).status).toBe(404)
  expect((await rawGet(port, '/', { host, origin: 'https://example.com' })).status).toBe(403)
  expect(dev.seen).toHaveLength(seenBefore)
})

test('Desk itself still refuses a `localhost` name it does not know, and the proxy name is not a way into its API', async () => {
  const home = temp('desk-dw-home-')
  const dev = fakeDevServer()
  const svc = fakeService({ projects: [{ id: 'p1a2b3c4', name: 'Site', processes: [web(dev.port)] }] })
  svc.publish(home)
  const desk = await boot(newClient(home).client, home)
  const port = Number(new URL(desk.url).port)
  // The proxy name reaches the dev server, not Desk's own /dw/api: its answer is the server's page.
  const viaProxy = await rawGet(port, '/dw/api/processes/p1a2b3c4.Web/stop', { host: `p1a2b3c4.web.localhost:${port}` })
  expect(viaProxy.body).toBe('hello from the dev server')
  expect(svc.seen.some((s) => s.path.endsWith('/stop'))).toBe(false)
  // Any other foreign host is refused by Desk's guard as before.
  expect((await rawGet(port, '/dw/status', { host: 'evil.example.com' })).status).toBe(403)
})
