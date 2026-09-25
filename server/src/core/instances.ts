// server/src/core/instances.ts: instance discovery + open/quit (PLAN.md §2).
// Adapted verbatim (behavior) from an internal LunarWerx tool's instance discovery module;
// the import paths were adapted (./shared instead of ../../../shared/index.ts, no .ts
// extensions to match this repo's convention), and openInstance's no-binary failure message
// is now MSIX-aware (core/desktop-install.ts) instead of the ported generic one.
//
// Depends on:
//   core/paths.ts    : instancesRoot(), resolveLaunchBinary(), launchArgs(dir), normalizePath()
//   core/process.ts  : listClaudeProcesses(): CMProcessInfo[] (per-OS main-process enumeration,
//                       already filtered to exclude Electron `--type=` children and parsed for
//                       `--user-data-dir`)
//   core/shared.ts    : CMInstance, CMActionResult DTOs
//
// Nothing here throws for expected failure conditions (missing dirs, no processes found, spawn
// failures, permission errors); every public function returns a status-carrying result instead.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import {
  assertClaudeInspectorPortAvailable,
  prepareClaudeNativeLaunch,
} from '../claude-native-launch'
import {
  beginNativeLaunchRegistryGuard,
  type NativeLaunchRegistryResult,
} from '../claude-native-launch-registry'
import { captureNativeLaunchLogCursor, waitForNativeLaunchReady } from '../claude-native-ready'
import {
  ensureClaudeNativeProfileConfig,
  getClaudeNativeProfileConfig,
} from '../claude-native-settings'
import { buildDetachedSpawn } from '../detached-spawn.mjs'
import { detectDesktopInstall } from './desktop-install'
import { recordInstanceLaunches } from './instance-launches'
import { readInstanceMetaMap } from './instance-meta'
import { instanceNumbers, instanceRef } from './instance-numbers'
import { readLoginUuid } from './login-state'
import {
  currentPlatform,
  defaultClaudeDir,
  instancesRoot,
  isPathInside,
  launchArgs,
  normalizePath,
  resolveLaunchBinary,
} from './paths'
import {
  type CMProcessInfo,
  invalidateClaudeProcessCache,
  isPidAlive,
  type ListClaudeProcessesOptions,
  lastGoodClaudeProcessScan,
  listClaudeProcesses,
  scanClaudeProcesses,
} from './process'
import { awaitExitBounded, spawnCaptured } from './process.ts'
import type { CMActionResult, CMInstance } from './shared'

/** `taskkill` signals and exits; it does not wait for the target to die. A run that has not
 *  returned in ten seconds is wedged, and the caller's next step (a forced kill, a re-scan) is
 *  strictly better than waiting on it forever. */
const TASKKILL_TIMEOUT_MS = 10_000

/** How often a quit re-checks the pids it is waiting on (signal 0, no scan). */
const QUIT_POLL_MS = 100
/** After the main process has exited, how long its helper processes get to exit on their own
 *  before the survivors are forced. */
const QUIT_CHILD_SETTLE_MS = 1_500

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** How old a successful process scan may be and still stand in for a failed one in a LISTING. */
const LAST_GOOD_SCAN_MAX_AGE_MS = 5 * 60_000

/** A window-focus poke is instant or the desktop is not answering. */
const FOCUS_TIMEOUT_MS = 15_000

// ----------------------------------------------------------------------------
// Discovery
// ----------------------------------------------------------------------------

/** Metadata for one discovered instance dir, prior to attaching running-state. */
interface DiscoveredMeta {
  name: string
  dir: string // normalized
  isExternal: boolean
}

/**
 * Enumerates the subdirectories of `instancesRoot()`. Best-effort: a missing root
 * (first run) or a listing error yields an empty array rather than throwing.
 */
function listInstanceRootDirs(): DiscoveredMeta[] {
  const root = instancesRoot()
  const out: DiscoveredMeta[] = []
  try {
    if (!existsSync(root)) return out
    const entries = readdirSync(root, { withFileTypes: true })
    for (const entry of entries) {
      try {
        if (!entry.isDirectory()) continue
        const full = normalizePath(`${root}/${entry.name}`)
        out.push({ name: entry.name, dir: full, isExternal: false })
      } catch {
        // Skip anything we can't stat/read (permissions, race with deletion, etc.).
      }
    }
  } catch {
    // Root unreadable; treat as "no known instances", callers still see running ones.
  }
  return out
}

/** Best-effort recursive byte size of a directory. Returns undefined on any failure. */
function dirSizeBytes(dir: string): number | undefined {
  try {
    if (!existsSync(dir)) return undefined
    let total = 0
    const stack: string[] = [dir]
    while (stack.length) {
      const current = stack.pop()
      if (current === undefined) continue
      let entries: string[]
      try {
        entries = readdirSync(current)
      } catch {
        continue // locked/permission-denied subdir, skip it and keep summing the rest
      }
      for (const name of entries) {
        const full = `${current}/${name}`
        try {
          const st = statSync(full)
          if (st.isDirectory()) stack.push(full)
          else if (st.isFile()) total += st.size
        } catch {
          // Individual file/dir vanished or is locked; skip, best-effort only.
        }
      }
    }
    return total
  } catch {
    return undefined
  }
}

export { type LoginState, readLoginState, readLoginUuid } from './login-state'

export interface ListInstancesOptions {
  /** Attach account identity (slow path: decrypt + one network call per instance). */
  includeAccount?: boolean
  /** Compute on-disk size per instance (walks the tree, can be slow for large profiles). */
  includeSize?: boolean
  /** Resolver used when includeAccount is set. Injected so instances.ts has no hard
   *  dependency on core/accounts.ts (kept decoupled + easy to unit test). */
  resolveAccount?: (
    dir: string,
  ) => Promise<CMInstance['account'] | null | undefined> | CMInstance['account'] | null | undefined
}

