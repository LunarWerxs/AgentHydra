// server/src/mcp-client.ts - the MCP server's HTTP client for the daemon, split out of mcp.ts.
//
// Which base URL to talk to (and how to recover from a stale runtime pointer), the one `api()`
// every tool proxies through, the side-run notice, the small JSON-schema and query helpers the
// tool tables share, and resolving an `instance` argument to one real instance. mcp.ts and its
// tool modules (mcp-session-tools.ts, mcp-fan-out.ts) all build on this; it imports none of them.
import { appEnv, IS_COMPILED, PORT, SERVICE_NAME } from './config'
import { instanceFilePath, readInstanceInfo } from './instance'
import type { McpEngineTool } from './mcp-stdio.mjs'

const DEFAULT_BASE = `http://127.0.0.1:${PORT}`

/** Set once a pointer-named port refused a connection and the default port answered instead: the
 *  rest of this process talks to the default. Cleared only by resetDaemonResolutionForTests. */
let staleFallbackBase: string | null = null

// Resolve the base URL per call: an explicit AGENTHYDRA_URL/AGENTHYDRA_PORT always wins, else
// follow the port the daemon ACTUALLY bound (~/.agenthydra/runtime.json), so an auto-hopped port
// still works, else fall back to the static configured default.
export function daemonBase(): string {
  const url = appEnv('URL')
  if (url) return url
  const port = appEnv('PORT')
  if (port) return `http://127.0.0.1:${port}`
  if (staleFallbackBase) return staleFallbackBase
  return readInstanceInfo()?.url ?? DEFAULT_BASE
}

/** The daemon isn't listening. Distinct from a real API error, so a fallback can fire on THIS and
 *  only this — a 500 from a running daemon must still surface as a failure, not be silently retried
 *  in-process against different code. */
class DaemonUnreachable extends Error {}

/** How to START the daemon, phrased for THIS distribution: a packaged build has no Bun, so telling
 *  its user to `bun run start` is a dead end — point them at the executable / tray instead. */
const startHint = IS_COMPILED
  ? 'Start it by running the AgentHydra executable (or its tray shortcut).'
  : 'Start it with `bun run start`.'

interface DaemonHealth {
  ok?: boolean
  service?: string
  version?: string
}

/** /api/health of `base`, or null unless it answers ok AS this service within timeoutMs. */
async function healthOf(base: string, timeoutMs: number): Promise<DaemonHealth | null> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as DaemonHealth | null
    return body?.ok && body.service === SERVICE_NAME ? body : null
  } catch {
    return null
  }
}

/**
 * THE POINTER NAMED A PORT THAT REFUSED. Say so in those words, and ask the DEFAULT port before
 * concluding the daemon is down.
 *
 * On 2026-09-12 a probe daemon left ~/.agenthydra/runtime.json naming a dead 7799 while the real
 * daemon answered on 7787, and this client said "couldn't reach the daemon ... start it". Every
 * word of that was the wrong advice: nothing suggested the pointer, and starting a daemon would
 * have made a second one. The pointer's OWNER now keeps it honest (instance.ts); this is the
 * client's half: name the file, name the port it names, and try the default once. Only a base that
 * came from the pointer qualifies - an explicit AGENTHYDRA_URL/PORT is the caller's word and is
 * never second-guessed.
 */
async function recoverFromStalePointer(): Promise<{ note: string; recovered: boolean }> {
  if (appEnv('URL') || appEnv('PORT') || staleFallbackBase) return { note: '', recovered: false }
  const named = readInstanceInfo()?.url
  if (!named) return { note: '', recovered: false }
  const note =
    `${instanceFilePath()} names ${named}, nothing is listening there, and it may be stale ` +
    '(a daemon that exits cleanly deletes it; a crash, a hard kill or a side-run leaves it behind). '
  if (named === DEFAULT_BASE) return { note, recovered: false }
  const health = await healthOf(DEFAULT_BASE, 1500)
  if (!health) {
    return { note: `${note}The default port ${PORT} did not answer either. `, recovered: false }
  }
  staleFallbackBase = DEFAULT_BASE
  console.error(
    `[agenthydra mcp] ${note}The default port ${PORT} answers as ${SERVICE_NAME} ${health.version ?? ''}, ` +
      `so this process uses ${DEFAULT_BASE} from here on. Do NOT start another daemon.`,
  )
  return { note, recovered: true }
}

/** Non-null once the daemon we reached declared itself a SIDE-RUN (a relocated store). Put on
 *  every tool result by withDaemonWarning, so no caller can read a scratch store as the fleet. */
let daemonWarning: string | null = null

/** The daemon stamps every answer with `x-agenthydra-side-run: <store>` when its store is not the
 *  machine's (side-run.ts), so noticing costs no extra request. A client that silently reaches a
 *  scratch database is worse than an outage, because it looks like it worked. */
