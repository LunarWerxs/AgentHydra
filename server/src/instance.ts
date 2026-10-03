// Running-instance pointer — thin per-app adapter over the shared kit factory
// (`createInstancePointer`, synced in as `./instance-pointer.mjs`). The daemon records the
// port it ACTUALLY bound in <CONFIG_DIR>/runtime.json so the tray launcher and the
// /api/health probe can find it and enforce single-instance. Best-effort throughout.
import { connect } from 'node:net'
import { CONFIG_DIR, DATA_DIR, DB_PATH, HOST, PORT, SERVICE_NAME } from './config'
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
export const IS_PRIMARY_INSTALL = isPathInside(CONFIG_DIR, DATA_DIR)

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

/** The url a primary daemon binds when nothing is in its way: what every client falls back to. */
export const DEFAULT_URL = `http://${HOST}:${PORT}`

interface HealthBody {
  ok?: boolean
  service?: string
  pid?: number
  dbPath?: string
}

/** /api/health of `url` as OUR service, or null: not answering, not ok, or someone else's server. */
export async function ourHealthAt(url: string, timeoutMs: number): Promise<HealthBody | null> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as HealthBody | null
    return body?.ok && body.service === SERVICE_NAME ? body : null
  } catch {
    return null
  }
}

/**
 * A live AgentHydra on the DEFAULT port that the pointer does NOT name.
 *
 * That is the shape a stale, missing or hijacked runtime.json leaves behind (2026-09-12: the
 * pointer named a dead 7799 while the real daemon answered on 7787). findLiveInstance() trusts the
 * pointer and answered null, and a boot that believes it waits out the busy port, hops to 7788 and
 * writes a second pointer: two live daemons. So the boot guard asks the default port directly and,
 * like the kit, accepts only a body that carries OUR service name. Null when the pointer already
 * names that url (nothing new to learn there), when nothing answers, or when whatever answers is
 * someone else's server. The pointer is deliberately NOT repaired from here: the live daemon owns
 * it and re-asserts it itself (reassertInstancePointer).
 */
export async function findLiveOnDefaultPort(timeoutMs = 1500): Promise<InstanceInfo | null> {
  if (readInstanceInfo()?.url === DEFAULT_URL) return null
  const body = await ourHealthAt(DEFAULT_URL, timeoutMs)
  if (!body) return null
  return {
    port: PORT,
    url: DEFAULT_URL,
    pid: typeof body.pid === 'number' ? body.pid : 0,
    startedAt: 0,
    foundOnDefaultPort: true,
  }
}

/**
 * THE POINTER HEALS ITSELF. Called by the running daemon on a timer: if runtime.json is missing, or
 * names another pid whose url no longer answers as this service, write ours again. Never while it
 * names a LIVE other daemon (a hopped successor, an auto-update relaunch mid-handover): that one
 * owns the file. Before this, a pointer deleted by hand, lost to a crash, or overwritten by a
 * pre-fix side-run stayed wrong until the next restart, and every client dialled a dead port for
 * as long as the daemon lived.
 */
export async function reassertInstancePointer(
  boundPort: number,
  extra: () => Record<string, unknown>,
): Promise<'kept' | 'foreign-live' | 'rewritten'> {
  const info = readInstanceInfo()
  if (info?.pid === process.pid) return 'kept'
  if (info?.url && (await ourHealthAt(info.url, 1000))) return 'foreign-live'
  writeInstanceInfo(boundPort, extra())
  return 'rewritten'
}

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
  const pid = readInstanceInfo()?.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return careful
  return processExists(pid) === false ? 1 : careful
}

/** Whether `pid` is a running process: false only on ESRCH (no such process). EPERM means it IS
 *  running, just not ours to signal; any other failure is unknown (null). */
function processExists(pid: number): boolean | null {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return code === 'ESRCH' ? false : code === 'EPERM' ? true : null
  }
}

