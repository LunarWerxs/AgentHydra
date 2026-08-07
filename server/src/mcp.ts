// AgentHydra MCP server (stdio) — a thin client over the running daemon's REST API, so an
// MCP-speaking agent (Claude Desktop/Code, Cursor) shares one source of truth with the web UI.
// Start the daemon first (`bun run start` from repo root); point elsewhere with
// AGENTHYDRA_URL / AGENTHYDRA_PORT.
//
// The JSON-RPC 2.0 / MCP protocol + the stdio loop live in the SHARED, zero-dependency engine
// `./mcp-stdio.mjs` (part of the shared kit — edit it there, never here). This file is only the
// app-specific part: an HTTP client + a tool table, each tool a thin proxy over an existing
// /api/* route from index.ts. Beyond the sessions/queue/accounts/scheduler/instances/update tools,
// this also exposes the usage-check subsystem (check_usage / check_my_usage — any agent can read
// its own remaining quota; the weekly all-models % is the binding cap), CLI instances, and the
// auto-resume monitor.
//
// INSTANCE NUMBERS. Everything here that addresses one instance takes an `instance` argument, and
// that argument accepts the instance's permanent NUMBER (`7`, `#7`). That is the identifier a human
// can say out loud and write into a prompt — the alternatives an instance carries are a Windows
// folder path and a random uuid, neither of which survives being spoken. Start at
// list_instance_numbers (the whole fleet, one number each, across Claude Desktop + Claude CLI +
// Codex), resolve_instance (confirm which account a reference means before spending its quota) and
// whoami (which numbered instance THIS process is). The legacy `dir` / `id` parameters all still
// work exactly as before; the number is purely additive.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appEnv, IS_COMPILED, PORT, VERSION } from './config'
import { readInstanceInfo } from './instance'
import type { McpEngineTool } from './mcp-stdio.mjs'
import { runMcpStdio } from './mcp-stdio.mjs'

/** Where a plain `claude` login (no CLAUDE_CONFIG_DIR override) keeps its credentials. */
const defaultClaudeConfigDir = (): string => join(homedir(), '.claude')

// Resolve the base URL per call: an explicit AGENTHYDRA_URL/AGENTHYDRA_PORT always wins, else
// follow the port the daemon ACTUALLY bound (~/.agenthydra/runtime.json), so an auto-hopped port
// still works, else fall back to the static configured default.
export function daemonBase(): string {
  const url = appEnv('URL')
  if (url) return url
  const port = appEnv('PORT')
  if (port) return `http://127.0.0.1:${port}`
  return readInstanceInfo()?.url ?? `http://127.0.0.1:${PORT}`
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

async function api(pathname: string, init?: RequestInit): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${daemonBase()}${pathname}`, init)
  } catch (e) {
    throw new DaemonUnreachable(
      `couldn't reach the AgentHydra daemon at ${daemonBase()}. ${startHint} (${e instanceof Error ? e.message : String(e)})`,
    )
  }
  if (!res.ok) throw new Error(`AgentHydra ${res.status}: ${await res.text()}`)
  return res.json()
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
async function apiOrLocal(pathname: string, local: () => Promise<unknown>): Promise<unknown> {
  try {
    return await api(pathname)
  } catch (e) {
    if (e instanceof DaemonUnreachable) return await local()
    throw e
  }
}

// JSON Schema helper (the engine advertises each tool's `inputSchema` verbatim in tools/list).
const S = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
})
const JSON_HEADERS = { 'content-type': 'application/json' }
const str = (v: unknown): string => String(v ?? '')
const qs = (params: Record<string, unknown>): string => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v != null) p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** The `instance` parameter, described once and reused by every tool that takes one — so the same
 *  sentence appears everywhere and there is no tool where a number quietly isn't accepted. */
const INSTANCE_PARAM = {
  type: ['string', 'number'],
  description:
    "Which instance: its permanent NUMBER (7 or '#7' — see list_instance_numbers), or its dir/id, or an unambiguous name. The number is the reliable one; names are user-editable and can collide.",
} as const

