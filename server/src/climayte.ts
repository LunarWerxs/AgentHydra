// server/src/climayte.ts — the RUNTIME half of CliMayte (docs/CLIMAYTE.md): the store, the launch of each
// attempt, the tick that watches workers, and the API the routes and MCP tools call. The decisions
// themselves (how an attempt ended, which account is next, how a session moves) live in
// climayte-lib.ts, which is pure and pinned by tests.
//
// THE RUNTIME IS FIVE FILES, imported one way: climayte-core.ts (the store, the journal, reading an
// attempt's log) <- climayte-launch.ts (starting an attempt) <- climayte-schedule.ts (the
// scheduling pass) <- this file (the tick, what happens when an attempt ends, the API);
// climayte-totals.ts reads the core. None of them imports this file.
//
// WHY (owner, 2026-09-30): "I want this fully delegated ... orchestrating them only to CLI, not
// desktop instances ... just use all of my CLI accounts." A chat keeps only the orchestration; each
// piece of work is a Claude Code CLI session on one of his signed-in CLI instances, and a session
// that hits an account's usage limit is copied to another account and resumed there by itself. A
// Pro account's five-hour window lasts about ten minutes of heavy work, and moving threads by hand
// was the cost this removes.
//
// VISIBLE, WITHOUT A WINDOW. Workers run with `windowsHide` (no console on his screen, the 2026-08-31
// ruling) and every one is readable live in the CliMayte view and through climayte_status, and its
// transcript is an ordinary session in that account's folder. headless-policy.ts names this as the
// one exemption. Nothing here starts on its own: with no worker queued each tick is a no-op.

import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  accountsProvider,
  acctLabel,
  basisText,
  changed,
  configDirOf,
  freshRead,
  handoffWritten,
  JOURNAL_PATH,
  journal,
  LIVE_PATH,
  LOGS,
  type LogRead,
  latestUsage,
  listeners,
  liveByAccount,
  load,
  notify,
  ORG_WALL_MS,
  overageAllowed,
  packedPath,
  packLog,
  peekLog,
  perAccount,
  placementState,
  ROOT,
  readInto,
  runnerSpecPath,
  SIGNALS,
  save,
  saveWalls,
  signalPath,
  slashed,
  spendRecord,
  spentOf,
  storeLoaded,
  tailText,
  transcriptCandidates,
  transcriptFile,
  voidSpec,
  walls,
  workers,
} from './climayte-core'
import {
  appendJournal,
  type CliMayteJournalEntry,
  firstLine,
  formatJournalLine,
  type JournalFilter,
  readJournal,
} from './climayte-journal'
import { removeWorkerFiles, workerFileIds } from './climayte-launch'
import {
  aboutToBill,
  addResults,
  addTokens,
  atCeiling,
  type CliMayteAccount,
  type CliMayteLiveUsage,
  type CliMayteSizing,
  type CliMayteWalls,
  type CliMayteWave,
  type CliMayteWorker,
  type CliMayteWorkerBrief,
  type CliMayteWorkerReport,
  type CliMayteWorkerView,
  ceilingNotice,
  classifyAttempt,
  climayteEffort,
  climayteModel,
  climaytePriority,
  contextTokens,
  dueOrder,
  isLoginWall,
  isOrgDisabled,
  isWalledNow,
  joinResults,
  newestTranscript,
  notConverging,
  ORG_DISABLED_WALL,
  OVERAGE_NOTICE,
  PRE_OVERAGE_NOTICE,
  pastOnArrival,
  recentWorkers,
  toBrief,
  toReport,
  toView,
  type WindDownWhy,
  wallUntil,
  windDownAt,
  windDownMessage,
} from './climayte-lib'
import { FIT_PCT, projectedPct, sizeTask } from './climayte-placement'
import { launchRunner, type RunnerPids, readRunnerExit, readRunnerPids } from './climayte-runner'
import { roomNow, scheduleWorker, tickAccounts, tickState } from './climayte-schedule'
import {
  attemptUnits,
  bestRung,
  type CliMayteKind,
  type CliMayteVerdict,
  climayteKind,
  HAIKU,
  ladderIndex,
  ladderModel,
  nextRung,
  pickConfig,
  rereadUnits,
  scoreRows,
  UNITS_PER_PRO_PERCENT,
} from './climayte-scorecard'
import { judgeWaveTask, readWave, waveBatch, waveDone, writeWave } from './climayte-wave'
import { getCliInstance, setCliLoginVeto } from './core/cli-instances'
import { cliAuthStatus } from './core/cli-quick-add'
import { isPidAlive, killProcessTree } from './core/process'
import { parseResetTime } from './usage'

export {
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  setCliMayteOwnerDir,
} from './climayte-core'
export * from './climayte-journal'
export * from './climayte-lib'
export { climayteTotals } from './climayte-totals'

/** The room CliMayte has right now, for an agent deciding whether to hand work over (check_my_usage
 *  and list_usage say it): `idle`, the accounts running no CliMayte worker that placement would
 *  start an ordinary new task on right now (roomNow), and `waiting`, the tasks already queued or
 *  waiting, with the earliest time one of them is due to start. Owner, 2026-10-02: ten accounts sat
 *  idle for six hours while every chat did its own work. The same day at 04:58 it answered idle 9
 *  with 24 tasks waiting: it counted every account under the stop lines, and placement held them
 *  all. */
export function climayteCapacity(now = Date.now()): {
  idle: number
  accounts: number
  running: number
  waiting: number
  waitUntil: string | null
} {
  load()
  let accounts: CliMayteAccount[] = []
  try {
    accounts = accountsProvider()
  } catch {
    // no readable pool: no room to report
  }
  const busy = new Set<string>()
  const until: string[] = []
  let running = 0
  let waiting = 0
  for (const w of workers.values()) {
    if (w.status === 'queued' || w.status === 'waiting') {
      waiting++
      if (w.status === 'waiting' && w.waitUntil) until.push(w.waitUntil)
    }
    if (w.status !== 'running') continue
    running++
    if (w.accountId) busy.add(w.accountId)
  }
  const idle = roomNow(tickState(accounts, now)).filter((a) => !busy.has(a.id)).length
  return {
    idle,
    accounts: accounts.length,
    running,
    waiting,
    waitUntil: until.sort()[0] ?? null,
  }
}

const HANDOFFS = join(ROOT, 'handoffs')
/** The journal in scope, oldest first (the newest `limit`, default 100). */
export function climayteJournal(filter: JournalFilter = {}): CliMayteJournalEntry[] {
  return readJournal(JOURNAL_PATH, filter)
}

/** The same entries as readable one-line strings (formatJournalLine), newest last. */
export function climayteJournalLines(filter: JournalFilter = {}): string[] {
  const now = new Date()
  return climayteJournal(filter).map((e) => formatJournalLine(e, now))
}

/** A journal line about an account rather than a worker: the keepalive's nudges (usage-refresh.ts),
 *  under id and group 'keepalive', so `climayte_log { group: 'keepalive' }` lists them and a run's
 *  log shows when an idle account's window was started beside the work placed on it. */
export function climayteJournalNudge(
  details: Omit<Partial<CliMayteJournalEntry>, 'ts' | 'id' | 'group' | 'title' | 'event'>,
): void {
  appendJournal(JOURNAL_PATH, {
    ts: new Date().toISOString(),
    id: 'keepalive',
    group: 'keepalive',
    title: 'Start the 5-hour window',
    event: 'nudged',
    ...details,
  })
}

let started = false
let timer: ReturnType<typeof setTimeout> | null = null
let ticking = false
const reads = new Map<string, LogRead>()
// Waves modified during this tick: waveId -> { wave, configDir }. Cleared at the end of the tick.
const modifiedWaves = new Map<string, { wave: CliMayteWave; configDir: string }>()
/** The live readings are kept on disk too: an account whose workers stopped at its limit has no
 *  stream left to read, and a restart used to drop its last reading, so the tables and the routing
 *  fell back to a usage snapshot from before the limit (run 1: #88 showed 43% while walled until
 *  11:30pm; its last live reading was 97%). A reading whose window has reset is void anyway. */
