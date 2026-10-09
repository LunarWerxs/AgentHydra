// server/src/climayte-stops.ts — running attempts as CliMayte watches them, and how it stops them:
// each attempt's log read as it grows (readLog), the account walls and live readings learned from
// them, the runner processes found and killed (checkRunners, killRunners), and the usage stops
// (wind-down at the stop line, the ceiling, overage). climayte.ts drives these from its tick. Split
// from climayte.ts on 2026-10-08 to keep each file under the Architect's 2,500-line gate; nothing
// here imports climayte.ts.

import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  acctLabel,
  changed,
  freshRead,
  HANDOFFS,
  handoffWritten,
  journal,
  LIVE_PATH,
  type LogRead,
  liveByAccount,
  load,
  overageAllowed,
  peekLog,
  ROOT,
  readInto,
  runnerSpecPath,
  SIGNALS,
  saveWalls,
  signalPath,
  slashed,
  voidSpec,
  walls,
  workers,
} from './climayte-core'
import { firstLine } from './climayte-journal'
import {
  aboutToBill,
  atCeiling,
  type CliMayteAccount,
  type CliMayteLiveUsage,
  type CliMayteWalls,
  type CliMayteWorker,
  ceilingNotice,
  type classifyAttempt,
  contextTokens,
  IDENTITY_WALL,
  isLoginWall,
  ORG_DISABLED_WALL,
  OVERAGE_NOTICE,
  PRE_OVERAGE_NOTICE,
  pastOnArrival,
  type WindDownWhy,
  wallUntil,
  windDownAt,
  windDownMessage,
} from './climayte-lib'
import { type RunnerPids, readRunnerExit, readRunnerPids } from './climayte-runner'
import { isPidAlive, killProcessTrees, spawnCaptured } from './core/process'
import { nativeCommandLines } from './core/win-process-table'
import { parseResetTime } from './usage'

const reads = new Map<string, LogRead>()

/** The live readings are kept on disk too: an account whose workers stopped at its limit has no
 *  stream left to read, and a restart used to drop its last reading, so the tables and the routing
 *  fell back to a usage snapshot from before the limit (run 1: #88 showed 43% while walled until
 *  11:30pm; its last live reading was 97%). A reading whose window has reset is void anyway. */
let liveDirty = false

