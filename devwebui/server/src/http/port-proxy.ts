// Port proxy: open any managed dev server through the daemon's own port instead of its own.
// Idea from coder/code-server's domain/path proxy (src/node/routes/domainProxy.ts, MIT), written
// fresh for DevWebUI. A request whose Host is `<target>.localhost:<daemon port>` is forwarded
// (HTTP here, WebSocket upgrades via upgradeProxySocket in server/src/index.ts) to
// the loopback port (IPv4 or IPv6, whichever answers) of the managed process `<target>` names;
// `/proxy/<target>/...` on the daemon's own origin redirects to that subdomain form.
//
// WHY a subdomain and not a path: a proxied page served under `localhost:<daemon>/proxy/...` would
// run on the DAEMON's origin, so any script in the user's dev server (or its npm deps) could call
// the unauthenticated /api/* same-origin. `<target>.localhost` is its own origin (browsers resolve
// every `*.localhost` to loopback, RFC 6761), which the CSRF guard already refuses on /api/*.
//
// WHY only managed ports: the daemon must not become a generic loopback relay. `<target>` resolves
// only to a port some registered process declares, never the daemon's own port.
import type { Context, Hono } from "hono";
import { evaluateRequest } from "../loopback-guard.mjs";
import type { Manager } from "../manager";

