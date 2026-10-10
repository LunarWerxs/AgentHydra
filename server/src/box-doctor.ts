// THE MACHINE DOCTOR: the box-level faults that slow every session on this PC, checked every 15
// minutes, each one an incident while it stands and resolved when it clears.
//
// WHY THIS EXISTS. MPC-HELL ran ~1,600 processes on 2026-10-10 and refused new ones. None of the
// causes was a session's fault, so no session looked: Claude Desktop kept ~300 console hosts for
// terminals it had stopped, npm's bun.cmd first on PATH put a cmd.exe in front of every `bun` call,
// and commit charge reached 187 of 188 GB. The scheduled cleanup (claude-memory's orphan reaper) now
// clears the hosts, but nothing said when it stopped running, or when a new pile of the same shape
// appeared. This is that watch. It changes nothing on the machine; each finding says what to do.
//
// Checks, each skipped where it cannot be read (Windows only; the reaper's two only where its script
// is installed, since every Hydra family member works when the others are absent):
//   path-shim:<name>  `<name>` resolves on PATH to a batch shim fronting a native exe
//   commit            commit charge under 5% of its limit (opens), clears above 8%
//   pty-hosts         25+ console hosts under Claude Desktop with no terminal of their own
//   reaper            the orphan reaper's task is missing, or its log has not moved in 30 minutes
//   hoard:<key>       a pile the reaper reported (~/.claude/logs/box-alerts.json) whose parent lives
//   clock             this clock is more than five minutes off (box-doctor-clock.ts)
//   root:<path>       a drive or folder agents use exists but cannot be listed (box-doctor-roots.ts)
//   hydra:<...>       Project Hydra's registry, record and sweeps, where it is installed
//                     (box-doctor-hydra.ts; this doctor replaced `ph doctor`)
// Notes (report only, never an incident): commit under 12% (CliMayte holds new workers there) and
// the process count.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkClock } from './box-doctor-clock'
import {
  type HydraMode,
  hydraClockStamps,
  hydraFindings,
  hydraRoots,
  readHydraFacts,
} from './box-doctor-hydra'
import { driveRoots, probeRoots, type RootTarget, rootFindings } from './box-doctor-roots'
import { COMMIT_FLOOR_SHARE, type MachineMemory, readMachineMemory } from './climayte-memory'
import { spawnCaptured } from './core/process'
import {
  type NativeProcess,
  nativeCommandLines,
  nativeProcessTable,
} from './core/win-process-table'
import {
  deliverIncidentNotification,
  listIncidents,
  recordIncident,
  resolveIncident,
} from './incidents'

export const BOX_DOCTOR_SCOPE = 'box-doctor'
export const BOX_DOCTOR_MS = 15 * 60_000
const FIRST_CHECK_DELAY_MS = 120_000
/** fairjob.ps1 refuses new work below this share of the commit limit; so the incident opens there. */
const COMMIT_PROBLEM_SHARE = 0.05
/** ...and closes only above this, so a box hovering at 5% raises one incident, not one per pass. */
const COMMIT_CLEAR_SHARE = 0.08
/** The reaper clears leaked hosts older than 10 minutes every 5; this many means it is not. */
export const LEAKED_HOSTS_PROBLEM = 25
const REAPER_STALE_MS = 30 * 60_000
const REAPER_TASK = 'ClaudeOrphanReaper'
const EXEC_TIMEOUT_MS = 10_000
/** A drive agents worked on this recently is one the roots check lists. */
const RECENT_WORK_MS = 30 * 86_400_000
const MACHINE_ENV_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const USER_ENV_KEY = 'HKCU\\Environment'

export interface BoxFinding {
  key: string
  /** A problem is an incident until it clears; a note is only reported. */
  level: 'problem' | 'note'
  /** Stable while the fault stands: an incident's signature includes it, so no counts or ages. */
  message: string
  /** The live numbers and names behind it, for the report only. */
  detail?: string
}

export interface BoxDoctorReport {
  checkedAt: string
  /** False off Windows: nothing here can be read there. */
  supported: boolean
  processes: number | null
  memory: MachineMemory | null
  findings: BoxFinding[]
  /** What this pass could look at: exact keys (`commit`) and families (`path-shim:` covers every
   *  `path-shim:<name>`). A check that could not look is not a check that passed: an open incident
   *  none of these covers stays open. */
  checked: string[]
  /** Whether Project Hydra is installed, and how old its facts are or why they could not be read. */
  hydra: { installed: boolean; factsAt?: string; reason?: string }
}

