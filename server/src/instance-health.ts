// server/src/instance-health.ts - ONE ANSWER TO "CAN THIS INSTANCE BE USED RIGHT NOW, AND IF NOT,
// WHY NOT?"
//
// WHY THIS EXISTS (owner-queued gap, closed 2026-08-30): the fleet could say an instance was
// closed, and it could say it was signed out, and it could say an account was near its usage cap -
// three booleans in three files, each true for a different reason, and a failed act reported
// whichever one its own code path happened to look at. So "surface this chat" failed per-chat with
// a guess at the cause, twenty times over, instead of the fleet saying once: this account is not
// usable, here is why. This collects the signals that already exist, adds the one that did not,
// and gives every caller the same sentence.
//
// ⛔ 'CLOSED' IS NOT 'UNUSABLE'. A closed app is the normal resting state of this fleet and the
// system boots one deliberately when it needs to; saying a closed instance is broken would make
// the report useless. Closed is reported as its own state and is never a fault.
//
// ⛔ UNKNOWN IS NEVER 'FINE'. Every probe here can fail, and a probe that failed returns null, not
// false. A caller must be able to tell "I asked and it is healthy" from "I could not ask".

import { readLoginState } from './core/instances'

export type UnusableReason =
  | 'signed-out'
  | 'profile-unreadable'
  | 'no-config'
  | 'not-responding'
  | 'usage-wall'

export interface InstanceHealth {
  ref: string
  num: number | null
  /** The app process exists. Closed is a resting state, not a fault. */
  running: boolean
  /**
   * The app answered a window-level probe. NULL = not asked or the probe itself failed - never
   * read that as healthy, and never as broken.
   */
  responding: boolean | null
  /** Set when the instance cannot do useful work; null when it can (or when only closed). */
  unusable: { reason: UnusableReason; detail: string } | null
}

export interface HealthInput {
  ref: string
  num: number | null
  instanceDir: string
  isRunning: boolean
  /** Percent of the binding usage window already spent, when known. */
  usagePct?: number | null
}

/** At or above this an instance cannot be given new work; it is a wall, not a warning. */
export const USAGE_WALL_PCT = 99

/**
 * Which claude.exe main windows are answering, keyed by pid. NULL for a pid we could not judge.
 *
 * WHY A PROBE AT ALL: `isRunning` is a process enumeration - a pid and a command line. A wedged
 * Electron app keeps both, and its config.json on disk is untouched, so a hung instance reported
 * as perfectly healthy while every act against it failed one chat at a time. Windows already
 * tracks this per top-level window (`Responding`), so the signal is one call away and was simply
 * never asked for.
 */
export type RespondingMap = Map<number, boolean | null>

export interface HealthDeps {
  /** Seam for tests and for platforms with no such probe; default asks Windows. */
  responding?: () => RespondingMap
}

/** Ask Windows which claude.exe main windows are pumping messages. Never throws; an unavailable
 *  probe yields an EMPTY map, which reads as "not asked" for every pid rather than as trouble. */
export function readRespondingMap(
  run: (cmd: string, args: string[]) => { code: number; out: string } = defaultRun,
): RespondingMap {
  const map: RespondingMap = new Map()
  if (process.platform !== 'win32') return map
  try {
    const { code, out } = run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { "$($_.Id) $($_.Responding)" }',
    ])
    if (code !== 0) return map
    for (const line of out.split('\n')) {
      const [pidText, respondingText] = line.trim().split(/\s+/)
      const pid = Number(pidText)
      if (!Number.isInteger(pid) || pid <= 0) continue
      // Anything other than the two words we expect is UNKNOWN, not false. A misparse that reads
      // as 'not responding' would have the fleet declare a healthy app broken.
      map.set(pid, respondingText === 'True' ? true : respondingText === 'False' ? false : null)
    }
  } catch {
    // A missing or refused PowerShell is "not asked", never "not responding".
  }
  return map
}

function defaultRun(cmd: string, args: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync([cmd, ...args], {
    stdout: 'pipe',
    stderr: 'ignore',
    windowsHide: true,
  })
  return { code: proc.exitCode ?? 1, out: proc.stdout?.toString() ?? '' }
}

/**
 * The verdict for one instance. Order matters: report the fault a person can ACT on first. A
 * signed-out app and a wedged app are both unusable, but only one of them is fixed by signing in.
 */
export function healthOf(
  input: HealthInput,
  respondingByPid: RespondingMap,
  pid: number | null,
): InstanceHealth {
  const login = readLoginState(input.instanceDir)
  const responding = input.isRunning && pid !== null ? (respondingByPid.get(pid) ?? null) : null

  let unusable: InstanceHealth['unusable'] = null
  if (login.reason === 'unreadable')
    unusable = {
      reason: 'profile-unreadable',
      detail:
        'its config.json exists but could not be read or parsed - the profile is damaged, which ' +
        'is NOT a login problem and signing in again will not fix it',
    }
  else if (login.reason === 'no-config')
    unusable = {
      reason: 'no-config',
      detail: 'no config.json yet - this instance has never been signed in',
    }
  else if (login.reason === 'signed-out')
    unusable = { reason: 'signed-out', detail: 'no account is signed in - sign it in to use it' }
  else if (responding === false)
    unusable = {
      reason: 'not-responding',
      detail:
        'the app process is alive but its window is not answering - it is wedged, so every act ' +
        'against it will fail one chat at a time until it is restarted',
    }
  else if (typeof input.usagePct === 'number' && input.usagePct >= USAGE_WALL_PCT)
    unusable = {
      reason: 'usage-wall',
      detail: `at ${Math.round(input.usagePct)}% of its binding usage window - nothing useful until it resets`,
    }

  return { ref: input.ref, num: input.num, running: input.isRunning, responding, unusable }
}

/** Every instance's verdict in one pass, so the probe runs ONCE for the whole fleet. */
export function fleetHealth(
  inputs: Array<HealthInput & { pid: number | null }>,
  deps: HealthDeps = {},
): InstanceHealth[] {
  const map = (deps.responding ?? (() => readRespondingMap()))()
  return inputs.map((i) => healthOf(i, map, i.pid))
}

/** Only the instances that cannot be used, for a report that leads with what is wrong. */
export function unusableInstances(all: InstanceHealth[]): InstanceHealth[] {
  return all.filter((h) => h.unusable !== null)
}
