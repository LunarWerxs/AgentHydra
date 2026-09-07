/**
 * Register THIS daemon as an MCP server with the Claude Code CLI, automatically.
 *
 * WHY THIS EXISTS. Everything AgentHydra exposes over MCP - the chat moves, the fleet, the quota
 * reads - is reachable only if a client has been told where the server is, and until now that was
 * a paragraph in docs/REFERENCE.md telling the reader to type `claude mcp add --scope user
 * agenthydra -- bun run --cwd <path-to-agenthydra> mcp`. That instruction is wrong for everyone
 * who did not clone the repo: a downloaded release has no checkout to point `--cwd` at and,
 * usually, no Bun to run it with. So the people most likely to need the tools were the people
 * least able to get them, and the failure was silent - a client with no entry has no tools, and
 * nothing anywhere says why. Measured 2026-09-07 on a release install: no `agenthydra` entry in
 * ~/.claude.json at all, alongside three other MCP servers that had been registered by their own
 * installers.
 *
 * WHAT IT REGISTERS. The HTTP transport (`POST /api/mcp`), never the stdio one. Stdio is one
 * server process per client, and each is a relay whose entire job is to forward JSON-RPC to this
 * daemon - the cost f87dd06 removed. An HTTP entry costs nothing per client and, because the URL
 * carries the port this daemon ACTUALLY bound, it survives a port hop as long as this runs again
 * on the next boot. Which it does: syncing at boot is what keeps a stale URL from outliving the
 * hop that invalidated it.
 *
 * WHAT IT WILL NOT DO. ~/.claude.json is not ours - it holds the user's logins, their project
 * history and every other MCP server they have. So: a file that does not parse is never written
 * (it is reported instead, because overwriting it would destroy real state to fix a convenience);
 * only the single `mcpServers.agenthydra` key is ever touched; the write is a temp file and a
 * rename, so a crash mid-write cannot leave a truncated config; and nothing is written at all
 * when the entry is already what it should be.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSetting, setSetting } from './db'

/** The settings key. '1' (the default) means keep the registration current on every boot. */
export const MCP_REGISTER_SETTING = 'mcp_register_claude_code'

/** The name the entry goes under. Also the name every tool description and doc already uses. */
export const MCP_SERVER_KEY = 'agenthydra'

export function mcpRegisterEnabled(): boolean {
  return getSetting(MCP_REGISTER_SETTING) !== '0'
}

export function setMcpRegisterEnabled(on: boolean): void {
  setSetting(MCP_REGISTER_SETTING, on ? '1' : '0')
}

/**
 * Claude Code's USER-scope config file.
 *
 * `CLAUDE_CONFIG_DIR` is Claude Code's own relocation env var, and when it is set that directory
 * IS the ambient user scope - registering into ~/.claude.json instead would write a file that
 * client never reads. `AGENTHYDRA_MCP_CONFIG` names the file outright, for a test or for a
 * layout neither convention covers.
 */
export function claudeCodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AGENTHYDRA_MCP_CONFIG?.trim()
  if (explicit) return explicit
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  return join(dir || homedir(), '.claude.json')
}

export interface McpHttpEntry {
  type: 'http'
  url: string
}

/** The entry this daemon wants to see, for the URL it is actually serving on. */
export function desiredEntry(daemonUrl: string): McpHttpEntry {
  return { type: 'http', url: `${daemonUrl.replace(/\/+$/, '')}/api/mcp` }
}

export type McpRegisterAction =
  | 'added'
  | 'updated'
  | 'unchanged'
  | 'removed'
  | 'absent'
  | 'disabled'
  | 'failed'

export interface McpRegisterStatus {
  /** The setting, not the outcome: true means "keep this registered". */
  enabled: boolean
  configPath: string
  /** Is an `agenthydra` entry present and pointing at this daemon right now? */
  registered: boolean
  /** What the entry says now (any transport - a hand-written stdio one still shows here). */
  entry: unknown
  desired: McpHttpEntry
  action: McpRegisterAction
  /** Why it could not be done. Null on every success, INCLUDING 'disabled' and 'absent'. */
  error: string | null
}

/** Parse the config, distinguishing "no file yet" (fine, we create it) from "unreadable" (never
 *  written to). A file that is not a JSON OBJECT counts as unreadable for the same reason. */