function noteSideRun(res: Response): void {
  if (daemonWarning) return
  const store = (res as { headers?: Headers }).headers?.get('x-agenthydra-side-run')
  if (!store) return
  daemonWarning =
    `SIDE-RUN DAEMON: ${daemonBase()} serves ${store}, which is NOT this machine's fleet store. ` +
    'Every read and write through these tools goes to that store. If you meant the real daemon, ' +
    'set AGENTHYDRA_URL to it, or stop the side-run.'
  console.error(`[agenthydra mcp] ${daemonWarning}`)
}

/** Every tool answer carries `daemonWarning` while one is set. Applied where tools are handed to a
 *  transport (stdio and HTTP), not to TOOLS itself, so a test of one tool sees the bare result. */
export function withDaemonWarning(tools: McpEngineTool[]): McpEngineTool[] {
  return tools.map((t) => ({
    ...t,
    run: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const value = await t.run(args, signal)
      return daemonWarning && value && typeof value === 'object' && !Array.isArray(value)
        ? { daemonWarning, ...(value as Record<string, unknown>) }
        : value
    },
  }))
}

/** Tests only: forget a stale-pointer fallback and a side-run notice left by an earlier case. */
export function resetDaemonResolutionForTests(): void {
  staleFallbackBase = null
  daemonWarning = null
}

export async function api(pathname: string, init?: RequestInit): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${daemonBase()}${pathname}`, init)
  } catch (e) {
    const first = e instanceof Error ? e.message : String(e)
    const { note, recovered } = await recoverFromStalePointer()
    if (!recovered) {
      throw new DaemonUnreachable(
        `couldn't reach the AgentHydra daemon at ${daemonBase()}. ${note}${startHint} (${first})`,
      )
    }
    try {
      res = await fetch(`${daemonBase()}${pathname}`, init)
    } catch (e2) {
      throw new DaemonUnreachable(
        `couldn't reach the AgentHydra daemon at ${daemonBase()} even after setting the stale pointer aside. ${startHint} (${e2 instanceof Error ? e2.message : String(e2)})`,
      )
    }
  }
  noteSideRun(res)
  if (!res.ok) throw new Error(`AgentHydra ${res.status}: ${await res.text()}`)
  const text = await res.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    // A 200 THAT IS NOT JSON IS THE WEB APP'S CATCH-ALL PAGE answering a route this daemon
    // build does not have. Found live 2026-09-06: list_chats shipped at 23:15, the daemon on
    // the box was compiled at 21:29, and every call came back as a bare "Failed to parse
    // JSON" from the MCP layer - four retries with different arguments before anyone looked at
    // the body. The daemon is not broken and the tool is not broken; they are different ages.
    const html = /^\s*<!doctype html|^\s*<html/i.test(text)
    const head = text.slice(0, 80).replace(/\s+/g, ' ').trim()
    throw new Error(
      `AgentHydra answered ${pathname} with ${html ? 'HTML' : 'non-JSON'} instead of JSON - ` +
        `that is the web app's catch-all page, so the RUNNING daemon at ${daemonBase()} does not ` +
        `serve this route: its build predates the tool that calls it. Rebuild it from this ` +
        `checkout (bun run dist - the running exe is locked, so stop the daemon first) and ` +
        `relaunch it, or point at a source daemon (bun run --cwd server start). ` +
        `Body starts: ${head}`,
    )
  }
}

/**
 * Run a tool against the daemon, and if the daemon simply isn't running, do the work IN-PROCESS.
 *
 * WHY only some tools get this: the usage tools need nothing the daemon uniquely owns. The OAuth
 * tokens are files on disk, the quota endpoint is a plain HTTPS GET, and the transcripts are local
 * JSONL. So an agent can answer "how much quota do I have left?" with the app closed. The queue and
 * dispatch tools are the opposite: they mutate shared sqlite state and supervise real processes, so
 * a second, uncoordinated executor would be a correctness bug. Those keep failing loudly.
 *
 * The imports inside each fallback are DYNAMIC on purpose: they pull in bun:sqlite, and loading that
 * eagerly would open the database on every MCP start, including the (normal) case where the daemon
 * owns it and we never touch it.
 */
export async function apiOrLocal(
  pathname: string,
  local: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await api(pathname)
  } catch (e) {
    if (e instanceof DaemonUnreachable) return await local()
    throw e
  }
}

