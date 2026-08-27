// server/src/core/self-identity.ts — "WHICH instance am I?", answered from inside the agent's own
// process tree instead of from a single env var.
//
// THE BUG THIS EXISTS TO FIX (observed 2026-08-13, a real session that burned a Pro 5-hour window):
// `whoami` used to read ONLY `CLAUDE_CONFIG_DIR`, fall back to the default `~/.claude`, and report
// `instance: null`. That is correct for a CLI instance and WRONG for every Claude Desktop session,
// because a Desktop instance does not set `CLAUDE_CONFIG_DIR` at all — it is selected by the
// Electron host's `--user-data-dir`. The agent therefore reported the DEFAULT login while actually
// spending a completely different account's quota, and every one of its own attempts to check
// itself pointed at the wrong meter.
//
// THREE TRAPS THIS MODULE IS BUILT AROUND, all verified on a live session:
//
//  1. THE TRANSCRIPT PATH LIES. A Desktop-instance session still writes its transcript to the
//     DEFAULT `~/.claude/projects/<cwd-key>/<sessionId>.jsonl`. So "find my own transcript" proves
//     where the session logs, NOT which account pays. Do not identify by transcript location.
//  2. `~/.claude.json`'s `oauthAccount.emailAddress` LIES. It is the default login sitting on the
//     machine, not the credential the running session bills to. It looks authoritative and is not.
//  3. AN MCP SERVER GETS A REDUCED ENV. A stdio MCP server spawned by Claude Code sees
//     `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_HOST_SESSION_ID`, but NOT
//     `CLAUDE_CODE_EXECPATH` (which the Bash tool's child processes DO get). So a detector that only
//     reads env vars works when tested from a shell and silently fails where it actually runs.
//
// So identification is LAYERED, cheapest and most certain first, and every layer records the
// literal thing it observed (`proof`) so a human can audit the claim instead of trusting it:
//
//   codex-home-env          CODEX_HOME              — a Codex instance names its own home
//   claude-config-dir-env   CLAUDE_CONFIG_DIR       — a CLI instance names its own config dir
//   execpath-env            CLAUDE_CODE_EXECPATH    — <instanceDir>/claude-code/<ver>/claude.exe
//   host-session-file       CLAUDE_CODE_HOST_SESSION_ID → <instanceDir>/claude-code-sessions/**/<id>.json
//   ancestor-execpath       the parent claude.exe's image path (same shape as execpath-env)
//   ancestor-user-data-dir  the grandparent Electron host's `--user-data-dir=<instanceDir>`
//   default-login           nothing matched → the plain ~/.claude login, flagged ASSUMED
//
// The last one is deliberately NOT called "exact". "I could not tell" and "it is the default login"
// are different answers, and collapsing them is precisely how the original bug reported a confident
// wrong number.

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { claudeUserDataDir, instancesRoot, normalizeInstancePath } from './paths'

/** How an identity was established. Ordered from most to least certain — see the module header. */
export type SelfIdentityMethod =
  | 'codex-home-env'
  | 'claude-config-dir-env'
  | 'execpath-env'
  | 'host-session-file'
  | 'ancestor-execpath'
  | 'ancestor-user-data-dir'
  | 'default-login'

/** Which credential family the detected directory belongs to. */
export type SelfIdentityKind = 'desktop' | 'cli' | 'codex' | 'default-login'

/** One signal that resolved to a directory, with the literal observation that produced it. */
export interface SelfIdentityClue {
  method: SelfIdentityMethod
  kind: SelfIdentityKind
  /** The credential directory this signal points at (desktop user-data dir / CLAUDE_CONFIG_DIR /
   *  CODEX_HOME). */
  configDir: string
  /** The raw evidence — an env value, an executable path, a pid + command line. Printed back to the
   *  caller so the identification can be CHECKED rather than believed. */
  proof: string
}

