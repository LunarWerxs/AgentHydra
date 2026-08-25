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
//
// SELF-IDENTIFICATION runs HERE, not on the daemon — see the block above `detectSelf` and
// core/self-identity.ts. `whoami`, `check_my_usage` and a bare `usage_budget` all share it, so an
// agent can answer "whose quota am I spending?" without being told, including from a Claude
// Desktop session, which sets no CLAUDE_CONFIG_DIR at all.
import { appEnv, IS_COMPILED, PORT, VERSION } from './config'
import type { SelfIdentityDetection } from './core/self-identity'
import { readInstanceInfo } from './instance'
import type { McpEngineTool } from './mcp-stdio.mjs'
import { runMcpStdio } from './mcp-stdio.mjs'
import type { UsageAdvice, UsageSnapshot } from './types'

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
  /** Rate-limit tier — `Pro` / `Max 5×` / `Max 20×`. What the quota IS, as opposed to `plan`,
   *  which is what the subscription is called. The two disagree on org seats. */
  tier: string | null
  configDir: string
  loggedIn: boolean
  isRunning: boolean | null
}

// --- self-identification ------------------------------------------------------
//
// This is the part that has to run HERE, in the MCP server process, and not on the daemon: the
// whole method is reading this process's own environment and walking up to the `claude.exe` that
// spawned it. See core/self-identity.ts for what it looks at and why each signal is needed. The
// daemon is only asked the cheap, stateless question afterwards ("which instance owns this dir?").

/** The detection half is memoized: which instance a process belongs to CANNOT change while that
 *  process lives, and the ancestry fallback costs a PowerShell spawn. The dir→instance lookup is
 *  deliberately NOT cached — the fleet's account/plan data can change under us, and it is one
 *  loopback request. */
let selfDetectionCache: Promise<SelfIdentityDetection> | null = null

async function detectSelf(fresh = false): Promise<SelfIdentityDetection> {
  if (fresh || !selfDetectionCache) {
    selfDetectionCache = (async () => {
      const { detectSelfIdentity } = await import('./core/self-identity')
      return detectSelfIdentity()
    })()
  }
  try {
    return await selfDetectionCache
  } catch (e) {
    selfDetectionCache = null // a failed probe must not be remembered as the answer
    throw e
  }
}

/** Identity as the tools report it: the instance (when it is a managed one), the evidence, and an
 *  explicit warning whenever the answer is anything less than proven. */
interface SelfIdentityPayload {
  instance: ResolvedInstanceRow | null
  configDir: string | null
  kind: SelfIdentityDetection['kind']
  method: SelfIdentityDetection['method']
  confidence: SelfIdentityDetection['confidence']
  clues: SelfIdentityDetection['clues']
  ruledOut: string[]
  summary: string
  /** Present ONLY when the identification is uncertain or contradictory. Its absence is the
   *  signal that the number below can be quoted without a hedge. */
  warning?: string
}

async function selfIdentity(fresh = false): Promise<SelfIdentityPayload> {
  const { describeSelfIdentity } = await import('./core/self-identity')
  const detection = await detectSelf(fresh)

  let instance: ResolvedInstanceRow | null = null
  if (detection.configDir) {
    // A failed identity lookup may only ever cost the LABEL, never the detection — so this is
    // swallowed rather than thrown. The dir is still correct and still usable for a usage read.
    try {
      instance = (await apiOrLocal(
        `/api/instance-numbers/whoami${qs({ configDir: detection.configDir })}`,
        async () => {
          const { instanceForConfigDir } = await import('./core/instance-ref')
          return await instanceForConfigDir(detection.configDir as string)
        },
      )) as ResolvedInstanceRow | null
    } catch {
      instance = null
    }
  }

  const warnings: string[] = []
  if (detection.conflict) {
    warnings.push(
      'CONFLICT: two independent signals named different credential directories. The highest-priority one was used; do not spend quota on this identification without confirming it with the human.',
    )
  }
  if (detection.confidence === 'assumed') {
    warnings.push(
      'ASSUMED, not proven: no instance signal matched, so this fell back to the default ~/.claude login by elimination. If a human told you an instance number, THEIRS IS THE AUTHORITATIVE ANSWER — believe it over this.',
    )
  }
  if (detection.confidence === 'none') {
    warnings.push(
      'UNIDENTIFIED: this process does not look like it is running under Claude Code at all. Treat any quota reading as unattributed.',
    )
  }
  if (!instance && detection.confidence === 'exact' && detection.kind === 'desktop') {
    warnings.push(
      `This is a Claude Desktop user-data dir that AgentHydra does not manage (${detection.configDir}), so it has no instance number. Its quota can still be read.`,
    )
  }

  return {
    instance,
    configDir: detection.configDir,
    kind: detection.kind,
    method: detection.method,
    confidence: detection.confidence,
    clues: detection.clues,
    ruledOut: detection.ruledOut,
    summary: describeSelfIdentity(detection, instance),
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
  }
}

/** Enough of an instance row to name it in a sentence. Both the fleet rows and the slimmer
 *  `instance` echo that `/api/usage` attaches satisfy this. */
type NameableInstance = {
  num?: number
  name?: string
  plan?: string | null
  tier?: string | null
} | null

/** `instance #12 (Joel · Max 20×)` — the phrase an agent should use instead of a bare percentage.
 *  Prefers `tier` over `plan`: the tier is what the quota IS. */