const covers = (checked: ReadonlySet<string>, key: string) =>
  checked.has(key) || [...checked].some((c) => c.endsWith(':') && key.startsWith(c))

/** `exitCode` is null when the program never ran or was killed at the timeout; a number when it
 *  ran and said so itself (schtasks answers 1 for a task that does not exist). */
async function execText(cmd: string[]): Promise<{ exitCode: number | null; stdout: string }> {
  const r = await spawnCaptured(cmd, { timeoutMs: EXEC_TIMEOUT_MS })
  return { exitCode: r.timedOut ? null : r.code, stdout: r.stdout }
}

/** The native exe an npm-style batch shim runs (`"%dp0%\node_modules\bun\bin\bun.exe" %*`), or
 *  null for a shim that runs a script through node or anything else. */
export function shimTarget(shimText: string, shimDir: string): string | null {
  const m = /"%~?dp0%?\\([^"]+?\.exe)"/i.exec(shimText)
  return m?.[1] ? join(shimDir, m[1]) : null
}

/**
 * Each command whose FIRST match on PATH is a `.cmd` shim fronting a native exe that exists. Windows
 * walks PATH in order and, inside one folder, tries .COM, .EXE, .BAT then .CMD, so an exe of the same
 * name in an earlier folder or in the shim's own folder wins and the shim never runs.
 */
export function pathShimFindings(dirs: readonly string[]): BoxFinding[] {
  const resolved = new Set<string>()
  const out: BoxFinding[] = []
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    const byExt = (ext: string) =>
      names
        .filter((n) => n.toLowerCase().endsWith(ext))
        .map((n) => [n, n.slice(0, -4).toLowerCase()] as const)
    for (const [, base] of [...byExt('.com'), ...byExt('.exe'), ...byExt('.bat')])
      resolved.add(base)
    for (const [file, base] of byExt('.cmd')) {
      if (resolved.has(base)) continue
      resolved.add(base)
      const shim = join(dir, file)
      let target: string | null = null
      try {
        target = shimTarget(readFileSync(shim, 'utf8'), dir)
      } catch {
        // unreadable shim: nothing to say about it
      }
      if (!target || !existsSync(target)) continue
      out.push({
        key: `path-shim:${base}`,
        level: 'problem',
        message: `\`${base}\` resolves on PATH to ${shim}, a batch shim, so every call starts a cmd.exe (and a console host for a windowless caller) before ${target}. Put ${dirname(target)} ahead of ${dir} on PATH, or delete the shim.`,
      })
    }
  }
  return out
}

/** PATH as a new process gets it: the machine's entries, then the user's, %VARS% expanded. Null
 *  when reg could not be asked: half a PATH would flag shims an unread folder's exe outranks. */
async function registryPath(): Promise<string[] | null> {
  const dirs: string[] = []
  for (const key of [MACHINE_ENV_KEY, USER_ENV_KEY]) {
    const r = await execText(['reg', 'query', key, '/v', 'Path'])
    if (r.exitCode === null) return null
    const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(r.stdout)
    if (!m?.[1]) continue
    for (const raw of m[1].split(';')) {
      const dir = raw.replace(/%([^%]+)%/g, (all, v: string) => process.env[v] ?? all).trim()
      if (dir) dirs.push(dir.replace(/[\\/]+$/, ''))
    }
  }
  const seen = new Set<string>()
  return dirs.filter((d) => !seen.has(d.toLowerCase()) && seen.add(d.toLowerCase()))
}

/** `commitOpen`: the commit incident is open now, so it holds until the share passes the clear bar.
 *  Null when commit charge cannot be read. */