/**
 * Union of (a) subdirs of `instancesRoot()` and (b) dirs seen on a running Claude
 * process's `--user-data-dir`. One `CMInstance` per normalized dir. Dirs only seen
 * via a running process (i.e. launched from outside the instances root) are still
 * listed, flagged `isExternal: true`.
 */
export async function listInstances(options: ListInstancesOptions = {}): Promise<CMInstance[]> {
  const known = new Map<string, DiscoveredMeta>()
  for (const meta of listInstanceRootDirs()) known.set(meta.dir, meta)

  // includeChildren: one scan yields both the main process per dir (for pid/startTime/running)
  // AND every `--type=` child, so per-instance memory is the summed working set of the whole
  // Electron tree — not just the (small) main process. Same single CIM/ps call as before.
  // A FAILED scan is not "nothing is running": it falls back to the last scan that answered (see
  // lastGoodClaudeProcessScan), and only with none of those to "nothing", as before.
  const scan = await scanClaudeProcesses({ includeChildren: true })
  const procs: CMProcessInfo[] = scan.ok
    ? scan.processes
    : (lastGoodClaudeProcessScan(LAST_GOOD_SCAN_MAX_AGE_MS)?.processes ?? [])

  const runningByDir = new Map<string, CMProcessInfo>()
  const memoryByDir = new Map<string, number>()
  const root = normalizePath(instancesRoot())
  for (const proc of procs) {
    if (!proc.dir) continue
    const normDir = normalizePath(proc.dir)

    // Memory: sum every process (main + children) sharing this dir. WorkingSetSize double-counts
    // shared pages across the tree, same as Task Manager's per-process column — an accepted
    // approximation of "roughly how much RAM this instance uses".
    if (typeof proc.memoryBytes === 'number' && Number.isFinite(proc.memoryBytes)) {
      memoryByDir.set(normDir, (memoryByDir.get(normDir) ?? 0) + proc.memoryBytes)
    }

    // Running-state representative: the MAIN process only (it carries the pid + startTime we show);
    // keep the earliest-seen, defensive against duplicate scans.
    if (proc.isMain && !runningByDir.has(normDir)) runningByDir.set(normDir, proc)

    if (!known.has(normDir)) {
      const isUnderRoot = isPathInside(root, normDir)
      known.set(normDir, {
        name: basename(normDir),
        dir: normDir,
        isExternal: !isUnderRoot,
      })
    }
  }

  // One read of the presentation-metadata file (label/icon/color), keyed by normalized dir.
  const metaMap = readInstanceMetaMap()

  // When each profile was last started on this PC. Every running main process is folded in with
  // its OWN start time before the read, so an instance opened outside AgentHydra (Start menu,
  // taskbar, Claude's shortcut) counts the same as one opened from here. Writes only on change.
  const launches = recordInstanceLaunches(
    [...runningByDir.entries()]
      .map(([dir, proc]) => ({ dir, at: proc.startTime ? Date.parse(proc.startTime) : Number.NaN }))
      .filter((launch) => Number.isFinite(launch.at)),
  )

  // …and one read of the number registry for the WHOLE fleet, which also assigns a number to any
  // instance seen for the first time. Bulk rather than per-row: this list runs on a refresh timer.
  const numbers = instanceNumbers([...known.values()].map((m) => instanceRef('desktop', m.dir)))

  const results: CMInstance[] = []
  for (const meta of known.values()) {
    results.push(
      await buildInstanceRow(meta, {
        options,
        running: runningByDir.get(meta.dir),
        memoryByDir,
        metaMap,
        numbers,
        launches,
      }),
    )
  }

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

/**
 * Is this dir the regular, NON-ISOLATED Claude Desktop profile (`claudeUserDataDir()`)?
 *
 * One answer, THREE callers, and they must never disagree: `removeInstance` refuses to delete that
 * profile (core/lifecycle.ts Guard 1), `quitInstance` refuses to kill it without confirmation, and
 * `buildInstanceRow` stamps `CMInstance.isDefault`, which is how a session labelled `'default'`
 * finds its account. A UI calling a row "the default install" while a guard called the same row an
 * ordinary instance would be lying in one of the places, and the lie you notice is the dangerous
 * one. Each of the three used to inline its own copy of this comparison.
 *
 * ⛔ CASE IS FOLDED ONLY ON WINDOWS, matching normalizePath's own rule — POSIX paths are
 * case-sensitive, so `~/.config/Claude` and `~/.config/claude` are two different directories there.
 * The inlined copies lowercased unconditionally, which on Linux/macOS quietly made a differently
 * cased isolated instance look like the default profile. That was merely over-cautious in the two
 * guards (they refuse more than they must); it is not survivable in `isDefault`, where a false
 * positive puts one account's address against another account's chat. The fold is kept explicit
 * rather than trusting normalizePath alone so a future change there cannot silently make the
 * Windows comparison case-sensitive.
 *
 * `dir` must already be normalized. Never throws: an unresolvable default dir means "not the
 * default", never an error out of a list.
 */
export function isDefaultClaudeDir(dir: string): boolean {
  let defaultDir = ''
  try {
    defaultDir = normalizePath(defaultClaudeDir())
  } catch {
    return false
  }
  if (!defaultDir) return false
  const fold = (p: string) => (currentPlatform() === 'win32' ? p.toLowerCase() : p)
  return fold(dir) === fold(defaultDir)
}

/** Builds one row of listInstances's result from its already-gathered per-dir inputs. */
async function buildInstanceRow(
  meta: DiscoveredMeta,
  ctx: {
    options: ListInstancesOptions
    running: CMProcessInfo | undefined
    memoryByDir: Map<string, number>
    metaMap: ReturnType<typeof readInstanceMetaMap>
    numbers: Map<string, number>
    launches: Record<string, number>
  },
): Promise<CMInstance> {
  const { options, running, memoryByDir, metaMap, numbers, launches } = ctx
  let account: CMInstance['account'] = null
  if (options.includeAccount && options.resolveAccount) {
    try {
      account = (await options.resolveAccount(meta.dir)) ?? null
    } catch {
      account = null
    }
  }

  const sizeBytes = options.includeSize ? (dirSizeBytes(meta.dir) ?? null) : null
  const memoryBytes = running ? (memoryByDir.get(meta.dir) ?? null) : null
  const ui = metaMap[meta.dir]

  return {
    num: numbers.get(instanceRef('desktop', meta.dir)) ?? 0,
    name: meta.name,
    dir: meta.dir,
    isRunning: Boolean(running),
    pid: running?.pid ?? null,
    startTime: running?.startTime ?? null,
    lastLaunchedAt: launches[meta.dir] ? new Date(launches[meta.dir]).toISOString() : null,
    sizeBytes,
    memoryBytes,
    account,
    loginUuid: readLoginUuid(meta.dir),
    isExternal: meta.isExternal,
    isDefault: isDefaultClaudeDir(meta.dir),
    label: ui?.label ?? null,
    icon: ui?.icon ?? null,
    color: ui?.color ?? null,
  }
}

// ----------------------------------------------------------------------------
// Open
// ----------------------------------------------------------------------------

/** The argv + spawn flag used to launch an instance so it OUTLIVES this daemon. */
export interface InstanceLaunch {
  argv: string[]
  /** Pass `detached: true` to Bun.spawn (POSIX only; creates a new session via setsid). */
  detached: boolean
}

/**
 * Builds the launch argv for an instance binary, per-OS, such that the launched Claude Desktop
 * is NOT a descendant of this daemon, so quitting AgentHydra can't take the instance with it.
 *
 * WHY this matters: the Windows tray host quits by tree-killing the daemon's whole process tree
 * (`taskkill /PID <daemon> /T /F`, see lunarwerx-ui/src/tray-host/Tray-Host.ts). A Claude Desktop
 * launched as a direct child of the daemon (plain `Bun.spawn([binary, ...args]).unref()`) is IN
 * that tree, so Quit drags the whole instance down with it.
 *
 * The Windows `cmd /c start ""` hand-off and the POSIX `detached:true` are the shared kit primitive
 * (buildDetachedSpawn — see server-lib/detached-spawn.mjs, which documents why `.unref()` /
 * `detached:true` don't break the Windows tree). The ONE app-specific twist here is darwin: we hand
 * the launch to LaunchServices via `open` (which locates + launches Claude Desktop itself, never as
 * our child) instead of spawning the resolved binary — so darwin is handled here and everything else
 * delegates to the primitive. Pure + exported so the detach contract is locked in by unit tests
 * (see instances-launch.test.ts).
 */
export function buildInstanceLaunch(
  platform: NodeJS.Platform,
  binary: string,
  args: string[],
): InstanceLaunch {
  // darwin: `open ...args` hands off to LaunchServices (already detached); the resolved binary is
  // intentionally dropped — `open` finds and launches the app itself.
  if (platform === 'darwin') return { argv: ['open', ...args], detached: false }
  // win32 (`cmd /c start ""` hand-off) + linux (setsid `detached:true`) share the kit primitive.
  return buildDetachedSpawn(platform, [binary, ...args])
}

/**
 * Opens (launches) the given instance dir. If already running, this is a no-op
 * that returns an "already running" success result (focusing the existing window
 * is left to the shell layer (out of scope for this app's browser+tray shell).
 */
const nativeInstanceOpens = new Map<string, Promise<CMActionResult>>()
// Packaged Electron startup rewrites per-user protocol/browser registrations. Serialize managed
// startups so one profile cannot snapshot another profile's temporary registration as its baseline.
let nativeInstanceOpenQueue: Promise<void> = Promise.resolve()

export async function openInstance(dir: string): Promise<CMActionResult> {
  const normDir = normalizePath(dir)
  let nativeConfig: ReturnType<typeof getClaudeNativeProfileConfig>
  try {
    // Every desktop profile runs native control unless a person opted it out (2026-09-20).
    // Scoped to AgentHydra's own profiles; the machine's default Claude login is never touched.
    nativeConfig =
      (currentPlatform() === 'win32' && isPathInside(instancesRoot(), normDir)
        ? ensureClaudeNativeProfileConfig(normDir)
        : null) ?? getClaudeNativeProfileConfig(normDir)
  } catch (error) {
    return {
      ok: false,
      action: 'open',
      dir: normDir,
      message: `Invalid native launch configuration: ${error instanceof Error ? error.message : String(error)}`,
      data: {},
    }
  }
  if (!nativeConfig?.launchDebugger) return openConfiguredInstance(normDir, nativeConfig)
  const pending = nativeInstanceOpens.get(normDir)
  if (pending) return pending
  const operation = nativeInstanceOpenQueue.then(() =>
    openConfiguredInstance(normDir, nativeConfig),
  )
  nativeInstanceOpenQueue = operation.then(
    () => undefined,
    () => undefined,
  )
  nativeInstanceOpens.set(normDir, operation)
  try {
    return await operation
  } finally {
    if (nativeInstanceOpens.get(normDir) === operation) nativeInstanceOpens.delete(normDir)
  }
}

/**
 * Is this profile's app already up? Returns the "already running" success result when it is,
 * the native-config failure result when the freshness check itself failed on a managed profile
 * (the caller cannot decide), and `undefined` when nothing is running.
 *
 * Split out of openConfiguredInstance so its freshness scan + its two-shaped failure path do not
 * nest inside the launch dispatch below. Behaviour is unchanged.
 */
async function probeRunningInstance(
  normDir: string,
  nativeConfig: ReturnType<typeof getClaudeNativeProfileConfig>,
): Promise<CMActionResult | undefined> {
  try {
    // fresh: this decides whether to LAUNCH. A cached snapshot a poll tick old could miss an
    // instance that just started (→ a second copy on the same profile) or still show one the
    // user just quit (→ a click that silently does nothing).
    let procs: CMProcessInfo[]
    if (nativeConfig?.launchDebugger) {
      const scan = await scanClaudeProcesses({ fresh: true })
      if (!scan.ok) throw Error('Could not verify that the native Claude profile is closed')
      procs = scan.processes
    } else procs = await listClaudeProcesses({ fresh: true })
    const running = procs.find((p) => p.dir && normalizePath(p.dir) === normDir)
    if (running) {
      return {
        ok: true,
        action: 'open',
        dir: normDir,
        message: 'already running',
        data: { pid: running.pid },
      }
    }
  } catch (error) {
    if (nativeConfig?.launchDebugger) {
      return {
        ok: false,
        action: 'open',
        dir: normDir,
        message: error instanceof Error ? error.message : String(error),
        data: {},
      }
    }
    // Best-effort; if we can't determine running state, still attempt the launch
    // rather than silently failing here.
  }
  return undefined
}

/** The launch binary, or null when it could not be resolved (the caller still answers a result). */
async function resolveLaunchBinaryOrNull(): Promise<string | null> {
  try {
    return await resolveLaunchBinary()
  } catch {
    return null
  }
}

/**
 * The failure result for "no binary": say WHY when we can, because on Windows the usual culprit
 * is the MSIX build (not launchable with --user-data-dir, see core/desktop-install.ts), so the
 * failure toast becomes actionable instead of a dead end.
 */
async function noLaunchBinaryResult(normDir: string): Promise<CMActionResult> {
  let message = 'No Claude launch binary could be resolved.'
  try {
    const install = await detectDesktopInstall()
    if (install.platform === 'win32') {
      message = install.msixDetected
        ? 'Only the MSIX (Windows Apps) build of Claude Desktop is installed; it cannot be launched with an isolated profile. Install the classic Windows installer.'
        : 'No Claude Desktop installation was found. Install the classic Windows installer.'
    }
  } catch {
    // Detection is best-effort; keep the generic message.
  }
  return {
    ok: false,
    action: 'open',
    dir: normDir,
    message,
    data: {},
  }
}

async function openConfiguredInstance(
  normDir: string,
  nativeConfig: ReturnType<typeof getClaudeNativeProfileConfig>,
): Promise<CMActionResult> {
  const running = await probeRunningInstance(normDir, nativeConfig)
  if (running) return running

  const binary = await resolveLaunchBinaryOrNull()
  if (!binary) return await noLaunchBinaryResult(normDir)

  return dispatchConfiguredLaunch(normDir, binary, nativeConfig)
}

/** The scratch one launch attempt carries: what we spawned (so a partial failure can name it) and
 *  whether a process actually got started. */
interface LaunchAttempt {
  dispatched: boolean
  nativeData?: Record<string, unknown>
}

/** What a launch that reached verification reports: the pid to answer with, and the registry
 *  restoration that was performed (null when this profile needed no guard). */
interface VerifiedLaunch {
  pid: number
  registryRestoration: NativeLaunchRegistryResult | null
}

type NativeLaunchPlan = Awaited<ReturnType<typeof prepareClaudeNativeLaunch>>

/**
 * Spawn the launch, wait for a managed profile to report ready, restore the registry guard, and
 * answer either the launch result or the (possibly partial) failure. Split out of
 * openConfiguredInstance; the spawn/verify/restore order and every side effect are unchanged.
 */
async function dispatchConfiguredLaunch(
  normDir: string,
  binary: string,
  nativeConfig: ReturnType<typeof getClaudeNativeProfileConfig>,
): Promise<CMActionResult> {
  const attempt: LaunchAttempt = { dispatched: false }
  try {
    const plan = await prepareClaudeNativeLaunch(binary, nativeConfig)
    if (plan.nativeDebugger)
      attempt.nativeData = { binary: plan.binary, nativeDebugger: plan.nativeDebugger }
    const { argv, detached } = buildInstanceLaunch(process.platform, plan.binary, [
      ...plan.extraArgs,
      ...launchArgs(normDir),
    ])
    const registryGuard = plan.nativeDebugger
      ? await beginNativeLaunchRegistryGuard(plan.binary, normDir)
      : null
    const verified = await spawnVerifyAndRestore({
      normDir,
      plan,
      argv,
      detached,
      registryGuard,
      attempt,
    })
    // The world just changed under the cached snapshot — drop it so the poll tick that follows
    // this click shows the row as running instead of waiting out the TTL.
    invalidateClaudeProcessCache()
    return launchedResult(normDir, plan, verified)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'open',
      dir: normDir,
      message:
        attempt.nativeData && attempt.dispatched
          ? `Claude launch dispatched, but startup verification failed: ${message}`
          : `Failed to launch: ${message}`,
      data: attempt.nativeData
        ? {
            ...attempt.nativeData,
            launchDispatched: attempt.dispatched,
            nativeDebuggerReady: false,
          }
        : {},
    }
  }
}

