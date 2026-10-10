// server/src/session-keepalive.ts — keep an account's 5-hour window ticking (the nudge).
//
// WHAT IT IS FOR. The 5-hour quota window is a ROLLING one that only starts when the account is
// first used. An account left idle has no window running, so the moment you do want to work on it
// the clock starts from zero and you wait the full five hours before it refills. Nudging each idle
// account once puts every window in flight, so they come back sooner and stagger instead of all
// starting the moment you get busy.
//
// THE NUDGE (owner, 2026-10-01): "When a signed-in CLI instance has no active 5-hour window (no
// session resetsAt in its usage reading, or the reset is in the past), send one cheap prompt ... to
// start the timer: claude -p with that instance's CLAUDE_CONFIG_DIR, cheapest model, lowest effort,
// 1 turn, hidden window, env scrubbed like CliMayte. Skip walled, signed-out or org-disabled
// accounts and any at 85%+ weekly." So a nudge is Haiku 5.5 at low effort, one turn, no tools, no
// MCP servers, no skills, nothing saved, in the environment a CliMayte worker gets (scrubbedEnv: the
// account's own login, never an inherited API key or token). Every nudge, sent or failed, is a
// record in <DATA_DIR>/keepalive.json (which is also what holds off a second nudge while the first
// one's window runs) and a `nudged` line in CliMayte's journal (usage-refresh.ts wires that).
//
// ⛔ WHY THIS IS NOT A HEADLESS CHAT, which this program does not do (server/src/headless-policy.ts,
// owner law). That ban is on a CONVERSATION nobody can watch. This is the same shape as the `/usage`
// probe the policy file explicitly carves out: spawn `claude -p` with one throwaway question, read
// the answer, save nothing (`--no-session-persistence`). There is no thread, nothing to resume, and
// nothing a person would ever want to open. If this ever grows a second turn, or keeps its
// transcript, it has become a chat and belongs behind that chokepoint instead.
//
// ⛔ IT SPENDS REAL QUOTA, so it is OFF until switched on (Settings, or the CLI tab's switch), and it
// refuses on its own terms:
//   · an account whose window is ALREADY running is skipped — that is the whole goal, not a reason
//     to poke it again;
//   · an account the caller says is blocked is skipped: signed out, Claude Code switched off for its
//     organization, walled by CliMayte at a limit, or running a session right now;
//   · an account at or above the weekly floor is skipped, because burning the last of a weekly cap
//     to start a five-hour clock is exactly backwards;
//   · an unreadable quota reading is a skip, never a guess. "I could not tell" must not spend;
//   · an account nudged already whose window still runs, or whose last nudge failed within the
//     hour, is skipped: a usage reading lags a nudge by up to a sweep, and a failure (a dead login,
//     a missing CLI) does not fix itself in thirty minutes.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CliMayteLiveUsage, liveUsage, scrubbedEnv } from './climayte-lib'
import { CLAUDE_PROBE_NO_MCP_ARGS, DATA_DIR, resolveClaudeExe } from './config'
import { type CapturedRun, capturePipedProc } from './core/process.ts'
import type { CliNudgeRecord, UsageSnapshot } from './types'
import { usageProbeCwd } from './usage'
import { getCachedUsage } from './usage-cache'

/** The smallest question that still costs a turn. Deliberately not "hi" — a model that answers
 *  chattily costs more output than one told exactly what to say, and the reply is discarded. */
export const KEEPALIVE_PROMPT = 'Reply with the single word: ok'

/** The cheapest setting that still starts the window: Haiku 5.5, at its lowest effort. The owner
 *  asked for exactly that ("cheapest model, lowest effort", 2026-10-01). The old "never Haiku" rule
 *  (2026-09-06) was about Haiku 4.5, which is never used here (owner, 2026-10-07); Haiku 5.5 is
 *  allowed and preferred. The full id, never the `haiku` alias: an older CLI resolves the alias to
 *  Haiku 4.5. */
export const KEEPALIVE_MODEL = 'claude-haiku-5-5'
export const KEEPALIVE_EFFORT = 'low'

/** How long a failed nudge holds the next one off. */
export const RETRY_AFTER_FAIL_MS = 60 * 60_000
/** A 5-hour window: how long a nudge that started one, with no reset time read, holds the next off. */
const WINDOW_MS = 5 * 60 * 60_000

/**
 * Is this account's 5-hour window currently running?
 *
 * A reset INSTANT decides when the reading has one: past it, the window that reading described is
 * over (owner, 2026-10-01: "or the reset is in the past"). Without one, `resets` is `''` when the
 * window has not started (see UsageLimit), and that empty string is the signal. A null `session`
 * means the reading told us nothing about the window, which is NOT the same as "not running": both
 * are handled by the caller, separately, because one is a reason to act and the other is a reason
 * to leave it alone.
 */
