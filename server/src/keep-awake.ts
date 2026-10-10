// server/src/keep-awake.ts - keep this PC from going to sleep on its own while an agent works on it.
//
// Design idea from stablyai/orca's agent awake service (src/main/agent-awake-service.ts and
// agent-awake-status-lease.ts, MIT); written fresh for AgentHydra.
//
// WHY THIS EXISTS. CliMayte workers and hook-reporting sessions run with nobody at the keyboard, and
// Windows' idle timer does not know they are there: after its sleep timeout the PC suspends and every
// worker stops mid-turn, to be found hours later as a stall. While something is working, this asks the
// OS not to idle-sleep; once nothing is, it lets go.
//
// WHAT COUNTS AS WORKING, and nothing else:
//   - a CliMayte worker that is running or running its check (waiting for an account or queued is not
//     work: a queue held for days at a usage wall must not keep a PC up for days);
//   - a session whose live status row (agent-status.ts) says working, that THIS daemon heard (a row
//     restored from before a restart is not evidence) within the last KEEP_AWAKE_LEASE_MS. The lease
//     is what stops a lost Stop hook from holding the PC awake forever.
// A chat waiting on you (blocked) does not hold it: a person has to come back for it anyway.
//
// WHAT IT NEVER DOES. It asks only that the system stay up (ES_SYSTEM_REQUIRED), never the display:
// the screen still turns off and locks. It changes no power plan, and Sleep from the Start menu, the
// power button or the lid still works. The request dies with this process. The switch is
// `keepAwakeWhileWorking` in Settings, on by default.