/** The success result for a verified launch. */
function launchedResult(
  normDir: string,
  plan: NativeLaunchPlan,
  verified: VerifiedLaunch,
): CMActionResult {
  return {
    ok: true,
    action: 'open',
    dir: normDir,
    message: 'launched',
    // Stock win32/darwin launches return the transient hand-off PID; managed launches return
    // the real instance PID verified through its own inspector after startup.
    data: {
      binary: plan.binary,
      pid: verified.pid,
      ...(plan.nativeDebugger
        ? {
            nativeDebugger: plan.nativeDebugger,
            nativeDebuggerReady: true,
            registryRestoration: verified.registryRestoration,
          }
        : {}),
    },
  }
}

/**
 * Spawn and (for a managed profile) wait for readiness, and ALWAYS restore the registry guard
 * afterwards - whether or not any of that worked - then report or throw the accumulated failure.
 */
async function spawnVerifyAndRestore(args: {
  normDir: string
  plan: NativeLaunchPlan
  argv: string[]
  detached: boolean
  registryGuard: { restore(): Promise<NativeLaunchRegistryResult> } | null
  attempt: LaunchAttempt
}): Promise<VerifiedLaunch> {
  const { normDir, plan, argv, detached, registryGuard, attempt } = args
  let pid = 0
  let launchError: unknown
  let restorationError: unknown
  let registryRestoration: NativeLaunchRegistryResult | null = null
  try {
    pid = await spawnAndAwaitReady(normDir, plan, argv, detached, attempt)
  } catch (error) {
    launchError = error
  } finally {
    if (registryGuard) {
      try {
        registryRestoration = await registryGuard.restore()
      } catch (error) {
        restorationError = error
      }
      if (attempt.nativeData) attempt.nativeData.registryRestoration = registryRestoration
    }
  }
  const failures = launchFailures(launchError, restorationError, registryRestoration, attempt)
  if (failures.length) throw Error(failures.join('; '))
  return { pid, registryRestoration }
}

