// Hydra Desk server: Hono routes, the /ws hub, plugins, and the built window in production.

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Hono, type MiddlewareHandler } from 'hono'
import type { ServerEvent } from '@shared/protocol'
import pkg from '../package.json'
import { type HelloProvider, type Plugin, type ServerContext, setContext, type WsRoute } from './context'
import { createSettingsStore, SettingsError } from './settings'
import { cacheControl } from './static-cache'
import { createWsHub, type WsClient } from './ws'

export const VERSION: string = pkg.version

const DEFAULT_PLUGINS_DIR = join(import.meta.dir, 'plugins')
const WEB_DIST = resolve(import.meta.dir, '../../web/dist')

export interface CreateServerOptions {
  port: number
  home: string
  /** Folder of plugin files (default server/src/plugins). */
  pluginsDir?: string
  /** Handed to plugins as ctx.deps (tests inject fakes here). */
  deps?: Record<string, unknown>
  /** Folder of the built window (default web/dist); served only when it exists. */
  webDist?: string
  hostname?: string
}

export interface DeskServer {
  url: string
  port: number
  ctx: ServerContext
  stop(): Promise<void>
}

/** The names this server answers to. A browser naming anything else is another site's page, or a DNS name
 *  rebound to this machine; either could otherwise drive every route here. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** `value` is a Host header (host[:port]) or, with `isOrigin`, an Origin (scheme://host[:port]); any port passes. */
function isLocalHost(value: string, isOrigin: boolean): boolean {
  if (!isOrigin && /[\s@/\\?#]/.test(value)) return false
  try {
    return LOCAL_HOSTS.has(new URL(isOrigin ? value : `http://${value}`).hostname)
  } catch {
    // 'null' (a file:// page, a sandboxed frame) and anything else unreadable is not this machine.
    return false
  }
}

/** Why a request must be refused, or null. Requests without these headers (curl, the SDK, tests) pass. */
export function foreignRequest(headers: Headers): string | null {
  const host = headers.get('host')
  if (host !== null && !isLocalHost(host, false)) return `this server only answers to 127.0.0.1 or localhost, not ${host}`
  const origin = headers.get('origin')
  if (origin !== null && !isLocalHost(origin, true)) return `requests from ${origin} are refused`
  if (headers.get('sec-fetch-site') === 'cross-site') return 'cross-site requests are refused'
  return null
}

/** Answers 403 to a request from another site or a rebound DNS name, before any route sees it. */
export const localOnly: MiddlewareHandler = async (c, next) => {
  const why = foreignRequest(c.req.raw.headers)
  if (why) return c.json({ error: why }, 403)
  await next()
}

/** Every *.ts file in dir (not .d.ts / .test.ts), sorted by file name. */
function pluginFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts'))
    .sort()
    .map((f) => join(dir, f))
}

async function loadPlugins(app: Hono, ctx: ServerContext, dir: string): Promise<void> {
  for (const file of pluginFiles(dir)) {
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: Plugin }
      if (typeof mod.default !== 'function') {
        console.error(`[plugins] ${file} has no default export function; skipped`)
        continue
      }
      await mod.default(app, ctx)
    } catch (err) {
      // One broken plugin must not take the others (or the window) down with it.
      console.error(`[plugins] ${file} failed to load:`, err)
    }
  }
}

function serveStatic(app: Hono, dist: string): void {
  const index = join(dist, 'index.html')
  app.get('*', async (c) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname)
    const file = resolve(dist, `.${path}`)
    if (file === dist || file.startsWith(dist + sep)) {
      const found = Bun.file(file)
      // One async stat: a folder or a missing file falls through to the window's index.
      const isFile = await found.stat().then((st) => st.isFile(), () => false)
      if (isFile) return new Response(found, { headers: { 'cache-control': cacheControl(path) } })
    }
    return new Response(Bun.file(index), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
  })
}

