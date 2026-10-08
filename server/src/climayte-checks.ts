// server/src/climayte-checks.ts — the plumbing of a worker's check command: the shell it runs in,
// its pid and exit files, stopping it, a lost one, the edits it judges and a failure's severity.
// Starting, polling and judging a check stay in climayte.ts. Split from climayte.ts on 2026-10-08;
// nothing here imports it.

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { accountsProvider, changed, runnerSpecPath, voidSpec } from './climayte-core'
import type { CliMayteWorker } from './climayte-lib'
import { readRunnerExit, readRunnerPids } from './climayte-runner'
import {
  confirmedRunners,
  killRunners,
  pidFileFresh,
  RUNNER_CLAIM_GIVE_UP_MS,
  runnerIdentity,
} from './climayte-stops'
import { dirtyFiles, editedFilesOf, failsOnlyOnOthersFiles, unsavedEdits } from './climayte-unsaved'

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
export const MAX_CHECK_FAILS = 3

export const CHECK_TIMEOUT_MS = 20 * 60_000

/** Git's bash on Windows, never the WSL `bash.exe` in System32 that PATH may find first. */
export function checkShell(): string {
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
export const CHECK_RELAUNCHES = 3

export type CheckRunner = NonNullable<CliMayteWorker['checkRunner']>

/** Take the runner pid a check's runner wrote itself (like takeRunnerPids). */
export function takeCheckPid(r: NonNullable<CliMayteWorker['checkRunner']>): void {
  if (r.pid !== null) return
  const pids = readRunnerPids(r.pidFile)
  if (!pids) return
  r.pid = pids.runner
  if (pidFileFresh(r.pidFile)) confirmedRunners.add(pids.runner)
}

/** A check's runner files; its output log is the record and stays. */
export function removeCheckFiles(r: NonNullable<CliMayteWorker['checkRunner']>): void {
  // The spec too, claimed or not: it carries the daemon's environment (background review, 2026-10-02).
  const spec = runnerSpecPath(r.log)
  for (const f of [r.pidFile, r.exitFile, `${r.log}.stdin`, spec, `${spec}.taken`])
    rmSync(f, { force: true })
}

/** Stop a worker's check: kill its runner's tree, or void its spec before the runner claims it.
 *  False while that cannot be done yet (a runner that claimed the spec and wrote no pid, or one not yet
 *  confirmed as ours after a restart): the check stays on record and pollChecks asks again, so a check
 *  never runs on unwatched beside the worker's next turn (review, 2026-10-02). */
export function stopCheck(w: CliMayteWorker): boolean {
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
    killRunners([{ pid: r.pid, log: r.log }])
  }
  removeCheckFiles(r)
  return true
}

/** Stop the earlier rounds' checks set aside by startCheck, dropping each once it is stopped. */
export function stopStaleChecks(w: CliMayteWorker): void {
  if (!w.staleChecks?.length) return
  const left = w.staleChecks.filter((r) => !stopCheckRunner(r))
  if (left.length === w.staleChecks.length) return
  w.staleChecks = left.length ? left : undefined
  changed(w)
}

/** How a check's runner was lost, or null while it may still answer. Asked before the timeout: after
 *  an outage longer than CHECK_TIMEOUT_MS, a check that died with the machine runs again rather than
 *  being judged 'timed out' (a fail) (review, 2026-10-02). */
export function checkLost(r: CheckRunner): 'never started' | 'ended without an exit' | null {
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

/** The worker's changed files git still shows uncommitted (climayte-unsaved.ts); [] when the
 *  accounts or git cannot be read, so a read failure never fails a passing check. */
export function unsavedOf(w: CliMayteWorker): string[] {
  try {
    return unsavedEdits(w, accountsProvider())
  } catch (err) {
    console.error(`[climayte] ${w.id}: its uncommitted files could not be read:`, err)
    return []
  }
}

/** Every file the worker's sessions changed; null when they cannot be read, which reads as unknown
 *  (a failed check then scores as rework, not as someone else's). */
function editedOf(w: CliMayteWorker): string[] | null {
  try {
    return editedFilesOf(w, accountsProvider())
  } catch (err) {
    console.error(`[climayte] ${w.id}: its edited files could not be read:`, err)
    return null
  }
}

/** How bad a failed check was (CliMayteVerdict.severity): 0 when it could not run, timed out, or
 *  failed only on another session's uncommitted files in a shared checkout (failsOnlyOnOthersFiles);
 *  else 2 (rework). `others` says which of those it was. */
export function checkSeverity(
  w: CliMayteWorker,
  code: number | null,
  output: string,
): { severity: 0 | 2; others: boolean } {
  if (code === null || code === 126 || code === 127) return { severity: 0, others: false }
  const edited = editedOf(w)
  const dirty = edited ? dirtyFiles(w.cwd) : null
  const others = !!edited && !!dirty && failsOnlyOnOthersFiles(output, edited, dirty)
  return { severity: others ? 0 : 2, others }
}