/** Every reason this attempt must be answered as a failure, in the order they were found. */
function launchFailures(
  launchError: unknown,
  restorationError: unknown,
  registryRestoration: NativeLaunchRegistryResult | null,
  attempt: LaunchAttempt,
): string[] {
  const failures: string[] = []
  if (launchError)
    failures.push(launchError instanceof Error ? launchError.message : String(launchError))
  if (restorationError) {
    const reason =
      restorationError instanceof Error ? restorationError.message : String(restorationError)
    failures.push(`Registration restoration failed: ${reason}`)
    if (attempt.nativeData) attempt.nativeData.registryRestorationError = reason
  }
  if (registryRestoration?.errors.length) {
    failures.push(`Registration restoration failed: ${registryRestoration.errors.join('; ')}`)
  }
  return failures
}

/** Spawn the argv and, for a managed profile, wait until its inspector answers; returns the pid to
 *  report. Split out so the guard/restore bookkeeping above is not nested inside the spawn. */
async function spawnAndAwaitReady(
  normDir: string,
  plan: NativeLaunchPlan,
  argv: string[],
  detached: boolean,
  attempt: LaunchAttempt,
): Promise<number> {
  if (plan.nativeDebugger) {
    await assertClaudeInspectorPortAvailable(plan.nativeDebugger.port)
  }
  const startupLogCursor = plan.nativeDebugger
    ? await captureNativeLaunchLogCursor(normDir)
    : undefined
  const proc = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    ...(detached ? { detached: true } : {}),
  })
  proc.unref()
  attempt.dispatched = true
  // Stamped at spawn, not at readiness: the app WAS started on this PC even if the managed
  // handshake that follows fails, and the process scan will confirm or refine the time.
  recordInstanceLaunches([{ dir: normDir, at: Date.now() }])
  invalidateClaudeProcessCache()
  if (attempt.nativeData) attempt.nativeData.handoffPid = proc.pid
  let known: CMProcessInfo | null = null
  if (plan.nativeDebugger) {
    const ready = await waitForNativeLaunchReady({
      profileDir: normDir,
      binary: plan.binary,
      port: plan.nativeDebugger.port,
      startupLogCursor,
    })
    if (attempt.nativeData) attempt.nativeData.pid = ready.pid
    known = ready.owner
  }
  return confirmLaunchSurvives(normDir, {}, known)
}