export function saveLive(): void {
  if (!liveDirty) return
  liveDirty = false
  try {
    mkdirSync(ROOT, { recursive: true })
    const tmp = `${LIVE_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(liveByAccount)))
    renameSync(tmp, LIVE_PATH)
  } catch (err) {
    console.error('[climayte] could not save live readings:', err)
  }
}

/** A copy of each account's newest live reading, for the usage tables (usage-live.ts). */
export function climayteLiveReadings(): Map<string, CliMayteLiveUsage> {
  load()
  return new Map(liveByAccount)
}

/** Accounts CliMayte has walled at a usage limit, with when the wall ends and whether the limit is
 *  the weekly one: the tables show those as at their limit (usage-live.ts withLimitWall), not the
 *  percentage of a snapshot read before the limit hit (field note 19). */
export function climayteLimitWalls(): Map<string, { until: number; weekly: boolean }> {
  load()
  const now = Date.now()
  const out = new Map<string, { until: number; weekly: boolean }>()
  for (const [id, wall] of Object.entries(walls)) {
    if (isLoginWall(wall.reason) || wall.until <= now) continue
    out.set(id, { until: wall.until, weekly: /weekly/i.test(wall.reason) })
  }
  return out
}

/** A signed-out login is rechecked only when its credential file has changed since the wall (a new
 *  sign-in); the clock alone never asks the CLI again. */
export function signedOutRecheckDue(wall: { cred?: number | null }, cred: number | null): boolean {
  return wall.cred !== undefined && wall.cred !== cred
}

export const credStamp = (configDir: string): number | null => {
  try {
    return statSync(join(configDir, '.credentials.json')).mtimeMs
  } catch {
    return null
  }
}

export const authChecks = new Set<string>()

/** Walls' write is atomic (saveWalls); a failed one keeps the in-memory change and must not stop
 *  the recheck that made it. */
export function trySaveWalls(): void {
  try {
    saveWalls()
  } catch (err) {
    console.error('[climayte] could not save walls:', err)
  }
}

/** `auth status` passes a login whose organization turned Claude Code off, so only a new login
 *  (the credential file changing) lifts that wall; the next attempt then tells. True when `a`'s
 *  wall is that wall and the signed-out recheck must skip it. */
export function recheckOrgWall(
  a: CliMayteAccount,
  wall: CliMayteWalls[string] | undefined,
): boolean {
  if (wall?.reason !== ORG_DISABLED_WALL) return false
  // A wall from before walls kept the credential's stamp takes today's, so a new login can
  // still lift it.
  if (wall.cred === undefined) {
    wall.cred = credStamp(a.configDir)
    trySaveWalls()
  } else if (wall.cred !== credStamp(a.configDir)) {
    delete walls[a.id]
    trySaveWalls()
  }
  return true
}

/** Why an account whose credential file exists is nevertheless signed out, or null. Field note 3
 *  (2026-09-30): the CLI instance list said `loggedIn: true` for two accounts whose login was dead,
 *  because it only checks that the file exists. CliMayte's signed-out wall is the verified answer: set
 *  when an attempt failed to authenticate, and lifted only when `claude auth status` says the login
 *  works after the credential file changes (recheckSignedOut). A file
 *  rewritten since the wall (a new sign-in not yet rechecked) is given the benefit of the doubt.
 *  Costs one map lookup and one stat, so the listing stays as fast as it was. */
export function climayteSignedOutReason(id: string, configDir: string): string | null {
  load()
  const wall = walls[id]
  if (!isLoginWall(wall?.reason)) return null
  if (wall!.cred !== undefined && wall!.cred !== credStamp(configDir)) return null
  if (wall!.reason === ORG_DISABLED_WALL)
    return 'Claude Code is turned off for this account\'s organization ("Your organization has disabled Claude subscription access for Claude Code"), so CliMayte does not use it. Sign it in with a different login to use it again.'
  if (wall!.reason === IDENTITY_WALL)
    return 'Needs identity verification: Anthropic answers every request with "Identity verification is required to continue", so CliMayte does not use it. Verify the account on claude.ai, then sign in again (Quick add, or Log in) to use it again.'
  return 'Signed out: its credential file is there, but the login failed when CliMayte used it and has not worked since. It is used again once it signs in again. Sign in again: Quick add, or Log in.'
}

/** A pid file a runner wrote within RUNNER_CLAIM_GIVE_UP_MS vouches for that runner; an older one may
 *  name a pid Windows has handed to a stranger since (a long outage), so that runner is left to the WMI
 *  check (checkRunners) like any other after a restart (review, 2026-10-02). */
export function pidFileFresh(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs <= RUNNER_CLAIM_GIVE_UP_MS
  } catch {
    return false
  }
}

/** Workers whose CLI a daemon restart would kill: only attempts the daemon spawned itself (before
 *  runners, 2026-09-30), which sit in its kill-on-close job on Windows. A worker under a runner
 *  (climayte-runner.ts) lives outside the daemon and is picked up again after the restart, so it does
 *  not hold a restart or an auto-update back. Neither does a running check (startCheck). */
export function climayteRunningCount(): number {
  load()
  let n = 0
  for (const w of workers.values()) {
    // A check runs under a runner too since 2026-10-02 (startCheck), so it no longer counts here.
    if (w.status === 'running' && !w.attempts[w.attempts.length - 1]?.runner) n++
  }
  return n
}

/** The pids of the CLI processes CliMayte's workers run in now. The extra-usage guard leaves these
 *  to CliMayte, which stops its own workers at the same line and moves the task on: a kill from
 *  outside would read as 'interrupted' and resume the task on the very account that can bill. */
export function climayteWorkerPids(): Set<number> {
  const pids = new Set<number>()
  for (const w of workers.values()) {
    const at = w.attempts[w.attempts.length - 1]
    if (w.status !== 'running' || !at?.runner) continue
    if (at.pid) pids.add(at.pid)
    if (at.runner.pid) pids.add(at.runner.pid)
  }
  return pids
}

/** Runner pids this daemon has confirmed are really that attempt's runner (its command line names
 *  the attempt's spec), so a pid Windows reused for a stranger after a crash is never taken for it,
 *  and never killed. Checked once per runner per daemon. */
export const confirmedRunners = new Set<number>()

/** Runner pids whose command line came back naming something else: a stranger holds the pid, so
 *  that runner died. */
const foreignRunners = new Set<number>()

/** WMI can hang; a query past this is read as no answer. */
const RUNNER_QUERY_TIMEOUT_MS = 10_000

/** A query that failed is asked again on a later tick, but not every 1-second tick. */
const RUNNER_RECHECK_MS = 5_000

let runnerCheck: Promise<void> | null = null

let runnerCheckAt = 0

/** 'unknown' is read as still running: taking a failed or blank query for "ended" classed the
 *  attempt interrupted and relaunched it with --resume beside a CLI that may still have been
 *  running the same session, paying for the same work twice (review, 2026-10-01). */
type RunnerIdentity = 'ours' | 'gone' | 'unknown'

export function runnerIdentity(pid: number): RunnerIdentity {
  if (!isPidAlive(pid)) return 'gone'
  if (confirmedRunners.has(pid) || process.platform !== 'win32') return 'ours'
  return foreignRunners.has(pid) ? 'gone' : 'unknown'
}

function runnerQueryArgv(pids: number[]): string[] {
  const filter = pids.map((p) => `ProcessId=${p}`).join(' or ')
  return [
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`,
  ]
}

