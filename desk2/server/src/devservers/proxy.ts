// "Show through the server manager": a running dev server opened inside Desk's pane when its own page refuses to be
// framed (X-Frame-Options, CSP frame-ancestors). Ported from DevWebUI's port proxy (devwebui/server/src/http/
// port-proxy.ts), with its reasoning:
//
// - /dw/proxy/<process id>/<rest> (own page only) answers a redirect to `<id>.localhost:<Desk port>/<rest>`, and a
//   request whose Host is `<id>.localhost` is the proxy proper (a HostRoute, context.ts): HTTP and websocket upgrades
//   (hot reload) go on to http://127.0.0.1:<the server's port> with X-Frame-Options and the frame-ancestors part of
//   a CSP removed from the answer.
// - WHY a name and not a path under /dw/proxy: the proxied page then has an origin of its own, so absolute asset
//   paths (/assets/x.js, /@vite/client) reach the server and not Desk, and its scripts, which are the project's and
//   its packages', are not on Desk's origin where they could call Desk's own API. Browsers resolve every
//   `*.localhost` to this machine (RFC 6761).
// - WHY only servers the service lists as up: Desk must not become a relay to any loopback port.
// The proxy host is answered before Desk's local-only guard (which refuses such names) and judges the request
// itself: a browser's Origin must be a loopback name; the port it reaches is one the service lists.

import type { Context } from 'hono'
import type { DevWebProcess, DevWebProject } from '@shared/devwebui'
import type { HostRoute, WsRoute } from '../context'
import type { DevServicesClient } from './client'

/** `p1a2b3c4.web.localhost:7798` -> `p1a2b3c4.web`; anything else null. */
export function proxyLabelFromHost(host: string | undefined | null): string | null {
  if (!host) return null
  const m = /^([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)\.localhost(?::\d+)?$/i.exec(host.trim())
  return m ? m[1]!.toLowerCase() : null
}

// Hop-by-hop headers (RFC 9110 7.6.1) belong to one connection and are not relayed.
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']

// Node 17+ resolves `localhost` to ::1 first, so a dev server on its default host often listens on [::1] only while
// others bind 127.0.0.1 only: the family that answered last on a port is tried first next time, sockets too.
const LOOPBACKS = ['127.0.0.1', '[::1]']
const answeredOn = new Map<number, string>()
function loopbackOrder(port: number): string[] {
  const first = answeredOn.get(port)
  return first ? [first, ...LOOPBACKS.filter((h) => h !== first)] : LOOPBACKS
}

/** A CSP without its frame-ancestors directive; null when nothing is left of it. */
export function withoutFrameAncestors(csp: string): string | null {
  const kept = csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d !== '' && !/^frame-ancestors(\s|$)/i.test(d))
  return kept.length ? kept.join('; ') : null
}

/** Why a browser request may not use the proxy, or null: a page from another local origin is not Desk's window. */
function refusal(headers: Headers): string | null {
  const origin = headers.get('origin')
  if (origin === null) return null
  try {
    const h = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h) || h.endsWith('.localhost')) return null
  } catch {
    // floor-ok: an Origin that is not a URL is refused below like any other
  }
  return `requests from ${origin} are refused`
}

const json = (error: string, status: number): Response => Response.json({ error }, { status })