/** `web.localhost:4000` -> `web`; `p1a2b3c4.web.localhost` -> `p1a2b3c4.web`; else null. */
export function proxyLabelFromHost(host: string | undefined | null): string | null {
  if (!host) return null;
  const m = /^([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)\.localhost(?::\d+)?$/i.exec(host.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** Hostname-safe form of a project name, so `My App` is reachable as `my-app.localhost`. */
export function proxySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve a proxy target to the port of a managed process, or null. Tried in order: a literal
 * port some process declares, a full process id (`<projectId>.<localId>`), a project id or
 * slugged project name (its running port-bearing process first, else its first one), and a
 * process's in-file id when exactly one project has it.
 */
export function resolveProxyTarget(
  manager: Manager,
  target: string,
  ownPort?: number,
): number | null {
  const t = target.toLowerCase();
  const procs = manager.list().filter((p) => p.port && p.port !== ownPort);
  if (/^\d+$/.test(t)) {
    const port = Number(t);
    return procs.some((p) => p.port === port) ? port : null;
  }
  const byId = procs.find((p) => p.id.toLowerCase() === t);
  if (byId) return byId.port!;
  const projects = manager.listProjects();
  const project = projects.find((p) => p.id.toLowerCase() === t || proxySlug(p.name) === t);
  if (project) {
    const own = procs.filter((p) => p.projectId === project.id);
    return (own.find((p) => p.status === "running") ?? own[0])?.port ?? null;
  }
  const byLocal = procs.filter((p) => p.localId.toLowerCase() === t);
  return byLocal.length === 1 ? byLocal[0]!.port! : null;
}

/** Rewrite a `*.localhost` host to plain `localhost` so the shared guard, which knows only the
 *  exact loopback names, judges the proxied origin as the loopback it is. */
function unlabelHost(host: string | undefined): string | undefined {
  return host?.replace(/^[^/]*?\.localhost(?=(?::\d+)?$)/i, "localhost");
}

function unlabelOrigin(origin: string | undefined): string | undefined {
  if (!origin || origin === "null") return origin;
  try {
    const u = new URL(origin);
    return `${u.protocol}//${unlabelHost(u.host)}`;
  } catch {
    return origin; // unparseable: let the guard refuse it
  }
}

/** The shared CSRF guard's verdict for a proxied request (`*.localhost` counts as loopback). */
export function evaluateProxyRequest(req: Request): { ok: boolean; reason?: string } {
  const h = req.headers;
  return evaluateRequest({
    secFetchSite: h.get("sec-fetch-site") ?? undefined,
    origin: unlabelOrigin(h.get("origin") ?? undefined),
    host: unlabelHost(h.get("host") ?? new URL(req.url).host),
  });
}

// Hop-by-hop headers (RFC 9110 7.6.1) belong to one connection and must not be relayed.
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

// WHY both loopback families: Node 17+ resolves `localhost` to ::1 first on many hosts, so a dev
// server on its default host (Vite's is `localhost`) often listens on [::1] only, while others bind
// 127.0.0.1 only. The family that last answered on a port is tried first next time, sockets too.
const LOOPBACKS = ["127.0.0.1", "[::1]"];
const answeredOn = new Map<number, string>();

function loopbackOrder(port: number): string[] {
  const first = answeredOn.get(port);
  return first ? [first, ...LOOPBACKS.filter((h) => h !== first)] : LOOPBACKS;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** A refused request. A browser page load gets a one-click confirm page (code-server sends it to
 *  its login; DevWebUI has no login, so the user's own click is the proof of intent - the click
 *  is a same-origin navigation the guard accepts); anything else gets the guard's 403 JSON. */
function refuse(c: Context, label: string, reason: string): Response {
  const accept = c.req.header("accept") ?? "";
  if (c.req.method === "GET" && accept.includes("text/html")) {
    const url = new URL(c.req.url);
    const href = escapeHtml(`${url.pathname}${url.search}`);
    const name = escapeHtml(label);
    const body =
      `<!doctype html><meta charset="utf-8"><title>DevWebUI</title>` +
      `<p>Another site linked here. Open <b>${name}</b> through DevWebUI?</p>` +
      `<p><a href="${href}">Open ${name}</a></p>`;
    // Never framed: a cross-site iframe could otherwise clickjack the one proof-of-intent click.
    return c.html(body, 403, {
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
    });
  }
  return c.json({ error: `forbidden: ${reason}` }, 403);
}

async function forward(c: Context, port: number): Promise<Response> {
  const url = new URL(c.req.url);
  const headers = new Headers(c.req.raw.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  // Dev servers allow-list their own Host (Vite 6+ refuses others); keep the public one for apps
  // that build absolute URLs. Identity encoding: the runtime's fetch would otherwise decode the
  // body but leave Content-Encoding set, and the browser would decode it twice.
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  headers.set("host", `localhost:${port}`);
  headers.delete("accept-encoding");
  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
  // A refused connection moves on to the other loopback family; the body is teed so the retry
  // still has it, and the spare branch is dropped once a family answers.
  const hosts = loopbackOrder(port);
  let body = hasBody ? c.req.raw.body : null;
  let upstream: Response | undefined;
  for (const [i, host] of hosts.entries()) {
    let sent = body;
    if (body && i < hosts.length - 1) [sent, body] = body.tee();
    const init = {
      method: c.req.method,
      headers,
      body: sent ?? undefined,
      redirect: "manual",
      duplex: "half", // required to stream a request body
    } as RequestInit;
    try {
      upstream = await fetch(`http://${host}:${port}${url.pathname}${url.search}`, init);
      answeredOn.set(port, host);
      if (body && body !== sent) void body.cancel().catch(() => {});
      break;
    } catch {
      // try the next family
    }
  }
  if (!upstream) {
    const error = `nothing is answering on port ${port} - is the process running?`;
    return c.json({ error }, 502);
  }
  const out = new Headers(upstream.headers);
  for (const name of HOP_BY_HOP) out.delete(name);
  out.delete("content-encoding");
  out.delete("content-length");
  // A redirect to the dev server's own absolute origin stays inside the proxy.
  const location = out.get("location");
  if (location) {
    const ownOrigin = new RegExp(
      `^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=/|$)`,
      "i",
    );
    out.set("location", location.replace(ownOrigin, "") || "/");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

/**
 * Wire the port proxy into the app. MUST be registered before every other route and before the
 * /api/* guard: a `<target>.localhost` request (its /api/* paths included) belongs to the dev
 * server, never to the daemon's own routes.
 */
export function registerPortProxy(app: Hono, manager: Manager, ownPort?: number): void {
  app.use("*", async (c, next) => {
    const label = proxyLabelFromHost(c.req.header("host") ?? new URL(c.req.url).host);
    if (!label) return next();
    const verdict = evaluateProxyRequest(c.req.raw);
    if (!verdict.ok) return refuse(c, label, verdict.reason ?? "rejected");
    const port = resolveProxyTarget(manager, label, ownPort);
    if (port == null) {
      return c.json({ error: `no managed process with a port matches "${label}"` }, 404);
    }
    return forward(c, port);
  });

  // Path form: send the browser to the subdomain form so the proxied app gets its own origin.
  const redirect = (c: Context) => {
    const raw = c.req.param("target")!;
    const target = raw.toLowerCase();
    const hostSafe = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(target);
    if (!hostSafe || resolveProxyTarget(manager, target, ownPort) == null) {
      return c.json({ error: `no managed process with a port matches "${target}"` }, 404);
    }
    const url = new URL(c.req.url);
    const rest = url.pathname.slice(`/proxy/${raw}`.length) || "/";
    const port = url.port ? `:${url.port}` : "";
    return c.redirect(`${url.protocol}//${target}.localhost${port}${rest}${url.search}`, 307);
  };
  app.all("/proxy/:target", redirect);
  app.all("/proxy/:target/*", redirect);
}

// Bun upgrades a socket in Bun.serve's fetch, before Hono sees the request, so the WebSocket half
// is wired in server/src/index.ts. Structural types keep this file free of a bun-types dependency.

type WsMessage = string | ArrayBuffer | Uint8Array;

interface UpstreamSocket {
  readyState: number;
  binaryType: string;
  send(data: WsMessage): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: WsMessage }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

export interface ProxySocketData {
  port: number;
  /** Path and query to open on the upstream, e.g. `/?token=abc`. */
  path: string;
  protocols: string[];
  socket?: UpstreamSocket;
  queue: WsMessage[];
  clientClosed?: boolean;
}

interface ClientSocket {
  data: ProxySocketData;
  send(data: WsMessage): void;
  close(code?: number, reason?: string): void;
}

export interface UpgradeServer {
  upgrade(
    req: Request,
    options: { data: ProxySocketData; headers?: Record<string, string> },
  ): boolean;
}

/** Upgrade a WebSocket request addressed to a managed `<target>.localhost`; true when upgraded
 *  (the caller then returns nothing). Guard-refused or unresolved upgrades fall through to the
 *  app, which answers them with the same 403/404 as plain HTTP. */
export function upgradeProxySocket(
  req: Request,
  server: UpgradeServer,
  manager: Manager,
  ownPort?: number,
): boolean {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return false;
  const label = proxyLabelFromHost(req.headers.get("host") ?? new URL(req.url).host);
  if (!label || !evaluateProxyRequest(req).ok) return false;
  const port = resolveProxyTarget(manager, label, ownPort);
  if (port == null) return false;
  const url = new URL(req.url);
  const path = `${url.pathname}${url.search}`;
  const offered = req.headers.get("sec-websocket-protocol") ?? "";
  const protocols = offered.split(/\s*,\s*/).filter(Boolean);
  return server.upgrade(req, {
    data: { port, path, protocols, queue: [] },
    headers: protocols.length ? { "sec-websocket-protocol": protocols[0]! } : undefined,
  });
}

const SocketCtor = (
  globalThis as unknown as {
    WebSocket: new (url: string, protocols?: string[]) => UpstreamSocket;
  }
).WebSocket;
const OPEN = 1;

/** The upstream's close code as one a server may send on (RFC 6455 7.4): 1000 and 3000-4999 pass;
 *  the reserved ones (1004-1006, 1015) can throw in Bun, so a no-code or going-away close becomes
 *  1000 and anything else 1011. */
export function relayCloseCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  return code === 1001 || code === 1005 || code === 1006 ? 1000 : 1011;
}

/** Bun.serve `websocket` handlers that pipe a proxied client socket to its upstream. */
export const proxySocketHandlers = {
  open(ws: ClientSocket): void {
    const d = ws.data;
    const hosts = loopbackOrder(d.port);
    // One loopback family after the other, as for HTTP: an upstream that closes before it ever
    // opened on one family is retried on the next; only the last failure reaches the client.
    const connect = (i: number): void => {
      if (d.clientClosed) return;
      const host = hosts[i]!;
      const up = new SocketCtor(`ws://${host}:${d.port}${d.path}`, d.protocols);
      up.binaryType = "arraybuffer";
      d.socket = up;
      let opened = false;
      up.onopen = () => {
        opened = true;
        answeredOn.set(d.port, host);
        for (const m of d.queue.splice(0)) up.send(m);
      };
      up.onmessage = (ev) => ws.send(ev.data);
      up.onclose = (ev) => {
        if (opened) ws.close(relayCloseCode(ev.code), ev.reason);
        else if (i + 1 < hosts.length) connect(i + 1);
        else ws.close(1011, "upstream unreachable");
      };
      up.onerror = () => {
        if (opened) ws.close(1011, "upstream error");
      };
    };
    connect(0);
  },
  message(ws: ClientSocket, message: WsMessage): void {
    const up = ws.data.socket;
    if (up && up.readyState === OPEN) up.send(message);
    else ws.data.queue.push(message);
  },
  close(ws: ClientSocket): void {
    ws.data.clientClosed = true;
    ws.data.socket?.close();
  },
};
