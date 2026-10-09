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
// What never drives the tick sits beside this file, imported the same one way (split 2026-10-08,
// when this file reached 4,428 lines against the Architect's 2,500-line gate): climayte-stops.ts
// (attempt logs read, runners found and killed, the usage stops), climayte-checks.ts (a check
// command's plumbing), climayte-storage.ts (the storage pass), climayte-settle.ts (an attempt's
// outcome to its worker's next state), climayte-steer.ts (messages and verdicts checked),
// climayte-wave-ops.ts (waves on the live workers), climayte-dispatch.ts (a dispatch's tasks made
// into workers) and climayte-view.ts (the read API). This file keeps whatever starts, stops or
// schedules work, and re-exports the rest of the API by name.
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
} from 'node:fs'
import { join } from 'node:path'
import {
  CHECK_RELAUNCHES,
  CHECK_TIMEOUT_MS,
  type CheckRunner,
  checkLost,
  checkSeverity,
  checkShell,
  MAX_CHECK_FAILS,
  removeCheckFiles,
  stopCheck,
  stopStaleChecks,
  takeCheckPid,
  unsavedOf,
} from './climayte-checks'
import {
  acctLabel,
  changed,
  isActive,
  journal,
  LOGS,
  type LogRead,
  liveByAccount,
  load,
  notify,
  packedPath,
  packLog,
  perAccount,
  perAccountStrict,
  preloadDone,
  ROOT,
  runnerSpecPath,
  save,
  settleSpends,
  signalPath,
  storeLoaded,
  tailText,
  walls,
  workers,
} from './climayte-core'
import {
  assertKnownAccounts,
  deskProblem,
  hex,
  newWorker,
  type RunReply,
  type RunSetting,
  type RunTask,
  repeatOf,
  runDefaultsOf,
  runReply,
  sealedTask,
  sizeTasks,
  taskSettings,
} from './climayte-dispatch'
import { ETA_PROMPT_VERSION, etaTookSeconds } from './climayte-eta'
import { appendEtaRow, reviewRow, saidRow, settledRow } from './climayte-eta-ledger'
import { firstLine } from './climayte-journal'
import { removeWorkerFiles, workerFileIds } from './climayte-launch'
import {
  type CliMayteAccount,
  type CliMayteSealed,
  type CliMayteWave,
  type CliMayteWorker,
  classifyAttempt,
  climaytePriority,
  contextTokens,
} from './climayte-lib'
import {
  type CliMayteOrigin,
  type CliMaytePing,
  type CliMaytePingDeps,
  startCliMaytePing,
} from './climayte-ping'
import { launchRunner, readRunnerExit, readRunnerPids } from './climayte-runner'
import { scheduleDue, tickAccounts, tickState } from './climayte-schedule'
import { type CliMayteVerdict, climayteKind, nextRung } from './climayte-scorecard'
import {
  charge,
  installBroken,
  journalFinish,
  keepHome,
  keepResults,
  settleWorker,
} from './climayte-settle'
import {
  applySendSetting,
  configLabel,
  HELD_MESSAGE,
  haikuFailFloor,
  queueFollowUp,
  SENT_BACK,
  SENT_NOW_PREFIX,
  type SendSetting,
  sendSetting,
  tagKind,
  URGENT_PREFIX,
  verdictNoteTooLong,
  verdictProblem,
  verdictRecord,
  verdictSeverity,
} from './climayte-steer'
import {
  type Attempt,
  attemptExited,
  authChecks,
  checkRunners,
  cleanUpRunner,
  climayteSignedOutReason,
  credStamp,
  forgetRead,
  killAttempts,
  killLateStarts,
  noteReading,
  readLog,
  recheckOrgWall,
  saveLive,
  signedOutRecheckDue,
  stopAtCeilingOrOverage,
  stopWindDown,
  trySaveWalls,
  withStops,
} from './climayte-stops'
import {
  doneLogs,
  findPackedLogs,
  logSettled,
  PACK_AFTER_MS,
  PACK_EVERY_MS,
  PACK_PASS_BYTES,
  storagePass,
} from './climayte-storage'
import { matches, onCliMayteChange } from './climayte-view'
import { judgeWaveTask, waveBatch, writeWave } from './climayte-wave'
import {
  addToWaveBatch,
  endedInWave,
  liveWave,
  modifiedWaves,
  reconcilableWave,
  reconcileManager,
  settledWaves,
  settleKeyOfWorker,
  WAVE_MIN_TASKS,
  waveDirs,
} from './climayte-wave-ops'
import { getCliInstance, setCliLoginVeto } from './core/cli-instances'
import { cliAuthStatus } from './core/cli-quick-add'
import { desk2Url } from './desk2'
import { POINTER_DIR } from './instance'

