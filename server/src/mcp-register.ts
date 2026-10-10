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
 * WHAT IT REGISTERS. Two keys, both HTTP. `agenthydra` is this daemon's transport (`POST /api/mcp`),
 * never the stdio one. Stdio is one server process per client, each a relay whose entire job is to
 * forward JSON-RPC to this daemon - the cost f87dd06 removed. `browser` is Desk's browser tools
 * (`/mcp/browser` on the Desk port), so every Claude Code session on this PC has them without the
 * Connections MCP. Both URLs carry the port they are actually served on, and both survive a port
 * hop as long as this runs again on the next boot. Which it does: syncing at boot is what keeps a
 * stale URL from outliving the hop that invalidated it.
 *
 * WHAT IT WILL NOT DO. ~/.claude.json is not ours - it holds the user's logins, their project
 * history and every other MCP server they have. So: a file that does not parse is never written
 * (it is reported instead, because overwriting it would destroy real state to fix a convenience);
 * only the two keys above are ever touched, and a `browser` entry that is not AgentHydra's own
 * generic one (a stdio server, or an http url elsewhere) is kept and reported as a conflict; the
 * write is a temp file and a rename, so a crash mid-write cannot leave a truncated config; and
 * nothing is written at all when the entries are already what they should be.
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
import { join, resolve } from 'node:path'
import { getSetting, setSetting } from './db'
import { IS_PRIMARY_INSTALL } from './instance'

/** The settings key. '1' (the default) means keep the registration current on every boot. */
export const MCP_REGISTER_SETTING = 'mcp_register_claude_code'

/** The name the entry goes under. Also the name every tool description and doc already uses. */
export const MCP_SERVER_KEY = 'agenthydra'

/** The name Desk's browser tools go under. Only ever written when the key is free or already ours. */
export const MCP_BROWSER_KEY = 'browser'

const DESK_PORT_DEFAULT = 7798
const DESK_BROWSER_PATH = '/mcp/browser'
const GENERIC_DESK_BROWSER_URL = /^http:\/\/127\.0\.0\.1:\d+\/mcp\/browser$/