function instanceLabel(i: NameableInstance): string | null {
  if (!i?.num) return null
  const what = i.tier ?? i.plan ?? null
  return `instance #${i.num}${i.name ? ` (${i.name}${what ? ` · ${what}` : ''})` : what ? ` (${what})` : ''}`
}

/**
 * Attach the one-line `nextStep` instruction to a usage result.
 *
 * Every usage tool goes through here so the guidance is identical wherever it appears, and so a
 * response that reached us without an `advice` block (an older daemon, a cached row) still gets
 * one derived from its own snapshot rather than silently losing the instruction.
 */
async function withNextStep(result: unknown, self?: SelfIdentityPayload | null): Promise<unknown> {
  if (result === null || typeof result !== 'object') return result
  const r = result as Record<string, unknown>
  const { nextStep, usageAdvice } = await import('./usage')
  const advice =
    (r.advice as UsageAdvice | undefined) ??
    (r.snapshot ? usageAdvice(r.snapshot as UsageSnapshot) : null)
  if (!advice) return result
  return {
    ...r,
    advice,
    nextStep: nextStep(advice, {
      // `self` is only passed when the target was worked out rather than named by the caller —
      // a caller who passed `instance: 7` has no attribution problem to warn about.
      identityUncertain: self ? self.confidence !== 'exact' || !!self.warning : false,
      instanceLabel: instanceLabel((r.instance as NameableInstance) ?? self?.instance ?? null),
    }),
  }
}

/** Daemon-offline usage read for one identified instance, mirroring `/api/usage?instance=N`'s
 *  routing. Codex is the one family that cannot be answered here (its quota is an OpenAI API call
 *  the offline path deliberately does not make), so it says so instead of returning a silent null. */
async function localUsageForInstance(row: ResolvedInstanceRow): Promise<unknown> {
  const { usageAdvice, parseUsageOutput } = await import('./usage')
  if (row.kind === 'codex') {
    const snapshot = parseUsageOutput('', row.name)
    return {
      snapshot,
      cached: false,
      key: row.ref,
      reason: 'check_failed',
      advice: usageAdvice(snapshot),
      daemon: `offline (answered locally) — instance #${row.num} is a Codex instance, whose quota comes from the OpenAI API; start AgentHydra and retry.`,
    }
  }
  const { checkUsageForCliInstance, checkUsageForDesktop } = await import('./usage-service')
  const result =
    row.kind === 'desktop'
      ? await checkUsageForDesktop(row.handle)
      : await checkUsageForCliInstance(row.handle)
  if (!result) {
    const snapshot = parseUsageOutput('', row.name)
    return {
      snapshot,
      cached: false,
      key: row.ref,
      reason: 'check_failed',
      advice: usageAdvice(snapshot),
      daemon: 'offline (answered locally)',
    }
  }
  return {
    ...result,
    advice: result.advice ?? usageAdvice(result.snapshot),
    daemon: 'offline (answered locally)',
  }
}

/** Usage for a Claude DESKTOP user-data dir that is not a numbered instance. Always answered
 *  in-process: the desktop credential is Electron safeStorage, which the `configDir` REST route
 *  (a CLI `.credentials.json` reader) cannot open. */
async function localUsageForDesktopDir(dir: string): Promise<unknown> {
  const { checkUsageForDesktop } = await import('./usage-service')
  const { usageAdvice } = await import('./usage')
  const result = await checkUsageForDesktop(dir)
  return { ...result, advice: result.advice ?? usageAdvice(result.snapshot) }
}

/** Daemon-offline usage read for a bare CLI credential dir — the plain `~/.claude` login, or an
 *  explicit CLAUDE_CONFIG_DIR. */