export function memoryFindings(m: MachineMemory | null, commitOpen: boolean): BoxFinding[] | null {
  if (!m?.commitLimitBytes || m.commitFreeBytes == null) return null
  const share = m.commitFreeBytes / m.commitLimitBytes
  if (share < COMMIT_PROBLEM_SHARE || (commitOpen && share < COMMIT_CLEAR_SHARE))
    return [
      {
        key: 'commit',
        level: 'problem',
        message:
          'Commit charge is nearly at its limit: new processes start failing (0xC0000142) and fairjob holds every heavy job. Find what holds the memory, or grow the pagefile.',
      },
    ]
  if (share < COMMIT_FLOOR_SHARE)
    return [
      {
        key: 'commit-low',
        level: 'note',
        message: `Commit charge has ${(share * 100).toFixed(1)}% of its limit left; CliMayte starts no new worker below ${COMMIT_FLOOR_SHARE * 100}%.`,
      },
    ]
  return []
}

const HEADLESS_HOST = /\bconhost\.exe"?\s+--headless\b/i
const NODE_SERVICE = '--utility-sub-type=node.mojom.NodeService'

/**
 * Console hosts Claude Desktop keeps for terminals it already stopped. Desktop runs each terminal
 * through node-pty in its NodeService utility process, one headless conhost per shell, and leaves the
 * host behind when the shell exits; so under each NodeService, hosts beyond its live shells are leaks.
 */
export function leakedPtyHosts(
  table: readonly NativeProcess[],
  commandLine: (pid: number) => string | undefined,
): number {
  const byParent = new Map<number, { hosts: number; shells: number }>()
  const claude = new Set(
    table.filter((p) => p.name.toLowerCase() === 'claude.exe').map((p) => p.pid),
  )
  for (const p of table) {
    if (!claude.has(p.ppid)) continue
    const row = byParent.get(p.ppid) ?? { hosts: 0, shells: 0 }
    if (p.name.toLowerCase() !== 'conhost.exe') row.shells++
    else if (HEADLESS_HOST.test(commandLine(p.pid) ?? '')) row.hosts++
    byParent.set(p.ppid, row)
  }
  let leaked = 0
  for (const [parent, row] of byParent) {
    if (row.hosts > row.shells && commandLine(parent)?.includes(NODE_SERVICE))
      leaked += row.hosts - row.shells
  }
  return leaked
}

function ptyHostFindings(
  table: readonly NativeProcess[],
  reaperInstalled: boolean,
): BoxFinding[] | null {
  const claude = new Set(
    table.filter((p) => p.name.toLowerCase() === 'claude.exe').map((p) => p.pid),
  )
  const wanted = new Set<number>()
  for (const p of table) {
    if (claude.has(p.ppid) && p.name.toLowerCase() === 'conhost.exe') wanted.add(p.pid).add(p.ppid)
  }
  const lines = wanted.size ? nativeCommandLines([...wanted]) : new Map<number, string>()
  if (!lines) return null
  if (leakedPtyHosts(table, (pid) => lines.get(pid)) < LEAKED_HOSTS_PROBLEM) return []
  return [
    {
      key: 'pty-hosts',
      level: 'problem',
      message: reaperInstalled
        ? 'Claude Desktop is keeping console hosts for terminals it already stopped, and the orphan reaper is not clearing them: run ~/.claude/tools/orphan-reaper.ps1 to see why.'
        : 'Claude Desktop is keeping console hosts for terminals it already stopped (each an idle conhost.exe under its NodeService process); quitting Claude Desktop frees them.',
    },
  ]
}

const reaperScript = () => join(homedir(), '.claude', 'tools', 'orphan-reaper.ps1')
const reaperLog = () => join(process.env.TEMP || tmpdir(), 'orphan-reaper.log')
const alertsFile = () => join(homedir(), '.claude', 'logs', 'box-alerts.json')

/** Null when schtasks could not be asked (did not start, or hung past the timeout). */
async function reaperFindings(now: number): Promise<BoxFinding[] | null> {
  const task = await execText(['schtasks', '/query', '/tn', REAPER_TASK])
  if (task.exitCode === null) return null
  if (task.exitCode !== 0)
    return [
      {
        key: 'reaper',
        level: 'problem',
        message: `The orphan reaper is installed but its scheduled task (${REAPER_TASK}) is missing, so nothing clears leaked processes: reinstall it from claude-memory (node install.mjs).`,
      },
    ]
  let movedAt = 0
  try {
    movedAt = statSync(reaperLog()).mtimeMs
  } catch {
    // no log yet reads as never ran
  }
  if (now - movedAt <= REAPER_STALE_MS) return []
  return [
    {
      key: 'reaper',
      level: 'problem',
      message: `The orphan reaper's task (${REAPER_TASK}) has not written its log (${reaperLog()}) in the last half hour, so leaked processes are piling up: run it by hand to see why.`,
    },
  ]
}

