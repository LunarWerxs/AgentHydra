// CC Manager UI MCP server (stdio) — a thin client over the running daemon's REST API, so an
// MCP-speaking agent (Claude Desktop/Code, Cursor) shares one source of truth with the web UI.
// Start the daemon first (`bun run start` from repo root); point elsewhere with
// CCMANAGERUI_URL / CCMANAGERUI_PORT.
//
// The JSON-RPC 2.0 / MCP protocol + the stdio loop live in the SHARED, zero-dependency engine
// `./mcp-stdio.mjs` (part of the shared kit — edit it there, never here). This file is only the
// app-specific part: an HTTP client + a tool table, each tool a thin proxy over an existing
// /api/* route from index.ts. Beyond the sessions/queue/accounts/scheduler/instances/update tools,
// this also exposes the usage-check subsystem (check_usage / check_my_usage — any agent can read
// its own remaining quota; the weekly all-models % is the binding cap), CLI instances, and the
// auto-resume monitor.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IS_COMPILED, PORT, VERSION } from './config'
import { readInstanceInfo } from './instance'
import type { McpEngineTool } from './mcp-stdio.mjs'
import { runMcpStdio } from './mcp-stdio.mjs'

/** Where a plain `claude` login (no CLAUDE_CONFIG_DIR override) keeps its credentials. */
const defaultClaudeConfigDir = (): string => join(homedir(), '.claude')

// Resolve the base URL per call: an explicit CCMANAGERUI_URL/CCMANAGERUI_PORT always wins, else
// follow the port the daemon ACTUALLY bound (~/.ccmanagerui/runtime.json), so an auto-hopped port
// still works, else fall back to the static configured default.
export function daemonBase(): string {
  if (process.env.CCMANAGERUI_URL) return process.env.CCMANAGERUI_URL
  if (process.env.CCMANAGERUI_PORT) return `http://127.0.0.1:${process.env.CCMANAGERUI_PORT}`
  return readInstanceInfo()?.url ?? `http://127.0.0.1:${PORT}`
}

/** The daemon isn't listening. Distinct from a real API error, so a fallback can fire on THIS and
 *  only this — a 500 from a running daemon must still surface as a failure, not be silently retried
 *  in-process against different code. */
class DaemonUnreachable extends Error {}

/** How to START the daemon, phrased for THIS distribution: a packaged build has no Bun, so telling
 *  its user to `bun run start` is a dead end — point them at the executable / tray instead. */
const startHint = IS_COMPILED
  ? 'Start it by running the CCManagerUI executable (or its tray shortcut).'
  : 'Start it with `bun run start`.'

