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
// On Windows the runner first puts itself in a kill-on-close job (climayte-job.ts), so what the
// session leaves running (a dev server, a watcher) ends with the runner, and the exit file names it.

import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { containWorker, type Leftover } from './climayte-job'
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
}

/** Written by the runner once the CLI has started. */
export interface RunnerPids {
  runner: number
  child: number
}

/** Written by the runner when the CLI has ended (or could not start: `error`). */
export interface RunnerExit {
  code: number | null
  signal: string | null
  endedAt: number
  error?: string
  /** What the CLI left running, ended when the runner's job closed (Windows). */
  left?: Leftover[]
}

/** The runner mode itself (main.ts `--climayte-runner <spec>`). Returns the process exit code. */
export async function runCliMayteRunner(specPath: string): Promise<number> {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as RunnerSpec
  rmSync(specPath, { force: true })
  const exit = (e: RunnerExit) => writeFileSync(spec.exitFile, JSON.stringify(e))
  const job = containWorker()
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(spec.argv, {
      cwd: spec.cwd,
      env: spec.env,
      stdin: Bun.file(spec.stdin),
      stdout: openSync(spec.stdout, 'a'),
      stderr: openSync(spec.stderr, 'a'),
      windowsHide: true,
    })
  } catch (err) {
    exit({ code: null, signal: null, endedAt: Date.now(), error: String(err) })
    return 1
  }
  writeFileSync(spec.pidFile, JSON.stringify({ runner: process.pid, child: child.pid }))
  await child.exited
  const left = job?.leftovers(process.pid) ?? []
  exit({
    code: child.exitCode,
    signal: child.signalCode ?? null,
    endedAt: Date.now(),
    ...(left.length ? { left } : {}),
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

/** Write the spec and hand the runner to the OS, outside this process's tree and hidden. The pid
 *  arrives in `spec.pidFile` once the runner has started the CLI (readRunnerPids). */
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
