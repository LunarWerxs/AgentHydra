// server/src/climayte-runner.ts — the process a CliMayte worker's CLI runs under, OUTSIDE the daemon.
//
// Owner, 2026-09-30: "I need to be able to restart AgentHydra without breaking CliMayte runners." A
// Bun.spawn child sits in the daemon's kill-on-close job on Windows, so every daemon restart killed
// every worker, which then resumed as 'interrupted' and redid its current step. `detached` is no
// escape (DETACHED_PROCESS flashes a console per child, and the job still holds it).
//
// So a worker's CLI runs under a RUNNER: this same program in `--climayte-runner <spec>` mode,
// launched through the WMI hand-off (detached-spawn.mjs, hidden), which is born outside the
// daemon's tree. The runner starts the CLI with the attempt's prompt, log and error files as its
// stdin/stdout/stderr, writes both pids, waits, and writes an exit file. The daemon only ever reads
// files: the log it already tails, the pid file, and the exit file for the end. A restarted daemon
// therefore finds its running workers still running and simply goes on reading them.
//
// The spec carries the CLI's environment (WMI starts the runner with the user's default one, not
// the daemon's), so the runner deletes it the moment it has read it.
//
// The spec is also a single-owner claim. The runner takes it by renaming it to `.taken` before
// reading; the daemon voids an attempt that has not started by renaming it to `.void` (voidSpec in
// climayte-core.ts). Exactly one rename wins, so a cancel either stops the attempt before anything
// starts or knows the runner has it. Measured 2026-10-02: the WMI hand-off takes 0.4-2.2 s to reach
// this point, and three cancels 87-209 ms after launch each found no pid file, marked the attempt
// stopped and left the runner to run the CLI to completion ($0.145-0.150 and ~30k cache-write tokens
// each, charged to nothing).
//
// On Windows the runner first puts itself in a kill-on-close job (climayte-job.ts), so what the
// session leaves running (a dev server, a watcher) ends with the runner, and the exit file names it.

import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { containWorker, type Leftover } from './climayte-job'
import { pointSignalHook, serveSignal } from './climayte-signal'
import { buildDetachedSpawn } from './detached-spawn.mjs'

/** config.ts's own test, repeated so the runner process imports nothing of the daemon's: a source
 *  checkout has config.ts beside this file, a compiled exe does not. */
const IS_COMPILED = !existsSync(join(import.meta.dir, 'config.ts'))

export interface RunnerSpec {
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin: string
  stdout: string
  stderr: string
  pidFile: string
  exitFile: string
  /** The output files are new (a check's log): open them for writing, one handle when stdout and
   *  stderr are the same file. Git Bash cannot write through an append-only handle: its output
   *  vanished and `sleep` exited 1 (measured 2026-10-02), where the CLI appends to its logs fine. */
  fresh?: boolean
  /** A worker's wind-down channel (climayte-signal.ts): the runner answers the CLI's PostToolUse
   *  hook from `file` itself, and rewrites the `settings` file the CLI was given to say so before
   *  it starts the CLI. Absent for a check's log, which has no hooks. */
  signal?: { file: string; settings: string }
  /** The most processes the worker's tree may have alive at once, the runner included (Windows job
   *  ceiling, climayte-job.ts). Absent: no ceiling, as for a check's log. */
  maxProcesses?: number
}

/** Written by the runner the moment it has claimed the spec (`runner` only), then again once the CLI
 *  has started (with `child`), so the daemon can tell a runner still starting from a dead one. */
export interface RunnerPids {
  runner: number
  child?: number
}

/** Written by the runner when the CLI has ended (or could not start: `error`). */
export interface RunnerExit {
  code: number | null
  signal: string | null
  endedAt: number
  error?: string
  /** What the CLI left running, ended when the runner's job closed (Windows). */
  left?: Leftover[]
  /** The most processes the worker's tree had alive at once, the runner included (Windows, read
   *  every 2 s): what one worker really costs, and how close it came to its ceiling. */
  peakProcesses?: number
}

