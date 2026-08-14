// server/src/usage.ts — read an account's remaining Claude subscription quota.
//
// There is no `claude usage` subcommand and `/usage` is REPL-only, so the only non-interactive
// route is `claude -p "/usage"` in print mode. Auth is injected the SAME way dispatch-runner.ts
// does it (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY env — the account secret from the sqlite
// `accounts` table), so any account already registered for queue dispatch can be polled with no
// extra login. Value-blind: this module surfaces only the numbers `/usage` reports, never a token.
//
// The PURE, TESTED foundation (`parseUsageOutput` + the binding-cap helpers) is at the top; the
// live half (`checkUsage` — spawn `claude -p "/usage"`) + a small on-disk snapshot cache follow.
// `checkUsage` reuses the repo's `claude` binary resolution (config.ts) and the SAME auth-injection
// dispatch-runner.ts uses (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY), so any account already
// registered for queue dispatch is pollable with no extra login; CLAUDE_CONFIG_DIR is the fallback.

import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_PROJECTS_ROOT, DATA_DIR, resolveClaudeExe } from './config'
import { resolveCliConfigDirToken } from './core/accounts'
import { encodeCwdKey } from './transcript'
import type { UsageAdvice, UsageSnapshot } from './types'
import { fetchUsageApi } from './usage-api'

// The DTO types (UsageLimit / UsageSnapshot) are defined in the web-safe types hub (./types) and
// re-exported here so existing `from './usage'` importers keep resolving.
export type { UsageAdvice, UsageLimit, UsageSnapshot } from './types'