/** Desk's browser MCP endpoint on this machine. HYDRA_DESK_PORT overrides the default port. */
export function deskBrowserMcpUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${Number(env.HYDRA_DESK_PORT) || DESK_PORT_DEFAULT}${DESK_BROWSER_PATH}`
}

/** Is this AgentHydra's generic Desk browser entry (any port, no worker or cwd query)? */
export function isAgenthydraBrowserEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Record<string, unknown>
  return e.type === 'http' && typeof e.url === 'string' && GENERIC_DESK_BROWSER_URL.test(e.url)
}

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

/**
 * Is this daemon barred from the machine-wide Claude Code config? A side-run (a relocated store,
 * see IS_PRIMARY_INSTALL) must never write, update or remove `mcpServers.agenthydra` in the user's
 * real ~/.claude.json: on 2026-10-03 a scratch daemon on 7801 and the primary on 7787 rewrote each
 * other's URL every minute for hours, and every Claude session that started in a 7801 minute got
 * its agenthydra tools from the scratch store. Same rule the runtime.json pointer follows. An
 * explicit AGENTHYDRA_MCP_CONFIG names the side-run's OWN file, so it stays allowed.
 */
export function registrationBarred(
  primary: boolean = IS_PRIMARY_INSTALL,
  env: NodeJS.ProcessEnv = process.env,
  /** The caller named the exact file (a test's configPath), so no ambient config is in play. */
  explicitPath = false,
): boolean {
  if (env.AGENTHYDRA_MCP_CONFIG?.trim()) return false
  return !primary || (!explicitPath && homeRelocated(env) && !!env.CLAUDE_CONFIG_DIR?.trim())
}

/**
 * Is AGENTHYDRA_HOME pointed somewhere other than the default home? On its own that is NOT a
 * reason to bar: a real install may live elsewhere (docs/REFERENCE.md, install.ps1) and its config
 * is the user's own ~/.claude.json. It matters only together with an INHERITED CLAUDE_CONFIG_DIR
 * (registrationBarred checks both): 2026-10-06 scripts/smoke-release.ts, run from a CliMayte worker
 * whose env carries that variable, wrote its random port into the account's real .claude.json, dead
 * once the daemon exited (4 of 42 accounts). Without its own AGENTHYDRA_MCP_CONFIG it must not register.
 */
export function homeRelocated(env: NodeJS.ProcessEnv): boolean {
  const home = (env.AGENTHYDRA_HOME ?? env.CCMANAGERUI_HOME)?.trim()
  if (!home) return false
  const norm = (p: string) =>
    resolve(p)
      .replace(/[\\/]+$/, '')
      .toLowerCase()
  const h = norm(home)
  return h !== norm(join(homedir(), '.agenthydra')) && h !== norm(join(homedir(), '.ccmanagerui'))
}

export interface McpHttpEntry {
  type: 'http'
  url: string
}

/** The path this daemon serves MCP on (index.ts), whichever host and port. */
export const MCP_PATH = '/api/mcp'

/** The entry this daemon wants to see, for the URL it is actually serving on. */
export function desiredEntry(daemonUrl: string): McpHttpEntry {
  return { type: 'http', url: `${daemonUrl.replace(/\/+$/, '')}${MCP_PATH}` }
}

export type McpRegisterAction =
  | 'added'
  | 'updated'
  | 'unchanged'
  | 'removed'
  | 'absent'
  | 'disabled'
  /** The key holds another server that is not ours: it is left exactly as it is. */
  | 'conflict'
  /** Not attempted, and not an error: this daemon is a side-run (see registrationBarred). */
  | 'side-run'
  | 'failed'

export interface McpBrowserStatus {
  /** Is a `browser` entry present and pointing at Desk's browser endpoint right now? */
  registered: boolean
  /** What the `browser` key says now, whoever wrote it. */
  entry: unknown
  desired: McpHttpEntry
  action: McpRegisterAction
  /** Set when a foreign `browser` server is kept; says what it is and that it was left alone. */
  conflict: string | null
  /** Why the write could not be done. Null on every success. */
  error: string | null
}

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
  browser: McpBrowserStatus
}

/** Parse the config, distinguishing "no file yet" (fine, we create it) from "unreadable" (never
 *  written to). A file that is not a JSON OBJECT counts as unreadable for the same reason. */
export function readConfig(path: string): {
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
export function writeConfigAtomic(path: string, config: Record<string, unknown>): void {
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

/*
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
 * thing restarts from THEIR file - which is the merge actually wanted, since our change is two
 * keys. The window is not closed (nothing short of a shared lock could close it), but it shrinks
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
 * The last write failure per key, remembered so the READ-ONLY status can report it.
 *
 * Without this a failed write was unreportable by construction: mcpRegistrationStatus only ever
 * reads, so its `error` could only ever describe an unreadable file - and a read-only
 * ~/.claude.json reads perfectly. The panel therefore showed a bare "Not registered yet." with no
 * reason, in exactly the case the DTO field documents itself as existing for.
 */
const lastWriteErrors = new Map<string, { configPath: string; error: string }>()

/** Test seam: the failure memory is module state, so a test asserting on it needs a known start. */
export function resetMcpRegisterMemory(): void {
  lastWriteErrors.clear()
}

const rememberedWriteError = (configPath: string, key: string): string | null => {
  const remembered = lastWriteErrors.get(key)
  return remembered?.configPath === configPath ? remembered.error : null
}

const writeFailure = (configPath: string, e: unknown): string =>
  `could not write ${configPath}: ${e instanceof Error ? e.message : e}`

/** `config.mcpServers`, coerced to a plain record — an absent or malformed value reads as empty. */
function mcpServersRecord(config: Record<string, unknown>): Record<string, unknown> {
  return config.mcpServers &&
    typeof config.mcpServers === 'object' &&
    !Array.isArray(config.mcpServers)
    ? (config.mcpServers as Record<string, unknown>)
    : {}
}

/** One key we keep in ~/.claude.json: the entry we want there, and whether an existing entry is ours. */
interface KeySpec {
  key: string
  desired: McpHttpEntry
  ours: (entry: unknown) => boolean
}

function keySpecs(daemonUrl: string, deskUrl: string): [KeySpec, KeySpec] {
  return [
    { key: MCP_SERVER_KEY, desired: desiredEntry(daemonUrl), ours: () => true },
    {
      key: MCP_BROWSER_KEY,
      desired: { type: 'http', url: deskUrl },
      ours: isAgenthydraBrowserEntry,
    },
  ]
}

const foreignMessage = (configPath: string, key: string): string =>
  `"${key}" in ${configPath} is another server, not AgentHydra's entry; it is left as it is`

