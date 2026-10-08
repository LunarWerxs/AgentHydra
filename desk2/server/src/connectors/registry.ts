// The connectors Desk knows (server/src/connectors/defs/, one file each): polled in the background, their last
// status cached so a chat's buildOptions, which is synchronous, can read it. Actions (install, start, enable,
// disable) run here; the enabled flags live in <home>/connectors.json as { disabled: [...] }.

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONNECTOR_IDS, type ConnectorAction, type ConnectorId, type ConnectorStatus, type ConnectorView } from '@shared/connectors'
import type { ServerContext } from '../context'
import type { ConnectorDef, ConnectorFactory, Detected } from './types'

const DEFAULT_DEFS_DIR = join(import.meta.dir, 'defs')
const DEFAULT_POLL_MS = 15_000
// The probe pace while no window is on screen (each pass is a health fetch per connector).
const HIDDEN_POLL_MS = 120_000
const START_WAIT_MS = 30_000
const START_CHECK_MS = 1_000

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0]?.slice(0, 300) || 'failed'

export type ActionResult = ConnectorView | 'unknown' | 'unsupported'

export interface ConnectorRegistry {
  list(): ConnectorView[]
  action(id: string, action: ConnectorAction): Promise<ActionResult>
  /** Starts every enabled, installed, not running connector in the background; never throws. */
  autoStart(): void
  /** Probes every connector now. */
  refresh(): Promise<void>
  /** Probes first when the last pass is older than the poll interval (no window may have kept the poll going). */
  fresh(): Promise<void>
  stop(): void
}

export interface RegistryOptions {
  home: string
  defs: ConnectorDef[]
  pollMs?: number
  /** Whether a background tick probes now (no window on screen: it waits). Default: always. */
  shouldPoll?: () => boolean
  /** How long a start may take before it is a failure (tests shorten it). */
  startWaitMs?: number
}

/** Loads every connector file in `dir`; one that cannot load or names an id outside CONNECTOR_IDS is skipped. */
export async function loadDefs(dir: string, home: string): Promise<ConnectorDef[]> {
  const found: ConnectorDef[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
  } catch {
    return found
  }
  for (const name of names.sort()) {
    const file = join(dir, name)
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: ConnectorFactory }
      if (typeof mod.default !== 'function') {
        console.error(`[connectors] ${file} has no default export function; skipped`)
        continue
      }
      const def = mod.default({ home })
      if (!(CONNECTOR_IDS as readonly string[]).includes(def.info.id)) {
        console.error(`[connectors] ${file} has the id ${def.info.id}, which is not a connector id; skipped`)
        continue
      }
      found.push(def)
    } catch (err) {
      console.error(`[connectors] ${file} failed to load:`, err)
    }
  }
  return found
}

function readDisabled(home: string): Set<ConnectorId> {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'connectors.json'), 'utf8')) as { disabled?: unknown }
    if (Array.isArray(parsed.disabled)) return new Set(parsed.disabled.filter((x): x is ConnectorId => (CONNECTOR_IDS as readonly unknown[]).includes(x)))
  } catch {
    // floor-ok: no file or a broken one means every connector is enabled
  }
  return new Set()
}

