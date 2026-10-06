// The ServerContext every plugin receives (SPEC.md "Server wiring").

import type { ServerWebSocket } from 'bun'
import type { Hono } from 'hono'
import type { DeskSettings, ServerEvent } from '@shared/protocol'

export type HelloEvent = Extract<ServerEvent, { type: 'hello' }>
export type HelloProvider = () => HelloEvent | Promise<HelloEvent>

/** A plugin's own websocket path (besides the /ws hub). `T` is what accept hands on to the socket's handlers. */
export interface WsRoute<T = unknown> {
  /** After the local-only guard: a Response refuses the upgrade, otherwise `data` goes to open/message/close. */
  accept(req: Request): Response | { data: T } | Promise<Response | { data: T }>
  open(ws: ServerWebSocket<unknown>, data: T): void
  message(ws: ServerWebSocket<unknown>, data: T, message: string | Buffer): void
  close(ws: ServerWebSocket<unknown>, data: T): void
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
  /** Runs fn for each window that connects, after its `hello`; `send` reaches that window alone. */
  onConnect(fn: (send: (event: ServerEvent) => void) => void): void
  /** Serves a websocket at `path` (exact match) with its own handlers instead of the /ws hub's. */
  wsRoute<T>(path: string, route: WsRoute<T>): void
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