/** Only a command line that came back and does not name the attempt's spec makes a runner a
 *  stranger. A failed or timed-out query, or a pid with no line or a blank one (it ended meanwhile,
 *  or WMI would not show it), leaves the runner unknown, to be asked again. */
function judgeRunners(
  runners: { pid: number; log: string }[],
  lines: Map<number, string> | null,
): void {
  if (!lines) return
  for (const { pid, log } of runners) {
    const command = lines.get(pid)
    if (!command) continue
    if (command.includes(runnerSpecPath(log))) confirmedRunners.add(pid)
    else foreignRunners.add(pid)
  }
}

/** The runner query's "pid<TAB>command" lines, or null when it failed or timed out. */
function runnerQueryLines(ok: boolean, stdout: string): Map<number, string> | null {
  if (!ok) return null
  const lines = new Map<number, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, ...rest] = line.split('\t')
    const command = rest.join('\t').trim()
    if (pid && command) lines.set(Number(pid), command)
  }
  return lines
}

/** Ask about every running attempt's unconfirmed runner in ONE PowerShell call under a timeout:
 *  one unbounded call per runner, one after another, held the first tick after a restart for as
 *  long as WMI took. The tick does not wait for the answer, so a slow WMI never holds back the
 *  1-second overage stop; meanwhile those runners read as running. */
export function checkRunners(): void {
  if (runnerCheck || process.platform !== 'win32') return
  if (Date.now() - runnerCheckAt < RUNNER_RECHECK_MS) return
  const runners: { pid: number; log: string }[] = []
  for (const w of workers.values()) {
    const at = w.attempts[w.attempts.length - 1]
    const pid = at?.runner?.pid
    if (w.status === 'running' && at && pid && runnerIdentity(pid) === 'unknown')
      runners.push({ pid, log: at.log })
    // And every runner a stop is still waiting to kill, on any attempt of any worker: a cancelled
    // worker's or an urgent message's earlier attempt is neither 'running' nor the last (re-review).
    for (const a of w.attempts) {
      const late = a.runner?.killOnStart ? a.runner.pid : null
      const asked = a === at && w.status === 'running' // the line above has it already
      if (late && !asked && runnerIdentity(late) === 'unknown')
        runners.push({ pid: late, log: a.log })
    }
    // A check's runner after a restart: its spec path names the check's log the same way.
    const check = w.checkRunner
    // Any worker's: a cancelled one's check waits on this answer to be stopped (stopCheck).
    if (check?.pid && runnerIdentity(check.pid) === 'unknown')
      runners.push({ pid: check.pid, log: check.log })
    for (const r of w.staleChecks ?? [])
      if (r.pid && runnerIdentity(r.pid) === 'unknown') runners.push({ pid: r.pid, log: r.log })
  }
  if (!runners.length) return
  runnerCheckAt = Date.now()
  runnerCheck = (async () => {
    // In-process first (win-process-table.ts): a few ms, and no PowerShell walking every process.
    const native = nativeCommandLines(runners.map((p) => p.pid))
    if (native) return judgeRunners(runners, native)
    const r = await spawnCaptured(runnerQueryArgv(runners.map((p) => p.pid)), {
      timeoutMs: RUNNER_QUERY_TIMEOUT_MS,
      wantStderr: false,
    })
    judgeRunners(runners, runnerQueryLines(r.code === 0 && !r.timedOut, r.stdout))
  })()
    .catch((err) => console.error('[climayte] runner identity query failed:', err))
    .finally(() => {
      runnerCheck = null
    })
}