interface HoardAlert {
  key: string
  parent: string
  parentPid: number
  child: string
}

/** Each pile the reaper reported whose parent still lives (the file is rewritten only on change).
 *  Null when the file does not parse. */
export function hoardFindings(alertsJson: string, live: ReadonlySet<number>): BoxFinding[] | null {
  let hoards: HoardAlert[] = []
  try {
    const doc = JSON.parse(alertsJson) as { hoards?: HoardAlert[] }
    hoards = Array.isArray(doc.hoards) ? doc.hoards : []
  } catch {
    return null
  }
  return hoards
    .filter((h) => typeof h.key === 'string' && live.has(h.parentPid))
    .map((h) => ({
      key: `hoard:${h.key}`,
      level: 'problem' as const,
      message: `${h.parent} (pid ${h.parentPid}) keeps a pile of idle ${h.child} children it never closes. Find out what they are before killing any; once proven garbage, give the reaper a pass for them.`,
    }))
}

/** Read the machine and say what is wrong. Touches nothing; records nothing. */
export async function checkBox(
  o: { commitOpen?: boolean; hydra?: HydraMode } = {},
): Promise<BoxDoctorReport> {
  const checkedAt = new Date().toISOString()
  if (process.platform !== 'win32')
    return {
      checkedAt,
      supported: false,
      processes: null,
      memory: null,
      findings: [],
      checked: [],
      hydra: { installed: false },
    }
  const memory = readMachineMemory()
  const table = nativeProcessTable()
  const findings: BoxFinding[] = []
  const checked: string[] = []
  const add = (family: string, found: BoxFinding[] | null) => {
    if (!found) return
    findings.push(...found)
    checked.push(family)
  }
  const ph = await readHydraFacts(o.hydra ?? 'cached')
  const facts = ph.installed ? ph.facts : null
  let hydra: BoxDoctorReport['hydra'] = { installed: false }
  if (!ph.installed)
    checked.push('hydra:') // nothing to watch, so an incident from when it was is over
  else if ('reason' in ph) {
    hydra = { installed: true, reason: ph.reason }
    findings.push({
      key: 'hydra-unreadable',
      level: 'note',
      message:
        'Project Hydra is installed but its facts are not available this pass, so its checks hold where they were.',
      detail: ph.reason,
    })
  } else {
    hydra = { installed: true, factsAt: new Date(ph.at).toISOString() }
    const h = hydraFindings(ph.facts)
    findings.push(...h.findings)
    checked.push(...h.checked)
  }
  add('clock', await checkClock(execText, facts ? hydraClockStamps(facts) : []))
  const roots = rootFindings(await probeRoots(await rootTargets(facts)))
  if (roots) {
    findings.push(...roots.findings)
    checked.push(...roots.checked)
  }
  const path = await registryPath()
  add('path-shim:', path && pathShimFindings(path))
  add('commit', memoryFindings(memory, o.commitOpen ?? false))
  const reaperInstalled = existsSync(reaperScript())
  if (table) add('pty-hosts', ptyHostFindings(table, reaperInstalled))
  // Not installed: nothing to watch, so an incident from when it was is over.
  add('reaper', reaperInstalled ? await reaperFindings(Date.now()) : [])
  if (table) {
    let hoards: BoxFinding[] | null = []
    if (existsSync(alertsFile())) {
      try {
        hoards = hoardFindings(readFileSync(alertsFile(), 'utf8'), new Set(table.map((p) => p.pid)))
      } catch {
        hoards = null // unreadable for now: the reaper rewrites it on the next change
      }
    }
    add('hoard:', hoards)
    findings.push({
      key: 'processes',
      level: 'note',
      message: `${table.length} processes running.`,
    })
  }
  return {
    checkedAt,
    supported: true,
    processes: table?.length ?? null,
    memory,
    findings,
    checked,
    hydra,
  }
}