/** Whether something accepts a TCP connection at `url`'s host and port within timeoutMs. */
function portAccepts(url: string, timeoutMs: number): Promise<boolean> {
  let host: string
  let port: number
  try {
    const u = new URL(url)
    host = u.hostname
    port = Number(u.port)
  } catch {
    return Promise.resolve(false)
  }
  if (!port) return Promise.resolve(false)
  return new Promise((resolve) => {
    const sock = connect({ host, port })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/**
 * The daemon the pointer names, when it is ALIVE BUT NOT ANSWERING: its process exists and its
 * port still accepts connections, but /api/health timed out (the boot guard asks this only after
 * every probe failed). That is a blocked event loop, not a free slot.
 *
 * 2026-10-02 22:58Z (docs/CLIMAYTE-FIELD-NOTES.md, note 62): the daemon on 7787 froze for 25.6 s,
 * the tray started another, its probes all timed out inside the freeze, and it waited out the busy
 * port, hopped to 7788 and took the pointer. Two daemons then ran one store: each resumed the
 * other's running CliMayte workers as interrupted (two copies of each on two accounts), and every
 * MCP tool followed the pointer to 7788 while the orchestrator POSTed to 7787. A frozen daemon
 * answers again in seconds; a second daemon on its store is damage that lasts until one is stopped.
 *
 * Null when the pointer is ours or names no pid, when that process is gone (a crash: the boot goes
 * on as before), or when nothing accepts on its port (a process that kept the pid but not the port).
 */
export async function findStalledOwner(timeoutMs = 1000): Promise<InstanceInfo | null> {
  const info = readInstanceInfo()
  const pid = info?.pid
  if (!info?.url || typeof pid !== 'number' || pid <= 0 || pid === process.pid) return null
  if (processExists(pid) === false) return null
  return (await portAccepts(info.url, timeoutMs)) ? info : null
}

const sameFile = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

/** How many ports past the default a hopped daemon is looked for (findFreePort takes the first free). */
const HOP_SCAN = 4

/**
 * Another LIVE AgentHydra serving THIS daemon's store, or null: the pointer's daemon when it is not
 * this one, else one on the default port or the few just past it, where a hop lands. A twin need
 * not hold the pointer: on 2026-10-02 7787 restarted and took it back while the stray stayed on
 * 7788, named nowhere. Only a /api/health that answers as our service, from another pid, naming this
 * daemon's database counts (a side-run's own store is not this one; instance mode answers as another
 * service). The running daemon asks on its pointer tick and stamps every answer with what it found
 * (side-run.ts), so a client reading one of two daemons is told so instead of reading a partial
 * store as the whole (note 62). Nothing listening on a port is refused at once on loopback.
 */
export async function findPeerDaemon(
  boundPort: number,
  timeoutMs = 1000,
): Promise<{ url: string; pid: number } | null> {
  const own = `http://${HOST}:${boundPort}`
  const info = readInstanceInfo()
  const urls = new Set<string>()
  if (info?.url && info.pid !== process.pid) urls.add(info.url)
  for (let p = PORT; p <= PORT + HOP_SCAN; p++) urls.add(`http://${HOST}:${p}`)
  urls.delete(own)
  for (const url of urls) {
    const body = await ourHealthAt(url, timeoutMs)
    if (
      body &&
      typeof body.pid === 'number' &&
      body.pid !== process.pid &&
      typeof body.dbPath === 'string' &&
      sameFile(body.dbPath, DB_PATH)
    )
      return { url, pid: body.pid }
  }
  return null
}

/**
 * The live daemon the pointer names, as /api/health confirms it, or null (no pointer, it is this
 * process, or nothing answers as our service). Read by a relaunch successor before it reports in.
 */
export async function findPointerOwner(
  timeoutMs = 1500,
): Promise<{ pid: number; port: number } | null> {
  const info = readInstanceInfo()
  if (!info?.url || info.pid === process.pid) return null
  const body = await ourHealthAt(info.url, timeoutMs)
  if (!body || typeof body.pid !== 'number') return null
  return { pid: body.pid, port: info.port }
}