/** A runner writes its pid the moment it has claimed its spec (climayte-runner.ts), so one that
 *  claimed it and wrote nothing for this long died in between. Minutes, not the minute an unclaimed
 *  spec gets: reading a runner still starting on a busy box as ended would resume beside it. */
export const RUNNER_CLAIM_GIVE_UP_MS = 5 * 60_000

export type Attempt = CliMayteWorker['attempts'][number]

/** Take the pids a runner wrote (its own once it claimed the spec, the CLI's once that started).
 *  The runner wrote them itself, so they need no WMI check. True when something new came in. */
function takeRunnerPids(
  at: Attempt,
  runner: NonNullable<Attempt['runner']>,
  pids: RunnerPids,
): boolean {
  if (runner.pid === pids.runner && (pids.child ?? null) === (at.pid ?? null)) return false
  runner.pid = pids.runner
  if (pids.child) at.pid = pids.child
  if (pidFileFresh(runner.pidFile)) confirmedRunners.add(pids.runner)
  return true
}

/** Whether the attempt's CLI has ended. A runner attempt is read from its files, so the answer
 *  survives a daemon restart: an exit file means it ended; a runner gone without one died (finish
 *  then reads it as interrupted), while one not yet vouched for still runs. A spec nobody claimed
 *  within a minute is voided, so it never starts late (2026-10-02: reading a pid-less minute as
 *  ended could not tell "never started" from "started late"); a claimed one waits for its runner
 *  up to RUNNER_CLAIM_GIVE_UP_MS. An attempt the daemon spawned itself is read from its handle, or,
 *  with none (the daemon restarted), it died with that daemon's kill-on-close job on Windows. */
export function attemptExited(w: CliMayteWorker, at: Attempt): boolean {
  const runner = at.runner
  if (!runner)
    return (
      (process.platform === 'win32' && at.daemonPid !== process.pid) ||
      !(at.pid && isPidAlive(at.pid))
    )
  if (readRunnerExit(runner.exitFile)) return true
  // Read on until the CLI's pid is in: the runner's own comes first, alone.
  if (at.pid == null) {
    const pids = readRunnerPids(runner.pidFile)
    if (pids) {
      if (takeRunnerPids(at, runner, pids)) changed(w)
    } else if (runner.pid === null) {
      const age = Date.now() - runner.launchedAt
      if (age <= 60_000) return false
      if (voidSpec(at.log)) return true
      return age > RUNNER_CLAIM_GIVE_UP_MS
    }
  }
  return runnerIdentity(runner.pid as number) === 'gone'
}

/** Kill the attempts' CLIs through their runners (each whole tree), each only if its runner is still
 *  that worker's: one kill for them all (killRunners). Never a bare pid nobody can vouch for. Before
 *  a runner has written its pid the spec decides (measured 2026-10-02: three cancels 87-209 ms after
 *  launch stopped here at "no pid yet" and the runner ran each task to completion, $0.145-0.150 each
 *  charged to nothing; an urgent message even relaunched beside it on the same session). Voided
 *  first: nothing ever starts. Claimed first: the runner is marked killOnStart and killLateStarts
 *  kills it once its pid file appears. Every caller saves the workers right after (changed), which
 *  keeps the mark. */
