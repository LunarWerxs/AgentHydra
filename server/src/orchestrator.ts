/**
 * The orchestrator, driven from inside the daemon.
 *
 * WHAT IT IS. `orchestrator/` (a sibling of server/ and web/) is the Python toolbox that decides
 * what SHOULD happen to a chat: the dry loop, the sweep's lanes, moving chats between accounts,
 * archiving, naming, the tray-icon switch. It talks to this daemon over HTTP and owns no state the
 * daemon owns. Until 2026-09-03 it was a separate repository that an agent had to be TOLD about
 * ("you have to use both") - the owner's order that day was to fold it in, so one MCP surface
 * covers the whole fleet. This module is the seam: the daemon runs `python orch.py <script>` on the
 * caller's behalf and hands back what it printed. The rules stay where they are - in the scripts
 * (nothing acts without the tray icon; `--force` is a person's word; every act is verified) - so
 * driving them from here cannot bypass anything a hand-typed `python orch.py` could not.
 *
 * WHAT IT DELIBERATELY IS NOT. Not a rewrite of the toolbox in TypeScript (v2 was exactly that, and
 * was retired for acting on chats that were not finished - orchestrator/README.md tells that story),
 * and not a shell: the script name is validated against the menu grammar and the arguments go to
 * the process as an argv array, never through a shell, so there is nothing to inject.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ROOT } from './config'

/** Where the toolbox lives. `AGENTHYDRA_ORCHESTRATOR_DIR` overrides for a layout where the Python
 *  tree sits somewhere else (a compiled binary with the tree copied beside it, or a developer
 *  pointing at a second checkout); the default is the sibling folder in this repo / this release. */
export function orchestratorDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENTHYDRA_ORCHESTRATOR_DIR?.trim()
  return override || join(APP_ROOT, 'orchestrator')
}

/** The interpreter. `python` is what the toolbox's own docs and both owner machines use on Windows;
 *  Debian-family Linux and macOS ship only `python3`. `AGENTHYDRA_PYTHON` names a specific binary. */
export function pythonBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  const override = env.AGENTHYDRA_PYTHON?.trim()
  if (override) return override
  return platform === 'win32' ? 'python' : 'python3'
}

/** A menu name: `chats`, `migrate_chat`, `loop`, `armed`. orch.py resolves it to scripts/<name>.py
 *  or to one of its own driver words; anything else is refused HERE, before a process exists. */
const SCRIPT_NAME = /^[a-z][a-z0-9_]{0,63}$/
const MAX_ARGS = 64
const MAX_ARG_LENGTH = 4000
export const DEFAULT_TIMEOUT_MS = 10 * 60_000
export const MAX_TIMEOUT_MS = 60 * 60_000
/** Output kept per stream. The dry loop over a full fleet is a few thousand lines; a runaway is
 *  truncated from the FRONT so the verdict lines at the end survive. */
const MAX_OUTPUT_CHARS = 200_000

export interface OrchestratorInvocation {
  script: string
  args: string[]
  timeoutMs: number
}

export type InvocationCheck =
  | { ok: true; invocation: OrchestratorInvocation }
  | { ok: false; error: string }

/** Pure. Shapes the caller's request into an argv the driver accepts, or says exactly why not. */
export function validateInvocation(input: {
  script?: unknown
  args?: unknown
  timeoutMs?: unknown
}): InvocationCheck {
  const script = typeof input.script === 'string' ? input.script.trim() : ''
  if (!script)
    return {
      ok: false,
      error: 'script is required (a menu name such as `chats`, `loop` or `armed`)',
    }
  if (!SCRIPT_NAME.test(script))
    return {
      ok: false,
      error: `script ${JSON.stringify(script)} is not a menu name (lowercase letters, digits, underscores)`,
    }
  const rawArgs = input.args == null ? [] : input.args
  if (!Array.isArray(rawArgs)) return { ok: false, error: 'args must be an array of strings' }
  if (rawArgs.length > MAX_ARGS)
    return { ok: false, error: `too many args (${rawArgs.length} > ${MAX_ARGS})` }
  const args: string[] = []
  for (const a of rawArgs) {
    if (typeof a !== 'string') return { ok: false, error: 'every arg must be a string' }
    if (a.length > MAX_ARG_LENGTH)
      return { ok: false, error: `an arg is longer than ${MAX_ARG_LENGTH} characters` }
    if (a.includes('\0')) return { ok: false, error: 'an arg contains a NUL byte' }
    args.push(a)
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (input.timeoutMs != null) {
    const n = Number(input.timeoutMs)
    if (!Number.isFinite(n) || n <= 0)
      return { ok: false, error: 'timeoutMs must be a positive number' }
    timeoutMs = Math.min(Math.floor(n), MAX_TIMEOUT_MS)
  }
  return { ok: true, invocation: { script, args, timeoutMs } }
}

/** What orch.py's exit codes mean, verbatim from its docstring, so a caller reads a verdict and not
 *  a number. A script's OWN codes (migrate_chat's 4 = live writer, 6 = held, ...) are in that
 *  script's `--help`; the driver passes them through unchanged. */
export const DRIVER_EXIT_MEANINGS: Readonly<Record<number, string>> = Object.freeze({
  0: 'ok',
  1: 'daemon failure',
  2: 'the loop found something that failed',
  3: 'unknown script, deterministic refusal, or not armed (nothing acts without the tray icon)',
})

export interface OrchestratorRun {
  ok: boolean
  script: string
  args: string[]
  command: string[]
  cwd: string
  exitCode: number | null
  exitMeaning: string | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
}

export interface OrchestratorStatus {
  dir: string
  present: boolean
  python: string
  pythonVersion: string | null
  /** The driver's own menu (`python orch.py` with no arguments), when the tree is present and
   *  python answers - the one place every script and what it does is listed. */
  menu: string | null
  error: string | null
}

function tail(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `…[truncated ${text.length - MAX_OUTPUT_CHARS} chars]\n${text.slice(-MAX_OUTPUT_CHARS)}`
    : text
}

/** One spawn, captured, with a deadline. Exposed for tests through `deps`; the real thing is
 *  Bun.spawn with windowsHide (python is a console program - see scripts/checks/spawn-console-window.mjs). */
export interface SpawnDeps {
  spawn?: (
    command: string[],
    cwd: string,
    timeoutMs: number,
  ) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>
}

async function realSpawn(command: string[], cwd: string, timeoutMs: number) {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    windowsHide: true,
  })
  let timedOut = false
  const killer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }, timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(killer)
  return { code, stdout, stderr, timedOut }
}