// The `/usage` block looks like (note the U+00B7 middle-dot separator):
//   Current session: 0% used · resets Jul 13, 11:49pm (America/Chicago)
//   Current week (all models): 97% used · resets Jul 14, 2:59am (America/Chicago)
//   Current week (Fable): 89% used · resets Jul 14, 3am (America/Chicago)
// The "· resets …" clause is OPTIONAL: at 0% a window hasn't started, so the CLI prints just
// "Current session: 0% used" with no reset time. Verified against real output 2026-07-14.
const RE_SESSION = /Current session:\s*(\d+)%\s*used(?:\s*[·|-]?\s*resets\s+([^\r\n(]+))?/i
const RE_WEEK_ALL =
  /Current week \(all models\):\s*(\d+)%\s*used(?:\s*[·|-]?\s*resets\s+([^\r\n(]+))?/i
const RE_WEEK_MODEL =
  /Current week \((?!all models\))([^)]+)\):\s*(\d+)%\s*used(?:\s*[·|-]?\s*resets\s+([^\r\n(]+))?/i

/**
 * Parse the text output of `claude -p "/usage"` into a typed snapshot. Missing lines become null
 * (an unauthenticated or empty run yields all-null, which callers must treat as "no data", never
 * as "0% used"). Pure and side-effect-free so it is unit-tested against a captured fixture.
 */
export function parseUsageOutput(
  raw: string,
  account: string | null = null,
  now = new Date(),
): UsageSnapshot {
  const s = RE_SESSION.exec(raw)
  const wa = RE_WEEK_ALL.exec(raw)
  const wm = RE_WEEK_MODEL.exec(raw)
  return {
    account,
    session: s ? { pct: Number(s[1]), resets: (s[2] ?? '').trim() } : null,
    weekAll: wa ? { pct: Number(wa[1]), resets: (wa[2] ?? '').trim() } : null,
    weekModel: wm
      ? { label: wm[1].trim(), pct: Number(wm[2]), resets: (wm[3] ?? '').trim() }
      : null,
    capturedAt: now.toISOString(),
    // The text screen carries no ISO timestamps and no severity — that is exactly what the direct
    // API path (source: 'api') adds. Tagging the source lets consumers know which they're holding.
    source: 'cli',
  }
}

/**
 * The all-models weekly % is the real ceiling; the fresh 5-hour session % is a red herring when
 * weekly is near 100. Returns null when unknown — callers must NOT treat unknown as "plenty left".
 */
export function bindingWeeklyPct(snap: UsageSnapshot): number | null {
  return snap.weekAll?.pct ?? null
}

/** True when the snapshot has no usable data (all limits null) — an unverified read, not "empty quota". */
export function isNoData(snap: UsageSnapshot): boolean {
  return !snap.session && !snap.weekAll && !snap.weekModel
}

/**
 * The exact reset instant for a limit, as ISO. Prefers the API path's real `resetsAt` timestamp;
 * falls back to re-parsing the CLI path's yearless human string (parseResetTime). Returns null when
 * neither is available (a window that hasn't started prints no reset at all).
 *
 * Use this — not parseResetTime directly — anywhere a decision is scheduled against a reset.
 */
export function resetTimeIso(
  limit: { resets?: string; resetsAt?: string | null } | null | undefined,
  now = new Date(),
): string | null {
  if (!limit) return null
  if (limit.resetsAt) {
    const d = new Date(limit.resetsAt)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return parseResetTime(limit.resets ?? '', now)
}

/**
 * Turn a snapshot into an actionable verdict for an AI agent that is about to do expensive work.
 *
 * The audience is a Claude Code session checking its OWN quota mid-run (see docs/AI_USAGE_SELFCHECK.md):
 * it needs to know not just "what %" but "should I keep going, wind down, or dump my state NOW".
 * That last case is the one that actually costs the user: an agent that runs out of quota mid-task
 * dies holding un-saved context. `should_offload` is the signal to write that context to disk first.
 *
 * The weekly ALL-MODELS % is the binding cap — a fresh 5-hour session near 0% is a red herring when
 * weekly is near 100 (session resets in hours; weekly does not). Pure + tested.
 */
export function usageAdvice(snap: UsageSnapshot): UsageAdvice {
  const pct = bindingWeeklyPct(snap)
  if (pct === null) {
    return {
      severity: 'unknown',
      bindingPct: null,
      shouldOffload: false,
      safeToFanOut: false,
      // Unknown is NOT "plenty left" — refuse to greenlight a fan-out on an unverified read.
      advice:
        'Usage could not be read. Treat remaining quota as UNKNOWN — do not assume headroom, and do not start a heavy fan-out on this account.',
    }
  }
  // Trust the server's own severity when the API path supplied one; otherwise derive it. The
  // thresholds mirror the CLI's own color bands (warn approaching the cap, critical at the edge).
  const severity =
    snap.weekAll?.severity ?? (pct >= 95 ? 'critical' : pct >= 80 ? 'warning' : 'normal')
  const resets = snap.weekAll?.resets ? ` Weekly resets ${snap.weekAll.resets}.` : ''
  if (severity === 'critical') {
    return {
      severity,
      bindingPct: pct,
      shouldOffload: true,
      safeToFanOut: false,
      advice: `CRITICAL: weekly (all models) is ${pct}% used. You may be cut off mid-task. OFFLOAD NOW: write your working context, findings, and next steps to a file before doing anything else. Do not fan out.${resets}`,
    }
  }
  if (severity === 'warning') {
    return {
      severity,
      bindingPct: pct,
      shouldOffload: false,
      safeToFanOut: false,
      advice: `WARNING: weekly (all models) is ${pct}% used. Wind down: finish the current task, keep a written checkpoint, and shrink or postpone any fan-out.${resets}`,
    }
  }
  return {
    severity: 'normal',
    bindingPct: pct,
    shouldOffload: false,
    safeToFanOut: true,
    advice: `OK: weekly (all models) is ${pct}% used. Normal operation; a fan-out is safe.${resets}`,
  }
}

/** Context the caller knows and a snapshot cannot: whether WHOSE quota this is was ever settled. */
export interface NextStepOpts {
  /** True when the identification behind this reading is assumed, contradictory, or missing. */
  identityUncertain?: boolean
  /** How to name the account in a reply, e.g. `instance #11 (Pro)`. Null when unknown. */
  instanceLabel?: string | null
}

/**
 * ONE line telling the caller what to DO next. Attached to every usage tool result.
 *
 * `usageAdvice` above already describes the SITUATION; this is the instruction. They are separate
 * because an agent reading a nested `advice` object has to decide for itself what a severity
 * implies, and the decision that matters (save your work before you are cut off) is exactly the
 * one it will skip when it is busy. Putting a verb at the top level of every response is the
 * cheapest way to make the right move the obvious one.
 *
 * Deliberately ONE line: guidance that runs long stops being read, and this rides on every call.
 * Pure + tested; ordered by urgency, so the most expensive mistake is always the sentence shown.
 */
export function nextStep(advice: UsageAdvice, opts: NextStepOpts = {}): string {
  const who = opts.instanceLabel
    ? ` Report this as ${opts.instanceLabel}, never as a bare percentage.`
    : ''
  // An unconfirmed identity is said FIRST and always: a correct number attributed to the wrong
  // account is worse than no number, because it gets acted on.
  const attribution = opts.identityUncertain
    ? ' WHOSE quota this is could not be confirmed — say so rather than naming an account.'
    : who

  if (advice.shouldOffload) {
    return `SAVE YOUR WORK NOW: write your context, findings and next steps to a file before doing anything else, then wind down. Do not start a fan-out.${attribution}`
  }
  if (advice.severity === 'unknown') {
    return `Treat remaining quota as UNKNOWN — this is not "plenty left". Do not start a fan-out or a long task on an unverified read; retry the check or ask which account to use.${attribution}`
  }
  if (!advice.safeToFanOut) {
    return `Wind down: finish what you are on, keep a written checkpoint, and shrink or postpone any fan-out.${attribution}`
  }
  return `Fine to continue, including a fan-out — but gate it on CURRENT + PROJECTED cost, since a fan-out cannot be recalled once launched and solo work can be stopped at any tool call.${attribution}`
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}

/**
 * Best-effort parse of a `/usage` reset string ("Jul 14, 2:59am", the timezone already stripped by
 * parseUsageOutput) into an ISO timestamp, interpreted in the daemon machine's local time. Returns
 * null if it can't be parsed. The year is inferred from `now`; a result that lands in the past (a
 * reset that crosses the year boundary) rolls forward a year. Pure + tested so the auto-resume
 * monitor can schedule against it without depending on the fuzzy Date.parse of a yearless string.
 */
export function parseResetTime(resets: string, now = new Date()): string | null {
  if (!resets) return null
  const m = /([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})\s*([ap]m)?/i.exec(resets.trim())
  if (!m) return null
  const mon = MONTHS[m[1]!.toLowerCase()]
  if (mon === undefined) return null
  const day = Number(m[2])
  let hour = Number(m[3])
  const min = Number(m[4])
  const ampm = m[5]?.toLowerCase()
  if (ampm === 'pm' && hour < 12) hour += 12
  if (ampm === 'am' && hour === 12) hour = 0
  const year = now.getFullYear()
  let d = new Date(year, mon, day, hour, min, 0, 0)
  // A reset that reads as "in the past" by more than a day is really next year (Dec→Jan wrap).
  if (d.getTime() < now.getTime() - 24 * 3600 * 1000)
    d = new Date(year + 1, mon, day, hour, min, 0, 0)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// --- live check: spawn `claude -p "/usage"` -----------------------------------

/**
 * The OAuth scope string `claude` must see alongside an injected CLAUDE_CODE_OAUTH_TOKEN.
 *
 * THIS IS LOAD-BEARING (verified 2026-07-14): without CLAUDE_CODE_OAUTH_SCOPES in the child env,
 * `claude -p "/usage"` does NOT treat the injected token as usage-capable — it silently stops
 * handling `/usage` as a slash command, runs it as a plain prompt, and prints a ~200-byte cost
 * summary with NO percentages (exit 0, no error). It only "worked" during development because the
 * daemon happened to inherit this var from a Claude Code session; a tray launched from Explorer has
 * a clean env and never does. A PARTIAL scope string (e.g. just `user:inference`) is NOT enough —
 * the full grant scope list is required.
 */
export const DEFAULT_OAUTH_SCOPES =
  'user:inference user:file_upload user:profile user:sessions:claude_code'

/** Auth to inject for the probe (the SAME shape dispatch-runner.ts reads from the accounts table). */
export type UsageAuth = {
  authType: 'oauth_token' | 'api_key'
  secret: string
  /** Scopes of the grant the token came from; defaults to DEFAULT_OAUTH_SCOPES. See above. */
  scopes?: string
}

export type UsageCheckOpts = {
  /** Display label stamped onto the snapshot — `/usage` text never names the account. */
  account?: string | null
  /** CLAUDE_CONFIG_DIR to point the probe at (a dir `/login`'d once); the fallback path per §7-Q1. */
  configDir?: string
  /** A dispatch-account credential to inject (the primary path — no separate CLI login needed). */
  auth?: UsageAuth
  /** Hard cap on the probe (default 60s) — a hung `claude` never wedges the daemon. */
  timeoutMs?: number
  /** Skip the fast direct-API path and always spawn `claude`. Escape hatch + used by tests. */
  forceCli?: boolean
}

/**
 * Read one account's remaining quota.
 *
 * TWO PATHS, fast first:
 *
 *  1. **Direct API** (usage-api.ts) — a plain `GET /api/oauth/usage` with the OAuth access token.
 *     This is the same endpoint the CLI's own `/usage` screen reads. ~300ms, spawns nothing, and
 *     returns richer data (ISO reset timestamps + server-computed severity). Used whenever we can
 *     get an OAuth token: one injected via `auth`, or one read from `configDir`'s `.credentials.json`.
 *
 *  2. **CLI spawn** (the original path) — `claude -p "/usage"`, parsed from text. ~9s, because it
 *     boots the whole ~250 MB Claude Code binary. Still the fallback, and still the ONLY path that
 *     works when the API rejects our token (expired: the CLI refreshes its own credentials, we
 *     deliberately don't) or when auth is an API key rather than an OAuth token.
 *
 * Windows-safe: the binary is spawned DIRECTLY with an args array (never through Git Bash — MSYS
 * would mangle the `/usage` arg into a path), reusing config.ts `resolveClaudeExe()` exactly as
 * dispatch does. Auth is env-injected the same way dispatch-runner.ts does it. Value-blind on both
 * paths: only the parsed numbers are returned, never a token. A spawn failure / timeout / empty
 * output yields an all-null snapshot (`isNoData` true) — callers must treat that as "no data",
 * never as "0% used".
 */
/**
 * A directory that exists only so the `/usage` probe has somewhere harmless to be.
 *
 * Created lazily and never written to by us — the CLI is what puts a transcript under the matching
 * `~/.claude/projects/<encoded-cwd>` folder. Returns null if it cannot be created, in which case the
 * probe simply runs where it always did (a stub transcript is worth far less than a failed read).
 */
let probeCwdCache: string | null | undefined
export function usageProbeCwd(): string | null {
  if (probeCwdCache !== undefined) return probeCwdCache
  const dir = join(DATA_DIR, 'usage-probe')
  try {
    mkdirSync(dir, { recursive: true })
    probeCwdCache = dir
  } catch {
    probeCwdCache = null
  }
  return probeCwdCache
}

/**
 * Delete the transcripts the probe leaves behind.
 *
 * Safe by construction: it only ever touches the ONE project folder whose key encodes our own
 * scratch directory, so it cannot reach a real session even if the encoding changes underneath us
 * (a changed key just means the folder is not found and nothing is deleted). Best-effort — a file
 * the CLI still holds open is skipped and collected on the next sweep.
 */
export function pruneUsageProbeTranscripts(): number {
  const dir = usageProbeCwd()
  if (!dir) return 0
  const folder = join(CLAUDE_PROJECTS_ROOT, encodeCwdKey(dir))
  let removed = 0
  try {
    for (const name of readdirSync(folder)) {
      if (!name.endsWith('.jsonl')) continue
      try {
        rmSync(join(folder, name))
        removed++
      } catch {
        // still locked by the CLI; the next sweep gets it
      }
    }
  } catch {
    // folder does not exist yet — nothing has been probed from there
  }
  return removed
}

export async function checkUsage(opts: UsageCheckOpts = {}): Promise<UsageSnapshot> {
  const label = opts.account ?? null

  // --- fast path: the direct API read, whenever we can lay hands on an OAuth token ---------------
  if (!opts.forceCli) {
    // An API key is not accepted by the OAuth usage endpoint, so only an oauth_token qualifies.
    const injected = opts.auth && opts.auth.authType === 'oauth_token' ? opts.auth.secret : null
    // A CLI config dir keeps its token in PLAIN JSON, so a `/login`'d dir is usable directly.
    const fromDir = !injected && opts.configDir ? resolveCliConfigDirToken(opts.configDir) : null
    const token = injected ?? fromDir?.token ?? null
    if (token) {
      const res = await fetchUsageApi({ token, account: label, timeoutMs: opts.timeoutMs })
      if (res.ok) return res.snapshot
      // Not fatal: fall through to the CLI spawn (a 401 here just means "this token can't read
      // usage" — the CLI may still succeed by refreshing, or via a configDir login).
    }
  }

  // --- fallback: spawn `claude -p "/usage"` and parse the text screen ----------------------------
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  // Only override the ambient auth when we actually have a credential to inject (mirrors
  // dispatch-runner: clear all three inherited auth vars, then set the one for this account).
  if (opts.auth) {
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    if (opts.auth.authType === 'api_key') {
      env.ANTHROPIC_API_KEY = opts.auth.secret
    } else {
      env.CLAUDE_CODE_OAUTH_TOKEN = opts.auth.secret
      // MUST accompany the token, or `/usage` silently degrades to a cost summary — see
      // DEFAULT_OAUTH_SCOPES. Set it explicitly so the probe never depends on the daemon's
      // ambient environment (a tray launched from Explorer has none of these vars).
      env.CLAUDE_CODE_OAUTH_SCOPES = opts.auth.scopes?.trim() || DEFAULT_OAUTH_SCOPES
    }
  }
  if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir

  // Run the probe in a scratch directory of our own.
  //
  // `claude -p` opens a real session and writes a real transcript, keyed by the CWD it ran in. With
  // the probe inheriting the daemon's cwd, every quota check filed a ~3 KB stub into whatever
  // project folder that mapped to — a caveat, a `<command-name>/usage</command-name>` line, and
  // nothing else. Measured 2026-07-18: 279 such stubs, 33 of them in the previous day, sitting in
  // the middle of the user's real sessions.
  //
  // Quota is account-scoped, not directory-scoped, so where this runs makes no difference to what
  // it reads. Pointing it here keeps every stub in one folder we own and can sweep (see
  // pruneUsageProbeTranscripts), instead of scattering them through real work.
  const probeCwd = usageProbeCwd()
  if (probeCwd) env.PWD = probeCwd

  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    // windowsHide matters more here than at the other spawn sites: resolveClaudeExe() falls back to
    // `claude.cmd` when the packaged claude.exe is absent, and a .cmd runs THROUGH cmd.exe. This
    // refresh is also periodic, so on a machine without the .exe an unhidden spawn is a CMD window
    // that flashes on its own schedule, with no user action to blame it on.
    proc = Bun.spawn([resolveClaudeExe(), '-p', '/usage'], {
      env,
      cwd: probeCwd ?? undefined,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    }) as Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  } catch {
    return parseUsageOutput('', label) // never even launched → no data
  }

  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }, opts.timeoutMs ?? 60_000)

  let out = ''
  try {
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    out = stdout
  } catch {
    // read/exit error → whatever we captured (likely empty) parses to no-data
  } finally {
    clearTimeout(timer)
    // The probe has exited, so its transcript is closed and safe to drop. Swept every time rather
    // than on a schedule: the stub has no value the moment the numbers above are parsed, and the
    // cost is one readdir of a folder that holds at most a handful of files.
    pruneUsageProbeTranscripts()
  }
  return parseUsageOutput(out, label)
}

// Re-export the small cache API so existing imports keep working. Its implementation lives in a
// dependency-light module that the instance-only daemon can load without the live probe graph.
export { allCachedUsage, dropCachedUsage, getCachedUsage, setCachedUsage } from './usage-cache'