/** The drives agents worked on in the last 30 days, then the folders Project Hydra names. */
async function rootTargets(facts: unknown): Promise<RootTarget[]> {
  const out: RootTarget[] = []
  try {
    const { listProjects } = await import('./sessions')
    const recent = (await listProjects())
      .filter((p) => Date.now() - p.last_activity_at < RECENT_WORK_MS)
      .map((p) => p.cwd)
    for (const path of driveRoots(recent)) out.push({ role: 'drive of recent agent work', path })
  } catch {
    // no session index: Project Hydra's folders alone
  }
  const seen = new Set(out.map((t) => t.path.toLowerCase().replace(/[\\/]+$/, '')))
  for (const t of facts ? hydraRoots(facts) : []) {
    const k = t.path.toLowerCase().replace(/[\\/]+$/, '')
    if (!seen.has(k) && seen.add(k)) out.push(t)
  }
  return out
}

export interface BoxIncidentDeps {
  record: typeof recordIncident
  notify: typeof deliverIncidentNotification
  openKeys: () => Array<{ id: string; key: string }>
  resolve: (id: string) => boolean
}

export const defaultBoxIncidentDeps: BoxIncidentDeps = {
  record: recordIncident,
  notify: deliverIncidentNotification,
  openKeys: () =>
    [...listIncidents('open'), ...listIncidents('acked')]
      .filter((i) => i.scope === BOX_DOCTOR_SCOPE)
      .map((i) => ({ id: i.id, key: i.key })),
  resolve: resolveIncident,
}

/** One incident per problem (a repeat bumps a count and pages nobody); a box-doctor incident whose
 *  problem is gone is resolved only when its check ran this pass. Notes never become incidents. One
 *  problem that fails to record never stops the rest, or the resolving. Returns how many it resolved. */
export async function syncBoxIncidents(
  report: Pick<BoxDoctorReport, 'findings' | 'checked'>,
  deps: BoxIncidentDeps = defaultBoxIncidentDeps,
): Promise<number> {
  const problems = report.findings.filter((f) => f.level === 'problem')
  for (const f of problems) {
    const opts = { scope: BOX_DOCTOR_SCOPE, key: f.key, error: f.message, failureType: 'machine' }
    try {
      await deps.notify(await deps.record(opts), opts)
    } catch (err) {
      console.error(`[agenthydra] box doctor: could not record ${f.key}:`, err)
    }
  }
  const live = new Set(problems.map((f) => f.key))
  const checked = new Set(report.checked)
  let resolved = 0
  for (const open of deps.openKeys()) {
    if (!live.has(open.key) && covers(checked, open.key) && deps.resolve(open.id)) resolved++
  }
  return resolved
}

export interface BoxDoctorPassResult {
  report: BoxDoctorReport
  resolvedIncidents: number
}

/** Check the box and bring its incidents in line. Off Windows nothing is checked, so it records
 *  and resolves nothing. */
export async function runBoxDoctorPass(
  deps: BoxIncidentDeps = defaultBoxIncidentDeps,
  o: { hydra?: HydraMode } = {},
): Promise<BoxDoctorPassResult> {
  const commitOpen = deps.openKeys().some((i) => i.key === 'commit')
  const report = await checkBox({ commitOpen, hydra: o.hydra ?? 'hourly' })
  return { report, resolvedIncidents: await syncBoxIncidents(report, deps) }
}

let timer: ReturnType<typeof setInterval> | null = null
let firstRun: ReturnType<typeof setTimeout> | null = null

function tick(): void {
  try {
    runBoxDoctorPass()
      .then((r) => {
        const problems = r.report.findings.filter((f) => f.level === 'problem')
        if (problems.length)
          console.log(`[agenthydra] box doctor: ${problems.map((f) => f.key).join(', ')}`)
      })
      .catch((err) => console.error('[agenthydra] box doctor error:', err))
  } catch (err) {
    console.error('[agenthydra] box doctor error:', err)
  }
}

export function startBoxDoctorWatch(): void {
  if (timer || process.platform !== 'win32') return
  // Same shape as the version-drift watch: the chain always ends in .catch (this process exits on an
  // unhandled rejection), and neither timer is a reason for the process to stay alive.
  firstRun = setTimeout(tick, FIRST_CHECK_DELAY_MS)
  firstRun.unref()
  timer = setInterval(tick, BOX_DOCTOR_MS)
  timer.unref()
}

export function stopBoxDoctorWatch(): void {
  if (firstRun) clearTimeout(firstRun)
  if (timer) clearInterval(timer)
  firstRun = null
  timer = null
}