async function api(pathname: string, init?: RequestInit): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${daemonBase()}${pathname}`, init)
  } catch (e) {
    throw new DaemonUnreachable(
      `couldn't reach the CC Manager UI daemon at ${daemonBase()}. ${startHint} (${e instanceof Error ? e.message : String(e)})`,
    )
  }
  if (!res.ok) throw new Error(`CC Manager UI ${res.status}: ${await res.text()}`)
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
            "Run under a signed-in instance's login: 'desktop:<dir>' (a dir from list_instances) or 'cli:<id>' (an id from list_cli_instances). Takes precedence over account_id.",
        },
        new_chat: {
          type: 'boolean',
          description: 'Start a brand-new session instead of resuming.',
        },
        fork: { type: 'boolean' },
      },
      ['title', 'cwd', 'prompt'],
    ),
    run: (a) =>
      api('/api/queue', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(a),
      }),
  },
  {
    name: 'update_queue_item',
    description:
      "MUTATES: patch a queue item (title, cwd, prompt, model, effort, permission_mode, account_id, instance_ref, status, position, new_chat, fork). instance_ref ('desktop:<dir>' from list_instances, or 'cli:<id>' from list_cli_instances) runs the item under that signed-in instance's login and takes precedence over account_id.",
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
    run: (a) =>
      api(`/api/queue/${encodeURIComponent(str(a.id))}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(a.patch ?? {}),
      }),
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

  // --- multi-instance (isolated Claude Desktop instances) ------------------------
  {
    name: 'list_instances',
    description:
      'List isolated Claude Desktop instances with their live status and resolved account.',
    inputSchema: S(),
    run: () => api('/api/instances'),
  },
  {
    name: 'launch_instance',
    description: 'MUTATES: open (launch) a Claude Desktop instance by its directory.',
    inputSchema: S({ dir: { type: 'string' } }, ['dir']),
    run: (a) => api(`/api/instances/${encodeURIComponent(str(a.dir))}/open`, { method: 'POST' }),
  },
  {
    name: 'quit_instance',
    description: 'MUTATES: quit a running Claude Desktop instance by its directory.',
    inputSchema: S({ dir: { type: 'string' } }, ['dir']),
    run: (a) => api(`/api/instances/${encodeURIComponent(str(a.dir))}/quit`, { method: 'POST' }),
  },

  // --- usage-check subsystem (Feature B) ----------------------------------------
  {
    name: 'check_usage',
    description:
      "Read an account's remaining Claude subscription quota — session (5h) %, weekly (all models) %, any per-model weekly %, plus an `advice` verdict (severity / shouldOffload / safeToFanOut). The WEEKLY all-models % is the BINDING cap for pacing multi-agent work; a fresh 5-hour session % is a red herring when weekly is near 100, and switching flagship model does NOT dodge the all-models weekly bucket. Pass `account` (a saved dispatch account id or label) OR `configDir` (a CLAUDE_CONFIG_DIR that has been /login'd once); with neither, falls back to THIS process's own config (a self-check — but prefer check_my_usage for that).",
    inputSchema: S({
      account: { type: 'string', description: 'A saved dispatch account id or label.' },
      configDir: {
        type: 'string',
        description: 'A CLAUDE_CONFIG_DIR that has been logged in once via `claude` → /login.',
      },
    }),
    run: (a) => {
      const account = a.account != null ? str(a.account) : ''
      const configDir =
        a.configDir != null ? str(a.configDir) : (process.env.CLAUDE_CONFIG_DIR ?? '')
      if (!account && !configDir)
        throw new Error(
          'pass `account` or `configDir` (or set CLAUDE_CONFIG_DIR in this process for a self-check)',
        )
      return api(
        `/api/usage${qs({ account: account || undefined, configDir: configDir || undefined, refresh: '1' })}`,
      )
    },
  },
  {
    name: 'check_my_usage',
    description:
      'Self-check: read YOUR OWN remaining Claude quota, right now, in ~300ms. Returns the session (5h) %, the weekly all-models % (the BINDING cap), and an `advice` verdict with `shouldOffload` / `safeToFanOut` flags. CALL THIS when you are doing long or heavy work: if `shouldOffload` is true you are close to being cut off mid-task, and you should WRITE YOUR WORKING CONTEXT, FINDINGS, AND NEXT STEPS TO A FILE BEFORE CONTINUING, so the work survives. Also call it before a big multi-agent fan-out. Reads whichever config this process is using (CLAUDE_CONFIG_DIR if set, else the default ~/.claude login).',
    inputSchema: S(),
    run: () => {
      // A CLI instance sets CLAUDE_CONFIG_DIR; a NORMAL Claude Code session does not — it uses the
      // default ~/.claude. Falling back to that is what makes this work for the everyday case (the
      // session the user is actually talking to) instead of erroring out on it.
      const configDir = process.env.CLAUDE_CONFIG_DIR || defaultClaudeConfigDir()
      // Works with the app CLOSED: a self-check needs only the config dir's own token + one HTTPS GET.
      return apiOrLocal(`/api/usage${qs({ configDir, refresh: '1' })}`, async () => {
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
    },
  },
  {
    name: 'list_usage',
    description:
      "Survey the quota of EVERY managed instance (desktop + CLI) in one call, each with its `advice` verdict. Use this to answer 'which of my accounts has headroom?' before routing heavy work, or to find the account that is about to hit its weekly cap. Checks are concurrent and cost no quota.",
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
      "QUANTIFY the quota: turn a vague '98% used' into numbers you can actually plan with. Returns (a) `forecast` — the burn rate in %/HOUR, the hours of headroom left at that rate, and `exhaustsBeforeReset`, THE field that decides things: if false, the cap will NOT bite before it resets and you can work freely no matter how alarming the % looks; if true, you have `headroomHours` before you are cut off. And (b) `budget` — an estimated TOKEN headroom, derived by measuring (tokens counted from your Claude Code transcripts) / (percent burned), because Anthropic publishes no token or dollar quota. ALWAYS read `budget.caveat` and `budget.confidence`: the token figure only counts Claude Code on THIS machine, so if the account is also used from the desktop app or elsewhere it is an OPTIMISTIC UPPER BOUND. Use this before committing to a long task or a big fan-out. Pass `dir` (a desktop instance dir from list_instances) or `account`; add `configDir` to count a specific CLI config dir's transcripts.",
    inputSchema: S({
      dir: { type: 'string', description: 'Desktop instance dir (from list_instances).' },
      account: { type: 'string', description: 'A saved dispatch account id or label.' },
      configDir: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Claude config dirs whose transcripts count as this account's spend. Defaults to the plain ~/.claude login.",
      },
    }),
    run: (a) => {
      const params = new URLSearchParams()
      if (a.dir != null) params.set('dir', str(a.dir))
      if (a.account != null) params.set('account', str(a.account))
      const dirs = (Array.isArray(a.configDir) ? a.configDir : []).map(str)
      for (const d of dirs) params.append('configDir', d)
      if (!params.has('dir') && !params.has('account'))
        throw new Error('pass `dir` (a desktop instance) or `account` (id or label)')
      return apiOrLocal(`/api/usage/budget?${params.toString()}`, async () => {
        // Offline path: only the `dir` form works. The `account` form resolves a dispatch account out
        // of the daemon's sqlite, and racing the daemon for that DB is not worth the complexity.
        if (!a.dir)
          throw new Error(
            'the CC Manager UI daemon is not running; usage_budget can answer offline for `dir` (a desktop instance) but not for `account`. Start the app, or pass `dir`.',
          )
        const { checkUsageForDesktop } = await import('./usage-service')
        const { buildUsageBudget, budgetSummary } = await import('./usage-budget')
        const { usageAdvice } = await import('./usage')
        const result = await checkUsageForDesktop(str(a.dir))
        const budget = buildUsageBudget(result.snapshot, result.key, {
          configDirs: dirs.length ? dirs : undefined,
        })
        return {
          snapshot: result.snapshot,
          reason: result.reason,
          advice: usageAdvice(result.snapshot),
          budget,
          summary: budgetSummary(budget, result.snapshot.weekAll?.pct ?? null),
          daemon: 'offline (answered locally)',
        }
      })
    },
  },

  // --- CLI instances (Feature A) ------------------------------------------------
  {
    name: 'list_cli_instances',
    description:
      'List CLI instances (a CLAUDE_CONFIG_DIR per account, logged in once) with login state, associated account, and last usage snapshot.',
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
      'MUTATES: open a terminal running this CLI instance (its CLAUDE_CONFIG_DIR set), optionally with a model/effort.',
    inputSchema: S(
      { id: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' } },
      ['id'],
    ),
    run: (a) =>
      api(`/api/cli-instances/${encodeURIComponent(str(a.id))}/launch`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ model: a.model, effort: a.effort }),
      }),
  },
  {
    name: 'cli_instance_login_helper',
    description:
      'MUTATES: open a terminal for the USER to run /login and sign this CLI instance in. The daemon never performs the login itself.',
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) =>
      api(`/api/cli-instances/${encodeURIComponent(str(a.id))}/login`, { method: 'POST' }),
  },
  {
    name: 'link_cli_instance_to_desktop',
    description:
      "MUTATES: link a CLI instance to a DESKTOP instance (they are normally the same Anthropic account with two separate logins). Linking groups them in the UI and lets each act as the other's usage-check fallback when one's token is expired. Pass desktopDir: null to unlink.",
    inputSchema: S(
      {
        id: { type: 'string', description: 'CLI instance id.' },
        desktopDir: {
          type: ['string', 'null'],
          description: 'Desktop instance dir (from list_instances), or null to unlink.',
        },
      },
      ['id'],
    ),
    run: (a) =>
      api(`/api/cli-instances/${encodeURIComponent(str(a.id))}/link-desktop`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ desktopDir: a.desktopDir ?? null }),
      }),
  },

  // --- Codex CLI + Desktop instances --------------------------------------------
  {
    name: 'list_codex_instances',
    description:
      'List isolated Codex instances (one CODEX_HOME and desktop profile per OpenAI login).',
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
    description: 'MUTATES: open a terminal running this Codex instance.',
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) =>
      api(`/api/codex-instances/${encodeURIComponent(str(a.id))}/launch`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: '{}',
      }),
  },
  {
    name: 'codex_instance_login_helper',
    description:
      'MUTATES: open `codex login` in a terminal for the user. The daemon never authenticates for them.',
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) =>
      api(`/api/codex-instances/${encodeURIComponent(str(a.id))}/login`, { method: 'POST' }),
  },
  {
    name: 'open_codex_desktop_instance',
    description:
      'MUTATES: launch this isolated Codex Desktop instance, independently from other Codex windows.',
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) =>
      api(`/api/codex-instances/${encodeURIComponent(str(a.id))}/desktop/open`, {
        method: 'POST',
      }),
  },
  {
    name: 'focus_codex_desktop_instance',
    description: "MUTATES: bring this running Codex Desktop instance's window to the foreground.",
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) =>
      api(`/api/codex-instances/${encodeURIComponent(str(a.id))}/desktop/focus`, {
        method: 'POST',
      }),
  },
  {
    name: 'quit_codex_desktop_instance',
    description: 'MUTATES: stop this isolated Codex Desktop instance.',
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) =>
      api(`/api/codex-instances/${encodeURIComponent(str(a.id))}/desktop/quit`, {
        method: 'POST',
      }),
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
    description: 'Check whether a CC Manager UI update is available (git-based).',
    inputSchema: S(),
    run: () => api('/api/update'),
  },
]

export const SERVER_INFO = { name: 'ccmanagerui', version: VERSION }

/** The stdio loop, callable from main.ts's `--mcp` subcommand (the compiled exe's MCP mode). */
export function runMcp(): Promise<void> {
  return runMcpStdio({ serverInfo: SERVER_INFO, tools: TOOLS })
}

// Only run the stdio loop when this file is the entry point (`bun run mcp`), not when a test
// imports TOOLS/daemonBase — Bun sets import.meta.main false for module imports.
if (import.meta.main) {
  await runMcp()
}