/** What one key does on this sync. `write` false means nothing to persist for it. */
interface KeyPlan {
  spec: KeySpec
  current: unknown
  action: McpRegisterAction
  conflict: string | null
  write: boolean
  /** What the key becomes when `write` is set; null deletes it. */
  next: McpHttpEntry | null
}

/** One key's result, as the status reports it. */
interface KeyOutcome {
  registered: boolean
  entry: unknown
  action: McpRegisterAction
  error: string | null
  conflict: string | null
}

/**
 * Decide one key's fate. Off has to mean gone, not merely "stops being refreshed": a stale entry
 * left behind would keep answering after the user asked for it not to. A foreign entry under the
 * key is never touched in either direction.
 */
function planKey(spec: KeySpec, enabled: boolean, current: unknown, configPath: string): KeyPlan {
  const plan = (
    action: McpRegisterAction,
    write: boolean,
    next: McpHttpEntry | null,
    conflict: string | null = null,
  ): KeyPlan => ({ spec, current, action, conflict, write, next })
  const present = current != null
  if (present && !spec.ours(current))
    return plan('conflict', false, null, foreignMessage(configPath, spec.key))
  if (!enabled) return present ? plan('removed', true, null) : plan('absent', false, null)
  if (!present) return plan('added', true, spec.desired)
  if (sameEntry(current, spec.desired)) return plan('unchanged', false, null)
  return plan('updated', true, spec.desired)
}

/** A key's outcome once the write has been attempted: a failure only for a key we tried to write. */
function settle(plan: KeyPlan, enabled: boolean, failure: string | null): KeyOutcome {
  if (plan.write && failure)
    return {
      registered: !enabled && plan.current !== undefined,
      entry: plan.current ?? null,
      action: 'failed',
      error: failure,
      conflict: plan.conflict,
    }
  const entry = plan.write ? plan.next : (plan.current ?? null)
  return {
    registered: entry !== null && sameEntry(entry, plan.spec.desired),
    entry,
    action: plan.action,
    error: null,
    conflict: plan.conflict,
  }
}

function assemble(
  enabled: boolean,
  configPath: string,
  specs: [KeySpec, KeySpec],
  [agent, browser]: [KeyOutcome, KeyOutcome],
): McpRegisterStatus {
  return {
    enabled,
    configPath,
    registered: agent.registered,
    entry: agent.entry,
    desired: specs[0].desired,
    action: agent.action,
    error: agent.error,
    browser: {
      registered: browser.registered,
      entry: browser.entry,
      desired: specs[1].desired,
      action: browser.action,
      conflict: browser.conflict,
      error: browser.error,
    },
  }
}