/** How long a launched app must stay up before the launch is answered "launched", and how long it
 *  may take to show up in the process list at all. */
const LAUNCH_SURVIVAL_MS = 5_000
const LAUNCH_APPEAR_MS = 30_000
/** The gap between process scans while waiting for the app to appear. Each scan is itself a
 *  powershell + CIM round trip (1.0-1.5s measured 2026-09-25 with 112 claude.exe running), so a
 *  full second on top of that only delayed noticing an app that was already there. */
const LAUNCH_POLL_MS = 300
/** How often the survival window re-checks the one pid it is watching (signal 0, no scan). */
const LAUNCH_LIVENESS_POLL_MS = 250
/** How many times the watched main process may hand over to a new pid before the scan's answer is
 *  taken as it stands. */
const LAUNCH_MAX_HANDOFFS = 2

export interface LaunchSurvivalDeps {
  scan?: () => Promise<{ ok: true; processes: CMProcessInfo[] } | { ok: false; reason: string }>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Whether `pid` is still running. Defaults to isPidAlive (signal 0); injected by tests. */
  alive?: (pid: number) => boolean
}

/**
 * The pid of this profile's main process once it has been seen AND has been up for
 * LAUNCH_SURVIVAL_MS; throws otherwise.
 *
 * ⛔ "launched" USED TO MEAN "a process was handed the argv" (found live 2026-09-24, chat
 * ffb5fe39): `launch_instance {instance: 26}` answered `launched` with pid 42632 - the transient
 * `cmd /c start` hand-off on a stock launch - and seconds later `list_instances` showed it not
 * running. An app that exits within seconds of starting did not launch, and fan_out, which opens
 * closed accounts through this, must hear that as a failure rather than wait out its own timer.
 *
 * THE WINDOW COUNTS FROM THE PROCESS'S OWN START TIME, NOT FROM WHEN A SCAN NOTICED IT (2026-09-25,
 * owner: "why is Agent Hydra so friggin slow at opening instances"). The first cut slept the full
 * 5s after the scan that found the app and then ran one more full scan, so every open paid scan +
 * 5s + scan (~8s) on top of Claude's own startup, and a managed launch that had already waited
 * several seconds for its inspector paid all of it again. Now the scan's CreationDate starts the
 * clock, the watched pid is re-checked with signal 0 while the window runs (an early exit is
 * reported as soon as it happens), and a full scan is paid again only when that pid has died, to
 * see whether the profile's main process lives on under another pid. `known` is the row a managed
 * launch's readiness wait already found (it scanned for it): no scan is needed to find it again.
 */
