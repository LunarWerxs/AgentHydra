// server/src/climayte-runner-posix.ts — the CliMayte runner on macOS and Linux: this app in
// `--climayte-runner <spec>` mode (main.ts). Windows runs misc/climayte-runner.exe instead; the
// contract both keep (the spec as a single-owner claim, the pid and exit files, the wind-down hook
// answered by the runner) is in climayte-runner.ts.
//
// No job object here: the kill-on-close job, its process ceiling, `left` and `peakProcesses` are
// the Windows runner's.

import { openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { RunnerExit, RunnerPids, RunnerSpec } from './climayte-runner'
import { pointSignalHook, serveSignal } from './climayte-signal'

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
  let text: string
  try {
    text = readFileSync(taken, 'utf8')
  } finally {
    rmSync(taken, { force: true })
  }
  const spec = JSON.parse(text) as RunnerSpec
  // Before anything slow: a stop that lost the claim kills this runner by this pid (killOnStart).
  writeFileSync(spec.pidFile, JSON.stringify({ runner: process.pid } satisfies RunnerPids))
  const exit = (e: RunnerExit) => writeFileSync(spec.exitFile, JSON.stringify(e))
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
    })
  } catch (err) {
    signal?.stop()
    exit({ code: null, signal: null, endedAt: Date.now(), error: String(err) })
    return 1
  }
  writeFileSync(
    spec.pidFile,
    JSON.stringify({ runner: process.pid, child: child.pid } satisfies RunnerPids),
  )
  await child.exited
  signal?.stop()
  exit({ code: child.exitCode, signal: child.signalCode ?? null, endedAt: Date.now() })
  return 0
}
