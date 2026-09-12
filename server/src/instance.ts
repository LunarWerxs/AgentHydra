// Running-instance pointer — thin per-app adapter over the shared kit factory
// (`createInstancePointer`, synced in as `./instance-pointer.mjs`). The daemon records the
// port it ACTUALLY bound in <CONFIG_DIR>/runtime.json so the tray launcher and the
// /api/health probe can find it and enforce single-instance. Best-effort throughout.
import { CONFIG_DIR, DATA_DIR, HOST, SERVICE_NAME } from './config'
import { isPathInside } from './core/paths'
import { createInstancePointer, type InstanceInfo } from './instance-pointer.mjs'

export type { InstanceInfo }

/**
 * Is this daemon the PRIMARY install — the one entitled to the machine-wide pointer?
 *
 * ⛔ A DAEMON WITH A RELOCATED STORE MUST NOT TAKE THE SHARED POINTER. `<CONFIG_DIR>/runtime.json`
 * is how every client on the machine finds the daemon: the MCP tools, the orchestrator scripts,
 * `hydralib`, the tray. On 2026-09-12 a session started a daemon from source on port 7799 with a
 * scratch database to click through a UI change; it overwrote that pointer to name itself and
 * exited without restoring it, and from then on every tool on the machine dialled a dead port and
 * reported "the daemon is not running" — while the real one sat on 7787 answering /api/health 200.
 * Nothing in the error text suggested a stale pointer, so the obvious next move was to start a
 * daemon, which would have made a second one.
 *
 * The test is the STORE, not the port: a primary install that finds 7787 busy hops to 7788 and is
 * still the machine's daemon, and the auto-update successor deliberately takes the same port. What
 * a probe always has is its own state — `AGENTHYDRA_DATA_DIR` (or `AGENTHYDRA_DB`) pointed
 * somewhere else, or a whole scratch `AGENTHYDRA_HOME`, which moves CONFIG_DIR and therefore takes
 * the pointer with it and was never the problem. So: a data dir outside the config dir means this
 * process is a side-run, and its pointer goes beside ITS OWN state as a sidecar. Nothing to clean
 * up afterwards, which is the whole point — the previous fix was "remember to repair it by hand".
 */
const IS_PRIMARY_INSTALL = isPathInside(CONFIG_DIR, DATA_DIR)

/** Where this daemon records itself: the shared config dir when it is the primary install, else
 *  its own data dir. Exported for the boot log, so a side-run says out loud that it is one. */
export const POINTER_DIR = IS_PRIMARY_INSTALL ? CONFIG_DIR : DATA_DIR

const pointer = createInstancePointer({
  configDir: POINTER_DIR,
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