export {
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  setCliMayteMemoryReader,
  setCliMayteOwnerDir,
} from './climayte-core'
export {
  CliMayteSplitNeeded,
  REPEAT_WINDOW_MS,
  type RunDefaults,
  runSetting,
  sealedOf,
} from './climayte-dispatch'
export * from './climayte-journal'
export * from './climayte-lib'
export { installBroken, settleWorker } from './climayte-settle'
export {
  climayteAsk,
  climayteStopHook,
  HELD_MESSAGE,
  SENT_NOW_PREFIX,
  VERDICT_NOTE_MAX,
  verdictNoteTooLong,
} from './climayte-steer'
export {
  climayteLimitWalls,
  climayteLiveReadings,
  climayteRunningCount,
  climayteSignedOutReason,
  climayteWorkerPids,
} from './climayte-stops'
export { planStorage, type StoragePlan } from './climayte-storage'
export { climayteTotals } from './climayte-totals'
export {
  type CliMayteListFilter,
  climayteCapacity,
  climayteGet,
  climayteHandoff,
  climayteJournal,
  climayteJournalLines,
  climayteJournalNudge,
  climayteLeanWave,
  climayteLeanWorker,
  climayteList,
  climaytePickModel,
  climayteReports,
  climayteScorecard,
  climayteWait,
  onCliMayteChange,
} from './climayte-view'
export {
  climayteWave,
  climayteWaveEdit,
  climayteWaveResolve,
  climayteWaves,
  climayteWaveVerify,
} from './climayte-wave-ops'

let started = false

let timer: ReturnType<typeof setTimeout> | null = null

let ticking = false

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

/** A signed-out wall is lifted only by a new sign-in: when the account's credential file changes,
 *  the CLI's own `auth status` decides (about a quarter of a second, no quota). The clock never asks
 *  again, so a dead login costs no other worker a failed attempt (it was rechecked every 30 minutes,
 *  and each lift sent waiting work at it). */
function recheckSignedOut(accounts: CliMayteAccount[]): void {
  for (const a of accounts) {
    const wall = walls[a.id]
    if (recheckOrgWall(a, wall)) continue
    if (wall?.reason !== 'signed out' || authChecks.has(a.id)) continue
    const cred = credStamp(a.configDir)
    if (wall.cred === undefined) {
      wall.cred = cred
      trySaveWalls()
      continue
    }
    if (!signedOutRecheckDue(wall, cred)) continue
    wall.cred = cred
    authChecks.add(a.id)
    checkAuth(a)
  }
}

setCliLoginVeto(climayteSignedOutReason)

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
  // A task of a wave is judged by the daemon on the check and the commits together (piece 5).
  if (code === 0 && judgeInWave(w, true)) return
  // A pass with the worker's own files still uncommitted is not done: on 2026-10-05 one passed with
  // 15 files never committed and sat 'done' 2h26m while the tasks after it waited on that work.
  const unsaved = code === 0 ? unsavedOf(w) : []
  if (code === 0 && !unsaved.length) {
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
      severity: 0,
    })
    return
  }
  const fails =
    (w.verdicts ?? []).filter((v) => v.by === 'check' && v.verdict === 'fail').length + 1
  const retry = fails < MAX_CHECK_FAILS
  const files = `${unsaved.slice(0, 15).join(', ')}${unsaved.length > 15 ? ` and ${unsaved.length - 15} more` : ''}`
  const sev = unsaved.length
    ? { severity: 1 as const, others: false }
    : checkSeverity(w, code, output)
  const note = unsaved.length
    ? `The check \`${cmd}\` passed, but files you changed are not committed: ${files}. Commit them by pathspec (and push if the task pushes), then report again.`
    : `The check \`${cmd}\` failed (${code === null ? output : `exit ${code}`}). The end of its output:
${code === null ? '' : output.trim()}${sev.others ? "\nThe failing files are not ones this task edited, and another session's uncommitted changes are in them." : ''}`
  if (!retry) {
    w.status = 'failed'
    w.error = unsaved.length
      ? `Its changed files were still not committed after ${MAX_CHECK_FAILS} rounds; it needs the orchestrator: ${files}`
      : `The check still failed after ${MAX_CHECK_FAILS} rounds; it needs the orchestrator. Last: ${firstLine(output)}`
    journal(w, 'failed', { error: firstLine(w.error) })
  }
  climayteVerdict(w.id, { verdict: 'fail', note, retry, by: 'check', severity: sev.severity })
}

/** When the tick last looked for attempts whose spend the kit had not caught up with (every 5 s). */
let lastSettle = 0

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
    if (now - lastSettle >= 5_000) {
      lastSettle = now
      settleSpends(now)
    }
    killLateStarts()
    saveLive()
    pollChecks()
    recheckSignedOut(accounts)
    const state = tickState(accounts, now)
    const due = [...workers.values()].filter(
      (w) =>
        (w.status === 'queued' || w.status === 'waiting') && (w.notBefore ?? 0) <= now && !w.hold,
    )
    scheduleDue(state, due)
    // Piece 3: Process wave batch wakes.
    reconcileWaves(now)
    processBatchWakes(now)
    // Last, so packing never stands between a running worker and its overage stop.
    packOldLogs(now)
  } finally {
    ticking = false
    schedule()
  }
}

let nextPackAt = 0

/** Whether startCliMayte has filled doneLogs with the logs already gone at boot. Until then no pass
 *  runs: the first one would stat every attempt's log on the daemon's thread. */
let packReady = false

/** Pack the logs of settled attempts (packLog) once they are PACK_AFTER_MS old, then clear what
 *  finished workers left behind (retention), every PACK_EVERY_MS. */
