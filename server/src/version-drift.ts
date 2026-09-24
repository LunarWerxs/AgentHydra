// server/src/version-drift.ts - notice when the fleet is not on one Claude version, say so, and
// bring what is safe to touch up to date on its own.
//
// WHY (owner, 2026-09-23: "any time AgentHydra spots an old version, it makes a flag ... or
// automatically updates them all to the newest version if they're closed"). Every Desktop profile
// keeps its OWN Claude Code download under <profile>\claude-code\<version>\ and refreshes it only
// when that profile starts a session, so the 21 profiles measured that day held versions from
// 2.1.266 to 2.1.280 on disk while the five running ones agreed. The terminal CLI instances run a
// third copy (the npm global install) that nothing watched: it sat at 2.1.278 under 2.1.280.
//
// What can drift, and what happens to each:
//   1. A RUNNING Desktop on an older build than the newest installed one (an update landed while it
//      was open). Never restarted from here (AGENTS.md: do not close an active desktop), so it is
//      FLAGGED as an incident naming the instance; the person reopens it when it is idle.
//   2. LIVE CHATS whose engine is older than the version the newest Desktop asks for (they started
//      before an update). Same rule: flagged, never killed.
//   3. A CLOSED profile whose staged Claude Code is behind. The app would download the new one at
//      its next session anyway (measured: `[CCD] Downloading ... 2.1.280` on first launch); this
//      stages it now by hard-linking the exact verified files a profile already downloaded, so the
//      folder is byte-identical to what the app would have fetched, and appears in one rename.
//   4. The CLI install behind the Desktop's version: updated with npm, pinned to the Desktop's
//      version so terminal and desktop chats run one engine, only while nothing runs from it.
// A flag that stops being true resolves its own incident, so the Incidents panel shows only what is
// still wrong. AGENTHYDRA_VERSION_AUTOFIX=0 turns 3 and 4 into flags too.