import { type ChildProcess, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { climayteList } from './climayte-view'
import { db } from './db'
import { getProviderSettings } from './provider-settings'

/** How long a working row counts without a newer event (Orca uses the same two hours). */
export const KEEP_AWAKE_LEASE_MS = 2 * 60 * 60 * 1000
const TICK_MS = 60_000

/** CliMayte statuses that are a process doing work right now. */
const WORKING_WORKER = new Set(['running', 'checking'])

export interface KeepAwakeCounts {
  /** Sessions with a fresh, live `working` status row. */
  sessions: number
  /** CliMayte workers running or checking. */
  workers: number
}

export interface KeepAwakeStatus extends KeepAwakeCounts {
  enabled: boolean
  /** The OS has been asked to stay awake, now. */
  active: boolean
  /** What holds it on this platform, or 'none' where nothing can. */
  holder: 'windows' | 'caffeinate' | 'systemd-inhibit' | 'none'
  /** When the current hold began. */
  since: string | null
  /** Why the last hold or release failed, if it did. */
  error: string | null
}

/** One way of asking the OS to stay up. `hold` and `release` are each called once per transition. */
export interface AwakeHolder {
  kind: KeepAwakeStatus['holder']
  hold(): void
  release(): void
}

/** Pure: should the PC be held awake? */
export function shouldHoldAwake(enabled: boolean, c: KeepAwakeCounts): boolean {
  return enabled && c.sessions + c.workers > 0
}

/** Live working sessions: heard by this process (not restored) within the lease. */
export function countWorkingSessions(now = Date.now()): number {
  const cutoff = new Date(now - KEEP_AWAKE_LEASE_MS).toISOString()
  const row = db
    .query<{ n: number }, [string]>(
      "select count(*) as n from agent_status where state = 'working' and restored_unconfirmed = 0 and at >= ?",
    )
    .get(cutoff)
  return row?.n ?? 0
}

function countWorkingWorkers(): number {
  return climayteList({ active: true }).filter((w) => WORKING_WORKER.has(w.status)).length
}

// SetThreadExecutionState flags. The request belongs to the calling thread, which for this daemon is
// Bun's one JavaScript thread, so every call comes from the same place. `>>> 0` keeps the high bit
// as an unsigned value: `0x80000000 | 1` alone is a negative number in JavaScript.
const ES_CONTINUOUS = 0x80000000
const ES_SYSTEM_REQUIRED = 0x00000001

function windowsHolder(): AwakeHolder {
  const { dlopen, FFIType } = createRequire(import.meta.url)('bun:ffi') as typeof import('bun:ffi')
  const k = dlopen('kernel32.dll', {
    SetThreadExecutionState: { args: [FFIType.u32], returns: FFIType.u32 },
  })
  const set = (flags: number) => k.symbols.SetThreadExecutionState(flags >>> 0) as number
  return {
    kind: 'windows',
    hold() {
      if (set(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) === 0)
        throw new Error('SetThreadExecutionState refused the request')
    },
    release() {
      set(ES_CONTINUOUS)
    },
  }
}

/** macOS and Linux: a helper process holds the request while it lives, and is told to watch this
 *  daemon so it ends with it (an orphan would keep the machine up forever). */
function childHolder(kind: 'caffeinate' | 'systemd-inhibit', argv: string[]): AwakeHolder {
  let child: ChildProcess | null = null
  return {
    kind,
    hold() {
      const [cmd, ...args] = argv
      child = spawn(cmd as string, args, { stdio: 'ignore', windowsHide: true })
      child.on('error', () => {
        child = null
      })
    },
    release() {
      child?.kill()
      child = null
    },
  }
}

function platformHolder(): AwakeHolder | null {
  try {
    if (process.platform === 'win32') return windowsHolder()
    if (process.platform === 'darwin')
      return childHolder('caffeinate', ['caffeinate', '-i', '-w', String(process.pid)])
    if (process.platform === 'linux')
      return childHolder('systemd-inhibit', [
        'systemd-inhibit',
        '--what=idle',
        '--who=AgentHydra',
        '--why=An agent is working',
        '--mode=block',
        'sh',
        '-c',
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 30; done`,
      ])
  } catch {
    // No bun:ffi (a Node test run) or no kernel32: nothing can hold it here.
  }
  return null
}

export interface KeepAwakeDeps {
  holder: AwakeHolder | null
  enabled: () => boolean
  counts: () => KeepAwakeCounts
  now: () => number
}

/** The controller: evaluates, and touches the OS only on a change. Built with deps so the transition
 *  rules are tested without a power request. */
export function createKeepAwake(deps: KeepAwakeDeps) {
  let active = false
  let since: string | null = null
  let error: string | null = null
  let last: KeepAwakeCounts = { sessions: 0, workers: 0 }

  function refresh(): KeepAwakeStatus {
    const enabled = deps.enabled()
    try {
      last = deps.counts()
    } catch (e) {
      // A failed read is not "nothing works": keep whatever was decided last.
      error = `could not count working agents: ${(e as Error).message}`
      return status(enabled)
    }
    const want = shouldHoldAwake(enabled, last) && deps.holder !== null
    if (want !== active && deps.holder) {
      try {
        if (want) deps.holder.hold()
        else deps.holder.release()
        active = want
        since = want ? new Date(deps.now()).toISOString() : null
        error = null
      } catch (e) {
        error = `${want ? 'hold' : 'release'} failed: ${(e as Error).message}`
      }
    }
    return status(enabled)
  }

  function status(enabled = deps.enabled()): KeepAwakeStatus {
    return { enabled, active, holder: deps.holder?.kind ?? 'none', since, error, ...last }
  }

  function stop(): void {
    if (active && deps.holder) deps.holder.release()
    active = false
    since = null
  }

  return { refresh, status, stop }
}

let controller: ReturnType<typeof createKeepAwake> | null = null
let timer: ReturnType<typeof setInterval> | null = null

/** Starts the minute tick. Idempotent. */
export function startKeepAwake(): void {
  if (timer) return
  controller ??= createKeepAwake({
    holder: platformHolder(),
    enabled: () => getProviderSettings().keepAwakeWhileWorking,
    counts: () => ({ sessions: countWorkingSessions(), workers: countWorkingWorkers() }),
    now: Date.now,
  })
  controller.refresh()
  timer = setInterval(() => controller?.refresh(), TICK_MS)
  timer.unref?.()
}

/** Re-evaluates now (a settings change), and answers the result. */
export function refreshKeepAwake(): KeepAwakeStatus | null {
  return controller?.refresh() ?? null
}

export function keepAwakeStatus(): KeepAwakeStatus | null {
  return controller?.status() ?? null
}

export function stopKeepAwake(): void {
  if (timer) clearInterval(timer)
  timer = null
  controller?.stop()
}