export function createRegistry(opts: RegistryOptions): ConnectorRegistry {
  const defs = [...opts.defs].sort((a, b) => CONNECTOR_IDS.indexOf(a.info.id) - CONNECTOR_IDS.indexOf(b.info.id))
  const byId = new Map(defs.map((d) => [d.info.id, d]))
  const disabled = readDisabled(opts.home)
  const detected = new Map<ConnectorId, Detected & { checkedAt: number }>()
  /** installing / starting: what Desk is doing now (reason carries the progress line). */
  const busy = new Map<ConnectorId, { state: 'installing' | 'starting'; reason?: string }>()
  /** The last install or start that went wrong, until the connector answers or the action is tried again. */
  const failed = new Map<ConnectorId, string>()
  const startWaitMs = opts.startWaitMs ?? START_WAIT_MS

  const statusOf = (def: ConnectorDef): ConnectorStatus => {
    const id = def.info.id
    const d = detected.get(id) ?? { state: 'absent' as const, url: null, version: null, checkedAt: 0 }
    const b = busy.get(id)
    const f = failed.get(id)
    let state = d.state
    let reason = d.reason
    if (b) {
      state = b.state
      reason = b.reason
    } else if (d.state !== 'running' && f) {
      state = 'failed'
      reason = f
    }
    const enabled = !disabled.has(id)
    const status: ConnectorStatus = { id, state, url: d.url, version: d.version, enabled, givesChats: enabled && !!def.chat && state === 'running', checkedAt: d.checkedAt }
    if (reason) status.reason = reason
    return status
  }
  const view = (def: ConnectorDef): ConnectorView => ({ ...def.info, ...statusOf(def) })

  const probe = async (def: ConnectorDef): Promise<void> => {
    let d: Detected
    try {
      d = await def.detect()
    } catch (err) {
      d = { state: 'absent', url: null, version: null, reason: firstLine(err) }
    }
    if (d.state === 'running') failed.delete(def.info.id)
    detected.set(def.info.id, { ...d, checkedAt: Date.now() })
  }
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  let refreshedAt = 0
  // One pass at a time: a window coming back and its first GET /api/connectors join the same probes.
  let inflight: Promise<void> | null = null
  const refresh = (): Promise<void> =>
    (inflight ??= Promise.all(defs.map(probe)).then(
      () => {
        refreshedAt = Date.now()
        inflight = null
      },
      (err: unknown) => {
        inflight = null
        throw err
      }
    ))
  const fresh = async (): Promise<void> => {
    if (Date.now() - refreshedAt > pollMs) await refresh()
  }

  // With no window on screen the probes slow to HIDDEN_POLL_MS: a chat started then still gets a recent reading.
  const timer = setInterval(() => {
    if ((opts.shouldPoll?.() ?? true) || Date.now() - refreshedAt >= HIDDEN_POLL_MS) void refresh()
  }, pollMs)
  timer.unref?.()
  let stopped = false

  const background = (def: ConnectorDef, state: 'installing' | 'starting', work: () => Promise<void>): void => {
    const id = def.info.id
    failed.delete(id)
    busy.set(id, { state })
    void (async () => {
      try {
        await work()
      } catch (err) {
        failed.set(id, firstLine(err))
      } finally {
        busy.delete(id)
        await probe(def)
      }
    })()
  }

  const setEnabled = async (def: ConnectorDef, on: boolean): Promise<ActionResult> => {
    if (on) disabled.delete(def.info.id)
    else disabled.add(def.info.id)
    mkdirSync(opts.home, { recursive: true })
    writeFileSync(join(opts.home, 'connectors.json'), JSON.stringify({ disabled: [...disabled] }, null, 2))
    // Switching it back on is the person asking for its tools: an installed app that is not running starts now.
    if (on && def.start && detected.get(def.info.id)?.state === 'installed') return startOne(def)
    return view(def)
  }
  const installOne = (def: ConnectorDef): ActionResult => {
    const install = def.install
    if (!install) return 'unsupported'
    if (busy.has(def.info.id)) return view(def)
    background(def, 'installing', () =>
      install.call(def, (line) => {
        const b = busy.get(def.info.id)
        if (b) b.reason = line.slice(0, 200)
      })
    )
    return view(def)
  }
  const waitRunning = async (def: ConnectorDef): Promise<void> => {
    const deadline = Date.now() + startWaitMs
    for (;;) {
      await probe(def)
      if (detected.get(def.info.id)?.state === 'running') return
      if (stopped || Date.now() >= deadline) throw new Error(`${def.info.name} did not answer within ${Math.round(startWaitMs / 1000)} s`)
      await new Promise((r) => setTimeout(r, Math.min(START_CHECK_MS, startWaitMs)))
    }
  }
  const startOne = (def: ConnectorDef): ActionResult => {
    const start = def.start
    if (!start) return 'unsupported'
    if (busy.has(def.info.id)) return view(def)
    background(def, 'starting', async () => {
      await start.call(def)
      await waitRunning(def)
    })
    return view(def)
  }

  const action = async (id: string, act: ConnectorAction): Promise<ActionResult> => {
    const def = byId.get(id as ConnectorId)
    if (!def) return 'unknown'
    if (act === 'enable' || act === 'disable') return setEnabled(def, act === 'enable')
    if (act === 'install') return installOne(def)
    if (act === 'start') return startOne(def)
    return 'unsupported'
  }

  /** Starts, hidden and in the background, every enabled connector that is installed but not running (same path as a Start click). */
  const autoStart = (): void => {
    for (const def of defs) {
      if (disabled.has(def.info.id) || !def.start || detected.get(def.info.id)?.state !== 'installed') continue
      void action(def.info.id, 'start').catch((err) => console.error(`[connectors] auto-start of ${def.info.id} failed:`, firstLine(err)))
    }
  }

  return {
    list: () => defs.map(view),
    action,
    autoStart,
    refresh,
    fresh,
    stop() {
      stopped = true
      clearInterval(timer)
    }
  }
}