const allKeys = (outcome: KeyOutcome): [KeyOutcome, KeyOutcome] => [outcome, outcome]

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
    /** Desk's browser endpoint; defaults to the port Desk serves on (HYDRA_DESK_PORT or 7798). */
    deskUrl?: string
    enabled?: boolean
    configPath?: string
    /** Seams for the test: production reads IS_PRIMARY_INSTALL and process.env. */
    primary?: boolean
    env?: NodeJS.ProcessEnv
  },
  deps: McpRegisterDeps = {},
): McpRegisterStatus {
  const enabled = opts.enabled ?? mcpRegisterEnabled()
  const configPath = opts.configPath ?? claudeCodeConfigPath(opts.env)
  const specs = keySpecs(opts.daemonUrl, opts.deskUrl ?? deskBrowserMcpUrl(opts.env))
  // Before the file is even read: a barred daemon touches nothing, whatever the file holds.
  if (registrationBarred(opts.primary, opts.env, !!opts.configPath))
    return assemble(
      enabled,
      configPath,
      specs,
      allKeys({ registered: false, entry: null, action: 'side-run', error: null, conflict: null }),
    )
  const writeConfig = deps.writeConfig ?? writeConfigAtomic
  let raced: [KeyOutcome, KeyOutcome] | null = null

  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const before = stamp(configPath)
    const { config, error } = readConfig(configPath)
    // The point in the sequence where a concurrent writer's rename lands in the real world. A test
    // stands in for Claude Code here; in production this is undefined and costs nothing.
    deps.afterRead?.(configPath)
    if (!config)
      return assemble(
        enabled,
        configPath,
        specs,
        allKeys({ registered: false, entry: null, action: 'failed', error, conflict: null }),
      )

    const servers = mcpServersRecord(config)
    const plans = specs.map((s) => planKey(s, enabled, servers[s.key] ?? null, configPath)) as [
      KeyPlan,
      KeyPlan,
    ]
    // Nothing to write is not a race, so it returns before the stamp check: not writing cannot lose
    // anyone's work, and a concurrent writer is none of our business here.
    if (!plans.some((p) => p.write)) {
      for (const p of plans) lastWriteErrors.delete(p.spec.key)
      return assemble(
        enabled,
        configPath,
        specs,
        plans.map((p) => settle(p, enabled, null)) as [KeyOutcome, KeyOutcome],
      )
    }

    for (const p of plans) {
      if (!p.write) continue
      if (p.next) servers[p.spec.key] = p.next
      else delete servers[p.spec.key]
    }
    config.mcpServers = servers

    if (stamp(configPath) !== before) {
      const raceError = `${configPath} was written by another process while this update was being prepared`
      raced = plans.map((p) => settle(p, enabled, p.write ? raceError : null)) as [
        KeyOutcome,
        KeyOutcome,
      ]
      continue
    }

    try {
      writeConfig(configPath, config)
    } catch (e) {
      const failure = writeFailure(configPath, e)
      for (const p of plans)
        if (p.write) lastWriteErrors.set(p.spec.key, { configPath, error: failure })
      return assemble(
        enabled,
        configPath,
        specs,
        plans.map((p) => settle(p, enabled, p.write ? failure : null)) as [KeyOutcome, KeyOutcome],
      )
    }
    for (const p of plans) lastWriteErrors.delete(p.spec.key)
    return assemble(
      enabled,
      configPath,
      specs,
      plans.map((p) => settle(p, enabled, null)) as [KeyOutcome, KeyOutcome],
    )
  }

  return assemble(
    enabled,
    configPath,
    specs,
    raced ??
      allKeys({
        registered: false,
        entry: null,
        action: 'failed',
        error: `${configPath} is being written by another process`,
        conflict: null,
      }),
  )
}

/**
 * What a daemon keeps between registration syncs: the last result, so /api/health can report it
 * without re-reading ~/.claude.json, and so a failure that persists is logged once rather than on
 * every tick.
 *
 * Why a daemon re-runs the sync at all: ~/.claude.json is not ours, and every running Claude client
 * rewrites the whole file from its own in-memory copy. A client already open when the daemon wrote
 * the entry quietly reverts it on its next save, and a sync that only ran at boot never looked
 * again, so the symptom surfaced hours later in a DIFFERENT session as an MCP server with no tools
 * and nothing pointing at AgentHydra. The sync writes only when an entry differs and detects a
 * concurrent writer, so re-running it against an unchanged file costs one read. `run` never throws:
 * it is called from a repeating timer, where a throw would end the daemon.
 */