function readConfig(path: string): {
  config: Record<string, unknown> | null
  error: string | null
} {
  if (!existsSync(path)) return { config: {}, error: null }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    return { config: null, error: `could not read ${path}: ${e instanceof Error ? e.message : e}` }
  }
  // An empty file is Claude Code's own "not written yet" state, not damage.
  if (raw.trim() === '') return { config: {}, error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return {
      config: null,
      error: `${path} is not valid JSON (${e instanceof Error ? e.message : e}) - refusing to rewrite a config we cannot read`,
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return { config: null, error: `${path} is not a JSON object - refusing to rewrite it` }
  return { config: parsed as Record<string, unknown>, error: null }
}

/** The file we must actually replace. A dotfile manager may have made ~/.claude.json a SYMLINK
 *  into its own store; renaming over the link would replace it with a regular file and orphan the
 *  real config - a silent and confusing kind of loss. Resolving first means we rewrite the target
 *  the link points at, exactly as an editor would. */
function resolveTarget(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path // does not exist yet, or cannot be resolved: write where we were asked to
  }
}

/**
 * Temp file beside the target, then rename over it. Same directory on purpose: a rename across
 * volumes is a copy, which is exactly the non-atomic write this avoids.
 *
 * The temp file inherits the TARGET's permission bits before the rename. ~/.claude.json holds
 * OAuth material, and a fresh file created at the process umask would silently widen it - a
 * convenience feature must not loosen the permissions of a credential store on its way past.
 */
