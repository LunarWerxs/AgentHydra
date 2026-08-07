// Running-instance pointer — thin per-app adapter over the shared kit factory
// (`createInstancePointer`, synced in as `./instance-pointer.mjs`). The daemon records the
// port it ACTUALLY bound in <CONFIG_DIR>/runtime.json so the tray launcher and the
// /api/health probe can find it and enforce single-instance. Best-effort throughout.
import { CONFIG_DIR, HOST, SERVICE_NAME } from './config'
import { createInstancePointer, type InstanceInfo } from './instance-pointer.mjs'

export type { InstanceInfo }

const pointer = createInstancePointer({
  configDir: CONFIG_DIR,
  serviceName: SERVICE_NAME,
  host: HOST,
})

export const instanceFilePath = pointer.instanceFilePath
export const writeInstanceInfo = pointer.writeInstanceInfo
export const updateInstanceInfo = pointer.updateInstanceInfo
export const readInstanceInfo = pointer.readInstanceInfo
export const clearInstanceInfo = pointer.clearInstanceInfo
export const findLiveInstance = pointer.findLiveInstance

/**
 * How many /api/health probes the single-instance guard should spend before concluding "nothing is
 * running", given the pointer we actually have.
 *
 * The guard re-probes because a daemon that is ALIVE BUT BUSY (boot scanning, a slow sync tick) can
 * miss one probe, and concluding "free" there starts a second daemon that hops to PORT+1 — two live
 * daemons and a pointer aimed at the wrong one. That reasoning is sound and the retries stay.
 *
 * What it does not justify is paying for those retries when the pointer is a TOMBSTONE. A daemon
 * that exits cleanly deletes runtime.json, so a pointer that still exists means the last one was
 * hard-killed, crashed, or lost its host — and the pid it names is usually long gone. Probing that
 * three times is 500ms of pure setTimeout on the recovery path, i.e. exactly the boot after
 * something went wrong. Measured 2026-08-07: 1,420ms to first response with a stale pointer against
 * 920ms without one.
 *
 * So: ask the OS whether the recorded process still exists. Gone → one probe is enough to confirm
 * what we already know. Alive (or unknowable) → the full re-probe, unchanged. Signal 0 performs the
 * permission/existence check WITHOUT delivering a signal, on Windows as well as POSIX.
 *
 * Deliberately conservative in both unknown directions: no pointer, no pid, or a pid we are not
 * allowed to query all fall through to the careful path. A recycled pid belonging to some unrelated
 * process also lands there — it just costs the probes it costs today and still answers null.
 */
export function singleInstanceProbeAttempts(careful = 3): number {
  try {
    const pid = readInstanceInfo()?.pid
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return careful
    process.kill(pid, 0)
    return careful
  } catch (error) {
    // ESRCH: no such process — the pointer outlived its daemon. EPERM means it IS running, just
    // not ours to signal, so that one keeps the careful path.
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return code === 'ESRCH' ? 1 : careful
  }
}
