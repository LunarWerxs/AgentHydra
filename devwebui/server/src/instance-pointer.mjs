/**
 * Shared running-instance pointer for the LunarWerx daemons. The daemon may bind a
 * different port than requested (the preferred one was busy), so it records the port
 * it ACTUALLY bound in `<configDir>/runtime.json`. Launchers read this to open the
 * browser at the right URL and to detect an already-running instance via /api/health;
 * a dev Vite proxy can follow it too. Best-effort throughout: a write/read failure
 * never blocks the daemon.
 *
 * Runtime-agnostic (Bun + Node). Synced from the shared kit, do not edit in an
 * app; the `.d.mts` sibling types the import for the TypeScript apps.
 *
 * Per-app knobs:
 *   configDir    resolved dir that holds runtime.json (each app keeps its own
 *                resolution, e.g. honouring a $APP_HOME override, as local code)
 *   serviceName  if set, findLiveInstance also requires the health body's `service`
 *                to equal it (rejects a foreign daemon that happened to grab the port)
 *   host         host used in the recorded url (default "127.0.0.1")
 */
import { readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";

/** Gap between findLiveInstance re-probes (see `attempts` there). Short enough that a
 *  multi-attempt guard still adds well under a second to a genuine cold start. */
const RETRY_DELAY_MS = 250;

export function createInstancePointer({ configDir, serviceName, host = "127.0.0.1" }) {
  const runtimeFile = join(configDir, "runtime.json");

  /** Absolute path of the runtime pointer (so other tools can locate it). */
  function instanceFilePath() {
    return runtimeFile;
  }

  function persist(info) {
    mkdirSync(dirname(runtimeFile), { recursive: true });
    // 0600: it carries just the daemon's port + pid (no secrets). writeFileSync's
    // mode only applies on create; chmod forces it if the file already existed
    // (no-op on Windows, where the inherited dir ACL already restricts it).
    writeFileSync(runtimeFile, JSON.stringify(info, null, 2), { mode: 0o600 });
    try {
      chmodSync(runtimeFile, 0o600);
    } catch {
      /* windows / already-correct, ignore */
    }
  }

  /**
   * Record the port the daemon actually bound, so launchers can find this instance.
   * `extra` lets an app publish launcher-facing flags alongside the core fields
   * (e.g. `portableMode`, which the tray scripts read to pick app-window vs. tab);
   * core fields always win on a key collision.
   */
  function writeInstanceInfo(port, extra = {}) {
    try {
      persist({
        ...extra,
        port,
        url: `http://${host}:${port}`,
        pid: process.pid,
        startedAt: Date.now(),
      });
    } catch {
      /* best-effort, the launcher falls back to the default port */
    }
  }

  /**
   * Merge `fields` into the existing pointer (e.g. a settings toggle flipping
   * `portableMode` mid-run). No-op when no pointer exists: only a running daemon
   * owns the file, and its boot write is the one that creates it.
   */
  function updateInstanceInfo(fields) {
    try {
      const info = readInstanceInfo();
      if (!info) return;
      persist({ ...info, ...fields });
    } catch {
      /* best-effort */
    }
  }

  /** Read the recorded instance pointer, or null if missing/unreadable. */
  function readInstanceInfo() {
    try {
      return JSON.parse(readFileSync(runtimeFile, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * Remove the pointer on a clean shutdown — but ONLY if it still describes THIS process.
   *
   * The pointer is a singleton file; the daemons are not. A second daemon that boots, loses the
   * single-instance race, and exits runs its cleanup handler on the way out — and without this
   * guard that handler deletes the pointer belonging to the daemon that is still running. The
   * survivor is then invisible: launchers can't find it, and the restart scripts can't stop it.
   * That is the documented cause of the 2026-07-14 incident where a daemon served 10h39m-old code
   * while every rebuild reported success.
   *
   * Comparing `pid` makes deletion an owner-only operation. Erring toward keeping the file is the
   * cheap direction: readers already re-probe /api/health (findLiveInstance), so a stale pointer
   * reads as "not running", whereas a deleted live one strands a daemon nobody can see.
   */
  function clearInstanceInfo() {
    try {
      const info = readInstanceInfo();
      if (info?.pid && info.pid !== process.pid) return; // someone else's daemon — not ours to forget
      rmSync(runtimeFile, { force: true });
    } catch {
      /* best-effort */
    }
  }

  /**
   * Resolve a LIVE instance from the pointer, or null. Reads runtime.json and probes
   * `${url}/api/health` so a stale pointer (daemon crashed, or the port was recycled
   * by another app) reads as "nothing running", only a real, answering daemon counts.
   *
   * `attempts` > 1 re-probes before concluding "nothing running". A single probe is a
   * COIN FLIP for the single-instance guard: a daemon that is alive but momentarily busy
   * (boot-time scanning, a slow sync tick) misses one probe, the guard concludes the port
   * is free, and the caller starts a SECOND daemon that then hops to PORT+1 — leaving two
   * live daemons and a runtime pointer aimed at the wrong one. Observed repeatedly in
   * agenthydra's daemon.log (paired starts seconds apart, the second logging "port N was
   * busy"). Callers deciding whether to SPAWN should pass attempts >= 2; callers merely
   * reporting status can keep the cheap single probe.
   *
   * A service-name mismatch is a DEFINITIVE answer (someone else's server owns that port),
   * so it returns immediately and is never retried — only transient failures (timeout,
   * connection refused, a non-ok response) are worth a second look.
   */
  async function findLiveInstance(timeoutMs = 1000, attempts = 1) {
    const info = readInstanceInfo();
    if (!info?.url) return null;
    const tries = Math.max(1, attempts);
    for (let i = 0; i < tries; i++) {
      // Space out retries so a busy event loop gets a chance to drain before the next probe.
      if (i > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      try {
        const res = await fetch(`${info.url}/api/health`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) continue; // transient (503 while booting) → re-probe
        const body = await res.json();
        if (!body?.ok) continue;
        if (serviceName && body.service !== serviceName) return null; // definitive: not ours
        return info;
      } catch {
        // unreachable / timed out / malformed body → re-probe, then treat as not running
      }
    }
    return null;
  }

  return {
    instanceFilePath,
    writeInstanceInfo,
    updateInstanceInfo,
    readInstanceInfo,
    clearInstanceInfo,
    findLiveInstance,
  };
}