function writeConfigAtomic(path: string, config: Record<string, unknown>): void {
  const target = resolveTarget(path)
  const tmp = `${target}.agenthydra-${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    try {
      // Only when the target already exists; a file we are creating gets the platform default.
      if (existsSync(target)) chmodSync(tmp, statSync(target).mode & 0o777)
    } catch {
      // A filesystem with no mode bits (or a Windows ACL-only volume) is not a reason to fail the
      // write - the rename below is the part that matters.
    }
    renameSync(tmp, target)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    throw e
  }
}

/** A cheap identity for "are these the same file contents we read a moment ago" - size plus mtime.
 *  `null` means absent, which is itself a stamp and compares equal to itself. */
function stamp(path: string): string | null {
  try {
    const st = statSync(resolveTarget(path))
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return null
  }
}

const sameEntry = (a: unknown, b: McpHttpEntry): boolean =>
  !!a &&
  typeof a === 'object' &&
  (a as Record<string, unknown>).type === b.type &&
  (a as Record<string, unknown>).url === b.url

/**
 * WE ARE NOT THE ONLY WRITER OF THIS FILE, AND THE OTHER ONE IS CLAUDE CODE.
 *
 * Claude Code rewrites ~/.claude.json with the same whole-file read-modify-write-and-rename shape
 * this module uses (its own `.claude.json.tmp.*` leftovers in the home directory are the evidence),
 * on events nothing here controls: a session ending and appending to `projects[dir].history`, an
 * OAuth token refresh, a `claude mcp add`. Two such writers with no lock means whichever renames
 * SECOND silently discards everything the first one changed - and on this side that would be the
 * user's config, not ours. Raised by review 2026-09-07 as the most serious thing in this module.
 *
 * There is no lock to take: a lockfile invented here would be honoured only by us. What this does
 * instead is refuse to write ACROSS a change it can see. It stamps the file (size + mtime), builds
 * the new contents from that exact snapshot, and re-checks the stamp immediately before renaming.
 * A moved stamp means another writer got there first, so the snapshot is discarded and the whole
 * thing restarts from THEIR file - which is the merge actually wanted, since our change is one
 * key. The window is not closed (nothing short of a shared lock could close it), but it shrinks
 * from the whole read-compute-write to the width of a single rename.
 *
 * Bounded at three tries, and losing all three is not worth recording as a fault: nothing is wrong
 * with the config or with us, another program is simply busy, and this sync runs on every boot.
 */
/**
 * Test seams, in the same shape github-updater's ApplyUpdateDeps uses and for the same reason: the
 * two failures that matter here - a concurrent writer, and a config we are not allowed to write -
 * cannot be produced from the outside without one. Production passes nothing.
 */
export interface McpRegisterDeps {
  /** Stands in for writeConfigAtomic; a test throws from it to simulate a read-only config. */
  writeConfig?: (path: string, config: Record<string, unknown>) => void
  /** Runs where a concurrent writer's rename would land: after our read, before our stamp check. */
  afterRead?: (path: string) => void
}

const WRITE_ATTEMPTS = 3

/**
 * The last write failure, remembered so the READ-ONLY status can report it.
 *
 * Without this a failed write was unreportable by construction: mcpRegistrationStatus only ever
 * reads, so its `error` could only ever describe an unreadable file - and a read-only
 * ~/.claude.json reads perfectly. The panel therefore showed a bare "Not registered yet." with no
 * reason, in exactly the case the DTO field documents itself as existing for.
 */
let lastWriteError: { configPath: string; error: string } | null = null

/** Test seam: the failure memory is module state, so a test asserting on it needs a known start. */
export function resetMcpRegisterMemory(): void {
  lastWriteError = null
}

const writeFailure = (configPath: string, e: unknown): string =>
  `could not write ${configPath}: ${e instanceof Error ? e.message : e}`

/**
 * Bring the registration in line with the setting. Called at boot (once the bound port is known)
 * and again whenever the setting is flipped in Settings.
 *
 * NEVER THROWS. A daemon must boot whether or not another program's config file cooperates, so
 * every failure comes back as `action: 'failed'` with a reason a human can act on.
 */
export function syncMcpRegistration(
  opts: {
    daemonUrl: string
    enabled?: boolean
    configPath?: string
  },
  deps: McpRegisterDeps = {},
): McpRegisterStatus {
  const enabled = opts.enabled ?? mcpRegisterEnabled()
  const configPath = opts.configPath ?? claudeCodeConfigPath()
  const desired = desiredEntry(opts.daemonUrl)
  const base = { enabled, configPath, desired }
  const writeConfig = deps.writeConfig ?? writeConfigAtomic
  let raced: McpRegisterStatus | null = null

  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const before = stamp(configPath)
    const { config, error } = readConfig(configPath)
    // The point in the sequence where a concurrent writer's rename lands in the real world. A test
    // stands in for Claude Code here; in production this is undefined and costs nothing.
    deps.afterRead?.(configPath)
    if (!config) return { ...base, registered: false, entry: null, action: 'failed', error }

    const servers =
      config.mcpServers &&
      typeof config.mcpServers === 'object' &&
      !Array.isArray(config.mcpServers)
        ? (config.mcpServers as Record<string, unknown>)
        : {}
    const current = servers[MCP_SERVER_KEY]

    // The two nothing-to-do paths return BEFORE any stamp check: not writing cannot lose anyone's
    // work, so a concurrent writer is none of our business here.
    if (!enabled && current === undefined) {
      lastWriteError = null
      return { ...base, registered: false, entry: null, action: 'absent', error: null }
    }
    if (enabled && sameEntry(current, desired)) {
      lastWriteError = null
      return { ...base, registered: true, entry: current, action: 'unchanged', error: null }
    }

    // Turned off: take OUR entry out and leave every other server alone. Off has to mean gone, not
    // merely "stops being refreshed" - a stale entry left behind would keep answering after the
    // user asked for it not to.
    const action: McpRegisterAction = !enabled
      ? 'removed'
      : current === undefined
        ? 'added'
        : 'updated'
    if (enabled) servers[MCP_SERVER_KEY] = desired
    else delete servers[MCP_SERVER_KEY]
    config.mcpServers = servers

    if (stamp(configPath) !== before) {
      raced = {
        ...base,
        registered: !enabled && current !== undefined,
        entry: current ?? null,
        action: 'failed',
        error: `${configPath} was written by another process while this update was being prepared`,
      }
      continue
    }

    try {
      writeConfig(configPath, config)
    } catch (e) {
      lastWriteError = { configPath, error: writeFailure(configPath, e) }
      return {
        ...base,
        registered: !enabled && current !== undefined,
        entry: current ?? null,
        action: 'failed',
        error: lastWriteError.error,
      }
    }
    lastWriteError = null
    return { ...base, registered: enabled, entry: enabled ? desired : null, action, error: null }
  }

  return (
    raced ?? {
      ...base,
      registered: false,
      entry: null,
      action: 'failed',
      error: `${configPath} is being written by another process`,
    }
  )
}

/** Read-only: what the config says right now, for the Settings panel. Writes nothing. */
export function mcpRegistrationStatus(opts: {
  daemonUrl: string
  configPath?: string
}): McpRegisterStatus {
  const enabled = mcpRegisterEnabled()
  const configPath = opts.configPath ?? claudeCodeConfigPath()
  const desired = desiredEntry(opts.daemonUrl)
  const { config, error } = readConfig(configPath)
  // A remembered WRITE failure outranks a clean read. A read-only ~/.claude.json reads perfectly,
  // so without this the panel reports "not registered" and cannot say why.
  const writeError = lastWriteError?.configPath === configPath ? lastWriteError.error : null
  if (!config)
    return {
      enabled,
      configPath,
      registered: false,
      entry: null,
      desired,
      action: 'failed',
      error: error ?? writeError,
    }
  const servers =
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? (config.mcpServers as Record<string, unknown>)
      : {}
  const current = servers[MCP_SERVER_KEY] ?? null
  const registered = sameEntry(current, desired)
  return {
    enabled,
    configPath,
    registered,
    entry: current,
    desired,
    action:
      writeError && !registered
        ? 'failed'
        : enabled
          ? current === null
            ? 'absent'
            : 'unchanged'
          : 'disabled',
    error: registered ? null : writeError,
  }
}
