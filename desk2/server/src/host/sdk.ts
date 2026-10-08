// The Claude Agent SDK, loaded the first time a query runs here: its sdk.mjs is 1.2 MB, and a server start that
// runs no chat in this process (chats run in their hosts) never parses it. host/chat-host.ts imports it directly.

import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')

let loading: Promise<Sdk> | null = null

/** The SDK module, imported once. */
export function loadSdk(): Promise<Sdk> {
  loading ??= import('@anthropic-ai/claude-agent-sdk')
  return loading
}

/**
 * The SDK's query(), as a Query that starts once the SDK has loaded. Every Query method but close() already
 * returns a promise; close() before the load closes the query as soon as it exists.
 */
export function sdkQuery(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  const real = loadSdk().then((sdk) => sdk.query(params))
  real.catch(() => {}) // floor-ok: a failed load reaches every caller through its own call; this only keeps it from also being unhandled
  return new Proxy({} as Query, {
    get(_target, prop, receiver) {
      if (prop === Symbol.asyncIterator) return () => receiver
      if (prop === 'then') return undefined
      if (prop === 'close') return () => void real.then((q) => q.close(), () => {}) // floor-ok: a load that failed already rejects the query's next()
      return (...args: unknown[]) => real.then((q) => (q as unknown as Record<PropertyKey, (...a: unknown[]) => unknown>)[prop]!(...args))
    },
  })
}