export async function confirmLaunchSurvives(
  normDir: string,
  deps: LaunchSurvivalDeps = {},
  known: CMProcessInfo | null = null,
): Promise<number> {
  const scan = deps.scan ?? (() => scanClaudeProcesses({ fresh: true }))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  const alive = deps.alive ?? isPidAlive
  const want = normalizePath(normDir)
  const mainProc = async (): Promise<{ proc: CMProcessInfo | null; failed?: string }> => {
    const s = await scan()
    if (!s.ok) return { proc: null, failed: s.reason }
    const hit = s.processes.find((p) => p.isMain && p.dir && normalizePath(p.dir) === want)
    return { proc: hit ?? null }
  }
  const deadline = now() + LAUNCH_APPEAR_MS
  let seen: CMProcessInfo | null =
    known?.isMain && known.dir && normalizePath(known.dir) === want ? known : null
  let lastFailure: string | undefined
  while (seen === null) {
    const r = await mainProc()
    seen = r.proc
    lastFailure = r.failed ?? lastFailure
    if (seen !== null) break
    if (now() >= deadline)
      throw Error(
        `the app never appeared in the process list within ${LAUNCH_APPEAR_MS / 1000}s` +
          (lastFailure ? ` (process scan failed: ${lastFailure})` : ''),
      )
    await sleep(LAUNCH_POLL_MS)
  }
  // A hand-off (a stub that starts the real app and exits) shows up as a main process that dies
  // while a new one takes over; the successor must survive its own window too. Bounded, so a
  // profile whose main process keeps changing cannot hold the launch forever.
  let watched = seen
  for (let handoffs = 0; ; handoffs++) {
    const pid = watched.pid
    // A start time in the future (clock skew, a bad parse) must not stretch the window, and one we
    // cannot read falls back to the moment we saw the process, which is the old, longer wait.
    const started = watched.startTime ? Date.parse(watched.startTime) : Number.NaN
    const upSince = Number.isFinite(started) ? Math.min(started, now()) : now()
    const survivedAt = upSince + LAUNCH_SURVIVAL_MS
    while (alive(pid) && now() < survivedAt) {
      await sleep(Math.min(LAUNCH_LIVENESS_POLL_MS, survivedAt - now()))
    }
    if (alive(pid)) return pid
    // The pid we watched is gone. Before calling the launch failed, look once more: the profile's
    // main process may be running under another pid.
    const after = await mainProc()
    if (after.failed)
      throw Error(`started (pid ${pid}), but could not confirm it stayed up: ${after.failed}`)
    if (after.proc === null)
      throw Error(`started (pid ${pid}) and exited within ${LAUNCH_SURVIVAL_MS / 1000}s`)
    // The scan still lists the pid signal 0 called gone, or the main process keeps changing: the
    // scan is the authority, as the full rescan after the window always was.
    if (after.proc.pid === pid || handoffs >= LAUNCH_MAX_HANDOFFS) return after.proc.pid
    watched = after.proc
  }
}

// ----------------------------------------------------------------------------
// Quit
// ----------------------------------------------------------------------------

export interface QuitInstanceOptions {
  /** Skip the graceful phase and force-kill immediately. */
  force?: boolean
  /** How long to wait for a graceful exit before force-killing (ms). Default 5000. */
  gracefulTimeoutMs?: number
  /**
   * Explicit confirmation required to quit the DEFAULT (non-isolated) Claude Desktop profile —
   * the user's real, externally-managed Claude Desktop (the "External" instance row). Without
   * this, quitInstance refuses up front, before any process is even enumerated: unlike an
   * isolated instance dir this app created, that profile may have a real, in-progress
   * conversation. Mirrors removeInstance()'s Guard 1 in core/lifecycle.ts — same protection,
   * quit-side. Ignored (no effect) for any other dir.
   */
  confirmExternal?: boolean
  /**
   * Process-list source, injected so tests can exercise the guard/kill path deterministically
   * without spawning real OS process enumeration or risking a real kill (mirrors
   * ListInstancesOptions.resolveAccount's injection style). Defaults to listClaudeProcesses.
   */
  listProcesses?: (options: ListClaudeProcessesOptions) => Promise<CMProcessInfo[]>
}

/** True while any of `pids` is still alive (signal-0 probe, see isPidAlive). */
function anyAlive(pids: number[]): boolean {
  return pids.some(isPidAlive)
}