async function localUsageForConfigDir(configDir: string): Promise<unknown> {
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
      // THE DEFAULT WINDOW IS NAMED IN THE FIRST SENTENCE, and that is the whole reason this
      // description was rewritten. The route defaults to period=24h, this tool had no period
      // parameter at all, and so an agent asked to go through "all my chat histories" got one day
      // of them and no indication that anything had been withheld — a silent wrong answer, which
      // is the worst kind an API can give. Say the default, and give it the knob to change it.
      'List local Claude, Codex, OpenCode and other local-agent sessions, most recently active ' +
      'first. DEFAULTS TO THE LAST 24 HOURS: pass period="all" (or an explicit since/until) or you ' +
      'are seeing one day of a store that may hold years. Each row carries its source and a ' +
      '`dispatched` flag: true means AgentHydra queued that work, false means a person drove it by ' +
      'hand. That is known exactly (every dispatch names the session id on the command line), not ' +
      'guessed at. Rows also carry `limit_stop` (non-null when the session hit a usage/quota wall — ' +
      'see list_rate_limited_sessions) and `title_source`/`title_tag`, which say where the row got ' +
      'its title from. Start at list_projects to learn what folders exist, then scope with project= ' +
      'and page with offset= rather than raising limit.',
    inputSchema: S({
      limit: { type: 'number', description: 'Max sessions to return (default 200, max 500).' },
      offset: {
        type: 'number',
        description:
          'Skip this many rows first — the paging cursor. Pages are contiguous: offset=500 with ' +
          'limit=500 is exactly page 2 of the same ordering.',
      },
      period: {
        type: 'string',
        enum: ['24h', '7d', '30d', 'all'],
        description:
          'How far back to reach, by last activity. DEFAULT "24h". Use "all" for the whole store.',
      },
      since: {
        type: 'string',
        description:
          'Lower bound on last activity — epoch milliseconds or an ISO date ("2026-08-01"). ' +
          'Overrides period when both are given.',
      },
      until: {
        type: 'string',
        description:
          'Upper bound on last activity, same formats. With since, this is an arbitrary date range.',
      },
      project: {
        type: 'string',
        description:
          'Case-insensitive substring of the working directory or project key, e.g. "agenthydra". ' +
          'Use list_projects to see what is available.',
      },
      source: {
        type: 'string',
        enum: ['claude', 'codex', 'opencode', 'foreign'],
        description:
          'Optional provider filter. "foreign" is the shared reader for the other local agents ' +
          '(Cursor, Windsurf, Zed, Copilot CLI and the rest) — omit it to get every store at once.',
      },
      instance: {
        type: 'string',
        description:
          'Scope to one Claude Desktop instance by its DIRECTORY NAME (list_instances -> name), ' +
          "'default' for the non-isolated install, or 'other' for plain CLI sessions. Claude only.",
      },
      archived: {
        type: 'string',
        enum: ['hide', 'include', 'only'],
        description:
          'Provider archive state. Default "hide" — archived is the majority of a real store, so ' +
          'including it buries live work. Pass "include" when the question is genuinely historical.',
      },
      dispatched: {
        type: 'string',
        enum: ['all', 'queued', 'manual'],
        description: 'Narrow to work AgentHydra queued, or to work driven by hand. Default all.',
      },
      rateLimited: {
        type: 'string',
        enum: ['all', 'only', 'pending'],
        description:
          'Narrow to sessions that hit a usage/quota wall ("only"), or to the ones still stopped ' +
          'at one right now ("pending"). Default all.',
      },
    }),
    run: (a) =>
      api(
        `/api/sessions${qs({
          limit: a.limit,
          offset: a.offset,
          period: a.period,
          since: a.since,
          until: a.until,
          project: a.project,
          source: a.source,
          instance: a.instance,
          archived: a.archived,
          dispatched: a.dispatched,
          ratelimited: a.rateLimited,
        })}`,
      ),
  },
  {
    name: 'list_projects',
    description:
      'Every folder that has local agent conversations in it, newest activity first, with a ' +
      'session count and a per-provider breakdown. This is the index of the index: the session ' +
      'list only ever answers newest-N, so this is how you find out what "all my chat histories" ' +
      'actually contains before querying it. Cheap — it reads the transcript index, never a ' +
      'transcript. Feed a `cwd` back in as list_sessions(project=…).',
    inputSchema: S({}),
    run: () => api('/api/sessions/projects'),
  },
  {
    name: 'list_rate_limited_sessions',
    description:
      'Conversations that were cut off by a usage/quota wall — "You\'ve hit your weekly limit · ' +
      'resets 3am" — newest first. `pending: true` on a row means nothing followed the notice, so ' +
      'that session is STILL stopped there and is the actionable half; pending:false means it was ' +
      "resumed later and is history. Detection trusts only the CLI's own error report, never model " +
      'prose or tool output, so a session that merely discussed rate limits is not listed. Claude ' +
      'sessions only: Codex and OpenCode record an error, but not in a form worth trusting, and a ' +
      'false claim here would be worse than a missing one. Defaults to the WHOLE store, not 24h, ' +
      'because this question is almost always historical.',
    inputSchema: S({
      limit: { type: 'number', description: 'Max sessions to return (default 200, max 500).' },
      pendingOnly: {
        type: 'boolean',
        description:
          'Only sessions still sitting at the wall right now. Default false (all of them).',
      },
      period: {
        type: 'string',
        enum: ['24h', '7d', '30d', 'all'],
        description: 'How far back to reach. DEFAULT "all" for this tool.',
      },
      project: { type: 'string', description: 'Case-insensitive cwd/project substring filter.' },
    }),
    run: (a) =>
      api(
        `/api/sessions${qs({
          limit: a.limit,
          period: a.period ?? 'all',
          project: a.project,
          archived: 'include',
          ratelimited: a.pendingOnly ? 'pending' : 'only',
        })}`,
      ),
  },
  {
    name: 'get_session',
    description: 'Get one session by id (full summary).',
    inputSchema: S(
      {
        id: { type: 'string' },
        source: { type: 'string', enum: ['claude', 'codex', 'opencode', 'foreign'] },
      },
      ['id'],
    ),
    run: (a) => api(`/api/sessions/${encodeURIComponent(str(a.id))}${qs({ source: a.source })}`),
  },
  {
    name: 'search_sessions',
    description:
      // The completeness caveat is the load-bearing sentence. An agent that reads an empty result
      // as "this text is nowhere on the machine" will confidently rebuild work that already exists,
      // so the flag that says otherwise is named in the description, not just in the payload.
      'Search the CONTENT of local transcripts (Claude, Codex, OpenCode) for text, or for a regular expression with regex=true. Returns matching sessions newest-active first, each with a match count and snippets. READ THE `searched` FIELD ON THE RESULT. "index" means it came from the conversation index: instant and complete over what was SAID (human and assistant turns, matched by whole words and phrases), but it does NOT cover tool output such as file reads and command output, and does not match text inside a word — re-run with everything=true when a miss would matter. "scan" means it streamed the transcripts under a wall-clock budget; check budgetExhausted, because when that is true the search gave up early and finding nothing proves nothing. limitReached means the hit list was capped, not that time ran out. Use list_sessions when you already know which session you want; use this to find one by something said inside it.',
    inputSchema: S(
      {
        query: { type: 'string', description: 'Text to find, or a regex pattern if regex=true.' },
        regex: {
          type: 'boolean',
          description:
            'Treat query as a regular expression. Structurally unsafe patterns are rejected rather than risking a hang.',
        },
        caseSensitive: { type: 'boolean', description: 'Match case exactly (default false).' },
        source: {
          type: 'string',
          enum: ['claude', 'codex', 'opencode', 'foreign'],
          description:
            "Optional provider filter. 'foreign' is the shared reader for the other local agents " +
            '(Cursor, Windsurf, Zed, Copilot CLI and the rest); omit it to search every store.',
        },
        instance: {
          type: 'string',
          description:
            "Scope to one Claude Desktop instance by its DIRECTORY NAME (list_instances -> name), or 'default' for the non-isolated install, or 'other' for plain CLI sessions. This one does NOT take an instance number.",
        },
        limit: { type: 'number', description: 'Max sessions to return (default 50, max 200).' },
        everything: {
          type: 'boolean',
          description:
            'Search every byte of every transcript, tool output included, instead of the fast conversation index. Slower (tens of seconds) and bounded by a time budget, but it is the only way to match text that appears inside a tool result or in the middle of a word. Use it when a normal search found nothing and you need to be sure.',
        },
      },
      ['query'],
    ),
    run: (a) =>
      api(
        `/api/sessions/search${qs({
          q: str(a.query),
          regex: a.regex ? '1' : undefined,
          case: a.caseSensitive ? '1' : undefined,
          source: a.source,
          instance: a.instance,
          limit: a.limit,
          everything: a.everything ? '1' : undefined,
        })}`,
      ),
  },
  {
    name: 'tail_session',
    description:
      'Tail a session transcript: the most recent turns. `limit` is applied AFTER the filters, so ' +
      'humanOnly=true gives you the last N things a PERSON said rather than N mixed turns — that is ' +
      'the cheapest way to find out what a long session was actually asked to do. Reasoning blocks ' +
      'are omitted unless thinking=true.',
    inputSchema: S(
      {
        id: { type: 'string' },
        limit: { type: 'number', description: 'Max turns to return (default 40).' },
        textOnly: { type: 'boolean', description: 'Drop tool_use/tool_result turns, text only.' },
        thinking: { type: 'boolean', description: "Include the model's reasoning blocks." },
        humanOnly: {
          type: 'boolean',
          description: 'Only the user turns. Overrides textOnly. Use this to skim a long session.',
        },
        source: { type: 'string', enum: ['claude', 'codex', 'opencode', 'foreign'] },
      },
      ['id'],
    ),
    run: (a) =>
      api(
        `/api/sessions/${encodeURIComponent(str(a.id))}/tail${qs({
          limit: a.limit,
          textOnly: a.textOnly ? '1' : undefined,
          thinking: a.thinking ? '1' : undefined,
          humanOnly: a.humanOnly ? '1' : undefined,
          source: a.source,
        })}`,
      ),
  },

  {
    name: 'export_session',
    description:
      'Render a WHOLE session as readable Markdown (or self-contained HTML), not the tail window. ' +
      'Secrets in recognisable formats are replaced before the text is returned. Use this to hand a ' +
      'session to a person, or to read one end to end; use tail_session when the recent turns are ' +
      'enough, because a long session exported in full is very large.',
    inputSchema: S(
      {
        id: { type: 'string' },
        format: { type: 'string', enum: ['markdown', 'html'], description: 'Default markdown.' },
        thinking: { type: 'boolean', description: "Include the model's reasoning blocks." },
        source: { type: 'string', enum: ['claude', 'codex', 'opencode', 'foreign'] },
      },
      ['id'],
    ),
    run: (a) =>
      api(
        `/api/sessions/${encodeURIComponent(str(a.id))}/export${qs({
          format: a.format,
          thinking: a.thinking ? '1' : undefined,
          source: a.source,
        })}`,
      ),
  },
  {
    name: 'scan_session_secrets',
    description:
      'Count the credentials a session printed into its transcript, with a REDACTED list of what ' +
      'and where. Never returns a secret, by design. Matches unmistakable formats only (private ' +
      'keys, AWS key ids, provider tokens): a count of zero means none of those were found, not ' +
      'that the session is clean.',
    inputSchema: S(
      {
        id: { type: 'string' },
        source: { type: 'string', enum: ['claude', 'codex', 'opencode', 'foreign'] },
      },
      ['id'],
    ),
    run: (a) =>
      api(`/api/sessions/${encodeURIComponent(str(a.id))}/secrets${qs({ source: a.source })}`),
  },

  // --- analytics ----------------------------------------------------------------
  {
    name: 'get_spend',
    description:
      'Token and dollar totals across sessions, broken down by model, project, day and dispatching ' +
      'account. Read `coverage`: the totals come from a background scan, so sessions/total tells ' +
      'you how much of the store it has reached, and a chart drawn from a half-warmed store is not ' +
      'wrong so much as partial. Costs use published list prices; a subscription plan is not billed ' +
      'per token. `unpricedModels` means those tokens counted but their money did not, so the ' +
      'total is a floor.',
    inputSchema: S({
      period: {
        type: 'string',
        enum: ['24h', '7d', '30d', 'all'],
        description: 'How far back to total. Default 30d.',
      },
    }),
    run: (a) => api(`/api/analytics/spend${qs({ period: a.period })}`),
  },
  {
    name: 'get_activity',
    description:
      'When work happens and what it uses: an hour-of-week histogram, the tool mix, total ' +
      'agent-minutes (engaged time, not wall clock), and the sessions whose health signals stand ' +
      'out (long tool-failure streaks, heavy edit churn, repeated compaction).',
    inputSchema: S({
      period: { type: 'string', enum: ['24h', '7d', '30d', 'all'], description: 'Default 30d.' },
    }),
    run: (a) => api(`/api/analytics/activity${qs({ period: a.period })}`),
  },
  {
    name: 'get_recent_edits',
    description:
      'Files changed across recent sessions, newest first, each with the session and the turn that ' +
      'changed it so you can open the transcript at that point. Paths only, never diffs.',
    inputSchema: S({ limit: { type: 'number', description: 'Max entries (default 200).' } }),
    run: (a) => api(`/api/analytics/edits${qs({ limit: a.limit })}`),
  },
  {
    name: 'get_run_cost',
    description:
      'What ONE queued run cost, computed from the transcript turns inside that run’s own start ' +
      'and finish instants. Nothing is stored, so this can never disagree with the session total. ' +
      'AgentsView cannot answer this at all: it did not dispatch the work and so cannot tell which ' +
      'turns belong to which run.',
    inputSchema: S({ id: { type: 'string', description: 'Queue item id.' } }, ['id']),
    run: (a) => api(`/api/queue/${encodeURIComponent(str(a.id))}/cost`),
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
      "Get a queue item's recorded run events (assistant/user/system turns for that run) AND how the run ended. Read `outcome` before drawing conclusions from the events: `died` is true whenever the run stopped without completing, `status` says which kind (failed / canceled / rate_limited / overloaded) and `exit_code` is the child process's own code, with -1 meaning the daemon lost the runner and never saw it exit. A log that simply stops is a crash or a kill, not a short answer, and the events alone cannot tell you which.",
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
      "WHICH INSTANCE AM I? Identifies the instance THIS process is actually running as — permanent number, kind, account email, plan and raw rate-limit tier — and shows its WORKING. It does NOT just read one env var: a Claude Desktop session sets no CLAUDE_CONFIG_DIR, so identification walks CODEX_HOME → CLAUDE_CONFIG_DIR → CLAUDE_CODE_EXECPATH → the instance folder holding this session's own claude-code-sessions file → the parent `claude.exe` process and the Electron host's --user-data-dir. Read `confidence`: 'exact' means a signal named the credential store and you may quote the number; 'assumed' means it fell back to the default ~/.claude login by ELIMINATION and must be hedged. `clues` is the literal proof, `ruledOut` says what was checked and came up empty. TWO THINGS THAT LOOK AUTHORITATIVE AND LIE, so never identify yourself from them: your transcript's location (a Desktop-instance session still writes to the DEFAULT ~/.claude/projects) and ~/.claude.json's oauthAccount email (the machine's default login, not the credential this session bills to). If a human tells you an instance number, THAT beats all of this.",
    inputSchema: S({
      fresh: {
        type: 'boolean',
        description:
          'Re-run the detection instead of reusing this process’s cached answer. Rarely needed — an identity cannot change while a process lives.',
      },
    }),
    run: async (a) => {
      const self = await selfIdentity(a.fresh === true)
      return {
        ...self,
        note: self.instance
          ? undefined
          : self.confidence === 'exact'
            ? 'Identified a credential directory that belongs to no managed instance, so there is no number to quote. check_my_usage still reads the right account.'
            : 'This process is not running as a managed instance — check_my_usage will report the default login, and will say so.',
        nextStep:
          self.confidence === 'exact'
            ? `Use ${instanceLabel(self.instance) ?? 'this account'} whenever you report quota, and call check_my_usage {} before any heavy or long work.`
            : 'Identification is NOT settled, so do not name an account. Ask the human which instance you are (their answer overrules this detection), and treat any quota reading as unattributed until they say.',
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
    run: async (a) => {
      const instance = a.instance != null ? str(a.instance).trim() : ''
      if (instance) return withNextStep(await api(`/api/usage${qs({ instance, refresh: '1' })}`))
      const account = a.account != null ? str(a.account) : ''
      const configDir =
        a.configDir != null ? str(a.configDir) : (process.env.CLAUDE_CONFIG_DIR ?? '')
      if (!account && !configDir)
        throw new Error(
          'pass `instance` (its number — see list_instance_numbers), `account`, or `configDir` (or use check_my_usage, which works out which account THIS process bills to on its own)',
        )
      return withNextStep(
        await api(
          `/api/usage${qs({ account: account || undefined, configDir: configDir || undefined, refresh: '1' })}`,
        ),
      )
    },
  },
  {
    name: 'check_my_usage',
    description:
      'Self-check: read YOUR OWN remaining Claude quota, right now, in ~300ms. Returns the session (5h) %, the weekly all-models % (the BINDING cap), an `advice` verdict with `shouldOffload` / `safeToFanOut` flags, and `identity` — WHICH numbered instance you are, on WHAT plan/tier, and HOW that was established, so you can report "instance #11 (Pro) is at 82% weekly" instead of an unattributed percentage. It identifies itself the same way whoami does (env → session file → parent process), so it reports the right account for a Claude DESKTOP session too, not just a CLI instance that sets CLAUDE_CONFIG_DIR. CALL THIS when you are doing long or heavy work: if `shouldOffload` is true you are close to being cut off mid-task, and you should WRITE YOUR WORKING CONTEXT, FINDINGS, AND NEXT STEPS TO A FILE BEFORE CONTINUING, so the work survives. Also call it before a big multi-agent fan-out — and gate on CURRENT + PROJECTED cost, because a fan-out cannot be recalled once launched while solo work can be stopped at any tool call. If `identity.warning` is present, the percentages are real but WHOSE they are is not settled: say so rather than quoting a bare number.',
    inputSchema: S(),
    run: async () => {
      const self = await selfIdentity()

      // Prefer the INSTANCE route. It matters: a desktop instance's credential lives in Electron
      // safeStorage, not in a `.credentials.json`, so reading it by configDir alone returns
      // check_failed — which is exactly what a Desktop session used to get back. Routing by number
      // takes the full credential chain (own token → linked CLI login → dispatch account).
      const usage = self.instance
        ? await apiOrLocal(`/api/usage${qs({ instance: self.instance.num, refresh: '1' })}`, () =>
            localUsageForInstance(self.instance as ResolvedInstanceRow),
          )
        : !self.configDir
          ? { snapshot: null, reason: 'check_failed' }
          : self.kind === 'desktop'
            ? // An UNMANAGED desktop user-data dir. Answered in-process rather than through
              // /api/usage?configDir=, which reads a CLI `.credentials.json` a desktop dir does
              // not have — the exact mismatch that made a Desktop session's self-check fail.
              // There is no REST route for an arbitrary desktop dir, and this needs none: the
              // safeStorage token is a local file and the quota endpoint is one HTTPS GET.
              await localUsageForDesktopDir(self.configDir)
            : // The plain `~/.claude` login (or a CLI config dir).
              await apiOrLocal(`/api/usage${qs({ configDir: self.configDir, refresh: '1' })}`, () =>
                localUsageForConfigDir(self.configDir as string),
              )

      return await withNextStep(
        {
          ...(usage as Record<string, unknown>),
          identity: self,
          // Kept at the top level for every existing caller written against the old shape.
          configDir: self.configDir,
          instance: self.instance,
        },
        self,
      )
    },
  },
  {
    name: 'list_usage',
    description:
      "Survey the quota of EVERY managed instance (desktop + CLI) in one call, each with its permanent instance `num` and its `advice` verdict. Use this to answer 'which of my accounts has headroom?' before routing heavy work, or to find the account that is about to hit its weekly cap — then refer to the winner by its number. Checks are concurrent and cost no quota.",
    inputSchema: S(),
    run: async () => {
      const survey = (await apiOrLocal('/api/usage/survey', async () => {
        const { surveyUsage } = await import('./usage-service')
        const { usageAdvice } = await import('./usage')
        const rows = await surveyUsage()
        return {
          rows: rows.map((r) => ({ ...r, advice: usageAdvice(r.result.snapshot) })),
          daemon: 'offline (answered locally)',
        }
      })) as Record<string, unknown>
      return {
        ...survey,
        // A survey has no single advice to branch on, so the instruction is about what to DO with
        // a list: pick by the binding cap, and quote the number so the human can check the choice.
        nextStep:
          'Route heavy work to the row with the lowest WEEKLY (all models) %, not the lowest session %, and name it by its `num` when you say where you sent it. A row whose advice.severity is "unknown" was not read successfully; that is not headroom.',
      }
    },
  },
  {
    name: 'usage_budget',
    description:
      "QUANTIFY the quota: turn a vague '98% used' into numbers you can actually plan with. Returns (a) `forecast` — the burn rate in %/HOUR, the hours of headroom left at that rate, and `exhaustsBeforeReset`, THE field that decides things: if false, the cap will NOT bite before it resets and you can work freely no matter how alarming the % looks; if true, you have `headroomHours` before you are cut off. And (b) `budget` — an estimated TOKEN headroom, derived by measuring (tokens counted from your Claude Code transcripts) / (percent burned), because Anthropic publishes no token or dollar quota. ALWAYS read `budget.caveat` and `budget.confidence`: the token figure only counts Claude Code on THIS machine, so if the account is also used from the desktop app or elsewhere it is an OPTIMISTIC UPPER BOUND. Use this before committing to a long task or a big fan-out. CALL IT WITH NO ARGUMENTS to budget YOURSELF — it identifies which instance this process is (same detection as whoami, so a Claude Desktop session works too) and returns an `identity` block naming the account it measured. Pass `instance` (its permanent number — the only form that works for Desktop, CLI and Codex alike, and it echoes back which account answered) to budget a different one; `dir` and `account` remain for the older desktop/dispatch paths. Add `configDir` to count a specific CLI config dir's transcripts.",
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
    run: async (a) => {
      const params = new URLSearchParams()
      if (a.instance != null && str(a.instance).trim())
        params.set('instance', str(a.instance).trim())
      if (a.dir != null) params.set('dir', str(a.dir))
      if (a.account != null) params.set('account', str(a.account))
      const dirs = (Array.isArray(a.configDir) ? a.configDir : []).map(str)
      for (const d of dirs) params.append('configDir', d)

      // NO TARGET GIVEN → budget MYSELF. This used to throw, which meant the one caller who most
      // needs a burn rate (an agent deciding whether it can finish) had to know its own instance
      // number first — and a Desktop session had no way to learn it.
      let self: SelfIdentityPayload | null = null
      if (!params.has('instance') && !params.has('dir') && !params.has('account')) {
        self = await selfIdentity()
        if (self.instance) params.set('instance', String(self.instance.num))
        else if (self.kind === 'desktop' && self.configDir) params.set('dir', self.configDir)
        // The plain ~/.claude login: no instance number, no desktop dir. `configDir` is both the
        // credential to read AND the transcripts to count, which is exactly what the budget route's
        // configDir branch does.
        else if (self.configDir) params.append('configDir', self.configDir)
        else
          throw new Error(
            `could not identify which account this process runs as (${self.summary}). Pass \`instance\` (its number — see list_instance_numbers), \`dir\` or \`account\`.`,
          )
      }

      const withSelf = (r: unknown) =>
        withNextStep(self ? { ...(r as Record<string, unknown>), identity: self } : r, self)

      // Read the TARGET back off `params`, not off `a` — self-identification may have filled it in.
      const spendDirs = params.getAll('configDir')
      const dirParam = params.get('dir')

      return withSelf(
        await apiOrLocal(`/api/usage/budget?${params.toString()}`, async () => {
          // Offline path: `instance`, `dir` and `configDir` all work — the number registry, the
          // instance stores and a CLI login's credentials are plain files, readable with the app
          // closed. Only `account` cannot be answered here: it resolves a dispatch account out of
          // the daemon's sqlite, and racing the daemon for that DB is not worth the complexity.
          const { resolveInstance, resolveInstanceError } = await import('./core/instance-ref')
          const hit = params.has('instance') ? await resolveInstance(params.get('instance')) : null
          if (params.has('instance') && !hit)
            throw new Error(await resolveInstanceError(params.get('instance')))
          if (!hit && !dirParam && spendDirs.length === 0)
            throw new Error(
              'the AgentHydra daemon is not running; usage_budget can answer offline for `instance`, `dir` or `configDir` but not for `account`. Start the app, or pass `instance`.',
            )
          if (hit?.kind === 'codex')
            throw new Error(
              `instance #${hit.num} is a Codex instance; its quota comes from the OpenAI API, which this offline path does not call. Start the app and retry.`,
            )
          const { checkUsageForCliInstance, checkUsageForDesktop } = await import('./usage-service')
          const { buildUsageBudget, budgetSummary } = await import('./usage-budget')
          const { checkUsage, isNoData, usageAdvice } = await import('./usage')
          const result =
            hit?.kind === 'cli'
              ? await checkUsageForCliInstance(hit.handle)
              : hit?.kind === 'desktop' || dirParam
                ? await checkUsageForDesktop(hit?.handle ?? (dirParam as string))
                : await (async () => {
                    const cd = spendDirs[0] as string
                    const snapshot = await checkUsage({ configDir: cd, account: cd })
                    return {
                      snapshot,
                      cached: false,
                      key: `dir:${cd}`,
                      reason: isNoData(snapshot) ? ('check_failed' as const) : ('ok' as const),
                    }
                  })()
          if (!result) throw new Error(`instance #${hit?.num} could not be checked`)
          const budget = buildUsageBudget(result.snapshot, result.key, {
            configDirs: spendDirs.length
              ? spendDirs
              : hit?.kind === 'cli'
                ? [hit.configDir]
                : undefined,
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
        }),
      )
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

  // --- orchestrator (docs/ORCHESTRATOR.md) --------------------------------------
  {
    name: 'get_orchestrator',
    description:
      'Get the orchestrator watcher: settings and the current attention feed — live chats idle and pending input (with the recap tail to judge from), chats due a context handoff, usage band/spike alerts per account, long-dirty repos, off-main branches, and offered task chips. This is the feed the /orchestrate reviewer session acts on.',
    inputSchema: S(),
    run: () => api('/api/orchestrator'),
  },
  {
    name: 'set_orchestrator',
    description:
      'MUTATES: update orchestrator watcher settings (enabled, tickSecs, idleQuietSecs, ctxHandoffTokens, softPct/warnPct/hardPct, sessionHighPct, resetSoonMins, spikePct, dirtyMins, nudgeCooldownMins). OFF by default. The watcher only reads local state; it never messages sessions or spends quota.',
    inputSchema: S({
      enabled: { type: 'boolean' },
      tickSecs: { type: 'number' },
      idleQuietSecs: { type: 'number' },
      ctxHandoffTokens: { type: 'number' },
      softPct: { type: 'number' },
      warnPct: { type: 'number' },
      hardPct: { type: 'number' },
      sessionHighPct: { type: 'number' },
      resetSoonMins: { type: 'number' },
      spikePct: { type: 'number' },
      dirtyMins: { type: 'number' },
      nudgeCooldownMins: { type: 'number' },
      openInstances: { type: 'string', enum: ['never', 'when-exhausted'] },
      openMinPlan: { type: 'string' },
      reviewerReservePct: { type: 'number' },
      handoffSurface: { type: 'string', enum: ['desktop', 'terminal', 'queue'] },
    }),
    run: (a) =>
      api('/api/orchestrator', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(a) }),
  },
  {
    name: 'launch_terminal_session',
    description:
      "MUTATES: open a VISIBLE terminal window running a NEW interactive Claude session in `cwd` with `prompt` as its first message, pinned to `instance_ref`'s account ('desktop:<dir>' or 'cli:<id>'; omitted = ambient login). Unlike a headless queue run, the session is on the user's screen and joins the live peer registry, so the orchestrator can keep orchestrating it. This is the default handoff-continuation surface.",
    inputSchema: S(
      {
        cwd: { type: 'string' },
        prompt: { type: 'string' },
        instance_ref: { type: 'string' },
        model: { type: 'string' },
      },
      ['cwd', 'prompt'],
    ),
    run: (a) =>
      api('/api/sessions/launch-terminal', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(a),
      }),
  },
  {
    name: 'orchestrator_ack',
    description:
      "MUTATES: acknowledge one attention item by its key after acting on it (or deciding not to). Suppresses that item for cooldownMins (default: the nudgeCooldownMins setting); a session item whose transcript moves after the ack re-arms on its own. `action` is a short note of what was done ('nudged', 'answered', 'queued chip', 'left for human').",
    inputSchema: S(
      {
        key: { type: 'string' },
        action: { type: 'string' },
        cooldownMins: { type: 'number' },
      },
      ['key', 'action'],
    ),
    run: (a) =>
      api('/api/orchestrator/ack', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(a),
      }),
  },
  {
    name: 'orchestrator_check',
    description: 'Run one orchestrator watcher pass now and return the fresh attention feed.',
    inputSchema: S(),
    run: () => api('/api/orchestrator/check', { method: 'POST' }),
  },
  {
    name: 'orchestrator_install_command',
    description:
      "MUTATES: install the shipped orchestrator commands (/orchestrate reviewer loop, /delayo park-this-thread, /resumeo unpark) into this machine's ~/.claude/commands. A copy the user edited is reported as 'differs' and left alone unless force is true. Enabling the orchestrator also installs them when absent.",
    inputSchema: S({ force: { type: 'boolean' } }),
    run: (a) =>
      api('/api/orchestrator/install-command', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(a),
      }),
  },
  {
    name: 'import_session_to_desktop',
    description:
      "MUTATES: import a FINISHED session into a desktop instance's app as a visible chat (the app's own claude://resume one-way import, targeted at one instance). Refuses a currently-live session (the import rewrites the transcript under an active writer). Finish all headless work FIRST and import LAST — this is how completed handoff work lands on the user's screen; a just-imported chat does not process peer messages until the user first interacts with it.",
    inputSchema: S({ session_id: { type: 'string' }, instance_ref: { type: 'string' } }, [
      'session_id',
    ]),
    run: async (a) =>
      api(`/api/sessions/${encodeURIComponent(str(a.session_id))}/import-desktop`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ instance_ref: a.instance_ref }),
      }),
  },
  {
    name: 'orchestrator_hold',
    description:
      'MUTATES: park or unpark one thread for the orchestrator (what /delayo and /resumeo do). held=true drops every feed item for that session so the reviewer never prompts it; held=false lifts the hold. Holds persist until lifted.',
    inputSchema: S({ session_id: { type: 'string' }, held: { type: 'boolean' } }, [
      'session_id',
      'held',
    ]),
    run: (a) =>
      api('/api/orchestrator/hold', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(a),
      }),
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

