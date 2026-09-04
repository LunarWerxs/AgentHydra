// Startup-liveness watchdog - a daemon that hangs before it starts listening looks IDENTICAL to a
// slow one from the outside: the tray icon just sits there, nothing has logged yet (initFileLogging
// itself only runs partway through boot), and /api/health has never been reachable because nothing
// is bound to a port to answer it. The only way anyone finds out today is by waiting and eventually
// killing the process by hand. A daemon thread - well, an unref'd timer, this being a single-
// threaded runtime - armed at process entry and disarmed once the port is actually bound catches
// that: a locked sqlite file, a port probe that never resolves, an updater step that stalls, all
// look the same to it (no renewal before the deadline), and it logs the last phase reached plus the
// pid and exits with a distinct code so the tray/service supervisor restarts instead of hanging.
//
// Slow-but-alive boots are not killed: every phase that could legitimately take a while calls
// renewBootWatchdog(phase) as it starts, which pushes the deadline back out and records the phase
// name for the fire-time diagnostic. A boot that is silently wedged never calls it again, so the
// original deadline (from the LAST renewal) still expires.
//
// Ported in shape (arm / renew / disarm) from NousResearch/hermes-agent's
// hermes_startup_watchdog.py (MIT, Copyright (c) Nous Research) - see that file's module docstring
// for the fuller design this trims from: no CPU-progress fallback, no faulthandler thread-stack
// dump, no lifecycle ledger. AgentHydra's boot is a short, single-process sequence of phases that
// each run once, not a long-lived gateway process guarding against adversarial deadlocks, so a
// bare deadline-with-renewal is the whole mechanism worth porting. Adapted for AgentHydra.
//
// Config is env-only (AGENTHYDRA_BOOT_DEADLINE_MS) so a hang while reading some OTHER config source
// can never be the reason the watchdog itself never arms.

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './config'

export const ENV_BOOT_DEADLINE_MS = 'AGENTHYDRA_BOOT_DEADLINE_MS'

/** Default deadline for the full daemon boot (db open → migrations → queue recovery → scheduler →
 *  listen). Generous: it has to cover a slow disk replaying a big WAL and a self-update relaunch
 *  racing the predecessor for the port (see index.ts's waitForPortFree). */
export const DEFAULT_BOOT_DEADLINE_MS = 120_000

/** Instance mode's whole point is to be a quick launcher; a wedge there should surface fast rather
 *  than sit for the same two minutes the full daemon is allowed. */
export const INSTANCE_MODE_BOOT_DEADLINE_MS = 30_000

/** Distinct from the crash handlers' exit(1) (index.ts / instance-mode.ts's own uncaughtException /
 *  unhandledRejection) so a watchdog fire is tellable apart from an ordinary crash in a launcher or
 *  a log, without having to match on the message text. */
export const BOOT_WATCHDOG_EXIT_CODE = 87

/** True while the constants above should never actually arm a real timer - bun test always sets
 *  this (see server/src/config.ts's own NODE_ENV === 'test' backstop, which this reuses rather than
 *  inventing a second test-mode signal). Tests exercise the mechanism directly via
 *  createBootWatchdog(), which has no test-mode gate of its own, with injected deps - never a real
 *  wait, never process.exit. */
function testModeActive(): boolean {
  return process.env.NODE_ENV === 'test'
}

export interface BootWatchdogFireInfo {
  lastPhase: string | null
  elapsedMs: number
  pid: number
}

interface BootWatchdogDeps {
  now: () => number
  setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void
  onFire: (info: BootWatchdogFireInfo) => void
}

function logDir(): string {
  return join(CONFIG_DIR, 'logs')
}

/** The diagnostic line the fire path writes - one line, so it never leaves the log mid-write. */
function fireMessage(info: BootWatchdogFireInfo): string {
  return (
    `[agenthydra] boot watchdog fired: the daemon did not reach a bound port within its deadline ` +
    `(pid=${info.pid}, elapsedMs=${info.elapsedMs}, lastPhase=${info.lastPhase ?? '(none - never renewed)'}); ` +
    `exiting ${BOOT_WATCHDOG_EXIT_CODE} so the supervisor restarts instead of a silent hang`
  )
}

/**
 * Console + the daemon's own log file (see log-file.mjs), then a distinct-code exit. Best-effort on
 * the file write - a watchdog whose OWN diagnostics wedge on a hung disk must still exit - and does
 * not rely on initFileLogging having already run (a hang early enough in boot could precede it), so
 * it appends to <CONFIG_DIR>/logs/daemon.log directly rather than going through console.error alone.
 */
function defaultOnFire(info: BootWatchdogFireInfo): void {
  const line = fireMessage(info)
  console.error(line)
  try {
    mkdirSync(logDir(), { recursive: true })
    appendFileSync(join(logDir(), 'daemon.log'), `[${new Date().toISOString()}] ERROR ${line}\n`)
  } catch {
    // Disk hung/full, or the dir is unwritable - console.error above is the fallback of last
    // resort and already ran; a logging failure must never be the reason the exit doesn't happen.
  }
  process.exit(BOOT_WATCHDOG_EXIT_CODE)
}