function packOldLogs(now: number): void {
  if (!packReady || now < nextPackAt) return
  let room = PACK_PASS_BYTES
  for (const w of workers.values())
    for (const at of w.attempts) {
      if (room <= 0 || doneLogs.has(at.log)) continue
      if (!logSettled(at) || now - (at.endedAt as number) < PACK_AFTER_MS) continue
      const packed = packLog(at.log, now - PACK_AFTER_MS)
      if (packed > 0 || !existsSync(at.log)) doneLogs.add(at.log)
      room -= packed
    }
  if (room > 0) storagePass(now, false)
  nextPackAt = now + (room <= 0 ? 60_000 : PACK_EVERY_MS)
}

/** What changed for the worker in this read: its newest summary line (lastActivity), or, an ended
 *  attempt, the finish of it (finish). */
function noteActivity(w: CliMayteWorker, r: LogRead, exited: boolean): void {
  const latest = r.recent[r.recent.length - 1] ?? null
  if (latest && latest !== w.lastActivity) {
    w.lastActivity = latest
    w.updatedAt = Date.now()
  }
  // Its `ETA:` line for this message (climayte-eta.ts), once: a later attempt of the same message
  // (a move, a handoff) keeps the first. startReport clears it when the next message goes in.
  if (!w.chat && !w.eta && r.eta) {
    w.eta = {
      minutes: r.eta.minutes,
      at: r.eta.at,
      attempt: w.attempts.length - 1,
      line: r.eta.line,
      prompt: ETA_PROMPT_VERSION,
    }
    appendEtaRow(saidRow(w, w.eta, r.eta.text))
    changed(w)
  }
  // Its answer to why the estimate missed (the Stop hook asked, climayteStopHook): kept on the
  // estimate and in the ledger.
  if (!w.chat && w.eta?.reviewAskedAt !== undefined && !w.eta.review && r.review) {
    w.eta.review = r.review
    appendEtaRow(reviewRow(w.id, w.eta, r.review, Date.now()))
    changed(w)
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

/** Piece 5: judge a finished wave task by command (judgeWaveTask) instead of the manager's word:
 *  the check (`checkPassed`, null with none) and its commits. A pass is provisional (it stays out of
 *  the scorecard until the orchestrator accepts the wave); a failed proof sends the task back one
 *  rung up like a failed check, three rounds and then failed; nothing provable records no verdict and
 *  escalates the key as `unproven`. False when the worker is no task of a running wave. */
function judgeInWave(w: CliMayteWorker, checkPassed: boolean | null): boolean {
  if (!w.wave || w.kind === 'manage') return false
  try {
    // The wave sits in the account it was started on, which is not always the worker's own.
    const found = liveWave(w.wave)
    const wave = found?.wave
    const task = wave?.tasks.find((t) => t.workerId === w.id)
    if (!found || !wave || !task || wave.status !== 'running') return false
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
      // Commits outside the brief's paths are a slip; any other failed proof is rework.
      const severity = j.proof.paths === false ? 1 : 2
      climayteVerdict(w.id, { verdict: 'fail', note: j.note, retry, by: 'wave', severity })
    } else {
      task.state = 'escalated'
      wave.escalations.push({ key: task.key, reason: `unproven: ${j.note}`, at: now })
    }
    modifiedWaves.set(w.wave, { wave, configDir: found.configDir })
    // A task sent back for another round is no change the manager needs yet.
    if (task.state !== 'running') addToWaveBatch(w, now, true)
    return true
  } catch {
    // A wave that cannot be read judges as an ordinary task.
    return false
  }
}

function finish(w: CliMayteWorker, events: unknown[]): void {
  const at = w.attempts[w.attempts.length - 1]
  if (at?.outcome !== 'running') return
  const hadRunnerPid =
    !!at.runner && (at.runner.pid !== null || readRunnerPids(at.runner.pidFile) !== null)
  cleanUpRunner(w, at)
  const stderr = tailText(at.errLog, 4_000)
  const v = installBroken(
    at,
    withStops(at, classifyAttempt(events, stderr, at.started === true)),
    events,
    stderr,
    hadRunnerPid,
  )
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
  // A worker that asked (climayteAsk) ended its turn to wait for the answer: nothing is judged, no
  // check runs and no wave batch is woken until the answer resumes it. A question left when the
  // turn went on (a message was already queued) is answered.
  const asking = w.status === 'done' && !!w.question
  // The message's estimate settles when its turn ends done, not to ask: the working time since the
  // `ETA:` line is the sample the next briefs are calibrated on (climayte-eta.ts).
  if (
    v.outcome === 'done' &&
    !asking &&
    w.status !== 'failed' &&
    w.eta &&
    w.eta.tookS === undefined
  ) {
    w.eta.tookS = etaTookSeconds(w.eta, w.attempts, now)
    w.eta.doneAt = now
    appendEtaRow(settledRow(w, w.eta as typeof w.eta & { tookS: number; doneAt: number }))
  }
  // climayteSend told the caller a queued message would be delivered; say that it was not.
  if (w.status === 'failed' && w.pending.length)
    w.error =
      `${w.error ?? ''} ${w.pending.length} queued message(s) were not delivered; send one again to retry.`.trim()
  journalFinish(w, at, v, spent)
  if (w.question && !asking) delete w.question
  // A wave task with no check is judged now; with one, when its check ends (judgeCheck).
  const judged = !asking && w.status === 'done' && !w.check && judgeInWave(w, null)
  if (!asking && w.status === 'done' && w.check) startCheck(w)
  if (!asking && !judged && w.status !== 'checking') addToWaveBatch(w, now)

  changed(w)
  schedule(50)
}

/** Piece 3: The daemon's batch wake. Process all waves that have held task changes and decide
 * whether to wake their managers with a batch report. Clear the modified waves map at the end. */
function processBatchWakes(now: number): void {
  for (const [, { wave, configDir }] of modifiedWaves) {
    const manager = workers.get(wave.managerId)
    // A wave no longer running (reported, decided) wakes no manager: there is nothing left to manage.
    if (
      !manager ||
      manager.status === 'failed' ||
      manager.status === 'cancelled' ||
      wave.status !== 'running'
    ) {
      // No manager to wake; keep what changed in the wave.
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
      // A manager ends every turn `done` and only this wake starts the next one (field note 71, live
      // wave wv-2fb769: the report sat in `pending` for over an hour). Queue it as climayteSend does
      // for a finished worker; one still running keeps the report for its next turn.
      if (!isActive(manager)) {
        manager.status = 'queued'
        manager.retries = 0
        manager.error = null
        manager.revived = true
      }
      changed(manager)
      schedule(0)
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

/** Store a dispatch's new workers, journal each and start them (climayteRun): a wave's carry the
 *  wave, any other the dispatcher to ping. */
function enlistWorkers(
  made: CliMayteWorker[],
  settings: RunSetting[],
  fresh: number[],
  input: { wave?: string; origin?: CliMayteOrigin },
): void {
  // A wave's tasks are reported to their manager by the wave's own batch wake, so they carry none.
  const origin = input.wave ? undefined : originFor(input.origin)
  for (const [k, w] of made.entries()) {
    if (input.wave) w.wave = input.wave
    if (origin) w.origin = origin
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
}

/** `model` / `effort` / `kind` at the top level are the group's default: a task that names its
 *  own wins. All are validated (climayteModel, climayteEffort, climayteKind) before anything is created.
 *  The scorecard chooses model AND effort for the task's kind (default `code`): of the settings that
 *  pass it reliably the one whose passed task costs least; Haiku 5.5 on every pick while it is still
 *  learning for the kind, else a cheaper one still learning on every 4th pick, every 2nd while the
 *  kind's pick is Opus (pickConfig). A named model or effort holds
 *  only with `ownerWords`, on a sealed task, or with a `modelWhy` on a rung cheaper than the pick
 *  (runSetting).
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
    /** The owner's own words asking for this model or effort, quoted (runSetting); at most 2000 characters. */
    ownerWords?: string
    kind?: string
    check?: string
    priority?: number
    size?: string
    /** One of the owner's own chats, not a delegated task (CliMayteWorker.chat). */
    chat?: boolean
    /** A Desk chat's add-ons, only with `chat` (CliMayteWorker.desk). */
    desk?: { append: string; mcpServers: Record<string, object> }
    /** Launch sealed (CliMayteSealed, sealedOf); `prompt` here stands in for an empty task prompt,
     *  and the task's `cwd` is not read. */
    sealed?: CliMayteSealed & { prompt?: string }
  }>
  group?: string
  accounts?: string[]
  perAccount?: number
  /** per_account as a hard cap: the group never spills past it (owner ruling, 2026-10-03). */
  perAccountStrict?: boolean
  model?: string
  effort?: string
  modelWhy?: string
  /** Run-level ownerWords: every task that names no model or effort of its own (runSetting). */
  ownerWords?: string
  kind?: string
  priority?: number
  size?: string
  /** Make new workers even for tasks an earlier dispatch of this group already made. */
  copies?: boolean
  /** The wave these workers are tasks of (set by the manager's wave_dispatch). */
  wave?: string
  /** Who dispatched them, as the route resolved the caller (originFor); pinged when they settle. */
  origin?: CliMayteOrigin
}): RunReply {
  load()
  if (!Array.isArray(input.tasks) || !input.tasks.length)
    throw new Error('tasks must be a non-empty array')
  input = { ...input, tasks: input.tasks.map(sealedTask) }
  const defaults = runDefaultsOf(input)
  const settings = taskSettings(input.tasks, defaults)
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
  // Likewise its strictness: per_account spills past the cap unless the dispatcher said strict.
  if (input.perAccountStrict === true) perAccountStrict[group] = true
  else if (input.perAccountStrict === false) delete perAccountStrict[group]
  const made = fresh.map((i, k) =>
    newWorker(input.tasks[i] as RunTask, settings[i], sized[k], group, input.accounts, now),
  )
  enlistWorkers(made, settings, fresh, input)
  return runReply(group, repeats, fresh, made, now)
}

/** One verdict for several finished workers (the same `verdict`, `note` and `kind` for each), in
 *  one call: a batch wake hands an orchestrator several results it checked together. */
export function climayteVerdicts(
  ids: string[],
  input: Parameters<typeof climayteVerdict>[1],
): Array<{ id: string } & ReturnType<typeof climayteVerdict>> {
  return ids.map((id) => ({ id, ...climayteVerdict(id, input) }))
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

/** Queue an urgent message first and stop the running turn for it. Null when the worker had
 *  finished on its own a moment ago: the message then leads its next turn like any other. */
function sendUrgent(
  w: CliMayteWorker,
  text: string,
  { model, effort }: SendSetting,
): ReturnType<typeof climayteSend> | null {
  w.pending.unshift(`${URGENT_PREFIX}\n\n${text}`)
  journal(w, 'follow-up-queued', {
    pending: w.pending.length,
    urgent: true,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  })
  if (stopToDeliver(w, 'Stopped to deliver an urgent message from the orchestrator.')) {
    const more = w.pending.length - 1
    return {
      ok: true,
      urgent: true,
      model: w.model,
      effort: w.effort,
      message: `Stopped its running work; the same session continues now with this message first${more ? `, then the ${more} message(s) queued before it` : ''}.`,
    }
  }
  return null
}

/** `urgent`: a running worker is stopped cleanly (its attempt recorded with its cost, the transcript
 *  kept) and the same session continues at once with this message first; messages already queued
 *  follow it, in order. Without it, a running worker gets the message when its task ends. */
export function climayteSend(
  id: string,
  text: string,
  opts: {
    urgent?: boolean
    model?: string
    effort?: string
    cwd?: string
    desk?: unknown
    ping?: true
  } = {},
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
  const setting = sendSetting(w, opts)
  if (typeof setting === 'string') return { ok: false, message: setting }
  // A Desk chat's add-ons as they are now replace the kept ones from the next launch on.
  if (opts.desk !== undefined) {
    const why = deskProblem(opts.desk, w.chat === true)
    if (why) return { ok: false, message: why }
    w.desk = opts.desk as CliMayteWorker['desk']
  }
  applySendSetting(w, setting)
  delete w.question // a message is the answer to what the worker asked (climayteAsk)
  // A stopped worker stays stopped for a ping: its text waits with the owner's next message.
  if (opts.ping && w.status === 'cancelled') {
    queueFollowUp(w, text, setting)
    changed(w)
    return {
      ok: true,
      message: "Held: the worker was stopped, so it resumes on its owner's next message.",
      model: w.model,
      effort: w.effort,
    }
  }
  if (w.status === 'running' && opts.urgent) {
    const sent = sendUrgent(w, text, setting)
    if (sent) return sent
    // It finished on its own a moment ago: the message leads its next turn like any other.
  } else {
    queueFollowUp(w, text, setting)
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

/** Send now on a message held for a running worker: its turn stops as for an urgent message, and the
 *  same session continues at once with that message first and the others after it, in order. No new
 *  message is added (a second climayteSend with urgent would deliver it twice). `text` says which held
 *  message: the one equal to it, else the first containing it (a sender's picture lines add to it);
 *  without it, the oldest. Nothing running or nothing held answers ok with `stopped: false`. */
export function climayteDeliverNow(
  id: string,
  text?: string,
): { ok: boolean; stopped?: boolean; message: string } {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  if (w.status !== 'running')
    return {
      ok: true,
      stopped: false,
      message: w.pending.length
        ? 'Not running: what it holds goes as its next turn.'
        : 'Not running, and it holds no message.',
    }
  const want = text?.trim()
  let i = want ? w.pending.indexOf(text as string) : w.pending.length ? 0 : -1
  if (i < 0 && want) i = w.pending.findIndex((p) => p.includes(want))
  if (i < 0)
    return {
      ok: true,
      stopped: false,
      message: 'That message is not held any more: it was delivered, or its turn has begun.',
    }
  const [held] = w.pending.splice(i, 1) as [string]
  w.pending.unshift(`${SENT_NOW_PREFIX}\n\n${held}`)
  journal(w, 'follow-up-queued', { pending: w.pending.length, urgent: true })
  if (stopToDeliver(w, 'Stopped to deliver a message the user sent now.')) {
    const more = w.pending.length - 1
    return {
      ok: true,
      stopped: true,
      message: `Stopped its running work; the same session continues now with this message${more ? `, then the ${more} other held message(s)` : ''}.`,
    }
  }
  // It finished on its own a moment ago: the message leads its next turn, with no word of a stop.
  w.pending[0] = held
  changed(w)
  return {
    ok: true,
    stopped: false,
    message: 'It had just finished: this message leads its next turn.',
  }
}

/** Ends a running worker's turn so the same session continues at once with what it holds (an urgent
 *  or sent-now message first). False when it had finished on its own a moment ago. */
function stopToDeliver(w: CliMayteWorker, notice: string): boolean {
  if (!stopRunning(w, notice)) return false
  w.status = 'queued'
  w.retries = 0
  w.error = null
  w.notBefore = null
  w.revived = true
  changed(w)
  schedule(0)
  return true
}

/** Send a failed result back to its session one rung up the ladder (a failed Haiku result at least
 *  to haikuFailFloor). What it was sent back on (null when it was not: already on the top setting,
 *  or the send was refused) and what to say. */
function sendBack(
  id: string,
  verdict: CliMayteVerdict,
  note: string | null,
): { next: { model: string; effort: string | null } | null; message: string } {
  const next = nextRung(verdict, haikuFailFloor(workers.get(id), verdict))
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

/** What a recorded verdict does next: a fail goes back to its session one rung up (sendBack) unless
 *  `retry` is false or the task is sealed. What it was sent back on (null when it was not) and what
 *  to say. */
function afterVerdict(
  id: string,
  w: CliMayteWorker,
  verdict: CliMayteVerdict,
  note: string | null,
  retry: unknown,
): { next: { model: string; effort: string | null } | null; message: string } {
  if (verdict.verdict === 'pass') return { next: null, message: 'Recorded a pass.' }
  // A sealed task is one visit of a series: a rung up, its next turn would run on a setting it never named.
  if (w.sealed)
    return {
      next: null,
      message: 'Recorded a fail; not sent back: a sealed task holds the setting it names.',
    }
  if (retry === false) return { next: null, message: 'Recorded a fail; not sent back.' }
  return sendBack(id, verdict, note)
}

export function climayteVerdict(
  id: string,
  input: {
    verdict?: unknown
    note?: unknown
    retry?: unknown
    kind?: unknown
    by?: unknown
    provisional?: boolean
    /** A fail's severity, 0-3 (CliMayteVerdict.severity); refused on a pass. */
    severity?: unknown
  },
): { ok: boolean; message: string; next?: { model: string; effort: string | null } | null } {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  if (input.verdict !== 'pass' && input.verdict !== 'fail')
    return { ok: false, message: "verdict must be 'pass' or 'fail'." }
  if (isActive(w))
    return { ok: false, message: 'It is still working: judge its result once it has finished.' }
  const tooLong = verdictNoteTooLong(input.note)
  if (tooLong) return { ok: false, message: tooLong }
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null
  const sev = input.severity
  const refused = verdictProblem(input.verdict, note, sev)
  if (refused) return { ok: false, message: refused }
  const badKind = tagKind(w, input.kind)
  if (badKind !== null) return { ok: false, message: badKind }
  const verdict = verdictRecord(
    w,
    input.verdict,
    note,
    input.by,
    input.provisional === true,
    verdictSeverity(sev),
  )
  w.verdicts = [...(w.verdicts ?? []), verdict]
  const { next, message } = afterVerdict(id, w, verdict, note, input.retry)
  journal(w, 'verdict', {
    verdict: verdict.verdict,
    notice: note ? firstLine(note) : undefined,
    model: verdict.model,
    effort: verdict.effort,
    kind: w.kind ?? undefined,
    severity: verdict.severity,
    reason: next ? `sent back on ${configLabel(next)}` : undefined,
  })
  changed(w)
  if (input.by !== 'wave' && input.by !== 'check') {
    try {
      settleKeyOfWorker(w, verdict.verdict === 'pass', note)
    } catch {
      // The verdict stands; the key can still be settled with climayte_wave_resolve.
    }
  }
  return { ok: true, message, next }
}

/** How often reconcileWaves reads the wave records (a read of every wave file). */
const WAVE_RECONCILE_MS = 5_000

let nextWaveReconcile = 0

/** Judge one task of a running wave that its finished worker left `running` (reconcileWaves). */
function reconcileWaveTask(id: string, task: CliMayteWave['tasks'][number], now: number): void {
  if (task.state !== 'running' || !task.workerId) return
  const w = workers.get(task.workerId)
  if (!w || w.wave !== id) return
  try {
    if (w.status === 'done') {
      // With a check, only its own latest pass settles the task (a fail sends the worker back).
      const last = w.verdicts?.at(-1)
      if (w.check && !(last?.by === 'check' && last.verdict === 'pass')) return
      judgeInWave(w, w.check ? true : null)
    } else if (w.status === 'failed' || w.status === 'cancelled') {
      const found = liveWave(id)
      const t = found?.wave.tasks.find((x) => x.key === task.key)
      if (!found || !t) return
      t.state = 'failed'
      modifiedWaves.set(id, { wave: found.wave, configDir: found.configDir })
      addToWaveBatch(w, now, true)
    }
  } catch (err) {
    console.error(`[climayte] wave ${id}: could not reconcile ${task.key}:`, err)
  }
}

/** Judge the tasks of a wave its finished workers name; a wave past `running` is settled. */
function reconcileWaveTasks(id: string, now: number): void {
  const wave = reconcilableWave(id, now)?.wave
  if (!wave) return
  if (wave.status !== 'running') {
    settledWaves.add(id)
    return
  }
  for (const task of wave.tasks) reconcileWaveTask(id, task, now)
}

/** A task of a running wave that is `running` while its worker has finished was missed by the
 *  worker's finish (a wave read from the wrong account, a daemon restarted mid-check): judge it now.
 *  A finished worker is judged on its check and commits (judgeInWave), a failed or cancelled one
 *  ends its task `failed`. A pass stays provisional until the orchestrator accepts the wave. */
function reconcileWaves(now: number): void {
  if (now < nextWaveReconcile) return
  nextWaveReconcile = now + WAVE_RECONCILE_MS
  // Most workers never belong to a wave: read no wave file unless a finished one does. A wave seen
  // past `running` never runs again, so it is not read again.
  const ended = [...workers.values()].filter(endedInWave)
  // A manager that ended `done` on its finished wave before settleWorker reported it (an older
  // daemon, a restart between): its wave is reported now (reportForManager).
  for (const m of ended) reconcileManager(m, now)
  const finished = ended.filter((w) => w.kind !== 'manage')
  if (!finished.length) return
  const ids = new Set(finished.map((w) => w.wave as string))
  for (const id of ids) reconcileWaveTasks(id, now)
}

/** Piece 7: write a wave and start its manager; nothing else starts (the manager dispatches).
 *  Throws an Error with the reason when the dispatch is refused. */
export function climayteWaveStart(input: {
  plan: unknown
  cwd: unknown
  tasks: unknown
  verify?: unknown
  branch?: unknown
  maxRounds?: unknown
  /** The climayte_manage caller: the manager worker reports to it. */
  origin?: CliMayteOrigin
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
    origin: input.origin,
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
    waiter: `python ~/.claude/tools/climayte_wait.py --wave ${id} --timeout-s 7200`,
  }
}

/** The attempt a stop kills: a running worker's last; null when the worker is not running. */
const runningAttempt = (w: CliMayteWorker): Attempt | null => {
  const at = w.attempts[w.attempts.length - 1]
  return w.status === 'running' && at ? at : null
}

/** Before a stop: a CLI that finished just now has that turn's result, cost and turns recorded
 *  first (poll). False when that left the worker no longer active, so there is nothing to stop. */
function pollBeforeStop(w: CliMayteWorker): boolean {
  const at = runningAttempt(w)
  if (at && attemptExited(w, at)) {
    try {
      poll(w)
    } catch (err) {
      // One worker's read error must not stop a group cancel; the kill path still runs.
      console.error(`[climayte] could not read ${w.id}:`, err)
    }
    if (!isActive(w)) return false
  }
  return true
}

/** Record an attempt whose CLI was killed (killAttempts) as stopped, with its spend. */
function recordStop(w: CliMayteWorker, at: Attempt, notice: string | null): void {
  at.outcome = 'cancelled'
  at.notice = notice
  at.endedAt = Date.now()
  charge(w, at)
  forgetRead(at.log)
  rmSync(signalPath(w.id), { force: true })
  removeWorkerFiles(w.id)
}

/** End a running worker's attempt now: kill its CLI and record the attempt as stopped, with its
 *  spend. False when the CLI had already finished (that turn is recorded instead, by poll) and the
 *  worker is no longer active. */
function stopRunning(w: CliMayteWorker, notice: string | null): boolean {
  if (!pollBeforeStop(w)) return false
  const at = runningAttempt(w)
  if (at) {
    killAttempts([at])
    recordStop(w, at, notice)
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
  const stopping: { w: CliMayteWorker; at: Attempt | null }[] = []
  for (const w of workers.values()) {
    if (!matches(w, filter) || !isActive(w)) continue
    stopCheck(w)
    if (pollBeforeStop(w)) stopping.push({ w, at: runningAttempt(w) })
  }
  // Every running CLI in one kill (killRunners), not one each: a group of 11 took 15.8 s that way.
  killAttempts(stopping.flatMap((s) => (s.at ? [s.at] : [])))
  for (const { w, at: running } of stopping) {
    try {
      if (running) recordStop(w, running, null)
    } catch (err) {
      // Killed already: the worker is cancelled even when its files could not be tidied, or the next
      // tick would read its dead CLI as interrupted and resume it.
      console.error(`[climayte] ${w.id}: its stop could not be recorded in full:`, err)
    }
    const at = w.attempts[w.attempts.length - 1]
    w.status = 'cancelled'
    w.error = null
    delete w.question
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

/* Idempotent: load the store and start watching. Called at daemon boot. */
/** Settles once startCliMayte's first load has run. The /api/corch routes wait on it, so a request
 *  that lands at boot never does the blocking read of done/ that preloadDone exists to avoid. */
let ready: Promise<void> = Promise.resolve()

export function climayteReady(): Promise<void> {
  return ready
}

export function startCliMayte(): void {
  if (started) return
  started = true
  ready = preloadDone()
    .catch((err) => console.error('[climayte] preloading finished workers failed:', err))
    .then(() => {
      load()
      sweepWorkerFiles()
      startPing()
      schedule(0)
    })
  void ready
    .then(findPackedLogs)
    .catch((err) => console.error('[climayte] looking for packed logs failed:', err))
    .finally(() => {
      packReady = true
      schedule(0)
    })
}

// --- pings to the dispatching chat (climayte-ping.ts; docs/CLIMAYTE.md) ----------------------------
// Owner, 2026-10-03: "when a chat finishes, it pings the orchestrator that started it", and a worker
// limited and moved is reported to that chat too. Every worker carries the chat (or worker) that
// dispatched it as its `origin`; the outbox started here diffs every change and sends the batch.

/** The ping outbox's folder: pings.json, pings-journal.jsonl and the `ping-off` kill switch. */
export const PING_DIR = join(POINTER_DIR, 'climayte')

const PING_OFF = join(PING_DIR, 'ping-off')

let ping: CliMaytePing | null = null

let pingOverrides: Partial<CliMaytePingDeps> | null = null

/** A chat origin naming a CliMayte worker's own session is that worker: a manager (or any worker)
 *  that dispatches work hears of it through climayteSend, not its transcript. */
function originFor(o: CliMayteOrigin | undefined): CliMayteOrigin | undefined {
  if (o?.kind !== 'chat') return o
  for (const w of workers.values())
    if (w.sessionId === o.sessionId || w.sessions?.includes(o.sessionId))
      return { kind: 'worker', workerId: w.id }
  return o
}

/** The composer fallback: a desktop chat whose instance runs, typed into through the daemon's own
 *  message route (which tries the peer pipe first and never types over a live one). */
const composer: NonNullable<CliMaytePingDeps['composer']> = {
  async eligible(o) {
    const { findDesktopChat } = await import('./instance-sessions')
    if (!findDesktopChat(o.sessionId)) return false
    const { desktopHomeFor } = await import('./session-launch')
    const home = await desktopHomeFor(o.sessionId).catch(() => null)
    if (!home) return false
    const { listInstances } = await import('./core/instances')
    const { samePathKey } = await import('./path-key')
    return (await listInstances()).some((i) => samePathKey(i.dir, home) && i.isRunning)
  },
  async send(sessionId, text) {
    const { api, JSON_HEADERS } = await import('./mcp-client')
    try {
      const r = (await api(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ text }),
      })) as { ok?: boolean; detail?: string }
      return { ok: r?.ok === true, reason: r?.detail ?? 'sent' }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  },
}

/** Desk 2's own route for a chat it runs (desk2 plugins/20-engine.ts POST /api/sessions/:id/ping): a
 *  real turn, with a closed chat resumed. 404 or no server there means the chat is not one of its.
 *  Asked on Desk 2's port whether or not Desk 2 sits beside this daemon (desk2.ts): a release exe
 *  runs from its own folder while Desk 2 runs from a checkout, and its chats still need waking. */
const desk: NonNullable<CliMaytePingDeps['desk']> = {
  async send(sessionId, text) {
    const url = desk2Url()
    try {
      const res = await fetch(`${url}/api/sessions/${encodeURIComponent(sessionId)}/ping`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(5_000),
      })
      if (res.status === 404) return { ok: false, reason: 'not a Desk 2 chat', notDesk: true }
      return { ok: res.ok, reason: res.ok ? 'sent' : `desk ${res.status}` }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string }).code ?? ''
      return {
        ok: false,
        reason: why,
        notDesk: /ECONNREFUSED|Unable to connect/i.test(`${why} ${code}`),
      }
    }
  },
}

function startPing(): void {
  if (ping) return
  mkdirSync(PING_DIR, { recursive: true })
  ping = startCliMaytePing({
    dir: PING_DIR,
    workers: () => [...workers.values()],
    subscribe: onCliMayteChange,
    climayteSend: (id, text, opts) => climayteSend(id, text, opts),
    composer,
    desk,
    ...pingOverrides,
  })
}

/** Stop the ping outbox (daemon shutdown). Pending pings stay in pings.json for the next start. */
export function stopCliMaytePing(): void {
  ping?.stop()
  ping = null
}

/** The running outbox, or null before startCliMayte. */
export function climaytePing(): CliMaytePing | null {
  return ping
}

/** Tests only: replace the outbox's transports (null: the real ones). A running outbox is restarted
 *  with them, so no test ever reaches a real chat. */
export function setCliMaytePingDeps(deps: Partial<CliMaytePingDeps> | null): void {
  pingOverrides = deps
  if (!ping && !(started && deps)) return
  stopCliMaytePing()
  startPing()
}

/** Whether a dispatch with a valid origin will be pinged, and why not. */
export function climaytePingState(): { on: true } | { on: false; why: string } {
  if (existsSync(PING_OFF)) return { on: false, why: `pings are switched off (${PING_OFF})` }
  return { on: true }
}

/** Pings no channel delivered to this chat (the last resort), marked read. */
export function climayteUnreadPings(sessionId: string): { count: number; texts: string[] } {
  return ping?.unreadPings(sessionId, { clear: true }) ?? { count: 0, texts: [] }
}

/** The chats with unread pings (none before startCliMayte). */
export function climayteUnreadSessions(): string[] {
  return ping?.unreadSessions() ?? []
}

/** climayte_status {group, ping: true}: the caller becomes the origin of the group's live workers
 *  that have none, so work dispatched before origins existed (or with an untraced caller) is
 *  pinged from now on. A worker already reporting elsewhere keeps its origin. */
export function climayteAdopt(
  group: string,
  origin: CliMayteOrigin,
): { adopted: number; owned: number; live: number; origin: CliMayteOrigin } {
  load()
  const o = originFor(origin) as CliMayteOrigin
  let adopted = 0
  let owned = 0
  let live = 0
  for (const w of workers.values()) {
    if (w.group !== group || !isActive(w)) continue
    live++
    if (w.origin) {
      owned++
      continue
    }
    w.origin = o
    adopted++
  }
  if (adopted) save()
  return { adopted, owned, live, origin: o }
}