export async function createServer(opts: CreateServerOptions): Promise<DeskServer> {
  const home = resolve(opts.home)
  mkdirSync(home, { recursive: true })

  const hub = createWsHub()
  const settings = createSettingsStore(home)
  const stopHooks: (() => void | Promise<void>)[] = []
  const connectHooks: ((send: (event: ServerEvent) => void) => void)[] = []
  const wsRoutes = new Map<string, WsRoute>()
  const routeOf = (ws: WsClient) => (ws.data as { route: WsRoute; data: unknown } | undefined) ?? null
  let hello: HelloProvider = () => ({ type: 'hello', version: VERSION, chats: [], settings: settings.get() })

  const ctx: ServerContext = {
    home,
    version: VERSION,
    broadcast: hub.broadcast,
    settings: settings.get,
    registerHello: (fn) => {
      hello = fn
    },
    wsClientCount: hub.clientCount,
    onConnect: (fn) => void connectHooks.push(fn),
    wsRoute: (path, route) => void wsRoutes.set(path, route as WsRoute),
    onStop: (fn) => void stopHooks.push(fn),
    deps: opts.deps ?? {},
  }
  setContext(ctx)

  const app = new Hono()
  app.onError((err, c) => {
    console.error('[server]', err)
    return c.json({ error: err.message || String(err) }, 500)
  })
  // First, so it covers every route the plugins add and the built window.
  app.use('*', localOnly)

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }))
  app.get('/api/settings', (c) => c.json(settings.get()))
  app.put('/api/settings', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'the body must be JSON' }, 400)
    }
    try {
      const next = settings.update(body)
      hub.broadcast({ type: 'settings.update', settings: next })
      return c.json(next)
    } catch (err) {
      if (err instanceof SettingsError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

  await loadPlugins(app, ctx, opts.pluginsDir ?? DEFAULT_PLUGINS_DIR)

  app.all('/api/*', (c) => c.json({ error: `no route ${c.req.method} ${new URL(c.req.url).pathname}` }, 404))
  const dist = resolve(opts.webDist ?? WEB_DIST)
  if (existsSync(join(dist, 'index.html'))) serveStatic(app, dist)

  const server = Bun.serve<unknown>({
    port: opts.port,
    hostname: opts.hostname ?? '127.0.0.1',
    async fetch(req, srv) {
      const route = wsRoutes.get(new URL(req.url).pathname)
      if (route) {
        const why = foreignRequest(req.headers)
        if (why) return Response.json({ error: why }, { status: 403 })
        const accepted = await route.accept(req)
        if (accepted instanceof Response) return accepted
        if (srv.upgrade(req, { data: { route, data: accepted.data } })) return undefined
        return new Response('expected a websocket upgrade', { status: 426 })
      }
      if (new URL(req.url).pathname === '/ws') {
        // The upgrade does not go through Hono, so it gets the same guard here.
        const why = foreignRequest(req.headers)
        if (why) return Response.json({ error: why }, { status: 403 })
        if (srv.upgrade(req, { data: undefined })) return undefined
        return new Response('expected a websocket upgrade', { status: 426 })
      }
      return app.fetch(req)
    },
    websocket: {
      async open(ws: WsClient) {
        const own = routeOf(ws)
        if (own) return own.route.open(ws, own.data)
        hub.addClient(ws)
        try {
          hub.send(ws, await hello())
        } catch (err) {
          console.error('[ws] hello provider failed:', err)
        }
        for (const fn of connectHooks) {
          try {
            fn((event) => hub.send(ws, event))
          } catch (err) {
            console.error('[ws] connect hook failed:', err)
          }
        }
      },
      message(ws: WsClient, message) {
        // The hub's client only pings (ClientEvent); nothing to answer.
        const own = routeOf(ws)
        if (own) own.route.message(ws, own.data, message)
      },
      close(ws: WsClient) {
        const own = routeOf(ws)
        if (own) return own.route.close(ws, own.data)
        hub.removeClient(ws)
      },
    },
  })

  const port = server.port as number
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    ctx,
    async stop() {
      for (const fn of stopHooks.splice(0)) {
        try {
          await fn()
        } catch (err) {
          console.error('[server] stop hook failed:', err)
        }
      }
      await server.stop(true)
    },
  }
}

if (import.meta.main) {
  const port = Number(process.env.HYDRA_DESK_PORT) || 7798
  const home = process.env.HYDRA_DESK_HOME || join(homedir(), '.hydra-desk-2')
  const desk = await createServer({ port, home })
  console.log(`AgentHydra ${VERSION} on ${desk.url} (home ${home})`)
  const shutdown = async () => {
    await desk.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