export function killAttempts(ats: Attempt[]): void {
  const kill: { at: Attempt; runner: NonNullable<Attempt['runner']>; pid: number }[] = []
  for (const at of ats) {
    const runner = at.runner
    if (!runner) continue
    if (runner.pid === null) {
      const pids = readRunnerPids(runner.pidFile)
      if (!pids) {
        if (voidSpec(at.log)) removeRunnerFiles(at)
        else runner.killOnStart = true
        continue
      }
      takeRunnerPids(at, runner, pids)
    }
    kill.push({ at, runner, pid: runner.pid as number })
  }
  killRunners(kill.map((k) => ({ pid: k.pid, log: k.at.log })))
  for (const { at, runner, pid } of kill) {
    const identity = runnerIdentity(pid)
    // Killed, or already ended: its pid and exit files would otherwise stay for good (review, 2026-10-02).
    if (identity === 'gone') removeRunnerFiles(at)
    // Not confirmed as ours (WMI failed or timed out): killLateStarts tries again once checkRunners
    // knows, instead of the stop being forgotten while the CLI runs on (re-review, 2026-10-02).
    else if (identity === 'unknown') runner.killOnStart = true
  }
}

/** Kill the runners a stop reached after they claimed their spec but before they wrote a pid
 *  (killAttempts marks them killOnStart). Every attempt of every worker, whatever its status: after a
 *  cancel the worker is no longer 'running', so pollRunning never visits it, and after an urgent
 *  message a new attempt is already the worker's last. */
export function killLateStarts(): void {
  for (const w of workers.values())
    for (const at of w.attempts) {
      const runner = at.runner
      if (!runner?.killOnStart) continue
      const pids = readRunnerPids(runner.pidFile)
      // A runner that already wrote its exit file has ended: its pid may be a stranger's by now.
      if (pids && !readRunnerExit(runner.exitFile)) {
        takeRunnerPids(at, runner, pids)
        if (runnerIdentity(pids.runner) === 'unknown') continue // checkRunners confirms it first
        killRunners([{ pid: pids.runner, log: at.log }])
      } else if (
        !pids &&
        !readRunnerExit(runner.exitFile) &&
        Date.now() - runner.launchedAt <= RUNNER_CLAIM_GIVE_UP_MS
      )
        continue
      // Killed, ended on its own, or a runner that claimed its spec and died before writing a pid.
      cleanUpRunner(w, at)
      delete runner.killOnStart
      changed(w)
    }
}

/** Kill runners' whole trees, each only if it is still its attempt's (or check's) runner. ONE WMI ask
 *  for the unconfirmed and ONE taskkill for the lot: each call walks every process on the box, and a
 *  group cancel that killed its 11 workers one call each held the daemon 15.8 s (2026-10-03). */
export function killRunners(runners: { pid: number; log: string }[]): void {
  const unknown = runners.filter((r) => runnerIdentity(r.pid) === 'unknown')
  if (unknown.length) {
    // A stop cannot wait for the next tick's check: ask about these now. In-process when it can
    // be; the PowerShell fallback holds the daemon for as long as WMI takes, under the same timeout.
    const native = nativeCommandLines(unknown.map((u) => u.pid))
    if (native) judgeRunners(unknown, native)
    else {
      const r = Bun.spawnSync(runnerQueryArgv(unknown.map((u) => u.pid)), {
        stdout: 'pipe',
        stderr: 'ignore',
        windowsHide: true,
        timeout: RUNNER_QUERY_TIMEOUT_MS,
      })
      judgeRunners(unknown, runnerQueryLines(r.success, r.stdout?.toString() ?? ''))
    }
  }
  const ours: number[] = []
  for (const { pid, log } of runners) {
    const identity = runnerIdentity(pid)
    if (identity === 'unknown')
      console.error(`[climayte] runner ${pid} could not be confirmed as ${log}'s; not killed`)
    if (identity === 'ours') ours.push(pid)
  }
  killProcessTrees(ours)
}

