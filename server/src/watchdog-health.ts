// server/src/watchdog-health.ts - the daemon supervisor's one judgement, kept in TypeScript so
// it is typed and testable rather than buried in a script.
//
// THE DANGEROUS FAILURE IS NOT "THE PROCESS DIED". That one announces itself the moment anything
// probes it. It is the daemon alive and answering HTTP while its sweep loop has stopped ticking:
// every reading says healthy, and the fleet quietly stops being managed. So the watchdog checks
// liveness AND liveliness, and this is the second half.

export interface LoopHealthInput {
  settings?: { enabled?: boolean; intervalMin?: number }
  lastRun?: { at?: string } | null
}

/** How many whole intervals the loop may miss before it counts as wedged. Three, because one
 *  tick can legitimately run long (a sweep drives real UI) and a false alarm teaches people to
 *  ignore the true one. */
export const MISSED_TICKS_ALLOWED = 3
/** Floor under the wedged window, so a 1-minute interval cannot alarm on a single slow tick. */
export const WEDGED_FLOOR_MS = 10 * 60_000

/**
 * Has the standing sweep stopped ticking?
 *
 * Never says wedged for a loop that is switched OFF - that is not a fault, it is a setting, and
 * alarming about it would be the false positive that gets the whole watchdog ignored.
 */
export function wedgedVerdict(
  status: LoopHealthInput | undefined | null,
  nowMs: number,
): { wedged: boolean; why: string } {
  const s = status?.settings
  if (!s?.enabled) return { wedged: false, why: 'the standing sweep is switched off' }
  const last = Date.parse(status?.lastRun?.at ?? '')
  // Enabled but never ticked: normal in the minutes after a restart, and the window below is
  // longer than that, so this is not yet evidence of anything.
  if (!Number.isFinite(last)) return { wedged: false, why: 'enabled but no tick recorded yet' }
  const interval = Number(s.intervalMin) || 15
  const window = Math.max(WEDGED_FLOOR_MS, MISSED_TICKS_ALLOWED * interval * 60_000)
  const age = nowMs - last
  if (age <= window) return { wedged: false, why: `last tick ${Math.round(age / 60_000)}m ago` }
  return {
    wedged: true,
    why: `the loop is enabled but has not ticked for ${Math.round(age / 60_000)}m (interval is ${interval}m)`,
  }
}
