/**
 * A relaunch successor keeps its predecessor's IDENTITY: which store, home and config files it runs on.
 *
 * 2026-10-03 09:24Z: a relaunch of a scratch side-run (port 7801) came up on the machine's REAL
 * store. The successor is launched through buildDetachedSpawn (WMI on Windows), WMI does not carry
 * the environment block, and only the port and the relaunch flag rode as argv flags. So the
 * successor had none of AGENTHYDRA_HOME / _DATA_DIR / _DB: it opened the live database, took the
 * machine-wide runtime.json pointer, could not get 7801, hopped to 7802 and ran as a second
 * supervisor of the live CliMayte store next to the primary.
 *
 * Why FLAGS and not a handoff file in POINTER_DIR: a side-run's POINTER_DIR is its DATA_DIR, which
 * is one of the very things the successor does not know yet. A file there is unreadable before
 * config resolves, and one in the machine-wide dir is how the wrong store gets picked. A flag on
 * the command line is the one channel WMI already carries (the port and the relaunch flag use it).
 *
 * A daemon on this code always passes the flag to its successor, `{}` for a primary. An ABSENT flag
 * therefore means the predecessor predates the handoff (every installed daemon older than the
 * handoff spawns its successor without it), and such a successor must still start, exactly as it
 * did before the handoff existed: refusing it (commit 1a239fb) meant no installed daemon could
 * ever relaunch onto the new code. Only a flag that is PRESENT but unreadable is refused.
 *
 * Imports no config, on purpose: this runs (relaunch-identity-boot.ts, the first import of
 * index.ts) before config.ts resolves the store from the environment.
 */
import { buildRelaunchArgv } from './relaunch-argv.mjs'
import { isRelaunchSuccessor, RELAUNCH_FLAG } from './single-instance'

/** `--handoff-env <json>`: the identity variables of the predecessor, a JSON object of strings. */
export const HANDOFF_FLAG = '--handoff-env'

/** `--from-pid <pid>`: the pid of the daemon that spawned this successor (its predecessor). */
export const FROM_PID_FLAG = '--from-pid'

/** Suffixes of the variables that say where state lives or how this daemon is wired to the
 *  machine. An allowlist, not "every AGENTHYDRA_*": a command line is readable by any local
 *  process, and AGENTHYDRA_SHUTDOWN_TOKEN is a secret. Each is read as AGENTHYDRA_* and as its
 *  pre-rename CCMANAGERUI_* spelling (config.ts appEnv). */
const IDENTITY_SUFFIXES = [
  'HOME',
  'DATA_DIR',
  'DB',
  'RUN_LOG_DIR',
  'INSTANCES_ROOT',
  'PORT_FIXED',
  'MCP_CONFIG',
  'NO_OPEN',
  'HOOKS_CONFIG',
  'CLAUDE_PROJECTS_ROOT',
  'CODEX_HOME',
  'DSH_HOME',
  'OPENCODE_DB',
]
const IDENTITY_KEYS = new Set(
  IDENTITY_SUFFIXES.flatMap((s) => [`AGENTHYDRA_${s}`, `CCMANAGERUI_${s}`]),
)

/** The identity this process was started with (the allowlisted variables that are set). */
export function relaunchIdentity(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of IDENTITY_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

/** `argv` without any inherited handoff flag, so a successor's argv is a fixed point across
 *  generations (the flag is re-appended from the live environment, never accumulated). */
export function withoutHandoff(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === HANDOFF_FLAG || argv[i] === FROM_PID_FLAG) {
      i++
      continue
    }
    out.push(argv[i] as string)
  }
  return out
}

/** The flag pair a successor's argv carries: this daemon's identity, `{}` for a primary. */
export function handoffArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [HANDOFF_FLAG, JSON.stringify(relaunchIdentity(env))]
}

export type IdentityResult = { ok: true; applied: number } | { ok: false; reason: string }