/** One row of the numbered fleet, as `/api/instance-numbers` returns it. */
interface ResolvedInstanceRow {
  num: number
  kind: 'desktop' | 'cli' | 'codex'
  handle: string
  ref: string
  name: string
  email: string | null
  plan: string | null
  configDir: string
  loggedIn: boolean
  isRunning: boolean | null
}

/** Resolve an `instance` argument to one real instance, or throw with the daemon's own reason
 *  (which distinguishes "no such number" from "that number's instance was deleted"). */
async function resolveRef(ref: unknown): Promise<ResolvedInstanceRow> {
  return (await api(`/api/instance-numbers/resolve${qs({ ref: str(ref) })}`)) as ResolvedInstanceRow
}

/**
 * The dir/id to act on: from `instance` (any spelling, resolved) or from the explicit legacy
 * param, whichever was supplied. Keeping BOTH is deliberate — every existing caller that already
 * passes a dir or id keeps working untouched, and the number is purely an addition.
 */
async function handleFrom(
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
async function normalizeInstanceRef(value: unknown): Promise<unknown> {
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

export const TOOLS: McpEngineTool[] = [
  // --- sessions (read-only) ---------------------------------------------------
  {
    name: 'list_sessions',
    description:
      'List local Claude, Codex, and OpenCode sessions, most recently active first. Each row carries its source.',
    inputSchema: S({
      limit: { type: 'number', description: 'Max sessions to return (default 200).' },
      source: {
        type: 'string',
        enum: ['claude', 'codex', 'opencode'],
        description: 'Optional provider filter.',
      },
    }),
    run: (a) => api(`/api/sessions${qs({ limit: a.limit, source: a.source })}`),
  },
  {
    name: 'get_session',
    description: 'Get one session by id (full summary).',
    inputSchema: S(
      {
        id: { type: 'string' },
        source: { type: 'string', enum: ['claude', 'codex', 'opencode'] },
      },
      ['id'],
    ),
    run: (a) => api(`/api/sessions/${encodeURIComponent(str(a.id))}${qs({ source: a.source })}`),
  },
  {
    name: 'tail_session',
    description:
      'Tail a session transcript: the most recent turns, optionally text-only (no tool_use/tool_result noise).',
    inputSchema: S(
      {
        id: { type: 'string' },
        limit: { type: 'number', description: 'Max turns to return (default 40).' },
        textOnly: { type: 'boolean', description: 'Drop tool_use/tool_result turns, text only.' },
        source: { type: 'string', enum: ['claude', 'codex', 'opencode'] },
      },
      ['id'],
    ),
    run: (a) =>
      api(
        `/api/sessions/${encodeURIComponent(str(a.id))}/tail${qs({ limit: a.limit, textOnly: a.textOnly ? '1' : undefined, source: a.source })}`,
      ),
  },

  // --- queue --------------------------------------------------------------------
  {
    name: 'list_queue',
    description:
      // rate_limited vs overloaded is the distinction an agent reading this most needs: the first is
      // YOUR quota (wait for the reset), the second is Anthropic's servers (already auto-retried).
      'List every queue item (queued/running/completed/failed/rate_limited/overloaded/canceled), in run order. rate_limited = the account hit its own session/weekly cap; overloaded = a 529 that outlasted the automatic retries.',
    inputSchema: S(),
    run: () => api('/api/queue'),
  },
  {
    name: 'add_queue_item',
    description:
      'MUTATES: add a new item to the run queue. title, cwd, and prompt are required; session_id is required when resuming an existing session (new_chat=false).',
    inputSchema: S(
      {
        title: { type: 'string' },
        cwd: { type: 'string', description: 'Absolute working directory for the run.' },
        prompt: { type: 'string' },
        session_id: {
          type: 'string',
          description: 'Required unless new_chat is true (a fresh id is generated then).',
        },
        model: { type: 'string' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        permission_mode: {
          type: 'string',
          enum: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
        },
        account_id: { type: 'string' },
        instance_ref: {
          type: 'string',
          description:
            "Run under a signed-in instance's login. Easiest form: its permanent NUMBER ('7' or '#7' — see list_instance_numbers), which is expanded before the item is stored. Also accepts 'desktop:<dir>' (a dir from list_instances) or 'cli:<id>' (an id from list_cli_instances). Takes precedence over account_id.",
        },
        new_chat: {
          type: 'boolean',
          description: 'Start a brand-new session instead of resuming.',
        },
        fork: { type: 'boolean' },
      },
      ['title', 'cwd', 'prompt'],
    ),
    run: async (a) =>
      api('/api/queue', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...a, instance_ref: await normalizeInstanceRef(a.instance_ref) }),
      }),
  },
  {
    name: 'update_queue_item',
    description:
      "MUTATES: patch a queue item (title, cwd, prompt, model, effort, permission_mode, account_id, instance_ref, status, position, new_chat, fork). instance_ref runs the item under that signed-in instance's login and takes precedence over account_id — pass its permanent NUMBER ('7'), or 'desktop:<dir>' from list_instances, or 'cli:<id>' from list_cli_instances.",
    inputSchema: S(
      {
        id: { type: 'string' },
        patch: {
          type: 'object',
          description:
            "Fields to update; any subset of the queue item columns, e.g. instance_ref: run under a signed-in instance's login ('desktop:<dir>' from list_instances or 'cli:<id>' from list_cli_instances) — takes precedence over account_id.",
        },
      },
      ['id', 'patch'],
    ),
    run: async (a) => {
      const patch = { ...((a.patch as Record<string, unknown>) ?? {}) }
      // Only touch the key when the caller actually sent it: `instance_ref: null` is the documented
      // way to UNPIN a run, and adding the key where it was absent would clear a pin nobody asked
      // to clear.
      if ('instance_ref' in patch)
        patch.instance_ref = await normalizeInstanceRef(patch.instance_ref)
      return api(`/api/queue/${encodeURIComponent(str(a.id))}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(patch),
      })
    },
  },
  {
    name: 'run_queue_item',
    description: 'MUTATES: start running a queued item now (fails if already running).',
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) => api(`/api/queue/${encodeURIComponent(str(a.id))}/run`, { method: 'POST' }),
  },
  {
    name: 'cancel_queue_item',
    description: 'MUTATES: cancel a running (or queued) item.',
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) => api(`/api/queue/${encodeURIComponent(str(a.id))}/cancel`, { method: 'POST' }),
  },
  {
    name: 'get_run_events',
    description:
      "Get a queue item's recorded run events (assistant/user/system turns for that run).",
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) => api(`/api/queue/${encodeURIComponent(str(a.id))}/events`),
  },

  // --- accounts -----------------------------------------------------------------
  {
    name: 'list_accounts',
    description:
      'List only legacy, manually-added credentials (label, auth_type, created_at) from the old pasted-credentials table. Secrets are always masked, never returned in full. This is NOT the primary account list — most signed-in accounts live on instances now; use list_instances / list_cli_instances for those.',
    inputSchema: S(),
    run: () => api('/api/accounts'),
  },

  // --- scheduler ------------------------------------------------------------------
  {
    name: 'get_scheduler',
    description:
      'Get the scheduler state: enabled, running/queued counts, spacing/poll seconds, max_concurrent.',
    inputSchema: S(),
    run: () => api('/api/scheduler'),
  },
  {
    name: 'set_scheduler',
    description:
      'MUTATES: update scheduler settings (any subset of enabled, spacing_seconds, poll_seconds, max_concurrent).',
    inputSchema: S({
      enabled: { type: 'boolean' },
      spacing_seconds: { type: 'number' },
      poll_seconds: { type: 'number' },
      max_concurrent: { type: 'number' },
    }),
    run: (a) =>
      api('/api/scheduler', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(a),
      }),
  },

  // --- instance numbers ----------------------------------------------------------
  // START HERE for anything about "which account". Every instance — Claude Desktop, Claude CLI,
  // Codex — carries a permanent number in ONE shared sequence, and that number is the only
  // identifier that is short, stable and safe to write into a prompt. The alternatives are a
  // Windows folder path and a random uuid.
  {
    name: 'list_instance_numbers',
    description:
      "THE INSTANCE DIRECTORY: every instance (Claude Desktop, Claude CLI, Codex) in one flat list, each with its permanent NUMBER, kind, signed-in account email, plan, login state, and the dir/id the per-kind tools take. Numbers are unique across all three kinds, assigned once and NEVER reused, so '#7' means the same account tomorrow. Call this first whenever a human says 'instance 7' or you need to pick an account to route work to.",
    inputSchema: S(),
    run: () => api('/api/instance-numbers'),
  },
  {
    name: 'resolve_instance',
    description:
      "Turn any reference to an instance — a number (7, '#7'), a dir, an id, a 'desktop:<dir>'/'cli:<id>' ref, or an unambiguous name — into the one instance it means, with its account email and plan. Use this to CONFIRM which account you are about to touch before a mutating or quota-spending action. Errors distinguish an unknown number from a retired one (its instance was deleted; numbers are never recycled).",
    inputSchema: S({ instance: INSTANCE_PARAM }, ['instance']),
    run: (a) => resolveRef(a.instance),
  },
  {
    name: 'whoami',
    description:
      'WHICH INSTANCE AM I? Identifies the instance THIS process is running as, by matching its own CLAUDE_CONFIG_DIR (or CODEX_HOME) against the fleet — returning the permanent number, kind, account email and plan. Call this when a human refers to you by number, or before check_my_usage, so you can state WHOSE quota you are about to report. A plain `claude` session on the default ~/.claude login belongs to no managed instance and correctly comes back as instance: null.',
    inputSchema: S(),
    run: async () => {
      const configDir =
        process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR || defaultClaudeConfigDir()
      const instance = await apiOrLocal(
        `/api/instance-numbers/whoami${qs({ configDir })}`,
        async () => {
          const { instanceForConfigDir } = await import('./core/instance-ref')
          return await instanceForConfigDir(configDir)
        },
      )
      return {
        configDir,
        instance,
        note: instance
          ? undefined
          : 'This process is not running as a managed instance — it uses the default login, which has no instance number. check_my_usage still works and reports that login.',
      }
    },
  },

  // --- multi-instance (isolated Claude Desktop instances) ------------------------
  {
    name: 'list_instances',
    description:
      'List isolated Claude Desktop instances with their live status and resolved account. Each row carries its permanent instance `num` — prefer that over `dir` when referring to one. For the whole fleet (Desktop + CLI + Codex) in one numbered list, use list_instance_numbers.',
    inputSchema: S(),
    run: () => api('/api/instances'),
  },
  {
    name: 'launch_instance',
    description:
      'MUTATES: open (launch) a Claude Desktop instance, by its number (`instance`) or its directory.',
    inputSchema: S({ instance: INSTANCE_PARAM, dir: { type: 'string' } }),
    run: async (a) =>
      api(`/api/instances/${encodeURIComponent(await handleFrom(a.dir, a.instance, 'dir'))}/open`, {
        method: 'POST',
      }),
  },
  {
    name: 'quit_instance',
    description:
      'MUTATES: quit a running Claude Desktop instance, by its number (`instance`) or its directory.',
    inputSchema: S({ instance: INSTANCE_PARAM, dir: { type: 'string' } }),
    run: async (a) =>
      api(`/api/instances/${encodeURIComponent(await handleFrom(a.dir, a.instance, 'dir'))}/quit`, {
        method: 'POST',
      }),
  },

  // --- usage-check subsystem (Feature B) ----------------------------------------
  {
    name: 'check_usage',
    description:
      "Read ONE account's remaining Claude subscription quota — session (5h) %, weekly (all models) %, any per-model weekly %, plus an `advice` verdict (severity / shouldOffload / safeToFanOut). The WEEKLY all-models % is the BINDING cap for pacing multi-agent work; a fresh 5-hour session % is a red herring when weekly is near 100, and switching flagship model does NOT dodge the all-models weekly bucket. NORMAL USE: pass `instance` — the permanent instance number a human quotes ('check instance 7'), which works for Claude Desktop, Claude CLI and Codex instances alike and echoes back WHICH account answered. `account` (a saved dispatch account id or label) and `configDir` (a CLAUDE_CONFIG_DIR that has been /login'd once) remain for the two older credential stores; with none of the three, falls back to THIS process's own config — but prefer check_my_usage for that.",
    inputSchema: S({
      instance: INSTANCE_PARAM,
      account: { type: 'string', description: 'A saved dispatch account id or label.' },
      configDir: {
        type: 'string',
        description: 'A CLAUDE_CONFIG_DIR that has been logged in once via `claude` → /login.',
      },
    }),
    run: (a) => {
      const instance = a.instance != null ? str(a.instance).trim() : ''
      if (instance) return api(`/api/usage${qs({ instance, refresh: '1' })}`)
      const account = a.account != null ? str(a.account) : ''
      const configDir =
        a.configDir != null ? str(a.configDir) : (process.env.CLAUDE_CONFIG_DIR ?? '')
      if (!account && !configDir)
        throw new Error(
          'pass `instance` (its number — see list_instance_numbers), `account`, or `configDir` (or set CLAUDE_CONFIG_DIR in this process for a self-check)',
        )
      return api(
        `/api/usage${qs({ account: account || undefined, configDir: configDir || undefined, refresh: '1' })}`,
      )
    },
  },
  {
    name: 'check_my_usage',
    description:
      'Self-check: read YOUR OWN remaining Claude quota, right now, in ~300ms. Returns the session (5h) %, the weekly all-models % (the BINDING cap), an `advice` verdict with `shouldOffload` / `safeToFanOut` flags, and `instance` — WHICH numbered instance you are, so you can report "instance #7 is at 82% weekly" instead of an unattributed percentage. CALL THIS when you are doing long or heavy work: if `shouldOffload` is true you are close to being cut off mid-task, and you should WRITE YOUR WORKING CONTEXT, FINDINGS, AND NEXT STEPS TO A FILE BEFORE CONTINUING, so the work survives. Also call it before a big multi-agent fan-out. Reads whichever config this process is using (CLAUDE_CONFIG_DIR if set, else the default ~/.claude login); `instance` is null when that is the default login, which belongs to no managed instance.',
    inputSchema: S(),
    run: async () => {
      // A CLI instance sets CLAUDE_CONFIG_DIR; a NORMAL Claude Code session does not — it uses the
      // default ~/.claude. Falling back to that is what makes this work for the everyday case (the
      // session the user is actually talking to) instead of erroring out on it.
      const configDir = process.env.CLAUDE_CONFIG_DIR || defaultClaudeConfigDir()
      // Works with the app CLOSED: a self-check needs only the config dir's own token + one HTTPS GET.
      const usage = await apiOrLocal(`/api/usage${qs({ configDir, refresh: '1' })}`, async () => {
        const { checkUsage, usageAdvice, isNoData } = await import('./usage')
        const snapshot = await checkUsage({ configDir, account: configDir })
        return {
          snapshot,
          cached: false,
          key: `dir:${configDir}`,
          reason: isNoData(snapshot) ? 'check_failed' : 'ok',
          advice: usageAdvice(snapshot),
          daemon: 'offline (answered locally)',
        }
      })
      // Attach the identity separately rather than routing the whole check through `instance`: the
      // reading itself must keep working with the daemon down and with no instance at all, so a
      // failed identity lookup can only ever cost the label, never the quota numbers.
      let instance: ResolvedInstanceRow | null = null
      try {
        instance = (await apiOrLocal(
          `/api/instance-numbers/whoami${qs({ configDir })}`,
          async () => {
            const { instanceForConfigDir } = await import('./core/instance-ref')
            return await instanceForConfigDir(configDir)
          },
        )) as ResolvedInstanceRow | null
      } catch {
        instance = null
      }
      return { ...(usage as Record<string, unknown>), configDir, instance }
    },
  },
  {
    name: 'list_usage',
    description:
      "Survey the quota of EVERY managed instance (desktop + CLI) in one call, each with its permanent instance `num` and its `advice` verdict. Use this to answer 'which of my accounts has headroom?' before routing heavy work, or to find the account that is about to hit its weekly cap — then refer to the winner by its number. Checks are concurrent and cost no quota.",
    inputSchema: S(),
    run: () =>
      apiOrLocal('/api/usage/survey', async () => {
        const { surveyUsage } = await import('./usage-service')
        const { usageAdvice } = await import('./usage')
        const rows = await surveyUsage()
        return {
          rows: rows.map((r) => ({ ...r, advice: usageAdvice(r.result.snapshot) })),
          daemon: 'offline (answered locally)',
        }
      }),
  },
  {
    name: 'usage_budget',
    description:
      "QUANTIFY the quota: turn a vague '98% used' into numbers you can actually plan with. Returns (a) `forecast` — the burn rate in %/HOUR, the hours of headroom left at that rate, and `exhaustsBeforeReset`, THE field that decides things: if false, the cap will NOT bite before it resets and you can work freely no matter how alarming the % looks; if true, you have `headroomHours` before you are cut off. And (b) `budget` — an estimated TOKEN headroom, derived by measuring (tokens counted from your Claude Code transcripts) / (percent burned), because Anthropic publishes no token or dollar quota. ALWAYS read `budget.caveat` and `budget.confidence`: the token figure only counts Claude Code on THIS machine, so if the account is also used from the desktop app or elsewhere it is an OPTIMISTIC UPPER BOUND. Use this before committing to a long task or a big fan-out. Pass `instance` (its permanent number — the only form that works for Desktop, CLI and Codex alike, and it echoes back which account answered); `dir` and `account` remain for the older desktop/dispatch paths. Add `configDir` to count a specific CLI config dir's transcripts.",
    inputSchema: S({
      instance: INSTANCE_PARAM,
      dir: { type: 'string', description: 'Desktop instance dir (from list_instances).' },
      account: { type: 'string', description: 'A saved dispatch account id or label.' },
      configDir: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Claude config dirs whose transcripts count as this account's spend. Defaults to the plain ~/.claude login (or, when `instance` is a CLI instance, that instance's own config dir).",
      },
    }),
    run: (a) => {
      const params = new URLSearchParams()
      if (a.instance != null && str(a.instance).trim())
        params.set('instance', str(a.instance).trim())
      if (a.dir != null) params.set('dir', str(a.dir))
      if (a.account != null) params.set('account', str(a.account))
      const dirs = (Array.isArray(a.configDir) ? a.configDir : []).map(str)
      for (const d of dirs) params.append('configDir', d)
      if (!params.has('instance') && !params.has('dir') && !params.has('account'))
        throw new Error(
          'pass `instance` (its number — works for Desktop, CLI and Codex), `dir` (a desktop instance) or `account` (id or label)',
        )
      return apiOrLocal(`/api/usage/budget?${params.toString()}`, async () => {
        // Offline path: `instance` and `dir` both work — the number registry and the instance
        // stores are plain JSON files, readable with the app closed. Only `account` cannot be
        // answered here: it resolves a dispatch account out of the daemon's sqlite, and racing
        // the daemon for that DB is not worth the complexity.
        const { resolveInstance, resolveInstanceError } = await import('./core/instance-ref')
        const hit = params.has('instance') ? await resolveInstance(params.get('instance')) : null
        if (params.has('instance') && !hit)
          throw new Error(await resolveInstanceError(params.get('instance')))
        if (!hit && !a.dir)
          throw new Error(
            'the AgentHydra daemon is not running; usage_budget can answer offline for `instance` or `dir` but not for `account`. Start the app, or pass `instance`.',
          )
        if (hit?.kind === 'codex')
          throw new Error(
            `instance #${hit.num} is a Codex instance; its quota comes from the OpenAI API, which this offline path does not call. Start the app and retry.`,
          )
        const { checkUsageForCliInstance, checkUsageForDesktop } = await import('./usage-service')
        const { buildUsageBudget, budgetSummary } = await import('./usage-budget')
        const { usageAdvice } = await import('./usage')
        const result =
          hit?.kind === 'cli'
            ? await checkUsageForCliInstance(hit.handle)
            : await checkUsageForDesktop(hit?.kind === 'desktop' ? hit.handle : str(a.dir))
        if (!result) throw new Error(`instance #${hit?.num} could not be checked`)
        const budget = buildUsageBudget(result.snapshot, result.key, {
          configDirs: dirs.length ? dirs : hit?.kind === 'cli' ? [hit.configDir] : undefined,
        })
        return {
          snapshot: result.snapshot,
          reason: result.reason,
          advice: usageAdvice(result.snapshot),
          budget,
          summary: budgetSummary(budget, result.snapshot.weekAll?.pct ?? null),
          ...(hit ? { instance: { num: hit.num, kind: hit.kind, name: hit.name } } : {}),
          daemon: 'offline (answered locally)',
        }
      })
    },
  },

  // --- CLI instances (Feature A) ------------------------------------------------
  {
    name: 'list_cli_instances',
    description:
      'List CLI instances (a CLAUDE_CONFIG_DIR per account, logged in once) with their permanent instance `num`, login state, associated account, and last usage snapshot.',
    inputSchema: S(),
    run: () => api('/api/cli-instances'),
  },
  {
    name: 'create_cli_instance',
    description:
      "MUTATES: create a new CLI instance — mkdir its CLAUDE_CONFIG_DIR (loggedIn=false). Signing it in is the USER's step afterward (an AI must never perform the /login).",
    inputSchema: S({ name: { type: 'string' } }, ['name']),
    run: (a) =>
      api('/api/cli-instances', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: str(a.name) }),
      }),
  },
  {
    name: 'launch_cli_instance',
    description:
      'MUTATES: open a terminal running this CLI instance (its CLAUDE_CONFIG_DIR set), optionally with a model/effort. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({
      instance: INSTANCE_PARAM,
      id: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
    }),
    run: async (a) =>
      api(
        `/api/cli-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/launch`,
        {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ model: a.model, effort: a.effort }),
        },
      ),
  },
  {
    name: 'cli_instance_login_helper',
    description:
      'MUTATES: open a terminal for the USER to run /login and sign this CLI instance in. The daemon never performs the login itself. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/cli-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/login`,
        { method: 'POST' },
      ),
  },
  {
    name: 'link_cli_instance_to_desktop',
    description:
      "MUTATES: link a CLI instance to a DESKTOP instance (they are normally the same Anthropic account with two separate logins). Linking groups them in the UI and lets each act as the other's usage-check fallback when one's token is expired. Both sides accept an instance NUMBER: `instance` for the CLI side, `desktop` for the desktop side. Pass desktopDir/desktop: null to unlink.",
    inputSchema: S({
      instance: INSTANCE_PARAM,
      id: { type: 'string', description: 'CLI instance id.' },
      desktop: {
        type: ['string', 'number', 'null'],
        description: "The desktop instance's number (or dir/name), or null to unlink.",
      },
      desktopDir: {
        type: ['string', 'null'],
        description: 'Desktop instance dir (from list_instances), or null to unlink.',
      },
    }),
    run: async (a) => {
      const id = await handleFrom(a.id, a.instance, 'id')
      // null is a meaningful VALUE here (unlink), so it must survive the resolve step untouched —
      // only a non-null `desktop` is looked up.
      const explicitNull = a.desktop === null || a.desktopDir === null
      const desktopDir = explicitNull
        ? null
        : a.desktop != null && str(a.desktop).trim()
          ? (await resolveRef(a.desktop)).handle
          : (a.desktopDir ?? null)
      return api(`/api/cli-instances/${encodeURIComponent(id)}/link-desktop`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ desktopDir }),
      })
    },
  },

  // --- Codex CLI + Desktop instances --------------------------------------------
  {
    name: 'list_codex_instances',
    description:
      'List isolated Codex instances (one CODEX_HOME and desktop profile per OpenAI login), each with its permanent instance `num` — the same sequence the Claude instances use, so a number is never ambiguous between them.',
    inputSchema: S(),
    run: () => api('/api/codex-instances'),
  },
  {
    name: 'create_codex_instance',
    description: "MUTATES: create an isolated CODEX_HOME. Authentication remains the user's step.",
    inputSchema: S({ name: { type: 'string' } }, ['name']),
    run: (a) =>
      api('/api/codex-instances', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: str(a.name) }),
      }),
  },
  {
    name: 'launch_codex_instance',
    description:
      'MUTATES: open a terminal running this Codex instance. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/launch`,
        { method: 'POST', headers: JSON_HEADERS, body: '{}' },
      ),
  },
  {
    name: 'codex_instance_login_helper',
    description:
      'MUTATES: open `codex login` in a terminal for the user. The daemon never authenticates for them. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/login`,
        { method: 'POST' },
      ),
  },
  {
    name: 'open_codex_desktop_instance',
    description:
      'MUTATES: launch this isolated Codex Desktop instance, independently from other Codex windows. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/desktop/open`,
        { method: 'POST' },
      ),
  },
  {
    name: 'focus_codex_desktop_instance',
    description:
      "MUTATES: bring this running Codex Desktop instance's window to the foreground. Identify it by number (`instance`) or by `id`.",
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/desktop/focus`,
        { method: 'POST' },
      ),
  },
  {
    name: 'quit_codex_desktop_instance',
    description:
      'MUTATES: stop this isolated Codex Desktop instance. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/desktop/quit`,
        { method: 'POST' },
      ),
  },

  // --- auto-resume monitor (Feature E) ------------------------------------------
  {
    name: 'get_monitor',
    description:
      'Get the auto-resume monitor: settings (enabled, maxAttempts, resumeBufferMin), the tracked rate-limited stops + their state (scheduled / blocked_weekly / needs_human), and per-account overrides.',
    inputSchema: S(),
    run: () => api('/api/monitor'),
  },
  {
    name: 'set_monitor',
    description:
      'MUTATES: update the auto-resume monitor (enabled, maxAttempts, resumeBufferMin). OFF by default. When on, a session killed by a 5-hour rate limit auto-resumes once the window clears — gated on the weekly cap not being maxed.',
    inputSchema: S({
      enabled: { type: 'boolean' },
      maxAttempts: { type: 'number' },
      resumeBufferMin: { type: 'number' },
    }),
    run: (a) =>
      api('/api/monitor', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(a) }),
  },

  // --- self-update ------------------------------------------------------------------
  {
    name: 'check_update',
    description: 'Check whether a AgentHydra update is available (git-based).',
    inputSchema: S(),
    run: () => api('/api/update'),
  },
]

export const SERVER_INFO = { name: 'agenthydra', version: VERSION }

/** The stdio loop, callable from main.ts's `--mcp` subcommand (the compiled exe's MCP mode). */
export function runMcp(): Promise<void> {
  return runMcpStdio({ serverInfo: SERVER_INFO, tools: TOOLS })
}

// Only run the stdio loop when this file is the entry point (`bun run mcp`), not when a test
// imports TOOLS/daemonBase — Bun sets import.meta.main false for module imports.
if (import.meta.main) {
  await runMcp()
}