export function windowRunning(
  snapshot: UsageSnapshot | null | undefined,
  now = Date.now(),
): boolean | null {
  const session = snapshot?.session
  if (!session) return null
  const at = session.resetsAt ? Date.parse(session.resetsAt) : Number.NaN
  if (Number.isFinite(at)) return at > now
  return (session.resets ?? '').trim() !== ''
}

/** One nudge sent to an account, kept so the next sweep knows what the last one did. */
export type NudgeRecord = CliNudgeRecord
export type NudgeRecords = Record<string, NudgeRecord>

export interface KeepaliveDecision {
  /** 'nudge' is the only outcome that spends anything. */
  action: 'nudge' | 'skip'
  /** Why, in words fit for a log line. Always set, including for a nudge. */
  reason: string
}

export interface KeepaliveContext {
  now?: number
  /** Why this account must not be nudged at all right now (signed out, walled at a limit, a session
   *  running on it), or null. The caller knows these; the reading does not. */
  blocked?: string | null
  /** The last nudge this account got, if any. */
  last?: NudgeRecord | null
}

const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * Decide what to do about ONE account, from its last quota reading.
 *
 * Pure, so the rule can be tested without spawning anything — the whole risk of this feature is in
 * the decision, not in the spawn.
 *
 * @param weeklyFloorPct skip when the weekly cap is at or above this. The weekly window is the
 *   binding one (a 5-hour window refills the same day; a weekly does not), so spending it to start
 *   a session clock is a bad trade at any level, and a terrible one near the cap.
 */
export function decideKeepalive(
  snapshot: UsageSnapshot | null | undefined,
  weeklyFloorPct: number,
  ctx: KeepaliveContext = {},
): KeepaliveDecision {
  if (ctx.blocked) return { action: 'skip', reason: ctx.blocked }
  const now = ctx.now ?? Date.now()
  const last = ctx.last
  if (last?.ok) {
    const until = last.resetsAt ? Date.parse(last.resetsAt) : last.at + WINDOW_MS
    if (Number.isFinite(until) && until > now)
      return {
        action: 'skip',
        reason: `nudged at ${iso(last.at)}; the window it started runs until ${iso(until)}`,
      }
  } else if (last && now - last.at < RETRY_AFTER_FAIL_MS) {
    return {
      action: 'skip',
      reason: `the last nudge failed (${last.note}); the next try is after ${iso(last.at + RETRY_AFTER_FAIL_MS)}`,
    }
  }

  if (!snapshot) return { action: 'skip', reason: 'no quota reading for this account' }

  const running = windowRunning(snapshot, now)
  if (running === null)
    return { action: 'skip', reason: 'the reading does not say whether the window is running' }
  if (running) return { action: 'skip', reason: 'the 5-hour window is already running' }

  const weekly = snapshot.weekAll?.pct
  if (typeof weekly !== 'number' || !Number.isFinite(weekly))
    return { action: 'skip', reason: 'no weekly figure, so the floor cannot be checked' }
  if (weekly >= weeklyFloorPct)
    return {
      action: 'skip',
      reason: `weekly usage is ${Math.round(weekly)}%, at or above the ${weeklyFloorPct}% floor`,
    }

  return { action: 'nudge', reason: `window idle, weekly at ${Math.round(weekly)}%` }
}

export interface KeepaliveTarget {
  /** The CLI instance's id: the key its nudge records are kept under. */
  id: string
  /** For log lines: '#84', or the instance's name when it has no number. */
  label: string
  /** CLAUDE_CONFIG_DIR of the CLI login. */
  configDir: string
  /** Its usage cache key (`cli:<id>`). */
  usageKey: string
  /** See KeepaliveContext.blocked. */
  blocked?: string | null
  /** The owner's weekly cap for the account (its placement's maxWeekPct), where set: the floor is the lower of the
   *  two, since work never goes past the cap and a window started there would only spend. */
  weekCapPct?: number | null
}

/** What a nudge did. `started` is judged by a reading after it, never by "the command exited 0". */
export interface NudgeOutcome {
  started: boolean
  note: string
  resetsAt: string | null
  model: string | null
  costUsd: number | null
}

/** The whole system prompt of a nudge, in place of the CLI's own (see keepaliveArgv). */
export const KEEPALIVE_SYSTEM_PROMPT = 'Reply with exactly the word the user asks for.'