/** When this daemon loaded: an attempt started before then was started by an earlier daemon. */
const BOOTED_AT = Date.now()

export function readLog(at: CliMayteWorker['attempts'][number]): LogRead {
  let r = reads.get(at.log)
  // This daemon's first read of a log an earlier daemon was tailing replays it from the start: its
  // readings keep their own time (readInto).
  const replay = !r && at.startedAt < BOOTED_AT
  if (!r) {
    r = freshRead()
    reads.set(at.log, r)
  }
  return readInto(at.log, r, replay)
}

/** The summary lines of finished attempts, for climayteGet: the CliMayte view asks for the selected
 *  worker every 3 s while any worker runs, and re-parsing a long session's log (megabytes of tool
 *  output) each time would burn the box. Bounded; the oldest entry goes first. */
const finishedRecent = new Map<string, string[]>()

function rememberFinished(path: string, recent: string[]): void {
  finishedRecent.delete(path)
  finishedRecent.set(path, recent)
  if (finishedRecent.size > 50) finishedRecent.delete(finishedRecent.keys().next().value as string)
}

export function finishedLines(path: string): string[] {
  const kept = finishedRecent.get(path)
  if (kept) return kept
  const recent = peekLog(path).recent
  rememberFinished(path, recent)
  return recent
}

export function forgetRead(path: string): void {
  const r = reads.get(path)
  if (r) rememberFinished(path, r.recent)
  reads.delete(path)
}

/** Ask a running session to wrap up and write a handoff (windDownMessage). The PostToolUse hook its
 *  launch installed prints this signal after the session's next tool call, so it winds down mid-
 *  turn without being killed (proven live 2026-09-30: the CLI showed the hook's additionalContext
 *  and the model acted on it). */
export function signalWindDown(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  why: WindDownWhy,
): void {
  const path = slashed(join(HANDOFFS, `${w.id}-${w.attempts.length - 1}.md`))
  const pct = why.reason === 'usage' ? why.pct : null
  mkdirSync(HANDOFFS, { recursive: true })
  mkdirSync(SIGNALS, { recursive: true })
  writeFileSync(
    signalPath(w.id),
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: windDownMessage(why, path),
      },
    }),
  )
  at.windDown = { at: Date.now(), pct, path }
  // The reason is kept for a handoff on conversation size: it is no sign of a task going in
  // circles (notConverging), and its continuation is told so (continuationPrompt).
  if (why.reason === 'context') at.windDown.reason = 'context'
  journal(w, 'handoff-requested', {
    account: acctLabel(at.account),
    pct,
    path,
    notice:
      why.reason === 'context'
        ? `conversation at ${Math.round(why.tokens / 1000)}k tokens`
        : undefined,
  })
  changed(w)
}

/** What poll noted from the read: the init mark and the model on the attempt, its 5-hour peak,
 *  and the newest reading in the account's live table (liveByAccount). */
export function noteReading(
  at: CliMayteWorker['attempts'][number],
  r: LogRead,
  watching: boolean,
): void {
  at.started ||= r.sawInit
  if (r.model) at.model = r.model
  // Only from a process this daemon is watching now: after a restart an old log is read again from
  // the start, and its readings would be stamped as fresh.
  const reading = r.live?.sessionPct
  if (r.live && reading != null && (!at.peak || reading > at.peak.pct))
    at.peak = { pct: reading, resetsAt: r.live.sessionResetsAt }
  if (!r.live || !watching) return
  const prev = liveByAccount.get(at.account.id)
  if (prev && prev.at >= r.live.at) return
  liveByAccount.set(at.account.id, r.live)
  liveDirty = true
}

/** The ceiling stop, or the overage stops: the log's overage notice first, then aboutToBill
 *  before the first billed request (poll). */
