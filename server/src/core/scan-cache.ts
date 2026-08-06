// server/src/core/scan-cache.ts — a tiny TTL + single-flight + stale-while-revalidate cache for
// the expensive OS process scans (core/process.ts, core/codex-desktop.ts).
//
// WHY THIS EXISTS (measured on Windows 11 26200, 2026-08-06):
//
//   powershell -NoProfile startup .......... ~130 ms
//   Get-CimInstance Win32_Process .......... ~260 ms
//   ------------------------------------------------
//   one GET /api/instances ................. ~490 ms
//
// and the Instances tab polls that route every 4 SECONDS (useInstances.startPolling), with the
// Codex table polling its own near-identical CIM query every 5. So for as long as the app is open
// it was spawning a PowerShell process a few times a second-ish, forever, and every one of those
// half-seconds sat on the request path — first paint included. That is the whole of the "feels
// heavy and laggy" symptom, and none of it bought freshness a human could perceive.
//
// The shape here is deliberately stale-while-revalidate rather than a plain TTL:
//
//   age <= freshMs   → return the cached value, scan nothing.
//   age <= staleMs   → return the cached value IMMEDIATELY and kick off a refresh in the
//                      background. The poll tick that pays for the scan is never the tick that
//                      waits for it, so the route answers in ~1 ms at every cadence.
//   older / no value → await a real scan (a cold first request, or coming back from idle).
//
// Two consequences worth stating out loud:
//
// * SPAWNS ARE DEMAND-DRIVEN, not timer-driven. Nothing here holds an interval; a refresh only
//   ever happens because a request arrived. Close the UI and the process scanning stops dead,
//   which a background `setInterval` refresher would not have done.
// * A cached answer can lag reality by up to freshMs + one poll interval. That is fine for
//   "is this instance running" — EXCEPT right after the user themselves changed it, which is
//   why every mutation path calls invalidate() (or asks for a fresh scan outright). Waiting a
//   tick to notice someone else's `Claude.exe` is invisible; waiting a tick after your own click
//   is not.
//
// Never throws: `scan` is expected to swallow its own failures (both current callers resolve to
// an empty array on any enumeration problem), and a rejection is still contained here so one bad
// scan can't reject a route that only wanted a process list.

export interface ScanCacheOptions {
  /** Below this age the cached value is served with no refresh at all. */
  freshMs: number
  /** Above this age a caller WAITS for a real scan instead of taking the cached value. */
  staleMs: number
}

export interface ScanCache<T> {
  /** The current value: cached, background-refreshed, or freshly scanned — see the file header.
   *  `fresh: true` bypasses the cache entirely (mutation paths that must not act on a stale
   *  snapshot), and the result it scans becomes the new cached value. */
  get(opts?: { fresh?: boolean }): Promise<T>
  /** Drop the cached value so the next get() scans for real. Call after anything that changes
   *  what a scan would return (launching, quitting, creating or deleting an instance). */
  invalidate(): void
}

export function createScanCache<T>(scan: () => Promise<T>, opts: ScanCacheOptions): ScanCache<T> {
  let value: T | undefined
  let filledAt = 0
  // Single-flight: concurrent callers (the two instance tables refreshing on the same tick, a
  // background revalidation racing a cold read) share ONE scan rather than each spawning a shell.
  let inflight: Promise<T> | null = null

  function run(): Promise<T> {
    if (inflight) return inflight
    const p = (async () => {
      try {
        const next = await scan()
        value = next
        filledAt = Date.now()
        return next
      } finally {
        inflight = null
      }
    })()
    inflight = p
    return p
  }

  return {
    async get({ fresh = false } = {}): Promise<T> {
      if (fresh) {
        // Not just "skip the cache": join an in-flight scan if one is already running (it started
        // no earlier than now, so it is fresh by definition) rather than queueing a second shell.
        return await run()
      }
      const age = value === undefined ? Number.POSITIVE_INFINITY : Date.now() - filledAt
      if (age <= opts.freshMs) return value as T
      if (age <= opts.staleMs) {
        // Stale-while-revalidate: answer now, pay for the scan off the request path. The catch is
        // load-bearing — this promise is deliberately unawaited, so an unhandled rejection here
        // would be an unhandled rejection in the daemon.
        void run().catch(() => {})
        return value as T
      }
      return await run()
    },
    invalidate(): void {
      value = undefined
      filledAt = 0
    },
  }
}