/** The runner mode itself (main.ts `--climayte-runner <spec>`). Returns the process exit code. */
export async function runCliMayteRunner(specPath: string): Promise<number> {
  const taken = `${specPath}.taken`
  try {
    renameSync(specPath, taken)
  } catch (err) {
    // The daemon voided it first (a cancel or an urgent message before this runner got here): the
    // attempt is over, so nothing starts and nothing is written.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
  const spec = JSON.parse(readFileSync(taken, 'utf8')) as RunnerSpec
  rmSync(taken, { force: true })
  // Before anything slow: a stop that lost the claim kills this runner by this pid (killOnStart).
  writeFileSync(spec.pidFile, JSON.stringify({ runner: process.pid } satisfies RunnerPids))
  const exit = (e: RunnerExit) => writeFileSync(spec.exitFile, JSON.stringify(e))
  const job = containWorker(spec.maxProcesses)
  let peak = 0
  const watchPeak = (): void => {
    const n = job?.active() ?? -1
    if (n > peak) peak = n
  }
  const peaking = job ? setInterval(watchPeak, 2_000) : null
  // The wind-down hook answered from here (no process per tool call). Only once the settings say so;
  // if they cannot be rewritten the CLI keeps the shell form the daemon wrote, and no port is held.
  let signal = spec.signal ? serveSignal(spec.signal.file) : null
  if (signal && spec.signal && !pointSignalHook(spec.signal.settings, signal.port)) {
    signal.stop()
    signal = null
  }
  let child: ReturnType<typeof Bun.spawn>
  try {
    const mode = spec.fresh ? 'w' : 'a'
    const out = openSync(spec.stdout, mode)
    child = Bun.spawn(spec.argv, {
      cwd: spec.cwd,
      env: spec.env,
      stdin: Bun.file(spec.stdin),
      stdout: out,
      stderr: spec.fresh && spec.stderr === spec.stdout ? out : openSync(spec.stderr, mode),
      windowsHide: true,
    })
  } catch (err) {
    signal?.stop()
    if (peaking) clearInterval(peaking)
    exit({ code: null, signal: null, endedAt: Date.now(), error: String(err) })
    return 1
  }
  writeFileSync(
    spec.pidFile,
    JSON.stringify({ runner: process.pid, child: child.pid } satisfies RunnerPids),
  )
  watchPeak()
  await child.exited
  signal?.stop()
  if (peaking) clearInterval(peaking)
  const left = job?.leftovers(process.pid) ?? []
  exit({
    code: child.exitCode,
    signal: child.signalCode ?? null,
    endedAt: Date.now(),
    ...(left.length ? { left } : {}),
    ...(peak > 0 ? { peakProcesses: peak } : {}),
  })
  // Returning ends this process, which closes the job: everything in `left` ends with it.
  return 0
}

/** How this program starts itself in runner mode: the compiled exe takes the flag directly; a
 *  source run goes through main.ts, the entry that dispatches modes. */
export function runnerArgv(specPath: string): string[] {
  return IS_COMPILED
    ? [process.execPath, '--climayte-runner', specPath]
    : [process.execPath, join(import.meta.dir, 'main.ts'), '--climayte-runner', specPath]
}

/** Write the spec and hand the runner to the OS, outside this process's tree and hidden. The pids
 *  arrive in `spec.pidFile`: the runner's once it has claimed the spec, the CLI's once it has started
 *  (readRunnerPids). */
export function launchRunner(spec: RunnerSpec, specPath: string): void {
  writeFileSync(specPath, JSON.stringify(spec))
  const { argv, detached } = buildDetachedSpawn(process.platform, runnerArgv(specPath), {
    hideWindow: true,
  })
  const handoff = spawn(argv[0] as string, argv.slice(1), {
    detached,
    stdio: 'ignore',
    windowsHide: true,
  })
  handoff.unref()
}

const readJson = <T>(path: string): T | null => {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null
  } catch {
    return null
  }
}

export const readRunnerPids = (pidFile: string): RunnerPids | null => readJson<RunnerPids>(pidFile)
export const readRunnerExit = (exitFile: string): RunnerExit | null =>
  readJson<RunnerExit>(exitFile)