export function stopAtCeilingOrOverage(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  r: LogRead,
  accountLive: CliMayteLiveUsage | null,
  now: number,
  watching: boolean,
  running: boolean,
): void {
  // The ceiling (CEILING_PCT, 90 on either window): stopped there, whatever it is doing. Not when
  // the owner allowed paid extra usage: that setting says to go past the limit, and lifts the stop
  // line the same way (pickAccount's allowFull).
  // Both lines go by the account's newest reading from any of its workers (sessionReading).
  if (watching && !at.ceiling && !at.overage && !overageAllowed()) {
    const c = atCeiling(r.live, accountLive, now)
    if (c) stopAtCeiling(w, at, { ...c, onArrival: pastOnArrival(r.firstLive, c) }, running)
  }
  if (at.overage || at.ceiling || overageAllowed()) return
  if (r.overage) {
    stopForOverage(w, at, r.overage, running)
    return
  }
  // Stop BEFORE the first billed request on an account that can bill (aboutToBill).
  const soon = watching ? aboutToBill(r.live) : null
  if (soon) stopForOverage(w, at, { ...soon, notice: PRE_OVERAGE_NOTICE }, running)
}

/** One wind-down ask per attempt (poll): the stop line a watched attempt is at (windDownAt),
 *  going by the account's newest reading from any of its workers (sessionReading), or its
 *  conversation's size (CONTEXT_HANDOFF_TOKENS). The ask reaches the session after its next tool
 *  call only, so one writing its final report is never handed off. */
export function stopWindDown(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  r: LogRead,
  accountLive: CliMayteLiveUsage | null,
  now: number,
  watching: boolean,
): void {
  // At the stop line the session writes a handoff, room elsewhere or not (owner, 2026-10-01: "The
  // goal is to NOT hit 'limit' ... at 85/90%"). With room elsewhere the task goes on in a fresh,
  // small session there; without, it waits for the first account with room (waitUntil). Until then
  // a session with nowhere to go worked on into the wall: w-228dcdcc on #98, 85% to 100% in 15
  // requests, outcome quota.
  // A sealed worker has no Write tool for a handoff: it stops at the ceiling and its session moves.
  if (!watching || at.windDown || at.overage || at.ceiling || w.sealed) return
  const why = windDownAt(r.live, accountLive, now, contextTokens(r.events))
  if (why) signalWindDown(w, at, why)
}

/** The account ran out and started billing paid extra usage. Unless the owner allowed it
 *  (overageAllowed), nobody asked for that spend (CliMayte exists to use FREE quota across accounts), so the account is walled until its window resets
 *  and the running turn is stopped now; finish() then treats it as a limit, and the session moves
 *  to an account with room, or waits for one, without spending another cent of overage. */
function stopForOverage(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  overage: { resetsAt: number | null; notice?: string },
  running: boolean,
): void {
  at.overage = overage
  walls[at.account.id] = {
    until: wallUntil(Date.now(), { resetsAt: overage.resetsAt, resets: null }, parseResetTime),
    reason: overage.notice ?? OVERAGE_NOTICE,
  }
  try {
    saveWalls()
  } catch (err) {
    console.error('[climayte] could not save walls:', err)
  }
  if (running) killAttempts([at])
  changed(w)
}

/** A ceiling stop's fields on its journal `limit` line. */
export const ceilingFields = (c: NonNullable<CliMayteWorker['attempts'][number]['ceiling']>) => ({
  ceiling: true,
  pct: c.pct,
  ...(c.onArrival ? { onArrival: true } : {}),
})

/** At the ceiling the turn is stopped where it is and the account walled until that window
 *  resets. finish() goes on from the handoff when the session wrote one after the stop line asked,
 *  else the session moves to an account with room or waits for one, like a limit, but journalled
 *  and counted as a ceiling stop, never a limit hit. */
function stopAtCeiling(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  c: NonNullable<CliMayteWorker['attempts'][number]['ceiling']>,
  running: boolean,
): void {
  at.ceiling = c
  walls[at.account.id] = {
    until: wallUntil(Date.now(), { resetsAt: c.resetsAt, resets: null }, parseResetTime),
    reason: ceilingNotice(c),
  }
  try {
    saveWalls()
  } catch (err) {
    console.error('[climayte] could not save walls:', err)
  }
  if (running) killAttempts([at])
  changed(w)
}