async function forward(req: Request, port: number): Promise<Response> {
  const url = new URL(req.url)
  const headers = new Headers(req.headers)
  for (const name of HOP_BY_HOP) headers.delete(name)
  // Dev servers allow-list their own Host (Vite 6+ refuses others); the public one stays in x-forwarded-host.
  // Identity encoding: fetch would decode the body and leave Content-Encoding set, and the browser would decode twice.
  headers.set('x-forwarded-host', url.host)
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''))
  headers.set('host', `localhost:${port}`)
  headers.delete('accept-encoding')
  if (headers.has('origin')) headers.set('origin', `http://localhost:${port}`)
  const referer = headers.get('referer')
  if (referer) {
    try {
      const r = new URL(referer)
      headers.set('referer', `http://localhost:${port}${r.pathname}${r.search}`)
    } catch {
      headers.delete('referer')
    }
  }
  const hosts = loopbackOrder(port)
  // A refused connection moves on to the other loopback family; the body is teed so the retry still has it.
  let body = req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null
  let upstream: Response | undefined
  for (const [i, host] of hosts.entries()) {
    let sent = body
    if (body && i < hosts.length - 1) [sent, body] = body.tee()
    const init = { method: req.method, headers, body: sent ?? undefined, redirect: 'manual', duplex: 'half' } as RequestInit
    try {
      upstream = await fetch(`http://${host}:${port}${url.pathname}${url.search}`, init)
      answeredOn.set(port, host)
      if (body && body !== sent) void body.cancel().catch(() => {})
      break
    } catch {
      // try the next family
    }
  }
  if (!upstream) return json(`nothing is answering on port ${port}: is the server running?`, 502)
  const out = new Headers(upstream.headers)
  for (const name of HOP_BY_HOP) out.delete(name)
  out.delete('content-encoding')
  out.delete('content-length')
  out.delete('x-frame-options')
  const csp = out.get('content-security-policy')
  if (csp !== null) {
    const left = withoutFrameAncestors(csp)
    if (left) out.set('content-security-policy', left)
    else out.delete('content-security-policy')
  }
  // A redirect to the server's own absolute origin stays inside the proxy.
  const location = out.get('location')
  if (location) out.set('location', location.replace(new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=/|$)`, 'i'), '') || '/')
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out })
}

type WsMessage = string | ArrayBuffer | Uint8Array

interface UpstreamSocket {
  readyState: number
  binaryType: string
  send(data: WsMessage): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: WsMessage }) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  onerror: (() => void) | null
}

export interface ProxySocketData {
  port: number
  /** Path and query to open on the upstream, e.g. `/?token=abc`. */
  path: string
  protocols: string[]
  socket?: UpstreamSocket
  queue: WsMessage[]
  clientClosed?: boolean
}

const SocketCtor = (globalThis as unknown as { WebSocket: new (url: string, protocols?: string[]) => UpstreamSocket }).WebSocket
const OPEN = 1

/** The upstream's close code as one a server may send on (RFC 6455 7.4): 1000 and 3000-4999 pass; the reserved ones
 *  (1004-1006, 1015) can throw in Bun, so a no-code or going-away close becomes 1000 and anything else 1011. */
export function relayCloseCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code
  return code === 1001 || code === 1005 || code === 1006 ? 1000 : 1011
}

const socketRoute = (resolve: (req: Request) => Promise<number | Response>): WsRoute<ProxySocketData> => ({
  async accept(req) {
    const port = await resolve(req)
    if (port instanceof Response) return port
    const url = new URL(req.url)
    const protocols = (req.headers.get('sec-websocket-protocol') ?? '').split(/\s*,\s*/).filter(Boolean)
    return { data: { port, path: `${url.pathname}${url.search}`, protocols, queue: [] }, headers: protocols.length ? { 'sec-websocket-protocol': protocols[0]! } : undefined }
  },
  open(ws, d) {
    const hosts = loopbackOrder(d.port)
    // One loopback family after the other, as for HTTP: an upstream that closes before it ever opened on one family
    // is retried on the next; only the last failure reaches the client.
    const connect = (i: number): void => {
      if (d.clientClosed) return
      const host = hosts[i]!
      const up = new SocketCtor(`ws://${host}:${d.port}${d.path}`, d.protocols)
      up.binaryType = 'arraybuffer'
      d.socket = up
      let opened = false
      up.onopen = () => {
        opened = true
        answeredOn.set(d.port, host)
        for (const m of d.queue.splice(0)) up.send(m)
      }
      up.onmessage = (ev) => ws.send(ev.data)
      up.onclose = (ev) => {
        if (opened) ws.close(relayCloseCode(ev.code), ev.reason)
        else if (i + 1 < hosts.length) connect(i + 1)
        else ws.close(1011, 'upstream unreachable')
      }
      up.onerror = () => {
        if (opened) ws.close(1011, 'upstream error')
      }
    }
    connect(0)
  },
  message(_ws, d, message) {
    const up = d.socket
    if (up && up.readyState === OPEN) up.send(message)
    else d.queue.push(message)
  },
  close(_ws, d) {
    d.clientClosed = true
    d.socket?.close()
  }
})

const FIND_MS = 3000

export interface DevProxy {
  /** Register with ctx.hostRoute: every `<id>.localhost` request, HTTP and websocket. */
  hostRoute: HostRoute
  /** The /dw/proxy/:id/* route (own page checked by the caller): a redirect to the `<id>.localhost` name. */
  redirect(c: Context): Promise<Response>
}

export function createDevProxy(client: DevServicesClient, base: string): DevProxy {
  /** Lower-cased process id -> port of every server listed as up: ids are case-sensitive, host names are not. */
  let table: { at: number; ports: Map<string, number> } | null = null
  const portOfLabel = async (label: string): Promise<number | null> => {
    if (!table || Date.now() - table.at > FIND_MS) {
      // Never starts the service: with none running no server is up.
      const res = await client.peek('/api/projects')
      if (!res?.ok) {
        table = null
        return null
      }
      const ports = new Map<string, number>()
      for (const p of (await res.json()) as DevWebProject[]) {
        for (const proc of p.processes ?? []) if (proc.status === 'running' && typeof proc.port === 'number') ports.set(proc.id.toLowerCase(), proc.port)
      }
      table = { at: Date.now(), ports }
    }
    return table.ports.get(label) ?? null
  }

  const resolve = async (req: Request): Promise<number | Response> => {
    const label = proxyLabelFromHost(req.headers.get('host'))
    if (!label) return json('not a proxy host', 404)
    const why = refusal(req.headers)
    if (why) return json(why, 403)
    const port = await portOfLabel(label)
    return port ?? json(`no running server named ${label} (is it started, and does it have a port?)`, 404)
  }

  const hostRoute: HostRoute = {
    match: (host) => proxyLabelFromHost(host) !== null,
    async fetch(req) {
      const port = await resolve(req)
      return port instanceof Response ? port : forward(req, port)
    },
    ws: socketRoute(resolve) as WsRoute
  }

  const redirect = async (c: Context): Promise<Response> => {
    const raw = c.req.param('id') ?? ''
    if (!/^[a-zA-Z0-9]+(?:[._-]+[a-zA-Z0-9]+)*$/.test(raw)) return c.json({ error: `${raw} is not a server id` }, 400)
    const res = await client.peek(`/api/processes/${encodeURIComponent(raw)}`)
    if (!res) return c.json({ error: 'the dev-servers service is not running' }, 503)
    if (res.status === 404) return c.json({ error: `no server ${raw}` }, 404)
    const proc = res.ok ? ((await res.json()) as DevWebProcess) : null
    if (!proc || proc.status !== 'running' || typeof proc.port !== 'number') return c.json({ error: `${proc?.name ?? raw} is not running, or has no port to show` }, 409)
    const url = new URL(c.req.url)
    const rest = url.pathname.slice(`${base}/${raw}`.length) || '/'
    return c.redirect(`${url.protocol}//${raw.toLowerCase()}.localhost${url.port ? `:${url.port}` : ''}${rest}${url.search}`, 307)
  }

  return { hostRoute, redirect }
}