export function createMcpReasserter(opts: {
  daemonUrl: () => string
  configPath?: string
  primary?: boolean
  env?: NodeJS.ProcessEnv
  log?: { info: (message: string) => void; warn: (message: string) => void }
}): { run: (enabled?: boolean) => McpRegisterStatus | null; last: () => McpRegisterStatus | null } {
  let last: McpRegisterStatus | null = null
  const log = opts.log ?? { info: console.log, warn: console.warn }
  const issueOf = (s: McpRegisterStatus | null) =>
    s?.error ?? s?.browser.error ?? s?.browser.conflict ?? null
  return {
    last: () => last,
    run(enabled) {
      try {
        const previousIssue = issueOf(last)
        const reg = syncMcpRegistration({
          daemonUrl: opts.daemonUrl(),
          enabled,
          configPath: opts.configPath,
          primary: opts.primary,
          env: opts.env,
        })
        last = reg
        const issue = issueOf(reg)
        if (issue) {
          if (issue !== previousIssue) log.warn(`[agenthydra] MCP registration: ${issue}`)
        } else {
          const changed = new Set(
            [reg.action, reg.browser.action].filter(
              (a) => a === 'added' || a === 'updated' || a === 'removed',
            ),
          )
          if (changed.size > 0)
            log.info(
              `[agenthydra] MCP registration ${[...changed].join(', ')} in ${reg.configPath}`,
            )
        }
        return reg
      } catch (error) {
        log.warn(
          `[agenthydra] MCP registration check failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return last
      }
    },
  }
}

/** One key's state as the read-only status reports it: what the file says, plus any remembered failure. */
function viewOf(
  spec: KeySpec,
  enabled: boolean,
  configPath: string,
  servers: Record<string, unknown>,
): KeyOutcome {
  const current = servers[spec.key] ?? null
  if (current !== null && !spec.ours(current))
    return {
      registered: false,
      entry: current,
      action: 'conflict',
      error: null,
      conflict: foreignMessage(configPath, spec.key),
    }
  const registered = sameEntry(current, spec.desired)
  // A remembered WRITE failure outranks a clean read. A read-only ~/.claude.json reads perfectly,
  // so without this the panel reports "not registered" and cannot say why.
  const writeError = rememberedWriteError(configPath, spec.key)
  return {
    registered,
    entry: current,
    action:
      writeError && !registered
        ? 'failed'
        : enabled
          ? current === null
            ? 'absent'
            : 'unchanged'
          : 'disabled',
    error: registered ? null : writeError,
    conflict: null,
  }
}

/** Read-only: what the config says right now, for the Settings panel. Writes nothing. */
export function mcpRegistrationStatus(opts: {
  daemonUrl: string
  deskUrl?: string
  configPath?: string
}): McpRegisterStatus {
  const enabled = mcpRegisterEnabled()
  const configPath = opts.configPath ?? claudeCodeConfigPath()
  const specs = keySpecs(opts.daemonUrl, opts.deskUrl ?? deskBrowserMcpUrl())
  if (registrationBarred(undefined, undefined, !!opts.configPath))
    return assemble(
      enabled,
      configPath,
      specs,
      allKeys({ registered: false, entry: null, action: 'side-run', error: null, conflict: null }),
    )
  const { config, error } = readConfig(configPath)
  if (!config)
    return assemble(
      enabled,
      configPath,
      specs,
      specs.map((s) => ({
        registered: false,
        entry: null,
        action: 'failed' as const,
        error: error ?? rememberedWriteError(configPath, s.key),
        conflict: null,
      })) as [KeyOutcome, KeyOutcome],
    )
  const servers = mcpServersRecord(config)
  return assemble(
    enabled,
    configPath,
    specs,
    specs.map((s) => viewOf(s, enabled, configPath, servers)) as [KeyOutcome, KeyOutcome],
  )
}