async function forceKillPid(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    try {
      const proc = Bun.spawn(['taskkill', '/pid', String(pid), '/f', '/t'], {
        stdout: 'ignore',
        stderr: 'ignore',
        windowsHide: true,
      })
      // Bounded (swept 2026-09-18): `await proc.exited` with nothing racing it hangs the caller
      // forever if taskkill itself wedges, and this sits on the quit path.
      await awaitExitBounded(proc, TASKKILL_TIMEOUT_MS)
    } catch {
      // Best-effort; process may have already exited between scan and kill.
    }
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already dead or not ours; ignore.
  }
}

async function gracefulKillPid(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    try {
      // No /f: asks the process to close its main window first (best-effort graceful).
      const proc = Bun.spawn(['taskkill', '/pid', String(pid), '/t'], {
        stdout: 'ignore',
        stderr: 'ignore',
        windowsHide: true,
      })
      // Bounded (swept 2026-09-18): `await proc.exited` with nothing racing it hangs the caller
      // forever if taskkill itself wedges, and this sits on the quit path.
      await awaitExitBounded(proc, TASKKILL_TIMEOUT_MS)
    } catch {
      // Ignore; we'll force-kill on timeout regardless.
    }
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already dead or not ours; ignore.
  }
}

/**
 * Finds every Claude process (main + `--type=` children) whose `--user-data-dir`
 * matches `dir`, tries a graceful shutdown first (unless `force`), then force-kills
 * anything still alive after the grace period. Returns the count actually stopped.
 */
export async function quitInstance(
  dir: string,
  options: QuitInstanceOptions = {},
): Promise<CMActionResult> {
  const normDir = normalizePath(dir)
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5000

  // --- Guard: never quit the default (non-isolated) Claude Desktop profile without explicit
  // confirmation. This is the quit-side analog of removeInstance()'s Guard 1 (core/lifecycle.ts):
  // that dir is the user's REAL, externally-managed Claude Desktop, not an isolated instance this
  // app created, and may have a real conversation in progress. Checked (and refused) BEFORE any
  // process enumeration, so an unconfirmed quit of the default dir never even lists processes.
  // Shared with the row builder's `isDefault` flag, so the guard and the UI can never disagree
  // about which row IS the regular install — see isDefaultClaudeDir.
  if (isDefaultClaudeDir(normDir) && options.confirmExternal !== true) {
    return {
      ok: false,
      action: 'quit',
      dir: normDir,
      message:
        'Refusing to quit the regular (non-isolated) Claude Desktop without explicit confirmation: it may have a real conversation in progress. Pass confirmExternal to proceed.',
      data: { killedCount: 0 },
    }
  }

  const listProcesses = options.listProcesses ?? listClaudeProcesses

  let matched: CMProcessInfo[]
  try {
    // fresh: these PIDs are about to be KILLED. Acting on a cached snapshot risks signalling a
    // PID the OS has since handed to an unrelated process.
    const all = await listProcesses({ includeChildren: true, fresh: true })
    matched = all.filter((p) => p.dir && normalizePath(p.dir) === normDir)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'quit',
      dir: normDir,
      message: `Failed enumerating processes: ${message}`,
      data: { killedCount: 0 },
    }
  }

  if (matched.length === 0) {
    return {
      ok: true,
      action: 'quit',
      dir: normDir,
      message: 'not running',
      data: { killedCount: 0 },
    }
  }

  const pids = matched.map((p) => p.pid)

  if (!options.force) {
    const main = matched.find((p) => p.isMain) ?? matched[0]
    if (main) {
      await gracefulKillPid(main.pid)
      // THE GRACE IS FOR THE MAIN PROCESS; THE HELPERS GET A SHORT SETTLE (2026-09-25, owner: "why
      // is Agent Hydra so friggin slow at closing instances"). Only the main process was asked to
      // close, and it is the one that runs Claude's quit cleanup (median ~1s across 41 logged
      // quits in this PC's profiles). The loop used to wait for EVERY pid, so one lingering
      // renderer or crashpad helper held the close to the full 5s. Now: the main process gets the
      // whole grace; once it is gone the helpers get QUIT_CHILD_SETTLE_MS to exit on their own
      // (the network service may still be flushing cookies), then whatever is left is forced.
      const deadline = Date.now() + gracefulTimeoutMs
      while (Date.now() < deadline && isPidAlive(main.pid)) await sleep(QUIT_POLL_MS)
      const settleBy = Math.min(deadline, Date.now() + QUIT_CHILD_SETTLE_MS)
      while (Date.now() < settleBy && anyAlive(pids)) await sleep(QUIT_POLL_MS)
    }
  }

  const stillAlive = pids.filter(isPidAlive)

  let forceKilled = 0
  if (stillAlive.length > 0) {
    await Promise.all(
      stillAlive.map(async (pid) => {
        await forceKillPid(pid)
        forceKilled += 1
      }),
    )
  }

  const gracefullyStopped = pids.length - stillAlive.length
  const totalAccountedFor = Math.max(0, gracefullyStopped) + forceKilled

  // Same reason as openInstance's: the row the user just acted on must go grey on the very next
  // poll, not whenever the cached snapshot happens to age out.
  invalidateClaudeProcessCache()

  return {
    ok: true,
    action: 'quit',
    dir: normDir,
    message: `stopped ${totalAccountedFor} process(es)`,
    data: { killedCount: totalAccountedFor },
  }
}

// ----------------------------------------------------------------------------
// Focus
// ----------------------------------------------------------------------------

/** Runs a small PowerShell snippet that finds the first visible top-level window owned by
 *  `pid`, restores it if minimized, and brings it to the foreground via user32. Returns
 *  'focused' | 'no-window' | an error string. Never throws. */