/** The nudge's command line. No tools, no MCP servers (CLAUDE_PROBE_NO_MCP_ARGS: 7 child processes
 *  per probe without them, measured), no skills, one turn, nothing saved; stream-json so the CLI's
 *  own usage event says which window the turn started. Its own one-line system prompt: measured on
 *  three idle Pro accounts (2026-10-01), a nudge with the CLI's default prompt cost $0.040 at list
 *  price (about 20k tokens of 1-hour cache writes), with this one $0.028 (13.7k), and with the
 *  5-minute cache as well (nudgeWindow's env) $0.018; the 5-hour meter read 0% after it. */
export function keepaliveArgv(exe: string): string[] {
  return [
    exe,
    '-p',
    KEEPALIVE_PROMPT,
    '--system-prompt',
    KEEPALIVE_SYSTEM_PROMPT,
    '--model',
    KEEPALIVE_MODEL,
    '--effort',
    KEEPALIVE_EFFORT,
    '--max-turns',
    '1',
    '--tools',
    '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    ...CLAUDE_PROBE_NO_MCP_ARGS,
  ]
}

/** What a nudge's stream-json said: the model that ran (system/init), the newest usage reading
 *  (rate_limit_event, climayte-lib liveUsage), the cost and any error (the result event). */
export function readNudgeStream(
  stdout: string,
  at: number,
): {
  model: string | null
  live: CliMayteLiveUsage | null
  costUsd: number | null
  error: string | null
} {
  let model: string | null = null
  let live: CliMayteLiveUsage | null = null
  let costUsd: number | null = null
  let error: string | null = null
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev?.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string')
      model = ev.model
    const reading = liveUsage(ev, at)
    if (reading) live = reading
    if (ev?.type === 'result') {
      if (typeof ev.total_cost_usd === 'number') costUsd = ev.total_cost_usd
      if (ev.is_error === true)
        error = String(ev.result ?? ev.subtype ?? 'error')
          .split(/\r?\n/)[0]!
          .slice(0, 200)
    }
  }
  return { model, live, costUsd, error }
}

/**
 * Start the window for one account by asking the model one throwaway question.
 *
 * ⛔ IT MUST BE A REAL PROMPT, not the `/usage` probe. `/usage` is a slash command the CLI answers
 * from quota state; if it never reaches the model it spends no turn and starts no window, and this
 * whole feature would be a no-op that looked like it worked.
 *
 * `readBack` reads the account's usage after the nudge (production: the usage check that also
 * refreshes the tables). The window counts as started when the CLI's own usage event or that
 * reading says it runs.
 */
export async function nudgeWindow(
  target: KeepaliveTarget,
  deps: {
    timeoutMs?: number
    readBack?: (t: KeepaliveTarget) => Promise<UsageSnapshot | null>
  } = {},
): Promise<NudgeOutcome> {
  const none = { resetsAt: null, model: null, costUsd: null }
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn(keepaliveArgv(resolveClaudeExe()), {
      // The account's own login, never a borrowed key or token (CliMayte's scrub), no claude.ai
      // connectors and the 5-minute prompt cache: the environment a CliMayte worker gets. A one-shot
      // call never reads its cache back, so the 1-hour default's dearer write is pure cost.
      env: {
        ...scrubbedEnv(target.configDir),
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        CLAUDE_CODE_PROMPT_CACHE_TTL: '5m',
      },
      cwd: usageProbeCwd() ?? undefined,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    }) as Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  } catch (err) {
    // Never launched: nothing was spent and nothing was started.
    return {
      started: false,
      note: `could not start claude: ${err instanceof Error ? err.message : String(err)}`,
      ...none,
    }
  }

  let run: CapturedRun | null = null
  try {
    run = await capturePipedProc(proc, { timeoutMs: deps.timeoutMs ?? 90_000 })
  } catch {
    // a read/exit error still may have spent the turn; the readings below decide
  }
  const now = Date.now()
  const read = readNudgeStream(run?.stdout ?? '', now)
  const after = deps.readBack ? await deps.readBack(target).catch(() => null) : null
  const streamReset =
    read.live?.sessionResetsAt != null && read.live.sessionResetsAt > now
      ? read.live.sessionResetsAt
      : null
  const afterRunning = windowRunning(after, now) === true
  const started = streamReset !== null || afterRunning
  const resetsAt =
    streamReset !== null
      ? iso(streamReset)
      : afterRunning
        ? (after?.session?.resetsAt ?? null)
        : null
  const stderrLine = (run?.stderr ?? '')
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim()
    .slice(0, 200)
  const why =
    read.error ??
    (run?.timedOut
      ? `timed out after ${Math.round((deps.timeoutMs ?? 90_000) / 1000)} s`
      : run?.code
        ? `claude exited ${run.code}${stderrLine ? `: ${stderrLine}` : ''}`
        : 'nudged, but the window still does not report as running')
  return {
    started,
    note: started ? `started the 5-hour window${resetsAt ? `; it resets ${resetsAt}` : ''}` : why,
    resetsAt,
    model: read.model,
    costUsd: read.costUsd,
  }
}

