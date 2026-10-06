// server/src/claude-install-guard.ts - keep AgentHydra from launching a broken Claude Code install.
//
// 2026-10-06 14:47-14:58: an npm global update of @anthropic-ai/claude-code stopped half way. bin/claude.exe
// was first a 500-byte placeholder (it prints "claude native binary not installed"), then a truncated
// native binary ("Exec format error"). resolveClaudeExe() kept naming that path, every CliMayte launch
// died within a second with nothing on stdout or stderr, classifyAttempt called each death "interrupted"
// (as if a daemon restart had killed it), retried three times and failed the chat. It looked like the
// account was broken.
//
// What this module does:
//   1. inspectClaudeExe: is the executable healthy (exists, plausible size, `--version` answers)?
//      The verdict is cached by path + size + mtime, so a launch costs nothing while the file is the same.
//   2. A last-known-good copy of a verified claude.exe (DATA_DIR/claude-lkg). While the global install is
//      broken, launches point at it (config.claudeExeFallback), so no work waits for a repair.
//   3. repairClaudeInstall: one repair at a time, with backoff: re-run the package's own install step when
//      its native package is complete, else `npm install -g <package>@<version package.json names>`; verify
//      with --version; raise ONE incident the owner sees when it keeps failing.
//   4. claudeInstallState: what the scheduler asks before it launches. Not healthy and no good copy: the
//      work is held ("Waiting: Claude Code install broken"), no retry is spent and no account is tried.

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { claudeExeFallback, DATA_DIR, resolveClaudeExeUnguarded } from './config'

/** The native Claude Code executable is ~250 MB; the placeholder is 500 bytes. Anything under this is a stub. */
export const MIN_EXE_BYTES = 5 * 1024 * 1024
/** `--version` must answer within this. */
const PROBE_TIMEOUT_MS = 8_000
/** A repair's install step (npm can be slow). */
const REPAIR_TIMEOUT_MS = 5 * 60_000
/** How long an UNHEALTHY verdict is trusted before the file is probed again. */
export const UNHEALTHY_RECHECK_MS = 30_000
/** The wording a held task carries (climayte-schedule). */
export const INSTALL_BROKEN_HEAD = 'Waiting: Claude Code install broken'

export interface InstallHealth {
  ok: boolean
  /** Why it is not healthy; null when it is. */
  reason: string | null
  exe: string
  version: string | null
}

export interface ProbeResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface RunResult extends ProbeResult {}

/** Everything that touches the machine, so a test fakes it. */
export interface GuardDeps {
  now: () => number
  /** The executable the scheduler would launch (before any last-known-good swap). */
  exe: () => string
  /** The file's size and mtime, or null when it does not exist. */
  stat: (path: string) => { size: number; mtimeMs: number } | null
  /** Run `<exe> --version`. */
  probe: (exe: string) => ProbeResult
  /** Run a command (the repair's install step). */
  run: (argv: string[], cwd: string | null, timeoutMs: number) => Promise<RunResult>
  readText: (path: string) => string | null
  /** The last-known-good folder. */
  lkgDir: string
  /** Copy a verified executable to the last-known-good place (atomically); a test records it. */
  copyLkg: (from: string, toDir: string) => Promise<void>
  /** Raise or clear the owner-visible incident. */
  raise: (message: string) => Promise<void>
  clear: () => Promise<void>
  log: (line: string) => void
  /** True when launches use an explicit override (AGENTHYDRA_CLAUDE_PATH): not ours to judge. */
  overridden: () => boolean
}

const nativeRun = (argv: string[], cwd: string | null, timeoutMs: number): Promise<RunResult> =>
  new Promise((resolve) => {
    const r = spawnSync(argv[0] as string, argv.slice(1), {
      cwd: cwd ?? undefined,
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(argv[0] as string),
    })
    resolve({
      code: r.status,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
      timedOut: r.error != null && /ETIMEDOUT/.test(String((r.error as { code?: string }).code)),
    })
  })

