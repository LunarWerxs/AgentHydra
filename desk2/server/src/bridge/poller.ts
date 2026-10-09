// While at least one window is connected: every 3 s read outside sessions and CliMayte workers, every
// 30 s the accounts, and broadcast each list only when it changed. bridge.status goes out when
// AgentHydra goes up or down (and on the first poll that reaches it after a window connects). Down = empty lists.
// AgentHydra out of reach for less than DOWN_GRACE_MS is not down: its relaunch after an update or a
// stalled event loop kept emptying the sidebar and filling it again (owner, 2026-10-09: chats "mass
// disappear, then they mass reappear"), so the lists stand, answered from their last read meanwhile (a
// window that just connected keeps the lists it painted from its cache).
// A window that connects is sent the last of each at once (welcome): broadcasts carry changes only, so
// a window joining one already open, or reloaded before the old one closed, would otherwise show no
// sessions until one of them next changed (Michael, 2026-10-04: a refresh showed none).

import type { ServerEvent } from '@shared/protocol'
import { DEFAULT_ACCOUNT_INFO } from './accounts'
import { BridgeError } from './client'
import type { Bridge } from './index'

export const FAST_POLL_MS = 3000
export const ACCOUNTS_POLL_MS = 30_000
/** While nothing runs anywhere, the timer polls this often instead (a window opening still polls at once). */
export const IDLE_POLL_MS = 9000
/** While windows are connected but none is on screen; one coming back on screen polls at once. */
export const HIDDEN_POLL_MS = 30_000
/** How long AgentHydra may be out of reach before it is down and the lists empty (under the bridge's KEEP_LAST_MS). */
export const DOWN_GRACE_MS = 60_000

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
  bridge: Pick<Bridge, 'url' | 'ping' | 'externalSessions' | 'workers' | 'listAccounts'> & Partial<Pick<Bridge, 'onWorkersChanged' | 'swarmJobs'>>
  broadcast(event: ServerEvent): void
  wsClientCount(): number
  /** Connected windows on screen (ServerContext.wsVisibleCount); without it every connected window counts. */
  wsVisibleCount?(): number
  onWsVisibility?(fn: (visible: number) => void): () => void
  fastMs?: number
  accountsMs?: number
  idleMs?: number
  hiddenMs?: number
  downGraceMs?: number
  now?: () => number
}

export function createPoller(o: PollerOptions) {
  const fastMs = o.fastMs ?? FAST_POLL_MS
  const accountsMs = o.accountsMs ?? ACCOUNTS_POLL_MS
  const idleMs = o.idleMs ?? IDLE_POLL_MS
  const hiddenMs = o.hiddenMs ?? HIDDEN_POLL_MS
  const downGraceMs = o.downGraceMs ?? DOWN_GRACE_MS
  const now = o.now ?? Date.now
  const visibleCount = o.wsVisibleCount ?? o.wsClientCount
  let timer: ReturnType<typeof setInterval> | null = null
  let unwatch: (() => void) | null = null
  let unwatchVisibility: (() => void) | null = null
  let visible = 0
  let running = false
  let clients = 0
  let up: boolean | null = null
  /** When AgentHydra first failed to answer since it last did; null while it answers. */
  let downSince: number | null = null
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

  /** Broadcasts bridge.status when AgentHydra's state changed; true when it did. */
  function setUp(isUp: boolean): boolean {
    if (isUp === up) return false
    up = isUp
    const status: ServerEvent = { type: 'bridge.status', up: isUp, url: o.bridge.url }
    remember(status)
    o.broadcast(status)
    return true
  }

  function emitDown(): void {
    idle = false
    emitIfChanged({ type: 'external.update', sessions: [] })
    emitIfChanged({ type: 'climayte.update', workers: [] })
    emitIfChanged({ type: 'swarm.update', jobs: [] })
    emitIfChanged({ type: 'accounts.update', accounts: [DEFAULT_ACCOUNT_INFO] })
    accountsAt = 0
  }

  /**
   * AgentHydra did not answer: down once it has been out of reach for downGraceMs. Until then nothing is said and
   * the lists stand; once down, the rest of a poll's reads are dropped.
   */
  function outOfReach(): void {
    downSince ??= now()
    if (up !== false && now() - downSince < downGraceMs) return
    setUp(false)
    emitDown()
  }

  /** A strict sessions read that could not reach AgentHydra. */
  function readFailed(err: unknown): null {
    if (err instanceof BridgeError && err.unreachable) outOfReach()
    return null
  }

  /**
   * Each list goes out the moment its read lands, so the sidebar does not wait on the slowest. A read that
   * failed for another reason than "down" keeps the last list rather than blanking it.
   */
  async function readLists(flipped: boolean): Promise<void> {
    const dueAccounts = flipped || now() - accountsAt >= accountsMs
    const [sessions, workers] = await Promise.all([
      o.bridge.externalSessions({ strict: true }).then((sessions) => {
        downSince = null
        if (up) emitIfChanged({ type: 'external.update', sessions })
        return sessions
      }, readFailed),
      o.bridge.workers().then((workers) => {
        if (up) emitIfChanged({ type: 'climayte.update', workers })
        return workers
      }, () => null),
      // The bridge reads HSwarm at most every SWARM_FRESH_MS (10 s); the other ticks get its last answer.
      o.bridge.swarmJobs?.().then((jobs) => {
        if (up) emitIfChanged({ type: 'swarm.update', jobs })
      }, () => null),
      dueAccounts &&
        o.bridge.listAccounts().then((accounts) => {
          if (!up) return
          accountsAt = now()
          emitIfChanged({ type: 'accounts.update', accounts })
        }, () => null),
    ])
    // Nothing running (and both reads answered): the timer can rest between polls.
    idle = !!up && !!sessions && !!workers && !sessions.some((x) => x.status === 'working' || x.status === 'needs_you') && !workers.some((w) => w.active)
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
      downSince = null
      accountsAt = 0
    }
    clients = n

    // While the last poll's reads reached AgentHydra they stand in for the ping: the strict sessions read says down itself.
    let flipped = false
    if (up !== true) {
      if (!(await o.bridge.ping())) return outOfReach()
      downSince = null
      flipped = setUp(true)
    }
    await readLists(flipped)
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
        const rest = o.wsClientCount() > 0 && visibleCount() === 0 ? hiddenMs : idle ? idleMs : 0
        if (rest && now() - polledAt < rest - fastMs / 2) return
        void tick()
      }, fastMs)
      // A window back on screen after none were: read now, not up to a hidden interval later.
      visible = visibleCount()
      unwatchVisibility =
        o.onWsVisibility?.((n) => {
          const back = visible === 0 && n > 0
          visible = n
          if (back) void tick()
        }) ?? null
      // A worker this side started, sent to or cancelled ends the rest: the list is read now, not up to
      // an idle interval later (the engine counts each chat's workers from that list).
      unwatch = o.bridge.onWorkersChanged?.(() => {
        idle = false
        void tick()
      }) ?? null
      void tick()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
      unwatch?.()
      unwatch = null
      unwatchVisibility?.()
      unwatchVisibility = null
    },
  }
}

export type Poller = ReturnType<typeof createPoller>