async function focusWindowByPid(pid: number): Promise<'focused' | 'no-window' | string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -Namespace AgentHydra -Name Win32 -MemberDefinition @"' +
      '\n[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);' +
      '\n[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);' +
      '\n[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);' +
      '\n[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' +
      '\n[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);' +
      '\npublic delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);' +
      '\n"@',
    `$targetPid = ${pid}`,
    '$found = [IntPtr]::Zero',
    '$callback = {',
    '  param([IntPtr]$hWnd, [IntPtr]$lParam)',
    '  $procId = 0',
    '  [void][AgentHydra.Win32]::GetWindowThreadProcessId($hWnd, [ref]$procId)',
    '  if ($procId -eq $targetPid -and [AgentHydra.Win32]::IsWindowVisible($hWnd)) {',
    '    $script:found = $hWnd',
    '    return $false',
    '  }',
    '  return $true',
    '}',
    '[void][AgentHydra.Win32]::EnumWindows($callback, [IntPtr]::Zero)',
    'if ($found -eq [IntPtr]::Zero) {',
    '  Write-Output "NO_WINDOW"',
    '} else {',
    '  [void][AgentHydra.Win32]::ShowWindow($found, 9)',
    '  $ok = [AgentHydra.Win32]::SetForegroundWindow($found)',
    '  if ($ok) { Write-Output "FOCUSED" } else { Write-Output "FOREGROUND_DENIED" }',
    '}',
  ].join('\n')

  // Bounded, and through the one bounded spawn (swept 2026-09-18). The hand-rolled version here
  // awaited both drains AND proc.exited, which settles on the SLOWEST of the three - and this
  // script's `Add-Type` makes powershell spawn the C# compiler, a grandchild that inherits these
  // pipes and can hold them open after powershell itself is gone. A focus click is not worth a
  // route that never answers.
  const r = await spawnCaptured(
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
    { timeoutMs: FOCUS_TIMEOUT_MS },
  )
  if (r.timedOut) return `focus timed out after ${FOCUS_TIMEOUT_MS / 1000}s`
  const trimmed = r.stdout.trim()
  if (trimmed.includes('FOCUSED')) return 'focused'
  if (trimmed.includes('NO_WINDOW')) return 'no-window'
  if (trimmed.includes('FOREGROUND_DENIED')) return 'foreground denied by Windows'
  if (r.code !== 0) return r.stderr.trim() || `powershell exited with code ${r.code}`
  return 'no-window'
}

/**
 * Brings the running instance's main window to the foreground on Windows (PID-driven, via
 * user32 EnumWindows/SetForegroundWindow). Gracefully no-ops on non-Windows platforms and
 * when the instance isn't currently running.
 */
export async function focusInstance(dir: string): Promise<CMActionResult> {
  const normDir = normalizePath(dir)

  if (process.platform !== 'win32') {
    return {
      ok: false,
      action: 'focus',
      dir: normDir,
      message: 'not supported on this platform',
      data: {},
    }
  }

  let procs: CMProcessInfo[]
  try {
    // fresh: this resolves the PID whose window we are about to raise; a stale one is either a
    // dead PID or, worse, a recycled one belonging to something else entirely.
    procs = await listClaudeProcesses({ fresh: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'focus',
      dir: normDir,
      message: `Failed enumerating processes: ${message}`,
      data: {},
    }
  }

  const running = procs.find((p) => p.dir && normalizePath(p.dir) === normDir)
  if (!running) {
    return { ok: false, action: 'focus', dir: normDir, message: 'not running', data: {} }
  }

  try {
    const outcome = await focusWindowByPid(running.pid)
    if (outcome === 'focused') {
      return {
        ok: true,
        action: 'focus',
        dir: normDir,
        message: 'focused',
        data: { pid: running.pid },
      }
    }
    if (outcome === 'no-window') {
      return {
        ok: false,
        action: 'focus',
        dir: normDir,
        message: 'no window found for this instance',
        data: { pid: running.pid },
      }
    }
    return {
      ok: false,
      action: 'focus',
      dir: normDir,
      message: outcome,
      data: { pid: running.pid },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'focus',
      dir: normDir,
      message: `Failed to focus: ${message}`,
      data: {},
    }
  }
}

// ----------------------------------------------------------------------------
// Reveal folder
// ----------------------------------------------------------------------------

/** Reveals the instance's profile directory in the OS file browser (Explorer/Finder/xdg-open).
 *  Fire-and-forget, matching the existing open-file route's style (index.ts's /open-file);
 *  Explorer's own exit code is unreliable, so success just means the spawn didn't throw.
 *
 *  NO windowsHide HERE, and it must stay that way: explorer is a GUI program, and Bun's windowsHide
 *  is libuv's hide flag, which sets STARTUPINFO SW_HIDE as well as CREATE_NO_WINDOW. A console app
 *  ignores SW_HIDE, but a GUI app obeys it, so hiding this spawn hides the very window the button
 *  exists to open: the route still returns ok, and nothing appears. Measured 2026-07-16, spawning
 *  `explorer <dir>` both ways: plain opened 1 Explorer window, windowsHide opened 0.
 *  (index.ts's open-file route is the safe-looking exception: `cmd /c start` hides only the
 *  transient cmd, because `start` ShellExecutes the target as a fresh process that inherits none of
 *  our STARTUPINFO.) */
export async function revealInstanceFolder(dir: string): Promise<CMActionResult> {
  const normDir = normalizePath(dir)
  try {
    const cmd =
      process.platform === 'win32'
        ? ['explorer', normDir]
        : process.platform === 'darwin'
          ? ['open', normDir]
          : ['xdg-open', normDir]
    Bun.spawn(cmd, {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }).unref()
    return { ok: true, action: 'reveal', dir: normDir, message: 'opened', data: {} }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'reveal',
      dir: normDir,
      message: `Failed to open folder: ${message}`,
      data: {},
    }
  }
}
