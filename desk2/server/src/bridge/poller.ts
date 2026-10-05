// While at least one window is connected: every 3 s read outside sessions and CliMayte workers, every
// 30 s the accounts, and broadcast each list only when it changed. bridge.status goes out when
// AgentHydra goes up or down (and on the first poll after a window connects). Down = empty lists.
// A window that connects is sent the last of each at once (welcome): broadcasts carry changes only, so
// a window joining one already open, or reloaded before the old one closed, would otherwise show no
// sessions until one of them next changed (Michael, 2026-10-04: a refresh showed none).

import type { ServerEvent } from '@shared/protocol'
import { DEFAULT_ACCOUNT_INFO } from './accounts'
import type { Bridge } from './index'

export const FAST_POLL_MS = 3000
export const ACCOUNTS_POLL_MS = 30_000
/** While nothing runs anywhere, the timer polls this often instead (a window opening still polls at once). */
export const IDLE_POLL_MS = 9000

/** Structural equality of two JSON-shaped values, without building a string of either. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const arr = b as unknown[]
    if (a.length !== arr.length) return false
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], arr[i])) return false
    return true
  }
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = Object.keys(x)
  if (keys.length !== Object.keys(y).length) return false
  for (const k of keys) if (!(k in y) || !sameJson(x[k], y[k])) return false
  return true
}

export interface PollerOptions {
  bridge: Pick<Bridge, 'url' | 'ping' | 'externalSessions' | 'workers' | 'listAccounts'>
  broadcast(event: ServerEvent): void
  wsClientCount(): number
  fastMs?: number
  accountsMs?: number
  idleMs?: number
  now?: () => number
}

export function createPoller(o: PollerOptions) {
  const fastMs = o.fastMs ?? FAST_POLL_MS
  const accountsMs = o.accountsMs ?? ACCOUNTS_POLL_MS
  const idleMs = o.idleMs ?? IDLE_POLL_MS
  const now = o.now ?? Date.now
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  let clients = 0
  let up: boolean | null = null
  let accountsAt = 0
  /** The last event broadcast for each type: compared structurally, so no list is stringified to find out it did not change. */
  const sent = new Map<string, ServerEvent>()
  let idle = false
  let polledAt = 0
  /** The newest event of each type, for a window that connects later (welcome). */
  const latest = new Map<string, ServerEvent>()

  function remember(event: ServerEvent): void {
    latest.set(event.type, event)
  }

  /** Broadcast when the payload differs from the last one sent for this event type. */
  function emitIfChanged(event: ServerEvent): void {
    remember(event)
    const prev = sent.get(event.type)
    if (prev && sameJson(prev, event)) return
    sent.set(event.type, event)
    o.broadcast(event)
  }

  async function poll(): Promise<void> {
    const n = o.wsClientCount()
    if (n === 0) {
      clients = 0
      idle = false
      return
    }
    if (clients === 0) {
      // A window (re)connected after none were: it gets everything once, then changes only.
      sent.clear()
      up = null
      accountsAt = 0
    }
    clients = n

    const isUp = await o.bridge.ping()
    const flipped = isUp !== up
    if (flipped) {
      up = isUp
      const status: ServerEvent = { type: 'bridge.status', up: isUp, url: o.bridge.url }
      remember(status)
      o.broadcast(status)
    }

    if (!isUp) {
      idle = false
      emitIfChanged({ type: 'external.update', sessions: [] })
      emitIfChanged({ type: 'climayte.update', workers: [] })
      emitIfChanged({ type: 'accounts.update', accounts: [DEFAULT_ACCOUNT_INFO] })
      accountsAt = 0
      return
    }

    const dueAccounts = flipped || now() - accountsAt >= accountsMs
    const [sessions, workers, accounts] = await Promise.all([
      o.bridge.externalSessions().catch(() => null),
      o.bridge.workers().catch(() => null),
      dueAccounts ? o.bridge.listAccounts().catch(() => null) : Promise.resolve(null),
    ])
    // A read that failed for another reason than "down" keeps the last list rather than blanking it.
    if (sessions) emitIfChanged({ type: 'external.update', sessions })
    if (workers) emitIfChanged({ type: 'climayte.update', workers })
    // Nothing running (and both reads answered): the timer can rest between polls.
    idle = !!sessions && !!workers && !sessions.some((x) => x.status === 'working' || x.status === 'needs_you') && !workers.some((w) => w.active)
    if (accounts) {
      accountsAt = now()
      emitIfChanged({ type: 'accounts.update', accounts })
    }
  }

  /** One poll; overlapping calls (a slow AgentHydra) are skipped, never stacked. */
  async function tick(): Promise<void> {
    if (running) return
    running = true
    polledAt = now()
    try {
      await poll()
    } catch (err) {
      console.error('[bridge] poll failed:', err)
    } finally {
      running = false
    }
  }

  return {
    tick,
    /**
     * A window just connected: while others were being served it gets the last status and lists on its
     * own (they are one poll old at most); then a poll runs now rather than at the next interval, and
     * anything newer goes to every window as usual. After a spell with none, `latest` may be an hour
     * old, and that poll sends everything fresh anyway (sent is cleared), so nothing is replayed.
     */
    welcome(send: (event: ServerEvent) => void): void {
      if (clients > 0) for (const e of latest.values()) send(e)
      void tick()
    },
    start(): void {
      if (timer) return
      timer = setInterval(() => {
        if (idle && now() - polledAt < idleMs - fastMs / 2) return
        void tick()
      }, fastMs)
      void tick()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

export type Poller = ReturnType<typeof createPoller>