/** What the session left running, ended with its runner's job (field note 43), goes in the
 *  journal; the runner's own files go. */
export function cleanUpRunner(w: CliMayteWorker, at: CliMayteWorker['attempts'][number]): void {
  if (!at.runner) return
  const exit = readRunnerExit(at.runner.exitFile)
  const left = exit?.left
  if (exit?.peakProcesses) {
    at.peakProcesses = exit.peakProcesses
    changed(w)
  }
  if (left?.length) {
    journal(w, 'cleaned', {
      account: acctLabel(at.account),
      notice: firstLine(
        left.map((p) => `${p.name} ${p.pid}${p.command ? `: ${p.command}` : ''}`).join('; '),
      ),
    })
    // A background job the session started (a deploy under fairjob, a dev server) ends with it. Said
    // on the attempt, where the orchestrator's report reads it: w-5fabf96a's ship.py vanished while
    // its turn ended "still waiting on the deploy" (Odin mega-run, 2026-10-02).
    at.left = left
      .slice(0, 5)
      .map((p) => (p.command ? `${p.name}: ${p.command}` : p.name).slice(0, 200))
    changed(w)
  }
  removeRunnerFiles(at)
}

/** An attempt's runner files: pids, exit, and the claimed spec of a runner that died mid-read (it
 *  carries the CLI's environment). The log is the attempt's record and stays. */
function removeRunnerFiles(at: Attempt): void {
  if (!at.runner) return
  rmSync(at.runner.pidFile, { force: true })
  rmSync(at.runner.exitFile, { force: true })
  rmSync(`${runnerSpecPath(at.log)}.taken`, { force: true })
}

/** Stopped at the ceiling: from its handoff when it wrote one, else on like a limit (the wall is up). */
function ceilingVerdict(
  at: CliMayteWorker['attempts'][number],
  ceiling: NonNullable<CliMayteWorker['attempts'][number]['ceiling']>,
  v: ReturnType<typeof classifyAttempt>,
): ReturnType<typeof classifyAttempt> {
  if (at.windDown && handoffWritten(at.windDown))
    return {
      ...v,
      outcome: 'handoff',
      notice: `${ceilingNotice(ceiling)} Its handoff was written; the task continues in a fresh session.`,
    }
  return {
    ...v,
    outcome: 'quota',
    notice: ceilingNotice(ceiling),
    resetsAt: ceiling.resetsAt,
    window: ceiling.week ? 'weekly' : 'session',
    resets: null,
  }
}

/** The CLI's verdict as CliMayte's own stops change it: an overage stop and a ceiling stop are
 *  limits (or a handoff), and a wind-down that wrote its handoff is one too. */
export function withStops(
  at: CliMayteWorker['attempts'][number],
  verdict: ReturnType<typeof classifyAttempt>,
): ReturnType<typeof classifyAttempt> {
  let v = verdict
  // Stopped to spare paid extra usage: a limit, whatever the killed process left behind. A turn
  // that still finished cleanly keeps its result; its account is walled either way.
  if (at.overage && v.outcome !== 'done')
    v = {
      ...v,
      outcome: 'quota',
      notice: at.overage.notice ?? OVERAGE_NOTICE,
      resetsAt: at.overage.resetsAt,
      window: 'session',
      resets: null,
    }
  if (at.ceiling && v.outcome !== 'done') v = ceilingVerdict(at, at.ceiling, v)
  // Asked to wind down: a handoff written after the signal means the task goes on in a fresh
  // session elsewhere; none means the session reported the whole task complete instead.
  if (at.windDown && v.outcome === 'done' && handoffWritten(at.windDown))
    v = {
      ...v,
      outcome: 'handoff',
      notice:
        at.windDown.reason === 'context'
          ? 'Its conversation had grown large: wrote a handoff; the task continues in a fresh session.'
          : at.windDown.pct === null
            ? 'Handed off on request: wrote a handoff; the task continues in a fresh session.'
            : `Wound down at ${Math.round(at.windDown.pct)}% of its usage limit and wrote a handoff; the task continues in a fresh session on another account.`,
    }
  return v
}
