// The ServerContext every plugin receives (SPEC.md "Server wiring").

import type { ServerWebSocket } from 'bun'
import type { Hono } from 'hono'
import type { DeskSettings, ServerEvent } from '@shared/protocol'

export type HelloEvent = Extract<ServerEvent, { type: 'hello' }>
export type HelloProvider = () => HelloEvent | Promise<HelloEvent>

/** A plugin's own websocket path (besides the /ws hub). `T` is what accept hands on to the socket's handlers. */
export interface WsRoute<T = unknown> {
  /** After the local-only guard: a Response refuses the upgrade, otherwise `data` goes to open/message/close. */
  accept(req: Request): Response | { data: T; headers?: Record<string, string> } | Promise<Response | { data: T; headers?: Record<string, string> }>
  open(ws: ServerWebSocket<unknown>, data: T): void
  message(ws: ServerWebSocket<unknown>, data: T, message: string | Buffer): void
  close(ws: ServerWebSocket<unknown>, data: T): void
}

/**
 * A route chosen by the request's Host header instead of its path: `<label>.localhost:<port>` names, which a browser
 * resolves to this machine and gives an origin of their own (the dev-server proxy, devservers/proxy.ts). It runs
 * before the local-only guard and the app, so it must judge the request itself.
 */
export interface HostRoute {
  /** True for a Host header (host[:port]) this route serves. */
  match(host: string): boolean
  fetch(req: Request): Response | Promise<Response>
  /** Its websocket upgrades. */
  ws: WsRoute
}

export interface ServerContext {
  /** The data home (HYDRA_DESK_HOME, default ~/.hydra-desk-2), created on start. */
  home: string
  version: string
  broadcast(event: ServerEvent): void
  settings(): DeskSettings
  /** Replaces the provider of the `hello` event each window gets on connect (the engine registers one). */
  registerHello(fn: HelloProvider): void
  wsClientCount(): number
  /** Windows connected to /ws and on screen; one that never said counts as on screen. */
  wsVisibleCount(): number
  /** Runs fn whenever wsVisibleCount changes; returns its unsubscribe. */
  onWsVisibility(fn: (visible: number) => void): () => void
  /** Runs fn for each window that connects, after its `hello`; `send` reaches that window alone. */
  onConnect(fn: (send: (event: ServerEvent) => void) => void): void
  /** Serves a websocket at `path` (exact match) with its own handlers instead of the /ws hub's. */
  wsRoute<T>(path: string, route: WsRoute<T>): void
  /** Serves every request whose Host header `route.match`es, HTTP and websocket, ahead of everything else. */
  hostRoute(route: HostRoute): void
  /** The base URL this server listens on (http://127.0.0.1:<bound port>), once it is bound. */
  url(): string
  /** Runs fn when the server stops (close runtimes, stop pollers). */
  onStop(fn: () => void | Promise<void>): void
  /** Whatever createServer({ deps }) was given: tests inject fakes here, plugins read them first. */
  deps: Record<string, unknown>
}

export type Plugin = (app: Hono, ctx: ServerContext) => void | Promise<void>

/** The context of the server started last in this process (the real app runs exactly one). */
export let ctx: ServerContext

export function setContext(next: ServerContext): void {
  ctx = next
}