let active: { registry: ConnectorRegistry; defs: ConnectorDef[] } | null = null

/** What a chat in `cwd` gets from the connectors that are running and enabled now: empty until the plugin has started. */
export function connectorsForChat(cwd: string): { mcpServers: Record<string, McpServerConfig>; prompts: string[] } {
  const out: { mcpServers: Record<string, McpServerConfig>; prompts: string[] } = { mcpServers: {}, prompts: [] }
  if (!active) return out
  const statuses = new Map(active.registry.list().map((v) => [v.id, v]))
  for (const def of active.defs) {
    const status = statuses.get(def.info.id)
    if (!status?.givesChats || !def.chat) continue
    try {
      const got = def.chat(cwd, status)
      if (!got) continue
      Object.assign(out.mcpServers, got.mcpServers)
      if (got.prompt?.trim()) out.prompts.push(got.prompt.trim())
    } catch (err) {
      console.error(`[connectors] ${def.info.id} chat() failed:`, firstLine(err))
    }
  }
  return out
}

/** Where connector `id` stands now, or null before the plugin has started. */
export function connectorStatus(id: ConnectorId): ConnectorView | null {
  return active?.registry.list().find((v) => v.id === id) ?? null
}

let ready: Promise<void> = Promise.resolve()
let pending: Promise<void> | null = null

/** Settles once the registry's first probe pass has landed (at once when no plugin started one); never rejects. */
export function connectorsReady(): Promise<void> {
  return ready
}

/**
 * The first probe pass while it has not landed, else null: a chat start waits on it only then, so one started later
 * keeps its status change and hand-off in the same tick (an await, even of a settled promise, would defer them).
 */
export function connectorsPending(): Promise<void> | null {
  return pending
}

/**
 * Starts the registry for this server (the plugin calls it, without waiting): defs from ctx.deps.connectors, else the
 * defs folder. Resolves after the first probe pass; until then connectorStatus is null. The background poll runs only
 * while a window is on screen, and a window coming back probes at once.
 */
export function startConnectors(ctx: ServerContext): Promise<ConnectorRegistry> {
  const started = boot(ctx)
  const landed: Promise<void> = started.then(
    () => {
      if (pending === landed) pending = null
    },
    () => {
      if (pending === landed) pending = null
    }
  )
  ready = landed
  pending = landed
  return started
}

async function boot(ctx: ServerContext): Promise<ConnectorRegistry> {
  const injected = ctx.deps.connectors as ConnectorDef[] | undefined
  const defs = injected ?? (await loadDefs(existsSync(DEFAULT_DEFS_DIR) ? DEFAULT_DEFS_DIR : '', ctx.home))
  const pollMs = typeof ctx.deps.connectorsPollMs === 'number' ? ctx.deps.connectorsPollMs : undefined
  const registry = createRegistry({ home: ctx.home, defs, pollMs, shouldPoll: () => ctx.wsVisibleCount?.() !== 0 })
  let visible = ctx.wsVisibleCount?.() ?? 1
  const unsubscribe = ctx.onWsVisibility?.((count) => {
    if (count > 0 && visible === 0) void registry.refresh()
    visible = count
  })
  // Before the first pass is awaited: a server stopped while it runs still ends the poll and the subscription.
  let stopped = false
  ctx.onStop(() => {
    stopped = true
    unsubscribe?.()
    registry.stop()
    if (active?.registry === registry) active = null
  })
  await registry.refresh()
  if (stopped) return registry
  active = { registry, defs: [...defs].sort((a, b) => CONNECTOR_IDS.indexOf(a.info.id) - CONNECTOR_IDS.indexOf(b.info.id)) }
  registry.autoStart()
  return registry
}