export const defaultGuardDeps: GuardDeps = {
  now: () => Date.now(),
  exe: () => resolveClaudeExeUnguarded(),
  stat: (p) => {
    try {
      const s = statSync(p)
      return { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return null
    }
  },
  probe: (exe) => {
    const r = spawnSync(exe, ['--version'], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe),
    })
    const timedOut = r.error != null && (r.error as { code?: string }).code === 'ETIMEDOUT'
    return {
      code: r.status,
      stdout: r.stdout ?? '',
      stderr: (r.stderr ?? '') || (r.error && !timedOut ? r.error.message : ''),
      timedOut,
    }
  },
  run: nativeRun,
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  },
  lkgDir: join(DATA_DIR, 'claude-lkg'),
  copyLkg: async (from, toDir) => {
    mkdirSync(toDir, { recursive: true })
    const tmp = join(toDir, `claude.exe.${process.pid}.tmp`)
    copyFileSync(from, tmp)
    renameSync(tmp, join(toDir, 'claude.exe'))
  },
  raise: async (message) => {
    const { recordIncident, deliverIncidentNotification } = await import('./incidents')
    const opts = { scope: 'claude-install', key: 'global', error: message }
    // A repeat bumps the count and pages nobody (deliverIncidentNotification suppresses it).
    await deliverIncidentNotification(await recordIncident(opts), opts)
  },
  clear: async () => {
    const { listIncidents, resolveIncident } = await import('./incidents')
    for (const i of [...listIncidents('open'), ...listIncidents('acked')])
      if (i.scope === 'claude-install') resolveIncident(i.id)
  },
  log: (line) => console.log(`[claude-install] ${line}`),
  overridden: () =>
    !!process.env.AGENTHYDRA_CLAUDE_PATH?.trim() || process.env.AGENTHYDRA_CLAUDE_GUARD === '0',
}

let deps: GuardDeps = defaultGuardDeps

/** Test seam: fake the machine (null: the real one). Also forgets every cached verdict and repair state. */
export function setGuardDeps(d: Partial<GuardDeps> | null): void {
  deps = d ? { ...defaultGuardDeps, ...d } : defaultGuardDeps
  resetGuard()
}

// --- inspection --------------------------------------------------------------------------------------

const VERSION_RE = /(\d+\.\d+\.\d+)/

const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0]?.slice(0, 160) ?? ''

/** Whether the file named by `exe` can be judged by size: a real path, not a PATH name or a .cmd shim. */
const isNativePath = (exe: string): boolean => /[\\/]/.test(exe) && /\.exe$/i.test(exe)

/** Healthy or not, with the reason in words the owner can act on. No cache (see checkClaudeExe). */
export function inspectClaudeExe(exe: string, d: GuardDeps = deps): InstallHealth {
  const bad = (reason: string): InstallHealth => ({ ok: false, reason, exe, version: null })
  if (/[\\/]/.test(exe)) {
    const s = d.stat(exe)
    if (!s) return bad(`${exe} does not exist`)
    if (isNativePath(exe) && s.size < MIN_EXE_BYTES)
      return bad(
        `${exe} is only ${s.size} bytes: a placeholder, not the Claude Code executable (an update did not finish)`,
      )
  }
  const p = d.probe(exe)
  if (p.timedOut)
    return bad(`\`claude --version\` did not answer within ${PROBE_TIMEOUT_MS / 1000} s`)
  const v = VERSION_RE.exec(p.stdout)
  if (p.code !== 0 || !v) {
    const said = firstLine(p.stderr) || firstLine(p.stdout)
    return bad(
      `\`claude --version\` failed (exit ${p.code ?? 'none'}${said ? `: ${said}` : ''}); the file is probably truncated`,
    )
  }
  return { ok: true, reason: null, exe, version: v[1] as string }
}

interface Cached {
  key: string
  health: InstallHealth
  at: number
}
const cache = new Map<string, Cached>()

/** inspectClaudeExe, cached by path + size + mtime: free while the file is unchanged. An unhealthy
 *  verdict is trusted UNHEALTHY_RECHECK_MS (a repair changes size or mtime, and ends it at once).
 *  `fresh` skips the cache (a launch that died instantly asks for a new look). */
export function checkClaudeExe(exe: string, fresh = false, d: GuardDeps = deps): InstallHealth {
  const s = /[\\/]/.test(exe) ? d.stat(exe) : null
  const key = `${exe}|${s?.size ?? '-'}|${s?.mtimeMs ?? '-'}`
  const hit = cache.get(exe)
  const now = d.now()
  if (!fresh && hit && hit.key === key && (hit.health.ok || now - hit.at < UNHEALTHY_RECHECK_MS))
    return hit.health
  const health = inspectClaudeExe(exe, d)
  cache.set(exe, { key, health, at: now })
  return health
}

