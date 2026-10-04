// The ServerContext every plugin receives (SPEC.md "Server wiring").

import type { Hono } from 'hono'
import type { DeskSettings, ServerEvent } from '@shared/protocol'

export type HelloEvent = Extract<ServerEvent, { type: 'hello' }>
export type HelloProvider = () => HelloEvent | Promise<HelloEvent>

export interface ServerContext {
  /** The data home (HYDRA_DESK_HOME, default ~/.hydra-desk), created on start. */
  home: string
  version: string
  broadcast(event: ServerEvent): void
  settings(): DeskSettings
  /** Replaces the provider of the `hello` event each window gets on connect (the engine registers one). */
  registerHello(fn: HelloProvider): void
  wsClientCount(): number
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
