/**
 * THE RELAUNCH HANDOFF: a daemon that relaunches itself never exits until its successor has
 * reported in. Used by relaunchDaemon() in index.ts (auto-update, /api/update/apply and
 * /api/daemon/restart all go through it).
 *
 * WHY (2026-09-25, from daemon.log). At 18:46:13Z the daemon logged "update applied, relaunching",
 * exited 0.8s later, and no successor ever logged a start. Port 7787 had no listener for 90
 * minutes; every chat's MCP got ECONNREFUSED and every usage gate that reads through the daemon
 * read "stop". The old code treated "spawn() did not throw" as "a successor exists", and on
 * Windows that proves nothing: the spawn is a transient powershell that hands the command line to
 * WMI Win32_Process.Create (see detached-spawn.mjs) and exits 0 whether or not the daemon it asked
 * for ever started. That update had swapped the exe on disk two minutes earlier, so the successor
 * most likely failed to start from a file mid-swap, and nothing could see it.
 *
 * THE CONTRACT. The predecessor clears any stale ack, spawns, then keeps SERVING while it waits for
 * the successor to write `relaunch.ack` in the shared pointer directory. The successor writes it as
 * its first act after booting (just before it waits for the port), so an ack means the new build
 * loaded, opened its state and is about to take the port. Only then does the predecessor free the
 * port. No ack inside the deadline: the predecessor logs it and STAYS UP on the running version.
 * One daemon on old code beats zero daemons on new code.
 *
 * Why an ack file rather than waiting for the successor to bind: the successor cannot bind until
 * the predecessor lets go of the port (it rebinds the SAME port so open tabs keep working), so
 * "bound" is unobservable from the side that must decide. "Booted and waiting for the port" is the
 * latest point both sides can see. A successor that acks and then dies before binding is the tray
 * watchdog's case (misc/tray-host-native: revives a daemon that stops answering).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const RELAUNCH_ACK_FILE = 'relaunch.ack'

/** How long a predecessor waits for its successor to report in. A healthy handoff acks in well
 *  under a second; the minute is for a box with its CPU pinned, where the transient powershell
 *  alone can take several seconds to start. */
export const RELAUNCH_ACK_TIMEOUT_MS = 60_000

export interface RelaunchAck {
  pid: number
  at: number
}

export function relaunchAckPath(dir: string): string {
  return join(dir, RELAUNCH_ACK_FILE)
}

/** Successor side: report in. Written to a temp name and renamed, so a reader never sees half. */
export function writeRelaunchAck(dir: string, pid = process.pid, now = Date.now()): void {
  mkdirSync(dir, { recursive: true })
  const path = relaunchAckPath(dir)
  const tmp = `${path}.${pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ pid, at: now } satisfies RelaunchAck))
  renameSync(tmp, path)
}

/** The ack in `dir`, or null when there is none. A file that is not a well-formed ack is not an
 *  ack from our successor (the writer above renames a complete file into place), so it reads as
 *  none; any other I/O error is real and throws. */
export function readRelaunchAck(dir: string): RelaunchAck | null {
  let raw: string
  try {
    raw = readFileSync(relaunchAckPath(dir), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const ack = parsed as Partial<RelaunchAck> | null
  if (!ack || typeof ack.pid !== 'number' || typeof ack.at !== 'number') return null
  return { pid: ack.pid, at: ack.at }
}

export interface RelaunchHandoffDeps {
  /** Start the successor. Throws when the spawn itself fails. Returning proves nothing more. */
  spawnSuccessor: () => void
  /** The directory both daemons share (the runtime pointer's directory). */
  ackDir: string
  /** This daemon's pid: an ack naming it is not a successor's. */
  selfPid: number
  /** Free the port and exit. Called at most once, and only after the successor reported in. */
  shutdown: () => void
  timeoutMs?: number
  pollMs?: number
  log?: (message: string) => void
  error?: (message: string, cause?: unknown) => void
}

/**
 * Spawn a successor and hand over to it. Resolves true when the successor reported in and
 * `shutdown` was called; false when this daemon is staying up (spawn threw, no ack in time, or the
 * ack directory could not be read). Never rejects: callers fire it from timers and hooks, where a
 * rejection would take the daemon down, the one outcome this exists to prevent.
 */
export async function relaunchWithHandoff(deps: RelaunchHandoffDeps): Promise<boolean> {
  const timeoutMs = deps.timeoutMs ?? RELAUNCH_ACK_TIMEOUT_MS
  const pollMs = deps.pollMs ?? 250
  const log = deps.log ?? ((m: string) => console.log(m))
  const error = deps.error ?? ((m: string, cause?: unknown) => console.error(m, cause ?? ''))
  const stay = `this daemon (pid ${deps.selfPid}) is STAYING UP on the running version`

  try {
    // A leftover ack from an earlier handoff would read as this one's successor.
    rmSync(relaunchAckPath(deps.ackDir), { force: true })
    deps.spawnSuccessor()
  } catch (e) {
    error(`[agenthydra] relaunch: the successor could not be spawned; ${stay}.`, e)
    return false
  }
  log(
    `[agenthydra] relaunch: successor spawned; waiting up to ${Math.round(timeoutMs / 1000)}s for it to report in before this daemon exits`,
  )

  const deadline = Date.now() + timeoutMs
  try {
    for (;;) {
      const ack = readRelaunchAck(deps.ackDir)
      if (ack && ack.pid !== deps.selfPid) {
        log(
          `[agenthydra] update applied, relaunching the daemon: successor pid ${ack.pid} reported in; this daemon (pid ${deps.selfPid}) exits to free the port`,
        )
        deps.shutdown()
        return true
      }
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, pollMs))
    }
  } catch (e) {
    error(`[agenthydra] relaunch: could not read ${relaunchAckPath(deps.ackDir)}; ${stay}.`, e)
    return false
  }
  error(
    `[agenthydra] relaunch: no successor reported in within ${Math.round(timeoutMs / 1000)}s (it failed to start, or started and died before booting); ${stay}. Restart it from the tray to retry.`,
  )
  return false
}