export interface SelfIdentityDetection {
  /** The winning directory, or null when nothing at all could be established. */
  configDir: string | null
  kind: SelfIdentityKind | 'unknown'
  method: SelfIdentityMethod | null
  /**
   * `exact`   — a signal that names the credential store directly. Act on it.
   * `assumed` — nothing named it; this is the default login by elimination. State the assumption.
   * `none`    — not running under Claude Code at all, or every signal failed.
   */
  confidence: 'exact' | 'assumed' | 'none'
  /** Every signal that resolved, winner first. More than one is a good sign; see `conflict`. */
  clues: SelfIdentityClue[]
  /** Signals that were checked and produced nothing, with why. This is what makes a failed
   *  detection debuggable instead of a shrug. */
  ruledOut: string[]
  /** True when two independent signals named DIFFERENT directories. The winner is still returned
   *  (highest-priority signal), but a caller about to spend quota should say so out loud. */
  conflict: boolean
}

/** Injection seams. Every one defaults to the real thing; tests pass fakes and touch no disk. */
export interface SelfIdentityDeps {
  env?: Record<string, string | undefined>
  /** Does this path exist? */
  exists?: (p: string) => boolean
  /** Directory entry names, or null when unreadable. */
  readDir?: (p: string) => string[] | null
  /** Ancestor process chain, nearest parent first. Null when it cannot be enumerated. */
  ancestry?: () => Promise<AncestorProcess[] | null>
  /** `~/.claude-instances`. */
  instancesRoot?: () => string
  /** The default (non-isolated) Claude Desktop user-data dir. */
  defaultUserDataDir?: () => string
  /** The default `claude` CLI login dir (`~/.claude`). */
  defaultConfigDir?: () => string
}

/** One ancestor process, as {@link processAncestry} reports it. */
export interface AncestorProcess {
  pid: number
  name: string | null
  executablePath: string | null
  commandLine: string | null
}

/** Where a plain `claude` login (no CLAUDE_CONFIG_DIR override) keeps its credentials. */
export const defaultClaudeConfigDir = (): string => join(homedir(), '.claude')

/**
 * `--user-data-dir` as it can appear in a reported command line. Duplicated from core/process.ts's
 * USER_DATA_DIR_RE on purpose: that module owns the *scan* of every running Claude process and
 * pulls in a scan cache with it, while this one must stay importable from the MCP server's cold
 * start. Both are covered by their own tests, and the three quoting forms are a stable Windows
 * fact, not a moving target.
 */