// --- last-known-good copy ----------------------------------------------------------------------------

const lkgExe = (d: GuardDeps): string => join(d.lkgDir, 'claude.exe')
let lkgSnapshotKey: string | null = null
let snapshotting = false

/** After the global install is seen healthy, keep a verified copy of it (once per file change, in the
 *  background). The copy is probed before it counts. */
function snapshotLkg(h: InstallHealth, d: GuardDeps): void {
  if (!isNativePath(h.exe) || snapshotting) return
  const s = d.stat(h.exe)
  const key = `${h.exe}|${s?.size}|${s?.mtimeMs}`
  if (lkgSnapshotKey === key) return
  const have = d.stat(lkgExe(d))
  if (
    have &&
    s &&
    have.size === s.size &&
    lkgSnapshotKey === null &&
    d.readText(join(d.lkgDir, 'version.txt')) === h.version
  ) {
    lkgSnapshotKey = key
    return
  }
  snapshotting = true
  void (async () => {
    try {
      await d.copyLkg(h.exe, d.lkgDir)
      const copy = inspectClaudeExe(lkgExe(d), d)
      if (copy.ok) {
        try {
          writeFileSync(join(d.lkgDir, 'version.txt'), copy.version ?? '')
        } catch {
          // the copy still works without its note
        }
        lkgSnapshotKey = key
        d.log(`kept a last-known-good Claude Code ${copy.version}`)
      } else {
        rmSync(lkgExe(d), { force: true })
        d.log(`the last-known-good copy did not verify (${copy.reason}); removed`)
      }
    } catch (err) {
      d.log(
        `could not keep a last-known-good copy: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      snapshotting = false
    }
  })()
}

// --- the state the scheduler asks ----------------------------------------------------------------------

export interface InstallState {
  /** A CLI can be launched now. */
  ok: boolean
  /** Why not (ok false), or why a fallback is in use (ok true and usingLastKnownGood). */
  reason: string | null
  version: string | null
  exe: string
  usingLastKnownGood: boolean
  /** A repair is running, or the next one is due at this time (epoch ms). */
  repairing: boolean
  nextRepairAt: number | null
}

/** Is a CLI launchable now? Cheap while the install is unchanged. Starts a repair (in the background) when
 *  the install is broken. `fresh`: look again now, whatever the cache says. */
export function claudeInstallState(fresh = false, d: GuardDeps = deps): InstallState {
  const exe = d.exe()
  const base = { exe, repairing: repair.running, nextRepairAt: repair.nextAt }
  if (d.overridden())
    return { ...base, ok: true, reason: null, version: null, usingLastKnownGood: false }
  const h = checkClaudeExe(exe, fresh, d)
  if (h.ok) {
    claudeExeFallback.primary = null
    claudeExeFallback.path = null
    if (repair.failures) void d.clear().catch(() => {})
    repair.failures = 0
    repair.nextAt = null
    snapshotLkg(h, d)
    return {
      ...base,
      repairing: false,
      nextRepairAt: null,
      ok: true,
      reason: null,
      version: h.version,
      usingLastKnownGood: false,
    }
  }
  void startRepair(h, d)
  const lkg = d.stat(lkgExe(d)) ? checkClaudeExe(lkgExe(d), false, d) : null
  if (lkg?.ok) {
    claudeExeFallback.primary = exe
    claudeExeFallback.path = lkgExe(d)
    return {
      ...base,
      repairing: repair.running,
      nextRepairAt: repair.nextAt,
      ok: true,
      reason: h.reason,
      version: lkg.version,
      usingLastKnownGood: true,
    }
  }
  claudeExeFallback.primary = null
  claudeExeFallback.path = null
  return {
    ...base,
    repairing: repair.running,
    nextRepairAt: repair.nextAt,
    ok: false,
    reason: h.reason,
    version: null,
    usingLastKnownGood: false,
  }
}

// --- repair ------------------------------------------------------------------------------------------

const BACKOFF_MS = [60_000, 120_000, 300_000, 900_000, 1_800_000]

interface RepairState {
  running: boolean
  failures: number
  nextAt: number | null
  /** How many times a repair has run (a test reads it: "once, under the lock"). */
  runs: number
  lastDetail: string | null
}
const repair: RepairState = { running: false, failures: 0, nextAt: null, runs: 0, lastDetail: null }

export const repairRuns = (): number => repair.runs

/** The platform folder npm unpacks the native binary into, beside the wrapper package. */
function nativePackageExe(pkgDir: string): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const plat =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  return join(
    pkgDir,
    'node_modules',
    '@anthropic-ai',
    `claude-code-${plat}-${arch}`,
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  )
}

function startRepair(h: InstallHealth, d: GuardDeps): Promise<void> {
  const now = d.now()
  if (repair.running || (repair.nextAt !== null && now < repair.nextAt)) return Promise.resolve()
  repair.running = true
  return repairNow(h, d).finally(() => {
    repair.running = false
  })
}

async function repairNow(h: InstallHealth, d: GuardDeps): Promise<void> {
  repair.runs++
  const pkgDir = dirname(dirname(h.exe))
  let how = ''
  let ran: RunResult | null = null
  try {
    if (basename(pkgDir) !== 'claude-code') {
      repair.lastDetail = `${h.exe} is not an npm global install of @anthropic-ai/claude-code; reinstall Claude Code by hand`
    } else {
      const pkg = d.readText(join(pkgDir, 'package.json'))
      const version = pkg ? (JSON.parse(pkg) as { version?: string }).version : undefined
      if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
        repair.lastDetail = `${pkgDir}/package.json names no usable version`
      } else {
        const native = nativePackageExe(pkgDir)
        const nativeStat = d.stat(native)
        const nativeOk =
          !!nativeStat && nativeStat.size >= MIN_EXE_BYTES && inspectClaudeExe(native, d).ok
        if (nativeOk) {
          how = 'ran the package install step (native package complete)'
          ran = await d.run(['node', join(pkgDir, 'install.cjs')], pkgDir, REPAIR_TIMEOUT_MS)
        } else {
          how = `ran npm install -g @anthropic-ai/claude-code@${version}`
          ran = await d.run(
            ['npm', 'install', '-g', `@anthropic-ai/claude-code@${version}`],
            null,
            REPAIR_TIMEOUT_MS,
          )
        }
      }
    }
  } catch (err) {
    repair.lastDetail = err instanceof Error ? err.message : String(err)
  }
  const after = checkClaudeExe(h.exe, true, d)
  if (after.ok) {
    d.log(`repaired: ${how}; claude ${after.version}`)
    repair.failures = 0
    repair.nextAt = null
    repair.lastDetail = null
    await d.clear().catch(() => {})
    return
  }
  const tail = ran ? firstLine(ran.stderr || ran.stdout) : ''
  const detail = [
    repair.lastDetail,
    how && `${how}: exit ${ran?.code ?? 'none'}${tail ? ` (${tail})` : ''}`,
    after.reason,
  ]
    .filter(Boolean)
    .join('; ')
  repair.failures++
  repair.nextAt =
    d.now() + (BACKOFF_MS[Math.min(repair.failures - 1, BACKOFF_MS.length - 1)] as number)
  repair.lastDetail = detail
  d.log(`repair failed (${repair.failures}): ${detail}`)
  await d
    .raise(
      `Claude Code is not usable on this machine and AgentHydra could not repair it (attempt ${repair.failures}): ${detail}. CliMayte work is held, not failed; it starts by itself once \`claude --version\` answers. Fix by hand: npm install -g @anthropic-ai/claude-code`,
    )
    .catch(() => {})
}

/** For climayte_status and Desk 2. */
export function installStatusView(): {
  ok: boolean
  reason: string | null
  version: string | null
  usingLastKnownGood: boolean
  repairing: boolean
  nextRepairAt: string | null
} {
  const s = claudeInstallState()
  return {
    ok: s.ok,
    reason: s.reason,
    version: s.version,
    usingLastKnownGood: s.usingLastKnownGood,
    repairing: s.repairing,
    nextRepairAt: s.nextRepairAt ? new Date(s.nextRepairAt).toISOString() : null,
  }
}

/** Wait for a running repair (tests; a scripted demonstration). */
export async function settleRepair(): Promise<void> {
  for (let i = 0; i < 400 && (repair.running || snapshotting); i++)
    await new Promise((r) => setTimeout(r, 5))
}

export function resetGuard(): void {
  cache.clear()
  repair.running = false
  repair.failures = 0
  repair.nextAt = null
  repair.runs = 0
  repair.lastDetail = null
  lkgSnapshotKey = null
  snapshotting = false
  claudeExeFallback.primary = null
  claudeExeFallback.path = null
}