/**
 * STANDING INSTRUCTIONS, handed to the model in the MCP `initialize` handshake, before it calls
 * anything.
 *
 * WHY THIS EXISTS. A tool description is only read once the model has already decided to call that
 * tool, which is useless for the behaviour that matters here: checking your quota BEFORE the
 * expensive thing, and saving your work BEFORE you are cut off. Neither is discoverable from a
 * tool list. Without this block those rules had to be typed into a human's prompt every session,
 * and the one session where nobody typed them is the session that runs out of quota mid-task.
 *
 * WHY IT IS THIS SHORT. It is in context for the entire session, on every request, so every line
 * is rent. Rules only, no explanation, no API shapes (docs/AI_USAGE_SELFCHECK.md holds the
 * reasoning). If a line would not change what an agent DOES, it does not belong here.
 */
export const SERVER_INSTRUCTIONS = `AgentHydra manages every Claude/Codex account on this machine and knows what each has left.

CHECK YOUR OWN QUOTA BEFORE HEAVY WORK, unprompted. You do not need to be told which account you
are: check_my_usage {} works it out and reads THAT account (~300ms, costs no quota, works with the
app closed). Do it before any multi-agent fan-out, long task, or work you would hate to lose.

Then act on what comes back:
- advice.shouldOffload true -> WRITE YOUR CONTEXT, FINDINGS AND NEXT STEPS TO A FILE NOW, before
  anything else. An agent that runs out mid-task dies holding everything it had not saved.
- advice.safeToFanOut false -> shrink or postpone the fan-out. Gate on CURRENT + PROJECTED cost,
  not current alone: a fan-out cannot be recalled once launched, solo work can be stopped at any
  tool call.
- A percentage decides nothing on its own. usage_budget {} turns it into a burn rate and
  exhaustsBeforeReset, which is the field to branch on.
- The weekly (all-models) % is the binding cap, except on Pro, where the 5-hour window usually
  binds first, so a low weekly number there is not the reassurance it looks like. Switching model
  does not dodge the shared weekly bucket.
- severity 'unknown' or a failed read is NOT "plenty left". Never fan out on an unverified read.

NEVER QUOTE AN UNATTRIBUTED PERCENTAGE. Every usage answer carries identity: name the instance.
If identity.warning is present, the numbers are real but whose they are is not settled, so say so.
A human who tells you your instance number OVERRULES the detection: do not argue them out of it
using a config file, because the config files on this machine are exactly what lie about it.

list_usage {} surveys every account at once. Route heavy work to one with headroom, by its number.
Mutating tools say MUTATES: in their description; never run /login for a human.`

/** The stdio loop, callable from main.ts's `--mcp` subcommand (the compiled exe's MCP mode). */
export function runMcp(): Promise<void> {
  return runMcpStdio({ serverInfo: SERVER_INFO, tools: TOOLS, instructions: SERVER_INSTRUCTIONS })
}

// Only run the stdio loop when this file is the entry point (`bun run mcp`), not when a test
// imports TOOLS/daemonBase — Bun sets import.meta.main false for module imports.
if (import.meta.main) {
  await runMcp()
}