/** Run one script by its menu name. The driver's cwd is the toolbox root, exactly as a person
 *  typing `python orch.py <script>` there, so state/, the tray heartbeat and the ledgers resolve
 *  to the same files a hand-run would use. */
export async function runOrchestrator(
  input: { script?: unknown; args?: unknown; timeoutMs?: unknown },
  deps: SpawnDeps & { dir?: string; python?: string } = {},
): Promise<OrchestratorRun | { ok: false; error: string }> {
  const check = validateInvocation(input)
  if (!check.ok) return { ok: false, error: check.error }
  const { script, args, timeoutMs } = check.invocation
  const dir = deps.dir ?? orchestratorDir()
  const driver = join(dir, 'orch.py')
  if (!existsSync(driver))
    return {
      ok: false,
      error: `the orchestrator is not at ${dir} (no orch.py). It ships in this repo as orchestrator/; set AGENTHYDRA_ORCHESTRATOR_DIR if it lives elsewhere.`,
    }
  const command = [deps.python ?? pythonBinary(), 'orch.py', script, ...args]
  const spawn = deps.spawn ?? realSpawn
  const started = Date.now()
  try {
    const r = await spawn(command, dir, timeoutMs)
    return {
      ok: r.code === 0 && !r.timedOut,
      script,
      args,
      command,
      cwd: dir,
      exitCode: r.code,
      exitMeaning: r.code == null ? null : (DRIVER_EXIT_MEANINGS[r.code] ?? null),
      timedOut: r.timedOut,
      durationMs: Date.now() - started,
      stdout: tail(r.stdout),
      stderr: tail(r.stderr),
    }
  } catch (e) {
    return {
      ok: false,
      error: `could not start ${command[0]}: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/** Is the toolbox there and does python answer - and if so, the menu. Read-only. */
export async function orchestratorStatus(
  deps: SpawnDeps & { dir?: string; python?: string } = {},
): Promise<OrchestratorStatus> {
  const dir = deps.dir ?? orchestratorDir()
  const python = deps.python ?? pythonBinary()
  const present = existsSync(join(dir, 'orch.py'))
  const spawn = deps.spawn ?? realSpawn
  let pythonVersion: string | null = null
  let error: string | null = present ? null : `no orch.py under ${dir}`
  try {
    const v = await spawn([python, '--version'], present ? dir : APP_ROOT, 15_000)
    pythonVersion = v.code === 0 ? `${v.stdout}${v.stderr}`.trim() || null : null
    if (v.code !== 0)
      error = error ?? `${python} --version exited ${v.code}: ${`${v.stderr}${v.stdout}`.trim()}`
  } catch (e) {
    error = error ?? `${python} is not runnable: ${e instanceof Error ? e.message : String(e)}`
  }
  let menu: string | null = null
  if (present && pythonVersion) {
    try {
      const m = await spawn([python, 'orch.py'], dir, 60_000)
      menu = m.code === 0 ? m.stdout.trim() : null
      if (m.code !== 0) error = error ?? `orch.py menu exited ${m.code}: ${m.stderr.trim()}`
    } catch (e) {
      error = error ?? (e instanceof Error ? e.message : String(e))
    }
  }
  return { dir, present, python, pythonVersion, menu, error }
}