// JSON Schema helper (the engine advertises each tool's `inputSchema` verbatim in tools/list).
export const S = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
})
export const JSON_HEADERS = { 'content-type': 'application/json' }
export const str = (v: unknown): string => String(v ?? '')
// Past this DECLARED run length, orchestrator_run detaches instead of blocking: no MCP client
// holds a connection open that long, and a call the client abandons loses the report for work
// the daemon finishes anyway (2026-09-11, the lost `sweep --all --yes`).
export const AUTO_DETACH_MS = 120_000
/** The longest corch_status may hold a call waiting. The desktop app's MCP client drops a call at
 *  about 60 s (the MCP SDK's default request timeout; measured 2026-09-30: a 55 s wait answered,
 *  110 s and 300 s timed out with nothing returned), so a longer wait only loses its answer. */
export const CORCH_MAX_WAIT_S = 50
export const qs = (params: Record<string, unknown>): string => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v != null) p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** The `instance` parameter, described once and reused by every tool that takes one — so the same
 *  sentence appears everywhere and there is no tool where a number quietly isn't accepted. */
export const INSTANCE_PARAM = {
  type: ['string', 'number'],
  description:
    "Which instance: its permanent NUMBER (7 or '#7' — see list_instance_numbers), or its dir/id, or an unambiguous name. The number is the reliable one; names are user-editable and can collide.",
} as const

/** One row of the numbered fleet, as `/api/instance-numbers` returns it. */
export interface ResolvedInstanceRow {
  num: number
  kind: 'desktop' | 'cli' | 'codex'
  handle: string
  ref: string
  name: string
  email: string | null
  plan: string | null
  /** Rate-limit tier — `Pro` / `Max 5×` / `Max 20×`. What the quota IS, as opposed to `plan`,
   *  which is what the subscription is called. The two disagree on org seats. */
  tier: string | null
  configDir: string
  loggedIn: boolean
  isRunning: boolean | null
}

/** Resolve an `instance` argument to one real instance, or throw with the daemon's own reason
 *  (which distinguishes "no such number" from "that number's instance was deleted"). */
export async function resolveRef(ref: unknown): Promise<ResolvedInstanceRow> {
  return (await api(`/api/instance-numbers/resolve${qs({ ref: str(ref) })}`)) as ResolvedInstanceRow
}

/**
 * The dir/id to act on: from `instance` (any spelling, resolved) or from the explicit legacy
 * param, whichever was supplied. Keeping BOTH is deliberate — every existing caller that already
 * passes a dir or id keeps working untouched, and the number is purely an addition.
 */
export async function handleFrom(
  explicit: unknown,
  instance: unknown,
  legacyName: string,
): Promise<string> {
  if (instance != null && str(instance).trim()) return (await resolveRef(instance)).handle
  const direct = str(explicit).trim()
  if (direct) return direct
  throw new Error(`pass \`instance\` (its number, e.g. 7) or \`${legacyName}\``)
}

/**
 * Normalize a queue item's `instance_ref` so a plain number works there too.
 *
 * The queue stores `desktop:<dir>` / `cli:<id>` and the dispatcher parses exactly those two
 * prefixes (dispatch.ts), so a number has to be expanded BEFORE the item is written — a run pinned
 * to "#7" that failed to resolve at dispatch time would fail long after the human walked away.
 * Anything already in ref form passes through untouched. The dir is taken from `handle`, not from
 * the registry key, because dispatch existsSync()s it.
 */
export async function normalizeInstanceRef(value: unknown): Promise<unknown> {
  if (value == null) return value
  const raw = str(value).trim()
  if (!raw || raw.startsWith('desktop:') || raw.startsWith('cli:')) return value
  const hit = await resolveRef(raw)
  if (hit.kind === 'codex')
    throw new Error(
      `instance #${hit.num} is a Codex instance; the queue runs Claude sessions, so it cannot be pinned to one. Pick a Claude Desktop or Claude CLI instance.`,
    )
  return `${hit.kind}:${hit.handle}`
}

/** The daemon's own refusal payload when it answers 409 busy, or null for any other failure.
 *
 *  ⛔ A REFUSAL ARRIVES AS A THROW, NOT AS A RESULT. `api` rejects on every non-2xx, so a 409
 *  reached the caller as the bare string `AgentHydra 409: {…}` - which is why the busy case read
 *  as "the tool blew up" rather than "the route is held, here is the operation holding it", and
 *  why the resume text had nowhere to be caught. Parsed back into the object the daemon sent so
 *  both are possible. Anything that is not a busy 409 is re-thrown untouched. */
export function busyRefusal(err: unknown): Record<string, unknown> | null {
  const message = err instanceof Error ? err.message : String(err)
  const body = message.startsWith('AgentHydra 409: ')
    ? message.slice('AgentHydra 409: '.length)
    : ''
  if (!body) return null
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).busy === true)
      return parsed as Record<string, unknown>
  } catch {
    /* a 409 whose body is not the refusal shape belongs to the caller, unaltered */
  }
  return null
}