import { createHash } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { copyFile, link, mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { listCliInstances } from './core/cli-instances'
import { listInstances } from './core/instances'
import { scanClaudeProcesses, spawnCaptured } from './core/process'
import {
  deliverIncidentNotification,
  listIncidents,
  recordIncident,
  resolveIncident,
} from './incidents'
import { readLiveRegistry } from './live-registry'

export const VERSION_DRIFT_SCOPE = 'version-drift'
export const VERSION_DRIFT_MS = 10 * 60_000
const FIRST_CHECK_DELAY_MS = 90_000
const LOG_TAIL_BYTES = 512 * 1024
const NPM_TIMEOUT_MS = 5 * 60_000
const CLI_PACKAGE = '@anthropic-ai/claude-code'
const SEMVER_RE = /^\d+(?:\.\d+)+$/

// --- versions ------------------------------------------------------------------------------------

/** Numeric, part by part; a missing part is 0. Non-numeric parts compare as 0 rather than throw. */
export function compareVersion(a: string, b: string): number {
  const av = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const bv = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

function newest(versions: Iterable<string>): string | null {
  let best: string | null = null
  for (const v of versions) if (best === null || compareVersion(v, best) > 0) best = v
  return best
}

/** The Desktop build a running main process was started from, read off its own command line: the
 *  managed copy (`...\claude-native\<build>-<hash>\claude.exe`) or a Squirrel app folder
 *  (`...\app-<build>\claude.exe`). Null for the version-less stub, which cannot be told apart. */
export function desktopBuildFromCmdline(cmdline: string): string | null {
  const managed = /[\\/]claude-native[\\/](\d+(?:\.\d+)+)-[^\\/"]*[\\/]claude\.exe/i.exec(cmdline)
  if (managed) return managed[1]
  const squirrel = /[\\/]app-(\d+(?:\.\d+)+)[\\/]claude\.exe/i.exec(cmdline)
  return squirrel ? squirrel[1] : null
}

/** The newest `app-<build>` folder of the Squirrel install, which is what every AgentHydra launch
 *  uses (claude-native-launch.ts resolveClaudeNativeSource). Null when there is none. */
export function newestInstalledDesktop(installRoot: string): string | null {
  try {
    const builds = readdirSync(installRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^app-\d+(?:\.\d+)*$/.test(e.name))
      .map((e) => e.name.slice(4))
    return newest(builds)
  } catch {
    return null
  }
}

/** The Claude Code version this profile's Desktop last asked for, from the newest line in its
 *  main.log that names it. Reads the tail only - the log of a long-lived profile runs to tens of MB. */
export function requestedEngineVersion(profileDir: string): string | null {
  const path = join(profileDir, 'logs', 'main.log')
  let text: string
  let fd: number | undefined
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - LOG_TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    fd = openSync(path, 'r')
    const bytes = readSync(fd, buf, 0, buf.length, start)
    text = buf.subarray(0, bytes).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  // `Initialized with version` is logged once per app start and scrolls out of a long-lived
  // profile's tail (measured on five open profiles, 2026-09-23); `required_version:` is logged on
  // every chat spawn, so between the two a profile that is doing anything always answers.
  let last: string | null = null
  const asked =
    /\[CCD\] (?:Initialized with version |session spawn on required_version:)(\d+(?:\.\d+)+)/g
  for (const m of text.matchAll(asked)) last = m[1]
  return last
}

interface StagedBuild {
  version: string
  dir: string
  exe: string
  size: number
  sha256: string
}

/** One `<profile>\claude-code\<version>\` folder the app finished: claude.exe plus the `.payload`
 *  (its sha256 and size) and `.verified` markers it writes after checking the download. Anything
 *  short of all three, or an exe whose size disagrees with its own payload, is not a finished copy. */
function readStagedBuild(ccDir: string, version: string): StagedBuild | null {
  const dir = join(ccDir, version)
  const exe = join(dir, 'claude.exe')
  try {
    if (!existsSync(join(dir, '.verified'))) return null
    const payload = JSON.parse(readFileSync(join(dir, '.payload'), 'utf8'))
    const size = statSync(exe).size
    if (typeof payload?.sha256 !== 'string' || payload.size !== size) return null
    return { version, dir, exe, size, sha256: payload.sha256.toLowerCase() }
  } catch {
    return null
  }
}

/** Every finished Claude Code copy staged under one profile, newest first. */
export function stagedEngineVersions(profileDir: string): StagedBuild[] {
  const ccDir = join(profileDir, 'claude-code')
  let names: string[]
  try {
    names = readdirSync(ccDir).filter((n) => SEMVER_RE.test(n))
  } catch {
    return []
  }
  return names
    .map((n) => readStagedBuild(ccDir, n))
    .filter((b): b is StagedBuild => b !== null)
    .sort((a, b) => compareVersion(b.version, a.version))
}

/** The npm-installed CLI's version, from the package's own package.json (no spawn). */
export function npmCliVersion(npmRoot: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
        'utf8',
      ),
    )
    return typeof pkg?.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

// --- the report ----------------------------------------------------------------------------------

export interface DriftInstanceRow {
  num: number
  name: string
  dir: string
  running: boolean
  /** Desktop build it runs now (running only; null when the command line does not say). */
  build: string | null
  /** Newest finished Claude Code copy staged in the profile. */
  stagedEngine: string | null
  /** True when the staged copy is older than the fleet target (or missing where others have one). */
  engineBehind: boolean
}

export interface DriftLiveChat {
  pid: number
  sessionId: string
  name: string
  cwd: string
  version: string
}

export interface DriftFlag {
  key: string
  message: string
}

export interface VersionDriftReport {
  checkedAt: string
  desktop: { newestInstalled: string | null; behind: number }
  engine: {
    /** The Claude Code version the fleet should be on, and where that answer came from. */
    target: string | null
    targetSource: 'desktop-log' | 'staged' | 'none'
    liveChats: DriftLiveChat[]
    staleLiveChats: number
  }
  cli: { version: string | null; behind: boolean }
  instances: DriftInstanceRow[]
  flags: DriftFlag[]
}

export interface VersionDriftDeps {
  desktopInstallRoot: string
  npmRoot: string
  /** Claude homes whose `sessions\` registry lists live chats: the default one plus every CLI
   *  instance's config dir. */
  claudeHomes: () => string[]
  listInstances: () => Promise<
    Array<{ num: number; name: string; dir: string; isRunning: boolean }>
  >
  /** Main Desktop processes with their command lines, freshly scanned. */
  runningMains: () => Promise<Array<{ dir: string | null; cmdline: string }> | null>
  now: () => Date
}

function localAppData(): string {
  return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
}

function appData(): string {
  return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
}

export const defaultVersionDriftDeps: VersionDriftDeps = {
  desktopInstallRoot: join(localAppData(), 'AnthropicClaude'),
  npmRoot: join(appData(), 'npm'),
  claudeHomes: () => {
    const homes = [process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')]
    try {
      for (const c of listCliInstances()) homes.push(c.configDir)
    } catch {
      // the CLI store is unreadable; the default home still answers
    }
    return [...new Set(homes)]
  },
  listInstances: () => listInstances(),
  runningMains: async () => {
    const scan = await scanClaudeProcesses({ fresh: true })
    return scan.ok ? scan.processes.map((p) => ({ dir: p.dir, cmdline: p.cmdline })) : null
  },
  now: () => new Date(),
}

function normDir(dir: string): string {
  return dir.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Build per running profile (normalized dir -> build). */
function runningBuilds(
  mains: Array<{ dir: string | null; cmdline: string }> | null,
): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const m of mains ?? [])
    if (m.dir) out.set(normDir(m.dir), desktopBuildFromCmdline(m.cmdline))
  return out
}

/** What version the fleet should run: what a profile ALREADY ON the newest installed build asked
 *  for, else the newest finished copy staged anywhere (the previous build's choice), else nothing. */
function engineTarget(
  instances: Array<{ dir: string }>,
  builds: Map<string, string | null>,
  newestDesktop: string | null,
  staged: Map<string, StagedBuild[]>,
): { target: string | null; source: VersionDriftReport['engine']['targetSource'] } {
  const asked: string[] = []
  for (const inst of instances) {
    const build = builds.get(normDir(inst.dir))
    if (!build || !newestDesktop || compareVersion(build, newestDesktop) !== 0) continue
    const v = requestedEngineVersion(inst.dir)
    if (v) asked.push(v)
  }
  const fromLog = newest(asked)
  if (fromLog) return { target: fromLog, source: 'desktop-log' }
  const fromStaged = newest([...staged.values()].flatMap((list) => list.map((s) => s.version)))
  return fromStaged ? { target: fromStaged, source: 'staged' } : { target: null, source: 'none' }
}

function liveChats(homes: string[]): DriftLiveChat[] {
  const out: DriftLiveChat[] = []
  for (const home of homes) {
    for (const s of readLiveRegistry(home)) {
      if (!s.version) continue
      out.push({ pid: s.pid, sessionId: s.sessionId, name: s.name, cwd: s.cwd, version: s.version })
    }
  }
  return out
}

function isBehind(version: string | null, target: string | null): boolean {
  return !!version && !!target && compareVersion(version, target) < 0
}

function instanceRows(
  instances: Array<{ num: number; name: string; dir: string; isRunning: boolean }>,
  builds: Map<string, string | null>,
  staged: Map<string, StagedBuild[]>,
  target: string | null,
): DriftInstanceRow[] {
  return instances.map((inst) => {
    const key = normDir(inst.dir)
    const running = builds.has(key) || inst.isRunning
    const stagedEngine = staged.get(key)?.[0]?.version ?? null
    return {
      num: inst.num,
      name: inst.name,
      dir: inst.dir,
      running,
      build: builds.get(key) ?? null,
      stagedEngine,
      engineBehind: isBehind(stagedEngine, target),
    }
  })
}

function desktopFlags(rows: DriftInstanceRow[], newestDesktop: string | null): DriftFlag[] {
  return rows
    .filter((r) => r.running && isBehind(r.build, newestDesktop))
    .map((r) => ({
      key: `desktop-build:#${r.num}`,
      message: `Instance #${r.num} (${r.name}) is running Claude Desktop ${r.build}, but ${newestDesktop} is installed. Close it and reopen it through AgentHydra when it is idle; it opens on the new build.`,
    }))
}

function liveChatFlag(stale: DriftLiveChat[], target: string | null): DriftFlag[] {
  if (stale.length === 0) return []
  return [
    {
      key: 'live-engines',
      message: `${stale.length} live chat(s) still run an older Claude Code than ${target} (they started before it arrived). Each picks up ${target} when its engine restarts; nothing was stopped.`,
    },
  ]
}

function cliFlag(cli: string | null, target: string | null): DriftFlag[] {
  if (!isBehind(cli, target)) return []
  return [
    {
      key: 'cli',
      message: `The terminal (CLI) Claude Code is ${cli}; the Desktop instances run ${target}. Terminal and desktop chats are on different engines until it is updated.`,
    },
  ]
}

/** Read-only: everything version-shaped about the fleet, and what is out of step. Touches nothing. */
export async function checkVersionDrift(
  deps: VersionDriftDeps = defaultVersionDriftDeps,
): Promise<VersionDriftReport> {
  const [instances, mains] = await Promise.all([deps.listInstances(), deps.runningMains()])
  const builds = runningBuilds(mains)
  const newestDesktop = newestInstalledDesktop(deps.desktopInstallRoot)
  const staged = new Map(instances.map((i) => [normDir(i.dir), stagedEngineVersions(i.dir)]))
  const { target, source } = engineTarget(instances, builds, newestDesktop, staged)
  const rows = instanceRows(instances, builds, staged, target)
  const chats = liveChats(deps.claudeHomes())
  const stale = chats.filter((c) => isBehind(c.version, target))
  const cli = npmCliVersion(deps.npmRoot)
  const desktop = desktopFlags(rows, newestDesktop)
  return {
    checkedAt: deps.now().toISOString(),
    desktop: { newestInstalled: newestDesktop, behind: desktop.length },
    engine: { target, targetSource: source, liveChats: chats, staleLiveChats: stale.length },
    cli: { version: cli, behind: isBehind(cli, target) },
    instances: rows,
    flags: [...desktop, ...liveChatFlag(stale, target), ...cliFlag(cli, target)],
  }
}

// --- the fixes -----------------------------------------------------------------------------------

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** A finished copy of `version` whose exe really hashes to its own payload - checked once, because
 *  every closed profile about to receive it trusts this one file. Prefers a running profile's copy:
 *  that is the one the app most recently downloaded and verified itself. */
async function verifiedSource(
  rows: DriftInstanceRow[],
  version: string,
): Promise<StagedBuild | null> {
  const ordered = [...rows].sort((a, b) => Number(b.running) - Number(a.running))
  for (const row of ordered) {
    const build = readStagedBuild(join(row.dir, 'claude-code'), version)
    if (!build) continue
    try {
      if ((await sha256File(build.exe)) === build.sha256) return build
    } catch {
      // unreadable right now; try the next profile's copy
    }
  }
  return null
}

/** Put `source` into one closed profile as `<profile>\claude-code\<version>\`. Built in a hidden
 *  sibling folder and renamed into place, so the app can never see a half-written copy. The exe is
 *  hard-linked (no second 230 MB on disk); a volume that refuses links gets a plain copy. */
export async function stageEngine(profileDir: string, source: StagedBuild): Promise<void> {
  const ccDir = join(profileDir, 'claude-code')
  const final = join(ccDir, source.version)
  if (existsSync(final)) return
  const tmp = join(ccDir, `.${source.version}.agenthydra-staging`)
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  try {
    await link(source.exe, join(tmp, 'claude.exe')).catch(() =>
      copyFile(source.exe, join(tmp, 'claude.exe')),
    )
    await copyFile(join(source.dir, '.payload'), join(tmp, '.payload'))
    await copyFile(join(source.dir, '.verified'), join(tmp, '.verified'))
    if (statSync(join(tmp, 'claude.exe')).size !== source.size)
      throw Error('staged exe size differs')
    await rename(tmp, final)
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

export interface FixDeps {
  /** Profiles running right now, freshly scanned just before anything is written. Null = could
   *  not look, which stages nothing: a profile that might be open is never touched. */
  runningDirs: () => Promise<Set<string> | null>
  stage: (profileDir: string, source: StagedBuild) => Promise<void>
  /** True when some process runs from the npm CLI install (it cannot be replaced under it). */
  cliInUse: () => Promise<boolean>
  npmInstall: (version: string) => Promise<{ ok: boolean; detail: string }>
  autofix: boolean
}

async function windowsCliInUse(npmRoot: string): Promise<boolean> {
  const pkgDir = join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code')
  const run = await spawnCaptured(
    [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${pkgDir.replace(/'/g, "''")}', [StringComparison]::OrdinalIgnoreCase) }).Count`,
    ],
    { timeoutMs: 20_000 },
  )
  const count = Number.parseInt(run.stdout.trim(), 10)
  // A scan that could not answer counts as in use: never replace an install that might be running.
  return run.code !== 0 || !Number.isFinite(count) || count > 0
}

export const defaultFixDeps: FixDeps = {
  runningDirs: async () => {
    const mains = await defaultVersionDriftDeps.runningMains()
    return mains ? new Set(mains.flatMap((m) => (m.dir ? [normDir(m.dir)] : []))) : null
  },
  stage: stageEngine,
  cliInUse: () =>
    process.platform === 'win32'
      ? windowsCliInUse(defaultVersionDriftDeps.npmRoot)
      : Promise.resolve(true),
  npmInstall: async (version) => {
    if (!SEMVER_RE.test(version)) return { ok: false, detail: `refused odd version ${version}` }
    const shell = process.env.ComSpec ?? 'cmd.exe'
    const run = await spawnCaptured(
      [shell, '/d', '/s', '/c', 'npm', 'install', '-g', `${CLI_PACKAGE}@${version}`],
      { timeoutMs: NPM_TIMEOUT_MS },
    )
    const tail = (run.stderr || run.stdout).trim().split(/\r?\n/).slice(-3).join(' ')
    return { ok: run.code === 0, detail: run.timedOut ? 'npm timed out' : tail }
  },
  autofix: process.env.AGENTHYDRA_VERSION_AUTOFIX !== '0',
}

export interface FixOutcome {
  staged: number[]
  stageFailed: DriftFlag[]
  cliUpdated: string | null
  cliFlag: DriftFlag | null
}

async function stageClosedProfiles(
  report: VersionDriftReport,
  deps: FixDeps,
): Promise<Pick<FixOutcome, 'staged' | 'stageFailed'>> {
  const target = report.engine.target
  const behind = report.instances.filter((r) => r.engineBehind && !r.running)
  if (!target || behind.length === 0) return { staged: [], stageFailed: [] }
  const running = await deps.runningDirs()
  if (!running) return { staged: [], stageFailed: [] }
  const source = await verifiedSource(report.instances, target)
  if (!source) return { staged: [], stageFailed: [] }
  const staged: number[] = []
  const stageFailed: DriftFlag[] = []
  for (const row of behind) {
    if (running.has(normDir(row.dir))) continue // opened since the report: the app handles it
    try {
      await deps.stage(row.dir, source)
      staged.push(row.num)
    } catch (err) {
      stageFailed.push({
        key: `stage:#${row.num}`,
        message: `Could not stage Claude Code ${target} into closed instance #${row.num} (${row.name}): ${err instanceof Error ? err.message : String(err)}. It still updates itself on its next launch.`,
      })
    }
  }
  return { staged, stageFailed }
}

async function updateCli(
  report: VersionDriftReport,
  deps: FixDeps,
): Promise<Pick<FixOutcome, 'cliUpdated' | 'cliFlag'>> {
  const flag = report.flags.find((f) => f.key === 'cli') ?? null
  const target = report.engine.target
  if (!flag || !target || !deps.autofix) return { cliUpdated: null, cliFlag: flag }
  if (await deps.cliInUse()) {
    return {
      cliUpdated: null,
      cliFlag: {
        key: 'cli',
        message: `${flag.message} It updates itself once no terminal chat is running from it.`,
      },
    }
  }
  const run = await deps.npmInstall(target)
  if (run.ok) return { cliUpdated: target, cliFlag: null }
  return {
    cliUpdated: null,
    cliFlag: { key: 'cli', message: `${flag.message} The automatic update failed: ${run.detail}` },
  }
}

/** Stage closed profiles and update the CLI where that is safe. With autofix off, nothing is written. */
export async function fixVersionDrift(
  report: VersionDriftReport,
  deps: FixDeps = defaultFixDeps,
): Promise<FixOutcome> {
  const stage = deps.autofix
    ? await stageClosedProfiles(report, deps)
    : { staged: [], stageFailed: [] }
  const cli = await updateCli(report, deps)
  return { ...stage, ...cli }
}

// --- flags -> incidents --------------------------------------------------------------------------

export interface IncidentDeps {
  record: typeof recordIncident
  notify: typeof deliverIncidentNotification
  openKeys: () => Array<{ id: string; key: string }>
  resolve: (id: string) => boolean
}

export const defaultIncidentDeps: IncidentDeps = {
  record: recordIncident,
  notify: deliverIncidentNotification,
  openKeys: () =>
    [...listIncidents('open'), ...listIncidents('acked')]
      .filter((i) => i.scope === VERSION_DRIFT_SCOPE)
      .map((i) => ({ id: i.id, key: i.key })),
  resolve: resolveIncident,
}

/** Record one incident per current flag (a repeat bumps a count and pages nobody), and resolve
 *  every version-drift incident whose flag is gone. Returns how many it resolved. */
export async function syncDriftIncidents(
  flags: DriftFlag[],
  deps: IncidentDeps = defaultIncidentDeps,
): Promise<number> {
  for (const flag of flags) {
    const opts = {
      scope: VERSION_DRIFT_SCOPE,
      key: flag.key,
      error: flag.message,
      failureType: 'config',
    }
    const result = await deps.record(opts)
    await deps.notify(result, opts)
  }
  const live = new Set(flags.map((f) => f.key))
  let resolved = 0
  for (const open of deps.openKeys()) {
    if (!live.has(open.key) && deps.resolve(open.id)) resolved++
  }
  return resolved
}

// --- one pass, and the timer ---------------------------------------------------------------------

export interface DriftPassResult {
  report: VersionDriftReport
  fixed: FixOutcome
  /** The flags still standing after the fixes, exactly as recorded. */
  flags: DriftFlag[]
  resolvedIncidents: number
}

/** Check, fix what is safe, then check again so the flags describe the fleet AFTER the fixes. */
export async function runVersionDriftPass(
  deps: { check?: VersionDriftDeps; fix?: FixDeps; incidents?: IncidentDeps } = {},
): Promise<DriftPassResult> {
  const first = await checkVersionDrift(deps.check)
  const fixed = await fixVersionDrift(first, deps.fix)
  const report =
    fixed.staged.length > 0 || fixed.cliUpdated ? await checkVersionDrift(deps.check) : first
  const flags = [
    ...report.flags.filter((f) => f.key !== 'cli'),
    ...(fixed.cliFlag && report.cli.behind ? [fixed.cliFlag] : []),
    ...fixed.stageFailed,
  ]
  const resolvedIncidents = await syncDriftIncidents(flags, deps.incidents)
  return { report, fixed, flags, resolvedIncidents }
}

let timer: ReturnType<typeof setInterval> | null = null
let firstRun: ReturnType<typeof setTimeout> | null = null

function tick(): void {
  runVersionDriftPass()
    .then((r) => {
      if (r.fixed.staged.length || r.fixed.cliUpdated)
        console.log(
          `[agenthydra] version drift: staged Claude Code ${r.report.engine.target} into #${r.fixed.staged.join(', #') || '-'}; CLI ${r.fixed.cliUpdated ? `updated to ${r.fixed.cliUpdated}` : 'unchanged'}`,
        )
    })
    .catch((err) => console.error('[agenthydra] version drift check error:', err))
}

export function startVersionDriftWatch(): void {
  if (timer) return
  // Same shape as the other standing sweeps: this process exits on an unhandled rejection, so the
  // chain always ends in .catch, and neither timer is a reason for the process to stay alive.
  firstRun = setTimeout(tick, FIRST_CHECK_DELAY_MS)
  firstRun.unref()
  timer = setInterval(tick, VERSION_DRIFT_MS)
  timer.unref()
}

export function stopVersionDriftWatch(): void {
  if (firstRun) clearTimeout(firstRun)
  if (timer) clearInterval(timer)
  firstRun = null
  timer = null
}