const realDeps: BootWatchdogDeps = {
  now: () => Date.now(),
  setTimeoutFn: (cb, ms) => setTimeout(cb, ms),
  clearTimeoutFn: (handle) => clearTimeout(handle),
  onFire: defaultOnFire,
}

export interface BootWatchdogHandle {
  /** Push the deadline back out to now + the original timeout and record *phase* as the last-known
   *  boot step (reported by the fire diagnostic). No-op once disarmed or fired. */
  renew(phase: string): void
  /** Boot reached a live, listening port - stand down. Idempotent; also cancels the timer so an
   *  unref'd handle can never itself be the reason anything lingers. */
  disarm(): void
  readonly disarmed: boolean
  /** The last phase name passed to renew(), or null if renew was never called. Exposed for tests. */
  readonly lastPhase: string | null
}

/**
 * Build one watchdog with fully injectable deps - the seam tests use so "expiry" and "renewal
 * before the deadline" are both provable with a fake clock/timer, no real waiting. Production code
 * never calls this directly; it goes through the module-singleton armBootWatchdog() below, which
 * applies the test-mode gate this function deliberately does NOT.
 */
export function createBootWatchdog(
  deadlineMs: number,
  deps: Partial<BootWatchdogDeps> = {},
): BootWatchdogHandle {
  const { now, setTimeoutFn, clearTimeoutFn, onFire } = { ...realDeps, ...deps }
  const armedAt = now()
  let lastPhase: string | null = null
  let disarmed = false

  function fire(): void {
    if (disarmed) return
    disarmed = true
    onFire({ lastPhase, elapsedMs: now() - armedAt, pid: process.pid })
  }

  let timer = setTimeoutFn(fire, deadlineMs)
  // Never keeps an otherwise-finished process alive - a normal exit must not wait out a 2-minute
  // boot timer just because it happened to still be armed (unref is a no-op on Bun's fake timers
  // under test, which is fine: those tests fire the callback directly and never let a real timer run).
  ;(timer as { unref?: () => void }).unref?.()

  return {
    renew(phase: string): void {
      if (disarmed) return
      lastPhase = phase
      clearTimeoutFn(timer)
      timer = setTimeoutFn(fire, deadlineMs)
      ;(timer as { unref?: () => void }).unref?.()
    },
    disarm(): void {
      if (disarmed) return
      disarmed = true
      clearTimeoutFn(timer)
    },
    get disarmed() {
      return disarmed
    },
    get lastPhase() {
      return lastPhase
    },
  }
}

/** Env override, floor-clamped to a sane minimum so a typo'd near-zero value can't make the
 *  watchdog fire mid-boot on every launch; falls back to *fallbackMs* on garbage or absent. */
export function resolveBootDeadlineMs(fallbackMs: number): number {
  const raw = process.env[ENV_BOOT_DEADLINE_MS]?.trim()
  if (!raw) return fallbackMs
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallbackMs
  return Math.max(n, 5_000)
}

// Module singleton: main.ts arms exactly one watchdog per process (the daemon and the instance-mode
// launcher are separate process entrypoints, never both in one process), and every phase along the
// way - db.ts, scheduler.ts, index.ts, instance-mode.ts - renews the SAME handle without needing to
// pass it around as a parameter through modules that otherwise don't know about each other.
let handle: BootWatchdogHandle | null = null

/**
 * Arm the process-wide boot watchdog. Idempotent (a second call while one is already armed is a
 * no-op) and inert under `bun test` (NODE_ENV=test - see testModeActive above), so tests never get
 * a live timer racing their assertions; call createBootWatchdog() directly to test the mechanism
 * itself. Never throws.
 */
export function armBootWatchdog(deadlineMs: number): void {
  if (testModeActive()) return
  if (handle && !handle.disarmed) return
  try {
    handle = createBootWatchdog(resolveBootDeadlineMs(deadlineMs))
  } catch (err) {
    // A watchdog that fails to arm must never take the boot it was meant to protect down with it.
    console.error('[agenthydra] failed to arm boot watchdog (continuing without it):', err)
  }
}

/** Renew the armed watchdog with *phase*. No-op when not armed (test mode, arm failed, or already
 *  disarmed) - safe to call unconditionally from any boot phase. Never throws. */
export function renewBootWatchdog(phase: string): void {
  try {
    handle?.renew(phase)
  } catch {
    // Renewal failing must never be why a live boot gets killed as if it had wedged.
  }
}

/** Stand down: boot reached a live, listening port. No-op when not armed. Never throws. */
export function disarmBootWatchdog(): void {
  try {
    handle?.disarm()
  } catch {
    // Best-effort by design - see renewBootWatchdog.
  }
}
