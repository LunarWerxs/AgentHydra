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
 * The flag is ALWAYS present on a successor, `{}` for a primary. That is what lets a successor tell
 * "my predecessor had nothing to hand over" from "my predecessor never handed me anything" and
 * refuse in the second case, rather than guess the machine store.
 *
 * Imports no config, on purpose: this runs (relaunch-identity-boot.ts, the first import of
 * index.ts) before config.ts resolves the store from the environment.
 */
import { buildRelaunchArgv } from './relaunch-argv.mjs'
import { isRelaunchSuccessor, RELAUNCH_FLAG } from './single-instance'

/** `--handoff-env <json>`: the identity variables of the predecessor, a JSON object of strings. */
export const HANDOFF_FLAG = '--handoff-env'

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
  'ZSWARM_HOME',
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
    if (argv[i] === HANDOFF_FLAG) {
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
 * successor: nothing to do. A successor with no handoff, or one that cannot be read, is refused:
 * starting anyway would fall back to the machine's real store, which is exactly the damage above.
 */
export function applyRelaunchIdentity(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): IdentityResult {
  if (!isRelaunchSuccessor(env, argv)) return { ok: true, applied: 0 }
  const at = argv.indexOf(HANDOFF_FLAG)
  if (at === -1 || argv[at + 1] === undefined)
    return {
      ok: false,
      reason: `relaunch successor started without its predecessor's identity (${HANDOFF_FLAG})`,
    }
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
}): string[] {
  const relaunchArgv = buildRelaunchArgv(withoutHandoff(opts.argv), {
    execPath: opts.execPath,
    isCompiled: opts.isCompiled,
    boundPort: opts.boundPort,
    relaunchFlag: RELAUNCH_FLAG,
  }) as string[]
  return [...relaunchArgv, ...handoffArgs(opts.env)]
}