const USER_DATA_DIR_RE =
  /"--user-data-dir[= ]([^"]+)"|--user-data-dir[= ]"([^"]+)"|--user-data-dir[= ]([^"\s]+)/

/** The `--user-data-dir` value in a command line, or null. Handles all three Windows quotings. */
export function userDataDirFromCommandLine(cmdline: string): string | null {
  const m = cmdline.match(USER_DATA_DIR_RE)
  if (!m) return null
  const raw = (m[1] ?? m[2] ?? m[3])?.trim()
  return raw && raw.length > 0 ? raw : null
}

/**
 * The instance directory that owns a claude-code agent binary.
 *
 * Claude Desktop unpacks the agent under its OWN user-data dir:
 *   <userDataDir>/claude-code/<version>/claude.exe
 * so the directory above the `claude-code` segment IS the instance. This holds for isolated
 * instances (`~/.claude-instances/<name>`) and for the default install (`%APPDATA%/Claude`) alike.
 *
 * Returns null for any path with no `claude-code` segment — a globally-installed `claude` on PATH
 * is not an instance and must not be guessed into one.
 */
export function userDataDirFromAgentExe(exePath: string): string | null {
  if (!exePath?.trim()) return null
  const parts = exePath.split(/[\\/]/)
  const idx = parts.map((p) => p.toLowerCase()).lastIndexOf('claude-code')
  if (idx <= 0) return null
  const dir = parts.slice(0, idx).join(sep)
  return dir.trim() ? dir : null
}

/** A Claude Desktop user-data dir always carries one of these at its root. Used to reject a path
 *  that merely *looks* right (a stale/renamed folder) before reporting it as an identity. */
export function looksLikeUserDataDir(dir: string, exists: (p: string) => boolean): boolean {
  return exists(join(dir, 'config.json')) || exists(join(dir, 'Local State'))
}

/** Bounded recursive search for `<name>` under `<root>`. Depth- AND visit-capped so a pathological
 *  tree can never turn an identity check into a filesystem walk. */
function findFileUnder(
  root: string,
  name: string,
  readDir: (p: string) => string[] | null,
  exists: (p: string) => boolean,
  maxDepth = 3,
  budget = { visits: 2_000 },
): string | null {
  if (maxDepth < 0 || budget.visits <= 0) return null
  const direct = join(root, name)
  if (exists(direct)) return direct
  const entries = readDir(root)
  if (!entries) return null
  for (const entry of entries) {
    if (budget.visits-- <= 0) return null
    if (entry === name) return join(root, entry)
    const child = join(root, entry)
    // Only descend into things that read as directories; readDir returning null is our "not a
    // directory (or unreadable)" signal, which keeps this free of an extra stat per entry.
    const hit = findFileUnder(child, name, readDir, exists, maxDepth - 1, budget)
    if (hit) return hit
  }
  return null
}

/** Every candidate desktop user-data dir on this machine: each isolated instance, plus the default
 *  install. Never throws — an unreadable instances root just yields the default. */
function candidateUserDataDirs(
  deps: Required<Pick<SelfIdentityDeps, 'readDir'>>,
  root: string,
  fallback: string,
): string[] {
  const dirs: string[] = []
  const entries = deps.readDir(root)
  if (entries) for (const e of entries) dirs.push(join(root, e))
  dirs.push(fallback)
  return dirs
}

interface EnvSignalResult {
  clue: SelfIdentityClue | null
  ruledOut: string
}

/** Stage 1 — CODEX_HOME names its own home outright. */
function checkCodexHomeSignal(env: Record<string, string | undefined>): EnvSignalResult {
  const codexHome = env.CODEX_HOME?.trim()
  if (codexHome) {
    return {
      clue: {
        method: 'codex-home-env',
        kind: 'codex',
        configDir: codexHome,
        proof: `CODEX_HOME=${codexHome}`,
      },
      ruledOut: '',
    }
  }
  return { clue: null, ruledOut: 'CODEX_HOME is unset (not a Codex instance)' }
}

/** Stage 2 — CLAUDE_CONFIG_DIR, set by every AgentHydra-launched CLI instance. Wins over any
 *  desktop signal: when it is set, the `claude` binary uses THOSE credentials, even if the
 *  terminal happens to have been opened from inside a Desktop instance. */
function checkClaudeConfigDirSignal(env: Record<string, string | undefined>): EnvSignalResult {
  const cfgDir = env.CLAUDE_CONFIG_DIR?.trim()
  if (cfgDir) {
    return {
      clue: {
        method: 'claude-config-dir-env',
        kind: 'cli',
        configDir: cfgDir,
        proof: `CLAUDE_CONFIG_DIR=${cfgDir}`,
      },
      ruledOut: '',
    }
  }
  return {
    clue: null,
    ruledOut: 'CLAUDE_CONFIG_DIR is unset (not a CLI instance — a Desktop session never sets it)',
  }
}

/** Stage 3 — CLAUDE_CODE_EXECPATH, present for hooks and Bash-tool children, absent inside MCP. */
function checkExecPathSignal(
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean,
): EnvSignalResult {
  const execPath = env.CLAUDE_CODE_EXECPATH?.trim()
  if (!execPath) {
    return {
      clue: null,
      ruledOut:
        'CLAUDE_CODE_EXECPATH is unset (expected inside an MCP server — it is only set for hooks and Bash-tool children)',
    }
  }
  const dir = userDataDirFromAgentExe(execPath)
  if (dir && looksLikeUserDataDir(dir, exists)) {
    return {
      clue: {
        method: 'execpath-env',
        kind: 'desktop',
        configDir: dir,
        proof: `CLAUDE_CODE_EXECPATH=${execPath}`,
      },
      ruledOut: '',
    }
  }
  return {
    clue: null,
    ruledOut: dir
      ? `CLAUDE_CODE_EXECPATH points at ${dir}, which is not a Claude user-data dir (no config.json / Local State)`
      : `CLAUDE_CODE_EXECPATH=${execPath} has no claude-code/<version>/ segment to derive an instance from`,
  }
}

/** Stage 4 — CLAUDE_CODE_HOST_SESSION_ID → the instance dir that holds this session's own file.
 *  The strongest filesystem-only route: a Desktop instance stores each Claude Code session as
 *  <instanceDir>/claude-code-sessions/<a>/<b>/<hostSessionId>.json. No process enumeration, no
 *  elevated permissions, works when PowerShell/ps is unavailable. */
function checkHostSessionSignal(
  env: Record<string, string | undefined>,
  rootOf: () => string,
  defaultUdd: () => string,
  readDir: (p: string) => string[] | null,
  exists: (p: string) => boolean,
): EnvSignalResult {
  const hostSessionId = env.CLAUDE_CODE_HOST_SESSION_ID?.trim()
  if (!hostSessionId) {
    return {
      clue: null,
      ruledOut: 'CLAUDE_CODE_HOST_SESSION_ID is unset (not a Claude Desktop session)',
    }
  }
  for (const dir of candidateUserDataDirs({ readDir }, rootOf(), defaultUdd())) {
    const sessionsRoot = join(dir, 'claude-code-sessions')
    if (!exists(sessionsRoot)) continue
    const hit = findFileUnder(sessionsRoot, `${hostSessionId}.json`, readDir, exists)
    if (hit) {
      return {
        clue: { method: 'host-session-file', kind: 'desktop', configDir: dir, proof: hit },
        ruledOut: '',
      }
    }
  }
  return {
    clue: null,
    ruledOut: `no instance holds a claude-code-sessions file for CLAUDE_CODE_HOST_SESSION_ID=${hostSessionId}`,
  }
}

/** Stage 5 (last resort) — walk this process's ancestry for a claude-code binary path or a
 *  Desktop --user-data-dir. The only signal that survives a stripped env, and the only one that
 *  spawns a process — detectSelfIdentity skips it once anything cheaper has already answered. */
async function checkProcessAncestrySignal(
  deps: SelfIdentityDeps,
  exists: (p: string) => boolean,
): Promise<EnvSignalResult> {
  const chain = deps.ancestry ? await deps.ancestry() : await defaultAncestry()
  if (chain === null) {
    return { clue: null, ruledOut: 'process ancestry could not be enumerated on this platform' }
  }
  if (chain.length === 0) {
    return { clue: null, ruledOut: 'process ancestry returned no parent processes' }
  }
  for (const proc of chain) {
    // The agent binary itself: <instanceDir>/claude-code/<ver>/claude.exe.
    const fromExe = userDataDirFromAgentExe(proc.executablePath ?? '')
    if (fromExe && looksLikeUserDataDir(fromExe, exists)) {
      return {
        clue: {
          method: 'ancestor-execpath',
          kind: 'desktop',
          configDir: fromExe,
          proof: `pid ${proc.pid} (${proc.name ?? 'unknown'}) → ${proc.executablePath}`,
        },
        ruledOut: '',
      }
    }
    // The Electron host that launched it: `--user-data-dir=<instanceDir>`.
    const fromCmd = userDataDirFromCommandLine(proc.commandLine ?? '')
    if (fromCmd && looksLikeUserDataDir(fromCmd, exists)) {
      return {
        clue: {
          method: 'ancestor-user-data-dir',
          kind: 'desktop',
          configDir: fromCmd,
          proof: `pid ${proc.pid} (${proc.name ?? 'unknown'}) → --user-data-dir=${fromCmd}`,
        },
        ruledOut: '',
      }
    }
  }
  return {
    clue: null,
    ruledOut: `walked ${chain.length} ancestor process(es); none carried --user-data-dir or a claude-code binary path`,
  }
}

/**
 * Work out which instance THIS process belongs to.
 *
 * Cheap signals first: the env checks cost nothing, the host-session-file scan is a handful of
 * readdirs, and the process-ancestry walk (a ~300ms PowerShell spawn on Windows) only runs when
 * everything cheaper has come up empty. That ordering matters because `check_my_usage` is
 * advertised as a ~300ms call an agent can make mid-task without thinking about it.
 */
export async function detectSelfIdentity(
  deps: SelfIdentityDeps = {},
): Promise<SelfIdentityDetection> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>)
  const exists = deps.exists ?? ((p: string) => existsSync(p))
  const readDir =
    deps.readDir ??
    ((p: string) => {
      try {
        return readdirSync(p, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch {
        return null
      }
    })
  const rootOf = deps.instancesRoot ?? instancesRoot
  const defaultUdd = deps.defaultUserDataDir ?? claudeUserDataDir
  const defaultCfg = deps.defaultConfigDir ?? defaultClaudeConfigDir

  const clues: SelfIdentityClue[] = []
  const ruledOut: string[] = []
  const add = (clue: SelfIdentityClue) => clues.push(clue)

  // --- 1-3. Env signals — CODEX_HOME / CLAUDE_CONFIG_DIR / CLAUDE_CODE_EXECPATH. ------------------
  for (const result of [
    checkCodexHomeSignal(env),
    checkClaudeConfigDirSignal(env),
    checkExecPathSignal(env, exists),
  ]) {
    if (result.clue) add(result.clue)
    else ruledOut.push(result.ruledOut)
  }

  // --- 4. CLAUDE_CODE_HOST_SESSION_ID → the instance dir that holds this session's own file. -----
  const hostSignal = checkHostSessionSignal(env, rootOf, defaultUdd, readDir, exists)
  if (hostSignal.clue) add(hostSignal.clue)
  else ruledOut.push(hostSignal.ruledOut)

  // --- 5. Process ancestry — the last resort, and the only one that survives a stripped env. -----
  // Skipped entirely when something above already answered: it is the one step that spawns a
  // process, and paying ~300ms to confirm an env var we already trust is waste.
  if (clues.length === 0) {
    const ancestrySignal = await checkProcessAncestrySignal(deps, exists)
    if (ancestrySignal.clue) add(ancestrySignal.clue)
    else ruledOut.push(ancestrySignal.ruledOut)
  } else {
    ruledOut.push('process ancestry not walked (a cheaper signal already identified this process)')
  }

  // --- verdict -----------------------------------------------------------------------------------
  const winner = clues[0] ?? null
  const distinct = new Set(clues.map((c) => normalizeInstancePath(c.configDir)))
  const conflict = distinct.size > 1

  if (winner) {
    return {
      configDir: winner.configDir,
      kind: winner.kind,
      method: winner.method,
      confidence: 'exact',
      clues,
      ruledOut,
      conflict,
    }
  }

  // Nothing named a credential store. If we are demonstrably inside Claude Code, the default login
  // is the only remaining candidate — but that is an ASSUMPTION, and it is labelled as one.
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) {
    const dir = defaultCfg()
    return {
      configDir: dir,
      kind: 'default-login',
      method: 'default-login',
      confidence: 'assumed',
      clues: [
        {
          method: 'default-login',
          kind: 'default-login',
          configDir: dir,
          proof:
            'no instance signal matched; falling back to the plain ~/.claude login by elimination',
        },
      ],
      ruledOut,
      conflict: false,
    }
  }

  return {
    configDir: null,
    kind: 'unknown',
    method: null,
    confidence: 'none',
    clues,
    ruledOut,
    conflict: false,
  }
}

/** Ancestry via core/process.ts, imported lazily so the common (env-answered) path never loads the
 *  process-scanning module at all. */
async function defaultAncestry(): Promise<AncestorProcess[] | null> {
  const { processAncestry } = await import('./process')
  return processAncestry()
}

/**
 * One sentence a human or an agent can act on, e.g.
 *   "instance #12 (pap3r rotate2) — adriel@example.com · Max 20x [exact: host-session-file]"
 * Kept here rather than in the MCP layer so the REST route, the MCP tool and any future consumer
 * phrase it identically.
 */
export function describeSelfIdentity(
  detection: SelfIdentityDetection,
  instance: { num: number; name: string; email: string | null; plan: string | null } | null,
): string {
  const how = detection.method ? `[${detection.confidence}: ${detection.method}]` : '[unidentified]'
  if (!instance) {
    if (detection.confidence === 'none') {
      return `Could not identify which Claude account this process runs as. ${how}`
    }
    const where = detection.configDir ?? 'unknown'
    return detection.kind === 'default-login'
      ? `Not a managed instance — the plain ~/.claude login (${where}). ${how}`
      : `An unmanaged ${detection.kind} credential dir (${where}) — no instance number. ${how}`
  }
  const who = [instance.email, instance.plan].filter(Boolean).join(' · ')
  return `instance #${instance.num} (${instance.name})${who ? ` — ${who}` : ''} ${how}`
}