const RECORDS_PATH = join(DATA_DIR, 'keepalive.json')

/** Where the last nudge of every account is kept. A store, so the sweep's tests keep theirs in memory. */
export interface NudgeStore {
  read(): NudgeRecords
  write(id: string, rec: NudgeRecord): void
}

/** The production store: <DATA_DIR>/keepalive.json. Unreadable reads as empty (a lost record costs
 *  at most one early nudge); a write is temp file + rename. */
export const fileNudgeStore: NudgeStore = {
  read() {
    try {
      const raw = JSON.parse(readFileSync(RECORDS_PATH, 'utf8')) as unknown
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as NudgeRecords) : {}
    } catch {
      return {}
    }
  },
  write(id, rec) {
    try {
      const all = fileNudgeStore.read()
      all[id] = rec
      mkdirSync(DATA_DIR, { recursive: true })
      const tmp = `${RECORDS_PATH}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(all, null, 2))
      renameSync(tmp, RECORDS_PATH)
    } catch (err) {
      console.error('[keepalive] could not save the nudge record:', err)
    }
  },
}

/** The last reading we have for an account, without spending anything to get one. */
export function lastReading(usageKey: string): UsageSnapshot | null {
  return getCachedUsage(usageKey) ?? null
}

export interface KeepaliveSweepResult {
  considered: number
  nudged: string[]
  /** label -> why it was left alone. Kept so "why did nothing happen?" has an answer. */
  skipped: Record<string, string>
}

/**
 * One pass over the fleet: nudge every idle account that passes the rules.
 *
 * SEQUENTIAL, not parallel. Each nudge is a real CLI spawn against a real account, and firing a
 * dozen at once is both a thundering herd against the same API and the fastest way to turn a
 * misconfiguration into a dozen charges instead of one. There is no hurry here — the whole point is
 * a clock that runs for five hours.
 *
 * Returns what it did AND what it declined to do, because a sweep that silently does nothing is
 * indistinguishable from one that is broken. `onNudge` hears every nudge sent, started or not.
 */
export async function runKeepaliveSweep(deps: {
  enabled: boolean
  weeklyFloorPct: number
  targets: KeepaliveTarget[]
  nudge?: (t: KeepaliveTarget) => Promise<NudgeOutcome>
  reading?: (usageKey: string) => UsageSnapshot | null
  store?: NudgeStore
  onNudge?: (t: KeepaliveTarget, rec: NudgeRecord) => void
}): Promise<KeepaliveSweepResult> {
  const out: KeepaliveSweepResult = { considered: 0, nudged: [], skipped: {} }
  if (!deps.enabled) return out
  const read = deps.reading ?? lastReading
  const doNudge = deps.nudge ?? ((t: KeepaliveTarget) => nudgeWindow(t))
  const store = deps.store ?? fileNudgeStore
  const records = store.read()

  for (const t of deps.targets) {
    out.considered++
    const floor = Math.min(deps.weeklyFloorPct, t.weekCapPct ?? deps.weeklyFloorPct)
    const decision = decideKeepalive(read(t.usageKey), floor, {
      blocked: t.blocked,
      last: records[t.id] ?? null,
    })
    if (decision.action === 'skip') {
      out.skipped[t.label] = decision.reason
      continue
    }
    let outcome: NudgeOutcome
    try {
      outcome = await doNudge(t)
    } catch (e) {
      outcome = {
        started: false,
        note: `nudge failed: ${e instanceof Error ? e.message : String(e)}`,
        resetsAt: null,
        model: null,
        costUsd: null,
      }
    }
    const rec: NudgeRecord = {
      at: Date.now(),
      ok: outcome.started,
      note: outcome.note,
      resetsAt: outcome.resetsAt,
      model: outcome.model,
      costUsd: outcome.costUsd,
    }
    store.write(t.id, rec)
    records[t.id] = rec
    deps.onNudge?.(t, rec)
    // A nudge that did not start the window is reported as a skip WITH ITS REASON rather than as a
    // success: the turn was spent either way, and quietly calling that a win is how you end up
    // spending it again on the next tick forever.
    if (outcome.started) out.nudged.push(t.label)
    else out.skipped[t.label] = outcome.note
  }
  return out
}