/**
 * Successor side, before config resolves: put the predecessor's identity into `env`. Not a
 * successor: nothing to do. A successor with no handoff flag comes from a predecessor that predates
 * the handoff: nothing is applied and it starts as it always did. A flag that is present but
 * cannot be read (not JSON, not an object, no value) is refused: starting anyway would guess the
 * machine's real store, which is exactly the damage above.
 */
export function applyRelaunchIdentity(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): IdentityResult {
  if (!isRelaunchSuccessor(env, argv)) return { ok: true, applied: 0 }
  const at = argv.indexOf(HANDOFF_FLAG)
  if (at === -1) return { ok: true, applied: 0 }
  if (argv[at + 1] === undefined) return { ok: false, reason: `${HANDOFF_FLAG} has no value` }
  let parsed: unknown
  try {
    parsed = JSON.parse(argv[at + 1] as string)
  } catch {
    return { ok: false, reason: `${HANDOFF_FLAG} is not valid JSON` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return { ok: false, reason: `${HANDOFF_FLAG} is not a JSON object` }
  let applied = 0
  for (const [key, value] of Object.entries(parsed)) {
    if (!IDENTITY_KEYS.has(key) || typeof value !== 'string') continue
    env[key] = value
    applied++
  }
  return { ok: true, applied }
}

/**
 * The full argv of a relaunch successor: the shared kit's relaunch argv (runtime, script, user
 * flags, the port actually served, the relaunch flag) plus this daemon's identity. The identity is
 * appended here, outside buildRelaunchArgv, because that builder is synced from a kit and is not
 * edited in an app.
 */
export function planRelaunchSuccessor(opts: {
  argv: readonly string[]
  execPath: string
  isCompiled: boolean
  boundPort: number
  env?: NodeJS.ProcessEnv
  /** This daemon's pid; the successor checks the store's owner against it. */
  selfPid?: number
}): string[] {
  const relaunchArgv = buildRelaunchArgv(withoutHandoff(opts.argv), {
    execPath: opts.execPath,
    isCompiled: opts.isCompiled,
    boundPort: opts.boundPort,
    relaunchFlag: RELAUNCH_FLAG,
  }) as string[]
  return [
    ...relaunchArgv,
    FROM_PID_FLAG,
    String(opts.selfPid ?? process.pid),
    ...handoffArgs(opts.env),
  ]
}

/** The value of a numeric flag in `argv`, or undefined when absent or not a positive integer. */
export function numericFlag(argv: readonly string[], flag: string): number | undefined {
  const at = argv.indexOf(flag)
  const n = at === -1 ? Number.NaN : Number(argv[at + 1])
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * Successor side, before it reports in, binds a port or writes anything: is the store it opened
 * owned by a live daemon that is NOT its predecessor? 2026-10-03 12:47: a side-run's successor lost
 * its environment (WMI), opened the machine's live store and ran 30 minutes as a second supervisor
 * of the live daemon's CliMayte workers (docs/CLIMAYTE-FIELD-NOTES.md note 74).
 *
 * `owner` is what the pointer names and /api/health confirmed (null: no pointer, or nothing answers
 * as this service, so nobody owns the store and the start goes on). The predecessor is known by
 * `--from-pid`; an older predecessor does not pass it, so the port it was told to serve (`--port`)
 * stands in: an upgrade relaunch keeps the pointer's port, a stray from another daemon does not.
 * Returns the refusal line, or null to start.
 */
export function relaunchRefusal(opts: {
  argv: readonly string[]
  selfPid: number
  owner: { pid: number; port: number } | null
}): string | null {
  const { argv, owner } = opts
  if (!owner || owner.pid === opts.selfPid) return null
  const fromPid = numericFlag(argv, FROM_PID_FLAG)
  const ownPort = numericFlag(argv, '--port')
  if (
    fromPid !== undefined ? owner.pid === fromPid : ownPort === undefined || owner.port === ownPort
  )
    return null
  const from =
    fromPid !== undefined
      ? `a relaunch from pid ${fromPid}`
      : `a relaunch from the daemon on ${ownPort}`
  return `relaunch refused: this store belongs to the daemon on ${owner.port} (pid ${owner.pid}); ${from} would run a second supervisor`
}