let liveDirty = false
function saveLive(): void {
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

const SIGNED_OUT_MS = 30 * 60_000
const credStamp = (configDir: string): number | null => {
  try {
    return statSync(join(configDir, '.credentials.json')).mtimeMs
  } catch {
    return null
  }
}
const authChecks = new Set<string>()

/** Walls' write is atomic (saveWalls); a failed one keeps the in-memory change and must not stop
 *  the recheck that made it. */
function trySaveWalls(): void {
  try {
    saveWalls()
  } catch (err) {
    console.error('[climayte] could not save walls:', err)
  }
}

/** `auth status` passes a login whose organization turned Claude Code off, so only a new login
 *  (the credential file changing) lifts that wall; the next attempt then tells. True when `a`'s
 *  wall is that wall and the signed-out recheck must skip it. */
function recheckOrgWall(a: CliMayteAccount, wall: CliMayteWalls[string] | undefined): boolean {
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

/** Ask the CLI whether `a`'s login works again; a yes lifts its wall. Any answer saves the wall
 *  (its new `until`, or its removal) and schedules the next tick at once. */
function checkAuth(a: CliMayteAccount): void {
  void cliAuthStatus(a.configDir)
    .then((s) => {
      if (s.loggedIn) delete walls[a.id]
    })
    .catch(() => {})
    .finally(() => {
      authChecks.delete(a.id)
      trySaveWalls()
      schedule(0)
    })
}

/** A signed-out wall is never lifted by the clock alone. When it runs out, or the account's
 *  credential file changes (a new sign-in), the CLI's own `auth status` decides: about a quarter
 *  of a second, no quota. A dead login stays walled, so it never costs another worker a failed
 *  attempt (before this, an expired account took one attempt from some worker every 30 minutes);
 *  a login that works again rejoins the pool at once. */
function recheckSignedOut(accounts: CliMayteAccount[], now: number): void {
  for (const a of accounts) {
    const wall = walls[a.id]
    if (recheckOrgWall(a, wall)) continue
    if (wall?.reason !== 'signed out' || authChecks.has(a.id)) continue
    const cred = credStamp(a.configDir)
    if (wall.until > now && (wall.cred === undefined || wall.cred === cred)) continue
    wall.until = now + SIGNED_OUT_MS
    wall.cred = cred
    authChecks.add(a.id)
    checkAuth(a)
  }
}
/** Why an account whose credential file exists is nevertheless signed out, or null. Field note 3
 *  (2026-09-30): the CLI instance list said `loggedIn: true` for two accounts whose login was dead,
 *  because it only checks that the file exists. CliMayte's signed-out wall is the verified answer: set
 *  when an attempt failed to authenticate, and lifted only when `claude auth status` says the login
 *  works (recheckSignedOut, every 30 minutes and whenever the credential file changes). A file
 *  rewritten since the wall (a new sign-in not yet rechecked) is given the benefit of the doubt.
 *  Costs one map lookup and one stat, so the listing stays as fast as it was. */
export function climayteSignedOutReason(id: string, configDir: string): string | null {
  load()
  const wall = walls[id]
  if (!isLoginWall(wall?.reason)) return null
  if (wall!.cred !== undefined && wall!.cred !== credStamp(configDir)) return null
  if (wall!.reason === ORG_DISABLED_WALL)
    return 'Claude Code is turned off for this account\'s organization ("Your organization has disabled Claude subscription access for Claude Code"), so CliMayte does not use it. Sign it in with a different login to use it again.'
  return 'Signed out: its credential file is there, but the login failed when CliMayte used it and has not worked since (checked again every 30 minutes, and as soon as the account signs in again). Sign in again: Quick add, or Log in.'
}

setCliLoginVeto(climayteSignedOutReason)

export function onCliMayteChange(cb: (w: CliMayteWorker) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

const isActive = (w: CliMayteWorker): boolean =>
  w.status === 'queued' ||
  w.status === 'running' ||
  w.status === 'waiting' ||
  w.status === 'checking'

/** The task's proof, run by CliMayte itself (owner, 2026-09-30: "whatever is best for the AI"): an
 *  orchestrator that has to remember to judge every result forgets some, and a worker's own "the
 *  tests pass" is a claim. A task with a `check` command is judged by its exit code the moment the
 *  worker reports done; a fail goes back to the same session one rung up the ladder with the end of
 *  the command's output, so nobody has to read it first.
 *
 *  It runs under a runner outside the daemon, like an attempt's CLI (climayte-runner.ts), and its
 *  record is on the worker (`checkRunner`), so a restart neither kills it nor waits for it: the next
 *  daemon reads it on from its files (pollChecks). As a plain daemon child it held every restart and
 *  auto-update back while any check ran (owner, 2026-10-02: "I thought we were supposed to have
 *  decoupling from tasks running and my ability to restart"; two megarun checks of up to 20 minutes
 *  each kept the Restart button refused). */
/** A check that still fails after this many rounds stops the task for the orchestrator. */
const MAX_CHECK_FAILS = 3
const CHECK_TIMEOUT_MS = 20 * 60_000

/** Git's bash on Windows, never the WSL `bash.exe` in System32 that PATH may find first. */
function checkShell(): string {
  if (process.platform !== 'win32') return 'bash'
  for (const root of [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ]) {
    if (!root) continue
    for (const sub of [
      ['Git', 'bin', 'bash.exe'],
      ['Programs', 'Git', 'bin', 'bash.exe'],
    ]) {
      const exe = join(root, ...sub)
      if (existsSync(exe)) return exe
    }
  }
  return 'bash'
}

/** How often one round of a check may lose its runner (never started, or ended without an exit file)
 *  before the round is judged a broken check: a command that kills the runner itself (`taskkill /IM
 *  bun.exe`) would otherwise run again forever and hold the worker in 'checking' (review, 2026-10-02). */
const CHECK_RELAUNCHES = 3

type CheckRunner = NonNullable<CliMayteWorker['checkRunner']>

function startCheck(w: CliMayteWorker, relaunches = 0): void {
  if (!w.check) return
  // An earlier round's check still being stopped (its runner not yet confirmed or not yet showing a
  // pid) moves aside and is stopped on its own; this round gets its own check. Returning here left
  // a new round's result never judged (background review, 2026-10-02).
  if (w.checkRunner) {
    w.staleChecks = [...(w.staleChecks ?? []), w.checkRunner]
    w.checkRunner = null
  }
  w.status = 'checking'
  if (!relaunches) w.checkRuns = (w.checkRuns ?? 0) + 1
  mkdirSync(LOGS, { recursive: true })
  const log = join(LOGS, `${w.id}-check-${w.checkRuns}.log`)
  // Files, never pipes, so nothing ties the check to this process. It reads nothing: an empty stdin.
  closeSync(openSync(log, 'w'))
  const stdin = `${log}.stdin`
  closeSync(openSync(stdin, 'w'))
  const runner = {
    log,
    pid: null,
    pidFile: `${log}.pid.json`,
    exitFile: `${log}.exit.json`,
    launchedAt: Date.now(),
    ...(relaunches ? { relaunches } : {}),
  }
  rmSync(runner.pidFile, { force: true })
  rmSync(runner.exitFile, { force: true })
  journal(w, 'check', { notice: firstLine(w.check) })
  // Saved BEFORE the runner exists: a daemon killed in between leaves a record the next one reads (a
  // spec nobody claimed is voided and the check runs again), never a runner nobody knows of (review).
  w.checkRunner = runner
  changed(w)
  try {
    launchRunner(
      {
        argv: [checkShell(), '-c', w.check],
        cwd: w.cwd,
        // The daemon's own environment, as when the check was its child (WMI would start the runner
        // with the user's default one).
        env: Object.fromEntries(
          Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        stdin,
        stdout: log,
        stderr: log,
        pidFile: runner.pidFile,
        exitFile: runner.exitFile,
        fresh: true,
      },
      runnerSpecPath(log),
    )
  } catch (err) {
    w.checkRunner = null
    judgeCheck(w, null, `could not start: ${err instanceof Error ? err.message : String(err)}`)
    changed(w)
  }
}

/** A pid file a runner wrote within RUNNER_CLAIM_GIVE_UP_MS vouches for that runner; an older one may
 *  name a pid Windows has handed to a stranger since (a long outage), so that runner is left to the WMI
 *  check (checkRunners) like any other after a restart (review, 2026-10-02). */
function pidFileFresh(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs <= RUNNER_CLAIM_GIVE_UP_MS
  } catch {
    return false
  }
}

/** Take the runner pid a check's runner wrote itself (like takeRunnerPids). */
function takeCheckPid(r: NonNullable<CliMayteWorker['checkRunner']>): void {
  if (r.pid !== null) return
  const pids = readRunnerPids(r.pidFile)
  if (!pids) return
  r.pid = pids.runner
  if (pidFileFresh(r.pidFile)) confirmedRunners.add(pids.runner)
}

/** A check's runner files; its output log is the record and stays. */
function removeCheckFiles(r: NonNullable<CliMayteWorker['checkRunner']>): void {
  // The spec too, claimed or not: it carries the daemon's environment (background review, 2026-10-02).
  const spec = runnerSpecPath(r.log)
  for (const f of [r.pidFile, r.exitFile, `${r.log}.stdin`, spec, `${spec}.taken`])
    rmSync(f, { force: true })
}

/** Stop a worker's check: kill its runner's tree, or void its spec before the runner claims it.
 *  False while that cannot be done yet (a runner that claimed the spec and wrote no pid, or one not yet
 *  confirmed as ours after a restart): the check stays on record and pollChecks asks again, so a check
 *  never runs on unwatched beside the worker's next turn (review, 2026-10-02). */
function stopCheck(w: CliMayteWorker): boolean {
  if (w.checkRunner && !stopCheckRunner(w.checkRunner)) return false
  w.checkRunner = null
  return true
}

/** Stop one check runner and remove its files; false while that cannot be done yet (stopCheck). */
function stopCheckRunner(r: CheckRunner): boolean {
  takeCheckPid(r)
  if (r.pid === null) {
    if (!voidSpec(r.log) && Date.now() - r.launchedAt <= RUNNER_CLAIM_GIVE_UP_MS) return false
  } else if (!readRunnerExit(r.exitFile)) {
    // Unconfirmed: checkRunners asks WMI on its own beat; a synchronous ask here would stall every tick.
    if (runnerIdentity(r.pid) === 'unknown') return false
    killRunner(r.pid, r.log)
  }
  removeCheckFiles(r)
  return true
}

/** Stop the earlier rounds' checks set aside by startCheck, dropping each once it is stopped. */
function stopStaleChecks(w: CliMayteWorker): void {
  if (!w.staleChecks?.length) return
  const left = w.staleChecks.filter((r) => !stopCheckRunner(r))
  if (left.length === w.staleChecks.length) return
  w.staleChecks = left.length ? left : undefined
  changed(w)
}

/** Read every check from its files, whichever daemon started it: judged once its exit file is in,
 *  stopped at CHECK_TIMEOUT_MS, and run again when it never started or its runner died without an
 *  exit file. A worker no longer checking (cancelled meanwhile) has its check stopped. */
function pollChecks(): void {
  for (const w of workers.values()) {
    // One worker's bad record (a hand edit, a half-written store) is that worker's problem: a throw
    // here ended the whole tick, so no task anywhere moved on (found by a test, 2026-10-02).
    try {
      stopStaleChecks(w)
      pollCheck(w)
    } catch (err) {
      console.error(`[climayte] ${w.id}: its check could not be read:`, err)
    }
  }
}

/** One worker's check, read from its files (pollChecks; split up so each step reads on its own). */
function pollCheck(w: CliMayteWorker): void {
  // A check started before runners was a daemon child: the restart ended it, so it runs again.
  if (w.status === 'checking' && !w.checkRunner) {
    startCheck(w)
    return
  }
  const r = w.checkRunner
  if (!r) return
  if (w.status !== 'checking') {
    if (stopCheck(w)) changed(w)
    return
  }
  const before = r.pid
  takeCheckPid(r)
  if (r.pid !== before) changed(w)
  const exit = readRunnerExit(r.exitFile)
  if (exit) {
    judgeFromExit(w, r, exit)
    return
  }
  const lost = checkLost(r)
  if (lost) {
    relaunchCheck(w, r, lost)
    return
  }
  if (Date.now() - r.launchedAt > CHECK_TIMEOUT_MS && stopCheck(w)) {
    judgeCheck(w, null, 'timed out after 20 minutes')
    changed(w)
  }
}

/** Judge a check from the exit file its runner wrote, then remove its files, only once the verdict is
 *  saved: a daemon killed before that reads the same exit file again. */
function judgeFromExit(
  w: CliMayteWorker,
  r: CheckRunner,
  exit: NonNullable<ReturnType<typeof readRunnerExit>>,
): void {
  w.checkRunner = null
  judgeCheck(
    w,
    exit.error ? null : exit.code,
    exit.error ? `could not start: ${exit.error}` : tailText(r.log, 1500),
  )
  changed(w)
  removeCheckFiles(r)
}

/** How a check's runner was lost, or null while it may still answer. Asked before the timeout: after
 *  an outage longer than CHECK_TIMEOUT_MS, a check that died with the machine runs again rather than
 *  being judged 'timed out' (a fail) (review, 2026-10-02). */
function checkLost(r: CheckRunner): 'never started' | 'ended without an exit' | null {
  const age = Date.now() - r.launchedAt
  if (r.pid === null) {
    if (age > 60_000 && voidSpec(r.log)) return 'never started'
    return age > RUNNER_CLAIM_GIVE_UP_MS ? 'ended without an exit' : null
  }
  // The exit file is read again: the runner may have written it and ended since the first read.
  return runnerIdentity(r.pid) === 'gone' && !readRunnerExit(r.exitFile)
    ? 'ended without an exit'
    : null
}

/** Start the same round of a lost check again (it never gave an answer), or judge it a broken check
 *  past CHECK_RELAUNCHES. */
function relaunchCheck(w: CliMayteWorker, r: CheckRunner, how: string): void {
  removeCheckFiles(r)
  w.checkRunner = null
  const relaunches = (r.relaunches ?? 0) + 1
  if (relaunches > CHECK_RELAUNCHES) {
    judgeCheck(w, null, `its runner ${how} ${relaunches} times in a row`)
    changed(w)
    return
  }
  journal(w, 'check', { notice: `the check's runner ${how}; it runs again` })
  startCheck(w, relaunches)
}

function judgeCheck(w: CliMayteWorker, code: number | null, output: string): void {
  w.status = 'done'
  const cmd = firstLine(w.check, 200)
  if (code === 0) {
    // A task of a wave is judged by the daemon on the check and the commits together (piece 5).
    if (judgeInWave(w, true)) return
    climayteVerdict(w.id, { verdict: 'pass', note: `The check passed: ${cmd}`, by: 'check' })
    return
  }
  // A check that could not start, or whose command is missing or not runnable (126, 127), says
  // nothing about the work: sending it back one rung up only spent more (stress review, 2026-10-02).
  // A verdict that ends the task sets 'failed' BEFORE the verdict's own save, so one save holds both:
  // a daemon killed between two saves left it 'done' under a fail (re-review, 2026-10-02).
  if (code === 126 || code === 127 || (code === null && !/^timed out/.test(output))) {
    w.status = 'failed'
    w.error = `The check itself is broken (${code === null ? firstLine(output) : `exit ${code}`}): fix the check command, then send the task on.`
    journal(w, 'failed', { error: firstLine(w.error) })
    climayteVerdict(w.id, {
      verdict: 'fail',
      note: `The check \`${cmd}\` could not run (${code === null ? output : `exit ${code}`}); the work was not judged.`,
      retry: false,
      by: 'check',
    })
    return
  }
  const fails =
    (w.verdicts ?? []).filter((v) => v.by === 'check' && v.verdict === 'fail').length + 1
  const retry = fails < MAX_CHECK_FAILS
  const note = `The check \`${cmd}\` failed (${code === null ? output : `exit ${code}`}). The end of its output:
${code === null ? '' : output.trim()}`
  if (!retry) {
    w.status = 'failed'
    w.error = `The check still failed after ${MAX_CHECK_FAILS} rounds; it needs the orchestrator. Last: ${firstLine(output)}`
    journal(w, 'failed', { error: firstLine(w.error) })
  }
  climayteVerdict(w.id, { verdict: 'fail', note, retry, by: 'check' })
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
const confirmedRunners = new Set<number>()
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

function runnerIdentity(pid: number): RunnerIdentity {
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
function judgeRunners(runners: { pid: number; log: string }[], ok: boolean, stdout: string): void {
  if (!ok) return
  const lines = new Map<number, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, ...rest] = line.split('\t')
    const command = rest.join('\t').trim()
    if (pid && command) lines.set(Number(pid), command)
  }
  for (const { pid, log } of runners) {
    const command = lines.get(pid)
    if (!command) continue
    if (command.includes(runnerSpecPath(log))) confirmedRunners.add(pid)
    else foreignRunners.add(pid)
  }
}

/** Ask about every running attempt's unconfirmed runner in ONE PowerShell call under a timeout:
 *  one unbounded call per runner, one after another, held the first tick after a restart for as
 *  long as WMI took. The tick does not wait for the answer, so a slow WMI never holds back the
 *  1-second overage stop; meanwhile those runners read as running. */
function checkRunners(): void {
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
    const proc = Bun.spawn(runnerQueryArgv(runners.map((r) => r.pid)), {
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
      timeout: RUNNER_QUERY_TIMEOUT_MS,
    })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    judgeRunners(runners, code === 0, stdout)
  })()
    .catch((err) => console.error('[climayte] runner identity query failed:', err))
    .finally(() => {
      runnerCheck = null
    })
}

/** A runner writes its pid the moment it has claimed its spec (climayte-runner.ts), so one that
 *  claimed it and wrote nothing for this long died in between. Minutes, not the minute an unclaimed
 *  spec gets: reading a runner still starting on a busy box as ended would resume beside it. */
const RUNNER_CLAIM_GIVE_UP_MS = 5 * 60_000

type Attempt = CliMayteWorker['attempts'][number]

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
function attemptExited(w: CliMayteWorker, at: Attempt): boolean {
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

/** Kill the attempt's CLI through its runner (the whole tree), if the runner is still this
 *  worker's. Never a bare pid nobody can vouch for. Before the runner has written its pid the spec
 *  decides (measured 2026-10-02: three cancels 87-209 ms after launch stopped here at "no pid yet"
 *  and the runner ran each task to completion, $0.145-0.150 each charged to nothing; an urgent
 *  message even relaunched beside it on the same session). Voided first: nothing ever starts.
 *  Claimed first: the runner is marked killOnStart and killLateStarts kills it once its pid file
 *  appears. Every caller saves the worker right after (changed), which keeps the mark. */
function killAttempt(at: Attempt): void {
  const runner = at.runner
  if (!runner) return
  if (runner.pid === null) {
    const pids = readRunnerPids(runner.pidFile)
    if (!pids) {
      if (voidSpec(at.log)) removeRunnerFiles(at)
      else runner.killOnStart = true
      return
    }
    takeRunnerPids(at, runner, pids)
  }
  killRunner(runner.pid as number, at.log)
  const identity = runnerIdentity(runner.pid as number)
  // Killed, or already ended: its pid and exit files would otherwise stay for good (review, 2026-10-02).
  if (identity === 'gone') removeRunnerFiles(at)
  // Not confirmed as ours (WMI failed or timed out): killLateStarts tries again once checkRunners
  // knows, instead of the stop being forgotten while the CLI runs on (re-review, 2026-10-02).
  else if (identity === 'unknown') runner.killOnStart = true
}

/** Kill the runners a stop reached after they claimed their spec but before they wrote a pid
 *  (killAttempt marks them killOnStart). Every attempt of every worker, whatever its status: after a
 *  cancel the worker is no longer 'running', so pollRunning never visits it, and after an urgent
 *  message a new attempt is already the worker's last. */
function killLateStarts(): void {
  for (const w of workers.values())
    for (const at of w.attempts) {
      const runner = at.runner
      if (!runner?.killOnStart) continue
      const pids = readRunnerPids(runner.pidFile)
      // A runner that already wrote its exit file has ended: its pid may be a stranger's by now.
      if (pids && !readRunnerExit(runner.exitFile)) {
        takeRunnerPids(at, runner, pids)
        if (runnerIdentity(pids.runner) === 'unknown') continue // checkRunners confirms it first
        killRunner(pids.runner, at.log)
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

/** Kill a runner's whole tree, if it is still this attempt's runner. */
function killRunner(pid: number, log: string): void {
  if (runnerIdentity(pid) === 'unknown') {
    // A stop cannot wait for the next tick's check: ask about this one now, under the same timeout.
    const r = Bun.spawnSync(runnerQueryArgv([pid]), {
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
      timeout: RUNNER_QUERY_TIMEOUT_MS,
    })
    judgeRunners([{ pid, log }], r.success, r.stdout?.toString() ?? '')
  }
  const identity = runnerIdentity(pid)
  if (identity === 'unknown')
    console.error(`[climayte] runner ${pid} could not be confirmed as ${log}'s; not killed`)
  if (identity !== 'ours') return
  try {
    killProcessTree(pid)
  } catch {
    // already gone
  }
}

function schedule(delay?: number): void {
  if (timer) clearTimeout(timer)
  // poll() runs every tick, so the overage stop is only as fast as the tick, and each second of
  // overage bills the owner: 1 s while a worker runs, 3 s while one is queued or waiting.
  const all = [...workers.values()]
  const next =
    delay ?? (all.some((w) => w.status === 'running') ? 1_000 : all.some(isActive) ? 3_000 : 15_000)
  timer = setTimeout(
    () => void tick().catch((err) => console.error('[climayte] tick failed:', err)),
    next,
  )
  timer.unref?.()
}

function pollRunning(): void {
  for (const w of workers.values()) {
    if (w.status !== 'running') continue
    try {
      poll(w)
    } catch (err) {
      console.error(`[climayte] could not read ${w.id}:`, err)
    }
  }
}

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    load()
    const now = Date.now()
    const accounts = tickAccounts()
    checkRunners()
    pollRunning()
    killLateStarts()
    saveLive()
    pollChecks()
    recheckSignedOut(accounts, now)
    const state = tickState(accounts, now)
    const due = [...workers.values()]
      .filter(
        (w) =>
          (w.status === 'queued' || w.status === 'waiting') && (w.notBefore ?? 0) <= now && !w.hold,
      )
      .sort(dueOrder)
    for (const w of due) {
      try {
        scheduleWorker(state, w)
      } catch (err) {
        console.error(`[climayte] could not schedule ${w.id}:`, err)
      }
    }
    // Piece 3: Process wave batch wakes.
    processBatchWakes(now)
    // Last, so packing never stands between a running worker and its overage stop.
    packOldLogs(now)
  } finally {
    ticking = false
    schedule()
  }
}

/** When this daemon loaded: an attempt started before then was started by an earlier daemon. */
const BOOTED_AT = Date.now()

function readLog(at: CliMayteWorker['attempts'][number]): LogRead {
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

/** A finished attempt's log is packed once it is this old (packOldLogs). */
const PACK_AFTER_MS = 24 * 3_600_000
/** One pass packs at most this much: it compresses on the daemon's own loop, and the first pass
 *  finds every log written so far (429 MiB on 2026-10-02). The rest follows a minute later. */
const PACK_PASS_BYTES = 32 * 1024 * 1024
let nextPackAt = 0

/** The attempt's CLI can no longer append to its log. finish() ends an attempt only once its CLI
 *  has exited. A cancel does not wait: the kill is not confirmed, and killAttempt leaves a runner
 *  it cannot vouch for alone, so a cancelled attempt's log is settled only when its runner wrote
 *  its exit file or is gone. */
function logSettled(at: CliMayteWorker['attempts'][number]): boolean {
  if (at.endedAt === null) return false
  if (at.outcome !== 'cancelled') return true
  if (!at.runner) return !(at.pid && isPidAlive(at.pid))
  if (readRunnerExit(at.runner.exitFile)) return true
  const pid = at.runner.pid ?? readRunnerPids(at.runner.pidFile)?.runner ?? null
  return pid === null || runnerIdentity(pid) === 'gone'
}

/** Pack the logs of attempts that ended a day ago or more (packLog), hourly. */
function packOldLogs(now: number): void {
  if (now < nextPackAt) return
  let room = PACK_PASS_BYTES
  for (const w of workers.values())
    for (const at of w.attempts) {
      if (room <= 0 || !logSettled(at) || now - (at.endedAt as number) < PACK_AFTER_MS) continue
      room -= packLog(at.log, now - PACK_AFTER_MS)
    }
  nextPackAt = now + (room <= 0 ? 60_000 : 3_600_000)
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
function finishedLines(path: string): string[] {
  const kept = finishedRecent.get(path)
  if (kept) return kept
  const recent = peekLog(path).recent
  rememberFinished(path, recent)
  return recent
}
function forgetRead(path: string): void {
  const r = reads.get(path)
  if (r) rememberFinished(path, r.recent)
  reads.delete(path)
}

/** Ask a running session to wrap up and write a handoff (windDownMessage). The PostToolUse hook its
 *  launch installed prints this signal after the session's next tool call, so it winds down mid-
 *  turn without being killed (proven live 2026-09-30: the CLI showed the hook's additionalContext
 *  and the model acted on it). */
function signalWindDown(
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
function noteReading(at: CliMayteWorker['attempts'][number], r: LogRead, watching: boolean): void {
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
function stopAtCeilingOrOverage(
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
function stopWindDown(
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
  if (!watching || at.windDown || at.overage || at.ceiling) return
  const why = windDownAt(r.live, accountLive, now, contextTokens(r.events))
  if (why) signalWindDown(w, at, why)
}

/** What changed for the worker in this read: its newest summary line (lastActivity), or, an ended
 *  attempt, the finish of it (finish). */
function noteActivity(w: CliMayteWorker, r: LogRead, exited: boolean): void {
  const latest = r.recent[r.recent.length - 1] ?? null
  if (latest && latest !== w.lastActivity) {
    w.lastActivity = latest
    w.updatedAt = Date.now()
  }
  if (exited) finish(w, r.events)
}

function poll(w: CliMayteWorker): void {
  const at = w.attempts[w.attempts.length - 1]
  if (!at) return
  const exited = attemptExited(w, at)
  // A process this daemon is watching now: its own child, or a live runner (a restarted daemon
  // picks those up again). A dead attempt's log, read again after a restart, is not.
  const watching = !exited && !!at.runner
  const r = readLog(at)
  noteReading(at, r, watching)
  const accountLive = liveByAccount.get(at.account.id) ?? null
  const now = Date.now()
  stopAtCeilingOrOverage(w, at, r, accountLive, now, watching, !exited)
  stopWindDown(w, at, r, accountLive, now, watching)
  noteActivity(w, r, exited)
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
  if (running) killAttempt(at)
  changed(w)
}

/** A ceiling stop's fields on its journal `limit` line. */
const ceilingFields = (c: NonNullable<CliMayteWorker['attempts'][number]['ceiling']>) => ({
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
  if (running) killAttempt(at)
  changed(w)
}

/** What the session left running, ended with its runner's job (field note 43), goes in the
 *  journal; the runner's own files go. */
function cleanUpRunner(w: CliMayteWorker, at: CliMayteWorker['attempts'][number]): void {
  if (!at.runner) return
  const left = readRunnerExit(at.runner.exitFile)?.left
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
function withStops(
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

/** Every turn's closing text, not just the last: a repo's Stop hook can force a turn after the
 *  report (field note 13), and a limit can cut the session after one. `result` is them joined. */
function keepResults(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  v: ReturnType<typeof classifyAttempt>,
): void {
  if (v.turnTexts.length) {
    w.results = addResults(w.results, v.turnTexts)
    w.result = joinResults(w.results)
    for (const text of v.turnTexts)
      journal(w, 'turn-end', {
        account: acctLabel(at.account),
        attempt: w.attempts.length,
        said: firstLine(text),
      })
  } else if (v.outcome === 'done' || v.outcome === 'handoff') w.result = v.result
}

/** Wall an account that hit its limit until the limit resets. */
function wallAtLimit(
  at: CliMayteWorker['attempts'][number],
  v: ReturnType<typeof classifyAttempt>,
  now: number,
): void {
  // The CLI's own resetsAt when it streamed one, else the notice's text (wallUntil). A weekly
  // wall with neither falls back to the account's own weekly reset rather than an hour.
  let weekly: number | null = null
  if (v.resetsAt === null && (v.window === 'weekly' || /weekly/i.test(v.notice ?? ''))) {
    const reading = latestUsage(at.account.id, getCliInstance(at.account.id)?.lastUsageCheck)
    const week = Date.parse(reading?.weekAll?.resetsAt ?? '')
    if (Number.isFinite(week)) weekly = week
  }
  walls[at.account.id] = {
    until: wallUntil(now, v, parseResetTime, weekly),
    reason: v.notice ?? 'usage limit',
  }
  // The wall holds in memory either way; a throw here must not leave the worker 'running'.
  trySaveWalls()
}

/** Wall an account whose login no longer works, until its recheck (recheckSignedOut). */
function wallSignedOut(
  at: CliMayteWorker['attempts'][number],
  v: ReturnType<typeof classifyAttempt>,
  now: number,
): void {
  const dir = getCliInstance(at.account.id)?.configDir
  const org = isOrgDisabled(v.notice)
  walls[at.account.id] = {
    until: now + (org ? ORG_WALL_MS : SIGNED_OUT_MS),
    reason: org ? ORG_DISABLED_WALL : 'signed out',
    cred: dir ? credStamp(dir) : null,
  }
  trySaveWalls()
}

function retryTransient(
  w: CliMayteWorker,
  v: ReturnType<typeof classifyAttempt>,
  now: number,
): void {
  if (w.retries < 3) {
    w.notBefore = now + [5_000, 10_000, 20_000][w.retries]!
    w.retries++
    w.status = 'queued'
  } else {
    w.status = 'failed'
    w.error = `Anthropic stayed overloaded through 3 retries: ${v.notice ?? ''}`.trim()
  }
}

/** Killed from outside with the transcript intact: resume the same session on the same
 *  account. Three in one turn means something keeps killing it, and that needs a person. No
 *  delay: with one, a resume took 3.1 s every time (6 real cases), all of it waiting. */
function resumeInterrupted(w: CliMayteWorker, stderr: string): void {
  if (w.retries < 3) {
    w.notBefore = null
    w.retries++
    w.status = 'queued'
  } else {
    w.status = 'failed'
    w.error = `The CLI was stopped before it finished three times in a row in this turn.${stderr ? ` Its last error output: ${stderr.slice(-1_500)}` : ''}`
  }
}

/** The worker's next state from how its attempt ended, with the account's wall where it earned one. */
function settleWorker(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  v: ReturnType<typeof classifyAttempt>,
  now: number,
  stderr: string,
): void {
  switch (v.outcome) {
    case 'done':
      w.retries = 0
      w.error = null
      w.status = w.pending.length ? 'queued' : 'done'
      break
    case 'handoff':
      // launch() starts the next session from the handoff; the wound-down account is tried last.
      // `retries` is not reset here or at a limit: they happen mid-turn, and resetting made "3 per
      // turn" into "3 between limits", which never ends (stress review, 2026-10-02).
      w.error = null
      w.status = 'queued'
      break
    case 'quota':
      wallAtLimit(at, v, now)
      w.status = 'queued'
      break
    case 'auth':
      wallSignedOut(at, v, now)
      w.status = 'queued'
      break
    case 'transient':
      retryTransient(w, v, now)
      break
    case 'interrupted':
      resumeInterrupted(w, stderr)
      break
    default:
      w.status = 'failed'
      w.error = v.result || stderr.slice(-1_500) || 'The CLI exited without a result.'
  }
  // A requeued task that keeps moving, handing off or spending stops here and asks (notConverging).
  if (w.status === 'queued' && (v.outcome === 'handoff' || v.outcome === 'quota')) {
    const stop = notConverging(w)
    if (stop) {
      w.status = 'failed'
      w.error = stop
    }
  }

  // Piece 2: The hold. When a manager's turn ends done while its wave has live tasks and no report,
  // hold it in waiting with hold: 'wave'.
  if (v.outcome === 'done' && w.kind === 'manage' && w.wave && w.status !== 'failed') {
    try {
      const configDir = configDirOf(w.accountId ?? '', accountsProvider())
      if (configDir) {
        const wave = readWave(configDir, w.wave)
        if (wave && wave.status === 'running' && !wave.report && !waveDone(wave)) {
          const running = wave.tasks.filter((t) => t.state === 'running').length
          const queued = wave.tasks.filter((t) => t.state === 'pending').length
          w.status = 'waiting'
          w.hold = 'wave'
          w.error = `Managing wave ${w.wave}: ${running} running, ${queued} queued`
        }
      }
    } catch {
      // If we can't read the wave, proceed normally (status is already set by settleWorker).
    }
  }
}

/** Piece 5: judge a finished wave task by command (judgeWaveTask) instead of the manager's word:
 *  the check (`checkPassed`, null with none) and its commits. A pass is provisional (it stays out of
 *  the scorecard until the orchestrator accepts the wave); a failed proof sends the task back one
 *  rung up like a failed check, three rounds and then failed; nothing provable records no verdict and
 *  escalates the key as `unproven`. False when the worker is no task of a running wave. */
function judgeInWave(w: CliMayteWorker, checkPassed: boolean | null): boolean {
  if (!w.wave || w.kind === 'manage') return false
  try {
    const configDir = configDirOf(w.accountId ?? '', accountsProvider())
    if (!configDir) return false
    const wave = modifiedWaves.get(w.wave)?.wave ?? readWave(configDir, w.wave)
    const task = wave?.tasks.find((t) => t.workerId === w.id)
    if (!wave || !task || wave.status !== 'running') return false
    const now = Date.now()
    const j = judgeWaveTask(task, wave, w.result, checkPassed)
    task.proof = j.proof
    if (j.verdict === 'pass') {
      task.state = 'passed'
      climayteVerdict(w.id, { verdict: 'pass', note: j.note, by: 'wave', provisional: true })
    } else if (j.verdict === 'fail') {
      const fails =
        (w.verdicts ?? []).filter((v) => v.by === 'wave' && v.verdict === 'fail').length + 1
      const retry = fails < MAX_CHECK_FAILS
      task.state = retry ? 'running' : 'failed'
      if (!retry) {
        w.status = 'failed'
        w.error = `The wave's proof still failed after ${MAX_CHECK_FAILS} rounds; it needs the orchestrator. Last: ${firstLine(j.note)}`
        journal(w, 'failed', { error: firstLine(w.error) })
      }
      climayteVerdict(w.id, { verdict: 'fail', note: j.note, retry, by: 'wave' })
    } else {
      task.state = 'escalated'
      wave.escalations.push({ key: task.key, reason: `unproven: ${j.note}`, at: now })
    }
    modifiedWaves.set(w.wave, { wave, configDir })
    // A task sent back for another round is no change the manager needs yet.
    if (task.state !== 'running') addToWaveBatch(w, now, true)
    return true
  } catch {
    // A wave that cannot be read judges as an ordinary task.
    return false
  }
}

function addToWaveBatch(w: CliMayteWorker, now: number, judged = false): void {
  // Piece 3: The daemon's batch wake. When a wave task finishes, add it to the wave's batch.held
  // so waveBatch can decide when to wake the manager.
  if (w.wave && (judged || w.status !== 'failed')) {
    try {
      const configDir = configDirOf(w.accountId ?? '', accountsProvider())
      if (configDir) {
        const wave = modifiedWaves.get(w.wave)?.wave ?? readWave(configDir, w.wave)
        if (wave && wave.status === 'running' && !wave.report) {
          // Find the task in the wave that this worker belongs to.
          const task = wave.tasks.find((t) => t.workerId === w.id)
          if (task && !wave.batch.held.includes(task.key)) {
            wave.batch.held.push(task.key)
            if (wave.batch.since === null) {
              wave.batch.since = now
            }
            wave.updatedAt = now
            modifiedWaves.set(w.wave, { wave, configDir })
          }
        }
      }
    } catch {
      // If we can't update the wave, the batch will be updated on the next tick.
    }
  }
}

function finish(w: CliMayteWorker, events: unknown[]): void {
  const at = w.attempts[w.attempts.length - 1]
  if (at?.outcome !== 'running') return
  cleanUpRunner(w, at)
  const stderr = tailText(at.errLog, 4_000)
  const v = withStops(at, classifyAttempt(events, stderr, at.started === true))
  rmSync(signalPath(w.id), { force: true })
  removeWorkerFiles(w.id)
  forgetRead(at.log)
  const now = Date.now()
  if (v.outcome === 'auth' || v.outcome === 'quota') keepHome(w, at)
  at.outcome = v.outcome
  at.notice = v.notice
  at.endedAt = now
  at.context = contextTokens(events)
  const spent = charge(w, at)
  w.turns += v.turns
  keepResults(w, at, v)
  if (w.status === 'cancelled') {
    changed(w)
    return
  }
  settleWorker(w, at, v, now, stderr)
  // climayteSend told the caller a queued message would be delivered; say that it was not.
  if (w.status === 'failed' && w.pending.length)
    w.error =
      `${w.error ?? ''} ${w.pending.length} queued message(s) were not delivered; send one again to retry.`.trim()
  journalFinish(w, at, v, spent)
  // A wave task with no check is judged now; with one, when its check ends (judgeCheck).
  const judged = w.status === 'done' && !w.check && judgeInWave(w, null)
  if (w.status === 'done' && w.check) startCheck(w)
  if (!judged && w.status !== 'checking') addToWaveBatch(w, now)

  changed(w)
  schedule(50)
}

/** An attempt refused at sign-in, or stopped at a limit, before it wrote anything to the session
 *  never becomes the session's home (field note 30): the home goes back to the account holding the
 *  newest transcript, which the next launch resumes on or moves from. */
function keepHome(w: CliMayteWorker, at: CliMayteWorker['attempts'][number]): void {
  const sessionId = at.sessionId ?? w.sessionId
  if (!sessionId || w.accountId !== at.account.id) return
  let accounts: CliMayteAccount[] = []
  try {
    accounts = accountsProvider()
  } catch {
    // the attempts' own accounts still resolve through the instance store
  }
  const here = configDirOf(at.account.id, accounts)
  const file = transcriptFile(here, sessionId)
  try {
    if (file && statSync(file).mtimeMs >= at.startedAt) return // it wrote: this is the home
  } catch {
    // gone since: it wrote nothing that is still there
  }
  const others = transcriptCandidates(w, accounts).filter((c) => c.id !== at.account.id)
  const holder = newestTranscript(others, sessionId)
  if (holder) w.accountId = holder.id
}

/** The journal line for an attempt that just ended (finish), from its verdict and the worker's
 *  new state. */
function journalFinish(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  v: {
    outcome: CliMayteWorker['attempts'][number]['outcome']
    notice: string | null
    turns: number
  },
  spent: number,
): void {
  const account = acctLabel(at.account)
  const notice = v.notice ? firstLine(v.notice) : undefined
  const until = (): string | undefined => {
    const u = walls[at.account.id]?.until
    return u ? new Date(u).toISOString() : undefined
  }
  if (w.status === 'failed') {
    journal(w, 'failed', { account, error: firstLine(w.error) })
    return
  }
  switch (v.outcome) {
    case 'done':
      journal(w, w.status === 'done' ? 'done' : 'turn-done', {
        account,
        costUsd: Math.round(spent * 10_000) / 10_000,
        turns: v.turns,
        totalCostUsd: Math.round(w.costUsd * 10_000) / 10_000,
      })
      break
    case 'handoff':
      // A ceiling stop that still got its handoff written is a ceiling stop all the same: without
      // this line the night's one ceiling stop (w-d7fbb102, #102) was in the totals but not here.
      if (at.ceiling) journal(w, 'limit', { account, until: until(), ...ceilingFields(at.ceiling) })
      journal(w, 'handoff-written', { account, path: at.windDown?.path })
      break
    case 'quota':
      journal(w, 'limit', {
        account,
        notice,
        until: until(),
        ...(at.ceiling ? ceilingFields(at.ceiling) : {}),
      })
      break
    case 'auth':
      journal(w, 'signed-out', { account, notice, until: until() })
      break
    case 'transient':
      journal(w, 'retry', {
        account,
        notice,
        retry: w.retries,
        waitS: w.notBefore ? Math.round((w.notBefore - Date.now()) / 1000) : 0,
      })
      break
    case 'interrupted':
      journal(w, 'interrupted', { account, retry: w.retries })
      break
  }
}

/** Charge an ended attempt to its task: its own cost and tokens. Returns the cost. */
function charge(w: CliMayteWorker, at: CliMayteWorker['attempts'][number]): number {
  const spent = spentOf(w, at)
  at.tokens = spent.tokens
  at.spend = spendRecord(w, at, spent)
  w.costUsd += spent.costUsd
  w.tokens = addTokens(w.tokens, spent.tokens)
  return spent.costUsd
}

const hex = (n: number): string => crypto.randomUUID().replace(/-/g, '').slice(0, n)

const isAutoSetting = (v: unknown): boolean =>
  typeof v === 'string' && v.trim().toLowerCase() === 'auto'

type RunTask = Parameters<typeof climayteRun>[0]['tasks'][number]

/** A run's defaults: what a task takes when it names none of its own. */
interface RunDefaults {
  /** The run's model is `auto`: the scorecard picks for every task that names no model. */
  auto: boolean
  model: string | null
  effort: string | null
  /** Why the run names its model or effort (runSetting); null: it gave no reason. */
  why: string | null
  kind: CliMayteKind | null
  priority: number
}

/** One task's setting, and for an `auto` task why the scorecard picked it. */
interface RunSetting {
  model: string | null
  effort: string | null
  kind: CliMayteKind | null
  auto: boolean
  reason: string | undefined
  priority: number
}

/** How many `auto` tasks of each kind are on record: pickConfig's every-4th exploring pick counts
 *  from here. */
function autoPicksSoFar(): Map<CliMayteKind, number> {
  const autoSoFar = new Map<CliMayteKind, number>()
  for (const w of workers.values())
    if (w.auto && w.kind) {
      const k = w.kind as CliMayteKind
      autoSoFar.set(k, (autoSoFar.get(k) ?? 0) + 1)
    }
  return autoSoFar
}

/** Refuse a task that could not run: no prompt, no such folder, a check that is not one command. */
function assertRunnable(t: RunTask, i: number): void {
  if (typeof t?.prompt !== 'string' || !t.prompt.trim())
    throw new Error(`task ${i + 1}: prompt is empty`)
  if (typeof t.cwd !== 'string' || !existsSync(t.cwd) || !statSync(t.cwd).isDirectory())
    throw new Error(`task ${i + 1}: cwd '${t.cwd}' is not an existing folder`)
  if (
    t.check !== undefined &&
    t.check !== null &&
    (typeof t.check !== 'string' || t.check.length > 2000)
  )
    throw new Error(`task ${i + 1}: check must be one shell command (at most 2000 characters)`)
}

/** One task's model, effort, kind and priority. Auto unless the task (or its run) names a model or
 *  effort AND says why (`modelWhy`): the scorecard's pick for its kind, and `autoSoFar` counts it.
 *  Owner, 2026-10-02: tasks are to go to "the cheapest/fastest model capable of reliably completing"
 *  them, yet in a day 194 of about 440 arrived pinned to Opus high or above by the chats that sent
 *  them, and a task naming nothing ran on the CLI's default, Opus high. A named setting with no
 *  reason is validated, then left to the scorecard. Throws on a value that is not one. */
function runSetting(
  t: RunTask,
  defaults: RunDefaults,
  rows: ReturnType<typeof scoreRows>,
  autoSoFar: Map<CliMayteKind, number>,
): RunSetting {
  const kind = climayteKind(t.kind) ?? defaults.kind
  const priority = climaytePriority(t.priority) ?? defaults.priority
  const autoAsked = isAutoSetting(t.model) || (isBlank(t.model) && defaults.auto)
  const model = autoAsked ? null : (climayteModel(t.model) ?? defaults.model)
  // Haiku runs with no effort level, as on the ladder, whatever the run's default says.
  const effort =
    autoAsked || model === HAIKU
      ? null
      : ((isAutoSetting(t.effort) ? null : climayteEffort(t.effort)) ?? defaults.effort)
  const why = (typeof t.modelWhy === 'string' && t.modelWhy.trim()) || defaults.why
  if ((model || effort) && why)
    return { model, effort, kind, auto: false, reason: `named by the sender: ${why}`, priority }
  const k = kind ?? 'code'
  const n = autoSoFar.get(k) ?? 0
  autoSoFar.set(k, n + 1)
  const pick = pickConfig(k, rows, n)
  const unexplained =
    model || effort
      ? ` (${[model, effort].filter(Boolean).join(' ')} was named without a modelWhy)`
      : ''
  return { ...pick.config, kind: k, auto: true, reason: pick.reason + unexplained, priority }
}

const isBlank = (v: unknown): boolean => v === undefined || v === null || v === ''

/** A queued worker for one task of a run. */
function newWorker(
  t: RunTask,
  setting: RunSetting | undefined,
  size: CliMayteSizing | undefined,
  group: string,
  accounts: string[] | undefined,
  now: number,
): CliMayteWorker {
  return {
    id: `w-${hex(8)}`,
    group,
    title: t.title?.trim() || t.prompt.replace(/\s+/g, ' ').trim().slice(0, 60),
    cwd: t.cwd,
    prompt: t.prompt,
    pending: [],
    model: setting?.model ?? null,
    effort: setting?.effort ?? null,
    kind: setting?.kind ?? null,
    ...(setting?.auto ? { auto: true } : {}),
    ...(t.check?.trim() ? { check: t.check.trim() } : {}),
    ...(size ? { size } : {}),
    priority: setting?.priority ?? 0,
    accounts: accounts?.length ? accounts : null,
    status: 'queued',
    sessionId: crypto.randomUUID(),
    accountId: null,
    attempts: [],
    result: null,
    results: [],
    error: null,
    lastActivity: null,
    costUsd: 0,
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: now,
    updatedAt: now,
  }
}

/** How long a dispatch counts as a repeat of the same group's earlier one (repeatOf). */
export const REPEAT_WINDOW_MS = 10 * 60_000

/** Piece 3: The daemon's batch wake. Process all waves that have held task changes and decide
 * whether to wake their managers with a batch report. Clear the modified waves map at the end. */
function processBatchWakes(now: number): void {
  for (const [, { wave, configDir }] of modifiedWaves) {
    const manager = workers.get(wave.managerId)
    if (!manager || manager.status === 'failed' || manager.status === 'cancelled') {
      // Manager is not available; keep what the tasks' judgements changed in the wave.
      try {
        writeWave(configDir, wave)
      } catch {
        // The next change writes it again.
      }
      continue
    }

    const ids = waveBatch(wave, workers, now)
    if (ids) {
      // Wake the manager with these task changes.
      wave.batch.held = []
      wave.batch.since = null
      wave.updatedAt = now

      // The manager gets a one-line summary of the changed task keys.
      const report = `Wave batch: ${ids.length} changed tasks: ${ids.join(', ')}`
      manager.pending.push(report)
      // The wake ends the hold (piece 2) that kept the manager's turn from starting again.
      manager.hold = null
      manager.notBefore = null
      changed(manager)
    }

    // Write the updated wave back to disk.
    try {
      writeWave(configDir, wave)
    } catch {
      // If write fails, the batch will be picked up on the next tick.
    }
  }

  modifiedWaves.clear()
}

/**
 * The worker an earlier dispatch already made for this task, or null: same group, same title, same
 * prompt and folder, made within REPEAT_WINDOW_MS, and not cancelled or failed (sending one of those
 * again is a retry). Field note 62 (2026-10-02): told by its MCP view that 16 workers it had just
 * POSTed did not exist, an orchestrator sent them twice more; 48 ran and 32 were cancelled.
 */
function repeatOf(t: RunTask, group: string, now: number): CliMayteWorker | null {
  const title = t.title?.trim() || t.prompt.replace(/\s+/g, ' ').trim().slice(0, 60)
  for (const w of workers.values())
    if (
      w.group === group &&
      w.title === title &&
      w.prompt === t.prompt &&
      w.cwd === t.cwd &&
      now - w.createdAt <= REPEAT_WINDOW_MS &&
      w.status !== 'cancelled' &&
      w.status !== 'failed'
    )
      return w
  return null
}

/** An account the task may use must exist: an unknown one used to make a task that waited forever
 *  for an account that will never sign in (fuzz, 2026-10-02). A signed-out instance is known, and
 *  its task waits for the sign-in as before. */
function assertKnownAccounts(accounts: string[] | undefined): void {
  if (!accounts?.length) return
  let pool: CliMayteAccount[] = []
  try {
    pool = accountsProvider()
  } catch {
    // the instance store below still knows every account
  }
  const unknown = accounts.filter((id) => !pool.some((a) => a.id === id) && !getCliInstance(id))
  if (unknown.length)
    throw new Error(
      `accounts: ${unknown.join(', ')} ${unknown.length === 1 ? 'is not a CLI instance' : 'are not CLI instances'} (give CLI instance ids; climayte_run also takes numbers)`,
    )
}

/** `model` / `effort` / `kind` at the top level are the group's default: a task that names its
 *  own wins. All are validated (climayteModel, climayteEffort, climayteKind) before anything is created.
 *  The scorecard chooses model AND effort for the task's kind (default `code`): of the settings that
 *  pass it reliably the one whose passed task costs least, or a cheaper one still learning on every
 *  4th pick (pickConfig). A named model or effort holds only with a `modelWhy` (runSetting).
 *  A task an earlier dispatch of the same group already made (repeatOf) answers with that worker,
 *  marked `repeat`, and makes nothing, unless `copies` asks for new ones. */
export function climayteRun(input: {
  tasks: Array<{
    prompt: string
    cwd: string
    title?: string
    model?: string
    effort?: string
    modelWhy?: string
    kind?: string
    check?: string
    priority?: number
    size?: string
  }>
  group?: string
  accounts?: string[]
  perAccount?: number
  model?: string
  effort?: string
  modelWhy?: string
  kind?: string
  priority?: number
  size?: string
  /** Make new workers even for tasks an earlier dispatch of this group already made. */
  copies?: boolean
  /** The wave these workers are tasks of (set by the manager's wave_dispatch). */
  wave?: string
}): RunReply {
  load()
  if (!Array.isArray(input.tasks) || !input.tasks.length)
    throw new Error('tasks must be a non-empty array')
  const groupAuto = isAutoSetting(input.model)
  const defaults: RunDefaults = {
    auto: groupAuto,
    why: (typeof input.modelWhy === 'string' && input.modelWhy.trim()) || null,
    model: groupAuto ? null : climayteModel(input.model),
    effort: groupAuto || isAutoSetting(input.effort) ? null : climayteEffort(input.effort),
    kind: climayteKind(input.kind),
    priority: climaytePriority(input.priority) ?? 0,
  }
  const rows = scoreRows(workers.values())
  const autoSoFar = autoPicksSoFar()
  const settings = input.tasks.map((t, i) => {
    assertRunnable(t, i)
    try {
      return runSetting(t, defaults, rows, autoSoFar)
    } catch (err) {
      throw new Error(`task ${i + 1}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  const cap = input.perAccount ?? 2
  if (!Number.isInteger(cap) || cap < 1 || cap > 4) throw new Error('perAccount must be 1..4')
  assertKnownAccounts(input.accounts)
  const now = Date.now()
  // Only a named group can repeat: an unnamed one is new by definition.
  const named = input.group?.trim()
  const repeats = input.tasks.map((t) =>
    named && input.copies !== true ? repeatOf(t, named, now) : null,
  )
  const fresh = input.tasks.flatMap((_, i) => (repeats[i] ? [] : [i]))
  // Sized and made: only the tasks no earlier dispatch made.
  const sized = fresh.length
    ? sizeTasks(
        { ...input, tasks: fresh.map((i) => input.tasks[i] as RunTask) },
        fresh.map((i) => settings[i] as RunSetting),
        fresh.map((i) => i + 1),
      )
    : []
  const group = named || `g-${hex(6)}`
  // Joining a group keeps its cap unless the caller names a new one. A group nobody gave a cap
  // has none on record and takes the default, which scales with each account's plan (groupCap).
  if (input.perAccount !== undefined) perAccount[group] = cap
  const made = fresh.map((i, k) =>
    newWorker(input.tasks[i] as RunTask, settings[i], sized[k], group, input.accounts, now),
  )
  for (const [k, w] of made.entries()) {
    if (input.wave) w.wave = input.wave
    workers.set(w.id, w)
    journal(w, 'dispatched', {
      cwd: w.cwd,
      accounts: w.accounts?.length,
      model: w.model,
      effort: w.effort,
      kind: w.kind ?? undefined,
      reason: settings[fresh[k] as number]?.reason,
      priority: w.priority,
    })
  }
  if (made.length) {
    // One save for the whole dispatch: a save per task wrote the store 21 times for 21 tasks,
    // 0.3 s of the daemon's loop (71 dispatches carried 215 tasks, 2026-10-02).
    save()
    for (const w of made) notify(w)
    startCliMayte()
    schedule(0)
  }
  return runReply(group, repeats, fresh, made, now)
}

/** What climayteRun answers. */
interface RunReply {
  group: string
  workers: Array<CliMayteWorkerView & { repeat?: true }>
  repeated?: number
  note?: string
}

/** climayteRun's answer, one row per task in the caller's order: the earlier worker, marked
 *  `repeat`, for a task an earlier dispatch made (`repeats`), else the one made now (`made`, for
 *  the tasks at `fresh`), and a note when any task was a repeat. */
function runReply(
  group: string,
  repeats: Array<CliMayteWorker | null>,
  fresh: number[],
  made: CliMayteWorker[],
  now: number,
): RunReply {
  const madeFor = new Map(fresh.map((i, k) => [i, made[k] as CliMayteWorker]))
  const views = repeats.map((earlier, i) => {
    if (earlier) return { ...toView(earlier, now), repeat: true as const }
    return toView(madeFor.get(i) as CliMayteWorker, now)
  })
  const repeated = repeats.filter(Boolean).length
  if (!repeated) return { group, workers: views }
  return {
    group,
    workers: views,
    repeated,
    note: `${repeated} of ${repeats.length} task(s) repeat what this group was sent in the last ${REPEAT_WINDOW_MS / 60_000} minutes (same title, prompt and folder): those rows are the workers already made (repeat: true), and nothing new was started for them. Send copies: true to run them again.`,
  }
}

/** A dispatch with a task too big for one window (sizeTask): nothing was started. */
export class CliMayteSplitNeeded extends Error {
  constructor(
    message: string,
    readonly tasks: Array<{
      task: number
      title: string
      expected: number
      window: number
      pieces: number
    }>,
  ) {
    super(message)
  }
}

/** Sizes every task of a dispatch against the accounts it may use (climayte-placement sizeTask), and
 *  refuses the whole dispatch, starting nothing, when a task is over SPLIT_SHARE of the biggest
 *  window unless it (or the dispatch) says `size: 'whole'`. `numbers`: each task's number in the
 *  caller's own list, when repeats were taken out of it (climayteRun). */
function sizeTasks(
  input: Parameters<typeof climayteRun>[0],
  settings: Array<{ model: string | null; effort: string | null; kind: string | null }>,
  numbers: number[] = input.tasks.map((_, i) => i + 1),
): CliMayteSizing[] {
  const sizeOf = (v: unknown, where: string): 'auto' | 'whole' => {
    if (v === undefined || v === null || v === '') return 'auto'
    const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
    if (s === 'auto' || s === 'whole') return s
    throw new Error(`${where}size must be auto or whole`)
  }
  const groupSize = sizeOf(input.size, '')
  let pool: CliMayteAccount[] = []
  try {
    pool = accountsProvider()
  } catch {
    // Sized against one Pro window.
  }
  const now = Date.now()
  const allowed = pool.filter((a) => !input.accounts?.length || input.accounts.includes(a.id))
  const open = allowed.filter((a) => !isWalledNow(walls[a.id], now))
  const { costOf, running, finishedSince } = placementState()
  const best = open
    .map((a) => ({
      a,
      room: Math.max(
        0,
        (FIT_PCT - projectedPct(a, running.get(a.id) ?? [], 0, finishedSince.get(a.id) ?? 0)) *
          (a.planFactor ?? 1),
      ),
    }))
    .sort((x, y) => y.room - x.room)[0]
  const tooBig: CliMayteSplitNeeded['tasks'] = []
  const sized = input.tasks.map((t, i): CliMayteSizing => {
    const s = settings[i] ?? { model: null, effort: null, kind: null }
    const cost = costOf(s)
    const fit = sizeTask(
      cost.pct,
      allowed.map((a) => a.planFactor ?? 1),
    )
    const n = numbers[i] ?? i + 1
    // A manager's cost is per wake (expectedCost) and it never splits: its wave does the work.
    const whole =
      s.kind === 'manage' || sizeOf(t.size, `task ${n}: `) === 'whole' || groupSize === 'whole'
    const title = t.title?.trim() || firstLine(t.prompt, 60)
    if (fit.split && !whole)
      tooBig.push({
        task: n,
        title,
        expected: Math.round(cost.pct),
        window: fit.window,
        pieces: fit.pieces,
      })
    return {
      expected: Math.round(cost.pct * 10) / 10,
      basis: basisText(cost, s),
      window: fit.window,
      room: best ? Math.round(best.room) : null,
      roomOn: best ? acctLabel(best.a) : null,
    }
  })
  if (tooBig.length) {
    const each = tooBig
      .map(
        (t) =>
          `task ${t.task} "${t.title}" is expected to use about ${t.expected}% of a Pro 5-hour window, and the biggest window it may use holds ${t.window}%: split it into about ${t.pieces} pieces`,
      )
      .join('; ')
    throw new CliMayteSplitNeeded(
      `Nothing started: split needed. ${each}. A task over half a window often runs out partway and moves accounts, re-writing its whole conversation into a cold cache. Send each piece as its own self-contained task with its own proof of done (keep pieces that touch the same files in order, one after another), or send it again with size: 'whole' to run it as it is.`,
      tooBig,
    )
  }
  return sized
}

function matches(
  w: CliMayteWorker,
  f: { group?: string; id?: string; ids?: string[]; active?: boolean },
): boolean {
  return (
    (!f.id || w.id === f.id) &&
    (!f.ids || f.ids.includes(w.id)) &&
    (!f.group || w.group === f.group) &&
    (!f.active || isActive(w))
  )
}

/** `limit`: keep every active worker and only the `limit` most recently finished ones
 *  (recentWorkers); `brief`: rows without the prompt and with the last 3 attempts (toBrief);
 *  `ids`: only these workers. */
export interface CliMayteListFilter {
  group?: string
  id?: string
  ids?: string[]
  active?: boolean
  limit?: number
  brief?: boolean
  /** With `brief`: also list finished work a verdict already covers (left out by default). */
  all?: boolean
}

export function climayteList(filter: CliMayteListFilter & { brief: true }): CliMayteWorkerBrief[]
export function climayteList(filter?: CliMayteListFilter): CliMayteWorkerView[]
export function climayteList(
  filter: CliMayteListFilter = {},
): CliMayteWorkerView[] | CliMayteWorkerBrief[] {
  load()
  const now = Date.now()
  const views = recentWorkers(
    [...workers.values()].filter((w) => matches(w, filter)),
    filter.limit,
  ).map((w) => toView(w, now))
  if (!filter.brief) return views
  // An orchestrator's default list is what it may act on: live work and unjudged results. Judged
  // finished rows were 80 KB of a 96 KB default answer (stress review, 2026-10-02).
  const keep =
    filter.all || filter.id || filter.ids?.length
      ? views
      : views.filter((v) => isLiveStatus(v.status) || !v.judged)
  return keep.map(toBrief)
}

const isLiveStatus = (s: CliMayteWorker['status']): boolean =>
  s === 'queued' || s === 'running' || s === 'waiting' || s === 'checking'

/** The report view of the same list (toReport): one compact row per worker, `chars` of its report. */
export function climayteReports(
  filter: CliMayteListFilter = {},
  chars?: number,
): CliMayteWorkerReport[] {
  return climayteList({ ...filter, brief: false }).map((v) => toReport(v, chars))
}

/** One verdict for several finished workers (the same `verdict`, `note` and `kind` for each), in
 *  one call: a batch wake hands an orchestrator several results it checked together. */
export function climayteVerdicts(
  ids: string[],
  input: Parameters<typeof climayteVerdict>[1],
): Array<{ id: string } & ReturnType<typeof climayteVerdict>> {
  return ids.map((id) => ({ id, ...climayteVerdict(id, input) }))
}

export function climayteGet(id: string): (CliMayteWorkerView & { events: string[] }) | null {
  load()
  const w = workers.get(id)
  if (!w) return null
  // Every attempt's summary lines, oldest first, each under one separator line, so the work before
  // a move or a restart stays visible. A finished attempt keeps only its summary lines
  // (finishedLines), never its parsed events; attempts older than the newest 60 lines are not read.
  const events: string[] = []
  for (let i = w.attempts.length - 1; i >= 0 && events.length < 60; i--) {
    const a = w.attempts[i]!
    const who = a.account.num === null ? a.account.name : `#${a.account.num} ${a.account.name}`
    const lines = a.outcome === 'running' ? readLog(a).recent : finishedLines(a.log)
    events.unshift(`— attempt ${i + 1} on ${who}: ${a.outcome} —`, ...lines)
  }
  return { ...toView(w, Date.now()), events: events.slice(-60) }
}

export function climayteWait(
  filter: CliMayteListFilter,
  timeoutMs: number,
): Promise<CliMayteWorkerView[] | CliMayteWorkerBrief[]> {
  load()
  if (![...workers.values()].some((w) => matches(w, filter) && isActive(w)))
    return Promise.resolve(climayteList(filter))
  return new Promise((resolve) => {
    const off = onCliMayteChange((w) => {
      if (!matches(w, filter)) return
      done()
    })
    const t = setTimeout(() => done(), Math.max(0, timeoutMs))
    let settled = false
    function done(): void {
      if (settled) return
      settled = true
      clearTimeout(t)
      off()
      resolve(climayteList(filter))
    }
  })
}

/** Hand a running task to a fresh session now, the same way a worker near its limit does: it
 *  finishes the step it is on, writes a handoff, and the task goes on from that handoff in a new
 *  session (on the account with the most room). For freeing an account, or giving a task whose
 *  conversation has grown huge a clean start without losing where it was. */
export function climayteHandoff(id: string): { ok: boolean; message: string } {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  const at = w.attempts[w.attempts.length - 1]
  if (w.status !== 'running' || !at || attemptExited(w, at))
    return { ok: false, message: 'Only a running worker can hand off; this one is not running.' }
  if (at.windDown) return { ok: true, message: 'It is already winding down.' }
  signalWindDown(w, at, { reason: 'request' })
  return {
    ok: true,
    message:
      'Asked to wrap up after its current step and write a handoff; the task then continues in a fresh session.',
  }
}

/** Change a task's priority (field note 20): queued and waiting work starts highest first, then
 *  oldest first; a running attempt is not stopped for it. */
export function climayteSetPriority(
  id: string,
  value: unknown,
): { ok: boolean; message: string; priority?: number } {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  let priority: number | null
  try {
    priority = climaytePriority(value)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  if (priority === null) return { ok: false, message: 'priority is required.' }
  const was = w.priority ?? 0
  if (priority !== was) {
    w.priority = priority
    journal(w, 'priority', { priority, was })
    changed(w)
    schedule(0)
  }
  return {
    ok: true,
    priority,
    message: isActive(w)
      ? `Priority ${priority}: it starts ahead of queued and waiting work with a lower priority.`
      : `Priority ${priority}, kept for when it is continued.`,
  }
}

/** What a message to a running worker waits for: a `-p` session takes no input mid-run, so it is
 *  delivered only when the whole current task ends. Field note 10 (2026-09-30): only this answer
 *  said so, and a "fix the build first" message could not reach a worker that was breaking it. */
export const HELD_MESSAGE =
  'Held until this worker finishes its WHOLE current task: a running CLI session takes no input mid-run, so it gets this only after it ends (that can be many minutes). If it must act on it now, send it again with urgent: true, which stops the running work and continues the same session with your message first.'

/** Preface of an urgent message, so the session knows why its turn ended mid-step. */
const URGENT_PREFIX =
  'AgentHydra stopped your previous turn mid-step to deliver this message from the orchestrator. Act on it first; then continue the task only if it still applies, checking the state of anything you were in the middle of.'

/** `urgent`: a running worker is stopped cleanly (its attempt recorded with its cost, the transcript
 *  kept) and the same session continues at once with this message first; messages already queued
 *  follow it, in order. Without it, a running worker gets the message when its task ends. */
export function climayteSend(
  id: string,
  text: string,
  opts: { urgent?: boolean; model?: string; effort?: string } = {},
): {
  ok: boolean
  message: string
  urgent?: boolean
  model?: string | null
  effort?: string | null
} {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  if (!text.trim()) return { ok: false, message: 'The message is empty.' }
  // A new model or effort applies from the next launch on: the turn that delivers this message
  // (or one queued before it) and every later one, in the same session (`--resume` takes both).
  let model: string | null
  let effort: string | null
  try {
    model = climayteModel(opts.model)
    effort = climayteEffort(opts.effort)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  if (model) w.model = model
  if (effort) w.effort = effort
  if (w.status === 'running' && opts.urgent) {
    w.pending.unshift(`${URGENT_PREFIX}\n\n${text}`)
    journal(w, 'follow-up-queued', {
      pending: w.pending.length,
      urgent: true,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    })
    if (stopRunning(w, 'Stopped to deliver an urgent message from the orchestrator.')) {
      w.status = 'queued'
      w.retries = 0
      w.error = null
      w.notBefore = null
      w.revived = true
      changed(w)
      schedule(0)
      const more = w.pending.length - 1
      return {
        ok: true,
        urgent: true,
        model: w.model,
        effort: w.effort,
        message: `Stopped its running work; the same session continues now with this message first${more ? `, then the ${more} message(s) queued before it` : ''}.`,
      }
    }
    // It finished on its own a moment ago: the message leads its next turn like any other.
  } else {
    w.pending.push(text)
    journal(w, 'follow-up-queued', {
      pending: w.pending.length,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    })
  }
  if (w.status === 'running') {
    changed(w)
    return { ok: true, message: HELD_MESSAGE, model: w.model, effort: w.effort }
  }
  if (!isActive(w)) {
    w.status = 'queued'
    w.retries = 0
    w.error = null
    w.revived = true
  }
  changed(w)
  schedule(0)
  return {
    ok: true,
    message: 'Queued as the next turn of the same session.',
    model: w.model,
    effort: w.effort,
  }
}

const SENT_BACK = 'The orchestrator checked your result and it did not pass. What was wrong:'

const configLabel = (c: { model: string | null; effort: string | null }): string =>
  c.model?.includes('haiku')
    ? 'Haiku 4.5'
    : `${c.model?.includes('sonnet') ? 'Sonnet 5.5' : c.model?.includes('opus') ? 'Opus 5.5' : (c.model ?? 'the default model')} · ${c.effort ?? 'default effort'}`

/** Tag an untagged task's kind from the verdict. The reason it is not a kind, or null. */
function tagKind(w: CliMayteWorker, kind: unknown): string | null {
  try {
    const k = climayteKind(kind)
    if (k) w.kind = k
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** A verdict's record: the setting that produced the result, and what that work cost. */
function verdictRecord(
  w: CliMayteWorker,
  passed: 'pass' | 'fail',
  note: string | null,
  by: unknown,
  provisional = false,
): CliMayteVerdict {
  // The work this verdict judges: every attempt since the previous verdict.
  const previous = w.verdicts?.at(-1)
  const since = previous?.at ?? 0
  const ran = w.attempts.filter((a) => a.startedAt >= since)
  const reported = [...ran].reverse().find((a) => a.model)?.model ?? null
  // No attempt since the previous verdict: this one judges the same work and replaces it in the
  // scorecard (scoreRows), so it keeps what that work cost.
  const span = w.attempts.at(-1)?.startedAt
  const same = !ran.length && previous?.span !== undefined && previous.span === span
  return {
    at: Date.now(),
    verdict: passed,
    note,
    model: ladderModel(w.model ?? reported),
    effort: w.effort,
    units: same
      ? previous.units
      : ran.reduce((sum, a) => sum + attemptUnits(a.tokens, a.model ?? w.model, a.cacheTtl), 0),
    reread: same
      ? (previous.reread ?? 0)
      : ran.reduce((sum, a) => sum + rereadUnits(a, w.model), 0),
    by: by === 'check' || by === 'owner' || by === 'wave' ? by : 'orchestrator',
    ...(provisional ? { provisional: true } : {}),
    ...(span !== undefined ? { span } : {}),
  }
}

/** Send a failed result back to its session one rung up the ladder. What it was sent back on
 *  (null when it was not: already on the top setting, or the send was refused) and what to say. */
function sendBack(
  id: string,
  verdict: CliMayteVerdict,
  note: string | null,
): { next: { model: string; effort: string | null } | null; message: string } {
  const next = nextRung(verdict)
  if (!next)
    return {
      next: null,
      message:
        'Recorded a fail. It already ran on the top setting (Opus 5.5 · max), so it was not sent back.',
    }
  const sent = climayteSend(
    id,
    `${SENT_BACK} ${note}\n\nFix it, prove the fix with a command and what it printed, and report again.`,
    { model: next.model, ...(next.effort ? { effort: next.effort } : {}) },
  )
  return sent.ok
    ? { next, message: `Recorded a fail. Sent back on ${configLabel(next)}.` }
    : { next: null, message: sent.message }
}

/** Judge a finished task's result (owner, 2026-09-30: "if it works, it gives it a thumbs up ... if
 *  it does not, it reports the failure, and what model it tries next"). The verdict is kept with the
 *  setting that produced the result and what that work cost, and the scorecard learns from it. A
 *  fail (with `note`, required: the worker gets it) sends the task back to the same session one
 *  rung up the ladder unless `retry` is false. `kind` tags a task dispatched without one. */
export function climayteVerdict(
  id: string,
  input: {
    verdict?: unknown
    note?: unknown
    retry?: unknown
    kind?: unknown
    by?: unknown
    provisional?: boolean
  },
): { ok: boolean; message: string; next?: { model: string; effort: string | null } | null } {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  if (input.verdict !== 'pass' && input.verdict !== 'fail')
    return { ok: false, message: "verdict must be 'pass' or 'fail'." }
  if (isActive(w))
    return { ok: false, message: 'It is still working: judge its result once it has finished.' }
  const note =
    typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 1000) : null
  if (input.verdict === 'fail' && !note)
    return { ok: false, message: 'Say what was wrong (note): the worker gets it with the retry.' }
  const badKind = tagKind(w, input.kind)
  if (badKind !== null) return { ok: false, message: badKind }
  const verdict = verdictRecord(w, input.verdict, note, input.by, input.provisional === true)
  w.verdicts = [...(w.verdicts ?? []), verdict]
  let next: { model: string; effort: string | null } | null = null
  let message = verdict.verdict === 'pass' ? 'Recorded a pass.' : 'Recorded a fail; not sent back.'
  if (verdict.verdict === 'fail' && input.retry !== false)
    ({ next, message } = sendBack(id, verdict, note))
  journal(w, 'verdict', {
    verdict: verdict.verdict,
    notice: note ? firstLine(note) : undefined,
    model: verdict.model,
    effort: verdict.effort,
    kind: w.kind ?? undefined,
    reason: next ? `sent back on ${configLabel(next)}` : undefined,
  })
  changed(w)
  return { ok: true, message, next }
}

/** Every directory a wave record may sit in: each account's config dir (readWave's `configDir`). */
function waveDirs(): string[] {
  const dirs: string[] = []
  try {
    for (const a of accountsProvider()) if (!dirs.includes(a.configDir)) dirs.push(a.configDir)
  } catch {
    // no accounts: no waves
  }
  return dirs
}

/** A wave by id, with the directory it is stored in, or null. */
function findWave(id: string): { wave: CliMayteWave; configDir: string } | null {
  for (const configDir of waveDirs()) {
    const wave = readWave(configDir, id)
    if (wave) return { wave, configDir }
  }
  return null
}

/** Every wave on record, newest first, exactly as stored (GET /api/corch/waves). */
export function climayteWaves(): CliMayteWave[] {
  const out = new Map<string, CliMayteWave>()
  for (const dir of waveDirs()) {
    let names: string[] = []
    try {
      names = readdirSync(join(dir, 'corch', 'waves'))
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.endsWith('.json') || out.has(n.slice(0, -5))) continue
      const wave = readWave(dir, n.slice(0, -5))
      if (wave) out.set(wave.id, wave)
    }
  }
  return [...out.values()].sort((a, b) => b.createdAt - a.createdAt)
}

export function climayteWave(id: string): CliMayteWave | null {
  return findWave(id)?.wave ?? null
}

/** Change a wave record and write it: `fn` gets the copy the tick may be holding (modifiedWaves) or
 *  the one on disk, so a write here is not overwritten by a stale copy at the end of the tick.
 *  Null when no such wave exists. */
export function climayteWaveEdit<T>(id: string, fn: (wave: CliMayteWave) => T): T | null {
  load()
  const held = modifiedWaves.get(id)
  const found = held ?? findWave(id)
  if (!found) return null
  const out = fn(found.wave)
  found.wave.updatedAt = Date.now()
  writeWave(found.configDir, found.wave)
  return out
}

/** The wave's own tasks are no `manage` kind, and a wave needs at least this many tasks: smaller jobs
 *  keep climayte_run. */
const WAVE_MIN_TASKS = 3

/** Piece 7: write a wave and start its manager; nothing else starts (the manager dispatches).
 *  Throws an Error with the reason when the dispatch is refused. */
export function climayteWaveStart(input: {
  plan: unknown
  cwd: unknown
  tasks: unknown
  verify?: unknown
  branch?: unknown
  maxRounds?: unknown
}): { wave: string; managerId: string; waiter: string } {
  load()
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const plan = str(input.plan)
  const cwd = str(input.cwd)
  if (!plan) throw new Error('plan (the plan file path) is required')
  if (!cwd || !existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd || '(none)'}`)
  const raw = Array.isArray(input.tasks) ? (input.tasks as Array<Record<string, unknown>>) : []
  if (raw.length < WAVE_MIN_TASKS)
    throw new Error(
      `A wave needs at least ${WAVE_MIN_TASKS} tasks (got ${raw.length}): use climayte_run for small jobs.`,
    )
  const keys = new Set<string>()
  const tasks: CliMayteWave['tasks'] = raw.map((t, i) => {
    const key = str(t?.key)
    const prompt = str(t?.prompt)
    if (!key) throw new Error(`task ${i + 1}: key is required`)
    if (keys.has(key)) throw new Error(`task key "${key}" is used twice`)
    keys.add(key)
    if (!prompt) throw new Error(`task "${key}": prompt is required`)
    if (str(t.kind) === 'manage')
      throw new Error(
        `task "${key}": a wave's tasks cannot be of kind manage (no manager of managers)`,
      )
    if (t.kind !== undefined) climayteKind(t.kind)
    if (!Array.isArray(t.paths) || t.paths.some((p) => typeof p !== 'string'))
      throw new Error(`task "${key}": paths must be a list of globs ([] = must not commit)`)
    return {
      key,
      prompt,
      title: str(t.title) || firstLine(prompt, 60),
      kind: str(t.kind) || 'code',
      check: str(t.check) || null,
      paths: t.paths as string[],
      after: Array.isArray(t.after)
        ? t.after.filter((a): a is string => typeof a === 'string')
        : [],
      workerId: null,
      state: 'pending',
      proof: null,
    }
  })
  for (const t of tasks)
    for (const a of t.after)
      if (!keys.has(a)) throw new Error(`task "${t.key}": after names an unknown key "${a}"`)
  const rounds = Number(input.maxRounds)
  const maxRounds = Number.isInteger(rounds) && rounds >= 1 ? rounds : 3
  let branch = str(input.branch)
  if (!branch) {
    const r = Bun.spawnSync(['git', 'branch', '--show-current'], { cwd, windowsHide: true })
    branch = r.stdout.toString().trim() || 'main'
  }
  const dir = waveDirs()[0]
  if (!dir) throw new Error('No CLI account is signed in to run a wave on.')
  const id = `wv-${hex(6)}`
  const now = Date.now()
  const manager = climayteRun({
    tasks: [
      {
        prompt: `You are the manager of wave ${id}. Plan: ${plan}. Start with the tasks whose "after" is met.`,
        cwd,
        title: `manager ${id}`,
        kind: 'manage',
      },
    ],
    group: `mgr-${id}`,
  })
  const managerId = manager.workers[0]?.id as string
  const mw = workers.get(managerId)
  if (mw) {
    mw.wave = id
    save()
  }
  writeWave(dir, {
    id,
    group: `wave-${id}`,
    managerId,
    plan,
    cwd,
    branch,
    verify: str(input.verify) || null,
    tasks,
    escalations: [],
    notes: '',
    rounds: 0,
    maxRounds,
    batch: { size: Math.max(1, Math.min(tasks.length, 3)), settleS: 600, held: [], since: null },
    status: 'running',
    report: null,
    createdAt: now,
    updatedAt: now,
  })
  return {
    wave: id,
    managerId,
    waiter: `python ~/.claude/tools/climayte_wait.py --group 'mgr-${id}' --unjudged --wake-on done,failed,cancelled --timeout-s 7200`,
  }
}

/** The note a wave verification records: the orchestrator's own (trimmed, at most 1000 chars), else
 *  none for an accepted wave and a stock line for a rejected one. */
function waveVerifyNote(note: unknown, accepted: boolean): string | null {
  if (typeof note === 'string' && note.trim()) return note.trim().slice(0, 1000)
  return accepted ? null : 'The orchestrator rejected the wave.'
}

/** Confirm every provisional wave pass on the wave's task workers; returns how many were confirmed. */
function confirmWavePasses(wave: CliMayteWave): number {
  let confirmed = 0
  for (const t of wave.tasks) {
    const w = t.workerId ? workers.get(t.workerId) : undefined
    if (!w) continue
    for (const v of w.verdicts ?? []) {
      if (v.by === 'wave' && v.provisional) {
        delete v.provisional
        confirmed++
      }
    }
    changed(w)
  }
  return confirmed
}

/** Record the orchestrator's pass or fail on the wave's manager, when it still exists. */
function recordManagerVerdict(wave: CliMayteWave, accepted: boolean, note: string | null): void {
  const manager = workers.get(wave.managerId)
  if (!manager) return
  // Recorded directly: the manager may still be ending its turn, which climayteVerdict refuses.
  manager.verdicts = [
    ...(manager.verdicts ?? []),
    verdictRecord(manager, accepted ? 'pass' : 'fail', note, 'orchestrator'),
  ]
  journal(manager, 'verdict', {
    verdict: accepted ? 'pass' : 'fail',
    notice: note ? firstLine(note) : undefined,
    kind: 'manage',
  })
  changed(manager)
}

/** Piece 7: the orchestrator's one verification of a reported wave. `ok` confirms every provisional
 *  pass of its tasks (they count in the scorecard from then on) and records a pass on the manager;
 *  not `ok` confirms none and records a fail on the manager, `retry: false` (the wave is over). */
export function climayteWaveVerify(
  id: string,
  input: { ok: unknown; note?: unknown },
): { ok: boolean; status: number; message: string } {
  load()
  const found = findWave(id)
  if (!found) return { ok: false, status: 404, message: `No such wave: ${id}` }
  const { wave, configDir } = found
  if (wave.status !== 'reported')
    return {
      ok: false,
      status: 409,
      message: `Wave ${id} is ${wave.status}: only a reported wave can be verified.`,
    }
  const accepted = input.ok === true
  const note = waveVerifyNote(input.note, accepted)
  const confirmed = accepted ? confirmWavePasses(wave) : 0
  recordManagerVerdict(wave, accepted, note)
  wave.status = accepted ? 'verified' : 'rejected'
  wave.updatedAt = Date.now()
  writeWave(configDir, wave)
  return {
    ok: true,
    status: 200,
    message: accepted
      ? `Wave ${id} verified: ${confirmed} provisional pass(es) confirmed.`
      : `Wave ${id} rejected: no provisional pass confirmed.`,
  }
}

/** What works, per kind of task: every verdict on record summed by setting, with what a task cost
 *  on average as a share of a Pro 5-hour window, and the setting an `auto` task of that kind gets
 *  next (`pick`; an exploring pick one rung cheaper is not marked). */
export function climayteScorecard(): {
  unitsPerPercent: number
  rows: Array<{
    kind: string
    model: string | null
    effort: string | null
    pass: number
    fail: number
    pctPerTask: number | null
    pick: boolean
  }>
} {
  load()
  const rows = scoreRows(workers.values())
  const picks = new Map<string, number>()
  for (const r of rows) {
    if (picks.has(r.kind)) continue
    try {
      const k = climayteKind(r.kind)
      if (k) picks.set(r.kind, bestRung(k, rows))
    } catch {
      // a kind no longer on the list: shown, never picked
    }
  }
  return {
    unitsPerPercent: UNITS_PER_PRO_PERCENT,
    rows: rows.map((r) => {
      const n = r.pass + r.fail
      const best = picks.get(r.kind)
      return {
        kind: r.kind,
        model: r.model,
        effort: r.effort,
        pass: r.pass,
        fail: r.fail,
        pctPerTask: n ? Math.round((r.units / n / UNITS_PER_PRO_PERCENT) * 10) / 10 : null,
        pick:
          best !== undefined &&
          ladderIndex({ model: ladderModel(r.model), effort: r.effort }) === best,
      }
    }),
  }
}

/** End a running worker's attempt now: kill its CLI and record the attempt as stopped, with its
 *  spend. False when the CLI had already finished (that turn is recorded instead, by poll) and the
 *  worker is no longer active. */
function stopRunning(w: CliMayteWorker, notice: string | null): boolean {
  const at = w.attempts[w.attempts.length - 1]
  // Stopped just after the CLI finished: record that turn's result, cost and turns first.
  if (w.status === 'running' && at && attemptExited(w, at)) {
    try {
      poll(w)
    } catch (err) {
      // One worker's read error must not stop a group cancel; the kill path below still runs.
      console.error(`[climayte] could not read ${w.id}:`, err)
    }
    if (!isActive(w)) return false
  }
  if (w.status === 'running' && at) {
    killAttempt(at)
    at.outcome = 'cancelled'
    at.notice = notice
    at.endedAt = Date.now()
    charge(w, at)
    forgetRead(at.log)
    rmSync(signalPath(w.id), { force: true })
    removeWorkerFiles(w.id)
  }
  return true
}

/** Queued messages survive a cancel (field note 11, 2026-09-30: a cancel dropped three silently):
 *  they are delivered, in order, when the worker is continued, and the answer counts them. */
export function climayteCancel(filter: { id?: string; group?: string }): {
  cancelled: string[]
  keptMessages: Record<string, number>
} {
  load()
  const cancelled: string[] = []
  const keptMessages: Record<string, number> = {}
  if (!filter.id && !filter.group) return { cancelled, keptMessages }
  for (const w of workers.values()) {
    if (!matches(w, filter) || !isActive(w)) continue
    stopCheck(w)
    if (!stopRunning(w, null)) continue
    const at = w.attempts[w.attempts.length - 1]
    w.status = 'cancelled'
    w.error = null
    delete w.revived
    if (w.pending.length) keptMessages[w.id] = w.pending.length
    journal(w, 'cancelled', {
      ...(at ? { account: acctLabel(at.account) } : {}),
      ...(w.pending.length ? { pending: w.pending.length } : {}),
    })
    changed(w)
    cancelled.push(w.id)
  }
  return { cancelled, keptMessages }
}

/** Move a file or folder into the archive, keeping it (a rename, or a copy then remove across
 *  drives). A missing source is not an error. */
function archiveMove(from: string, to: string): void {
  if (!existsSync(from)) return
  mkdirSync(join(to, '..'), { recursive: true })
  try {
    renameSync(from, to)
  } catch {
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
}

/** Remove finished tasks from CliMayte's list (owner, 2026-09-30: clear out the test sessions). Their
 *  records go; their logs and CLI transcripts are MOVED to corch/archive/<stamp>/<task id>/, never
 *  deleted, so a removal can be undone by hand. A task still queued, running or waiting is skipped. */
export function climayteRemove(ids: string[]): {
  removed: string[]
  skipped: string[]
  archive: string
} {
  load()
  const archive = join(ROOT, 'archive', new Date().toISOString().replace(/[:.]/g, '-'))
  const removed: string[] = []
  const skipped: string[] = []
  for (const id of ids) {
    const w = workers.get(id)
    // A stop still under way (a check or a runner it could not kill yet) is finished by the tick, which
    // only visits workers it still holds: removing one now would leave its runner going for good.
    const stopping =
      !!w?.checkRunner ||
      !!w?.staleChecks?.length ||
      !!w?.attempts.some((a) => a.runner?.killOnStart)
    if (!w || isActive(w) || stopping) {
      skipped.push(id)
      continue
    }
    const dest = join(archive, w.id)
    for (const [i, at] of w.attempts.entries()) {
      archiveMove(at.log, join(dest, 'logs', `${i}-out.jsonl`))
      archiveMove(packedPath(at.log), join(dest, 'logs', `${i}-out.jsonl.zst`))
      archiveMove(at.errLog, join(dest, 'logs', `${i}-err.log`))
    }
    const sessionIds = [
      ...new Set([...(w.sessions ?? []), w.sessionId].filter(Boolean)),
    ] as string[]
    const accounts = [...new Set(w.attempts.map((a) => a.account.id))]
    for (const accountId of accounts) {
      const dir = getCliInstance(accountId)?.configDir
      if (!dir) continue
      const projects = join(dir, 'projects')
      let keys: string[] = []
      try {
        keys = readdirSync(projects)
      } catch {
        continue
      }
      for (const key of keys)
        for (const sid of sessionIds) {
          const base = join(dest, 'transcripts', accountId, key)
          archiveMove(join(projects, key, `${sid}.jsonl`), join(base, `${sid}.jsonl`))
          archiveMove(join(projects, key, sid), join(base, sid))
        }
    }
    removeWorkerFiles(w.id)
    workers.delete(w.id)
    removed.push(w.id)
  }
  if (removed.length) save()
  return { removed, skipped, archive }
}

/** The settings and MCP files of every worker that is gone or finished, removed at daemon start:
 *  finish and stopRunning remove a worker's own, but a daemon that stopped first left them, and
 *  before 2026-10-02 nothing did. Never a live worker's: one queued, running, waiting or checking,
 *  or with a runner still to be stopped, keeps its files. Nothing when the store could not be read,
 *  which leaves no worker to tell a live one by. How many workers' files went. */
export function sweepWorkerFiles(): number {
  load()
  if (!storeLoaded()) return 0
  let swept = 0
  for (const id of workerFileIds()) {
    const w = workers.get(id)
    const live =
      !!w &&
      (isActive(w) || w.attempts.some((a) => a.outcome === 'running' || a.runner?.killOnStart))
    if (live) continue
    removeWorkerFiles(id)
    swept++
  }
  return swept
}

/** Idempotent: load the store and start watching. Called at daemon boot. */
export function startCliMayte(): void {
  load()
  if (started) return
  started = true
  sweepWorkerFiles()
  schedule(0)
}
