// server/src/sweep-loop.ts - THE STANDING SWEEP (rebuild backlog, owner: "resume your
// recommended backlog", 2026-08-30): the daemon runs the gate sweep on a schedule, so the
// fleet is gated and the safe deeds happen without any AI awake. Monitor-pattern rails:
//
//   - OFF BY DEFAULT (a standing loop that archives chats must be turned on by a person),
//     with the same settings discipline as the auto-resume monitor.
//   - UNATTENDED-SAFE CAPS by default: archive UNLIMITED (the owner's stated wish,
//     reversible, click-verified) but surface 0 - a surfaced chat is DORMANT until someone
//     delivers its prompt, and an unattended tick has no deliverer, so surfacing would park
//     invisible work. The AI-residue lanes (crashed beyond report, needs-input judgments)
//     are left in the last report for a courier/caller to work through chat_sweep/chat_act.
//   - One tick at a time (re-entrancy guard), and every act inside the sweep already holds
//     the process-wide act lock, so a tick can never interleave with a manual sweep or the
//     monitor's landing.
//   - The last report is kept and served verbatim - a loop whose work cannot be inspected
//     is v1's mistake with a timer attached.

import { courierPass } from './courier'
import { getSetting, setSetting } from './db'
import { reconcileDeliveries } from './deliveries'
import { type SweepDeps, type SweepReport, sweepGateActions } from './gate-sweep'

export interface SweepLoopSettings {
  enabled: boolean
  /** Minutes between ticks. */
  intervalMin: number
  /** -1 = unlimited (stored sentinel; the sweep gets Infinity). */
  maxArchive: number
  maxSurface: number
}

function num(key: string, fallback: number, min: number, max: number): number {
  const raw = getSetting(key)
  // '' is ABSENT, not zero: Number('') === 0 is finite, and treating it as a value silently
  // turned every unregistered key into 0 (caught live - the unlimited -1 archive cap read
  // as 0). The keys are also registered in db.ts DEFAULT_SETTINGS; this guard is the belt.
  if (raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

export function getSweepLoopSettings(): SweepLoopSettings {
  return {
    enabled: getSetting('sweep_enabled') === '1',
    intervalMin: num('sweep_interval_min', 15, 5, 24 * 60),
    maxArchive: num('sweep_max_archive', -1, -1, 10_000),
    maxSurface: num('sweep_max_surface', 0, 0, 100),
  }
}

export function setSweepLoopSettings(patch: Partial<SweepLoopSettings>): SweepLoopSettings {
  if (typeof patch.enabled === 'boolean') setSetting('sweep_enabled', patch.enabled ? '1' : '0')
  if (typeof patch.intervalMin === 'number' && Number.isFinite(patch.intervalMin))
    setSetting(
      'sweep_interval_min',
      String(Math.min(24 * 60, Math.max(5, Math.floor(patch.intervalMin)))),
    )
  if (typeof patch.maxArchive === 'number' && Number.isFinite(patch.maxArchive))
    setSetting(
      'sweep_max_archive',
      String(Math.min(10_000, Math.max(-1, Math.floor(patch.maxArchive)))),
    )
  if (typeof patch.maxSurface === 'number' && Number.isFinite(patch.maxSurface))
    setSetting(
      'sweep_max_surface',
      String(Math.min(100, Math.max(0, Math.floor(patch.maxSurface)))),
    )
  return getSweepLoopSettings()
}

export interface SweepLoopStatus {
  settings: SweepLoopSettings
  lastRun: {
    at: string
    tookMs: number
    report: SweepReport
  } | null
  /** The most recent tick FAILURE - kept beside lastRun so a permanently-failing loop can
   *  never impersonate a healthy idle one (review-confirmed). */
  lastError: { at: string; message: string } | null
  /** Ticks refused because one was already in flight - evidence, not silence. */
  overlapSkips: number
  /** The delivery-ledger reconcile failing on the tick - durable, cleared by a clean pass. */
  lastReconcileError: { at: string; message: string } | null
  /** The courier pass failing (tick or always-on housekeeping) - same durable convention. */
  lastCourierError: { at: string; message: string } | null
  /** ISO of the next tick when enabled (never earlier than now; before the first tick it
   *  reads as imminent, not as 1970); null when off. */
  nextDueAt: string | null
}

let lastRun: SweepLoopStatus['lastRun'] = null
let lastError: SweepLoopStatus['lastError'] = null
let lastReconcileError: { at: string; message: string } | null = null
let lastCourierError: { at: string; message: string } | null = null
let lastTickAt = 0
let overlapSkips = 0
let ticking = false

/** Is a tick executing RIGHT NOW? Auto-update's busy check reads this - a relaunch must not
 *  kill the daemon mid-UIA-click or mid-instance-boot (review-confirmed). */
export function isSweepTicking(): boolean {
  return ticking
}

export function sweepLoopStatus(): SweepLoopStatus {
  const s = getSweepLoopSettings()
  return {
    settings: s,
    lastRun,
    lastError,
    overlapSkips,
    lastReconcileError,
    lastCourierError,
    nextDueAt: s.enabled
      ? new Date(Math.max(Date.now(), lastTickAt + s.intervalMin * 60_000)).toISOString()
      : null,
  }
}

/** The status copy of a report is BOUNDED (a fleet-size report held forever is a leak); the
 *  cut is flagged, never silent. The tick's own return stays untrimmed. */
const MAX_STATUS_ROWS = 100
function trimForStatus(report: SweepReport): SweepReport {
  const over =
    report.archiveRows.length > MAX_STATUS_ROWS ||
    report.crashedRows.length > MAX_STATUS_ROWS ||
    report.waitForReset.length > MAX_STATUS_ROWS ||
    report.needsJudgment.length > MAX_STATUS_ROWS ||
    report.ungated.length > MAX_STATUS_ROWS ||
    report.unswept.length > MAX_STATUS_ROWS
  if (!over) return report
  return {
    ...report,
    rowsTruncated: true,
    archiveRows: report.archiveRows.slice(0, MAX_STATUS_ROWS),
    crashedRows: report.crashedRows.slice(0, MAX_STATUS_ROWS),
    waitForReset: report.waitForReset.slice(0, MAX_STATUS_ROWS),
    needsJudgment: report.needsJudgment.slice(0, MAX_STATUS_ROWS),
    ungated: report.ungated.slice(0, MAX_STATUS_ROWS),
    unswept: report.unswept.slice(0, MAX_STATUS_ROWS),
  }
}

/**
 * One tick: honors the enabled switch, never overlaps itself, records the report. The
 * schedule stamp happens HERE, only when a tick actually starts - the first cut stamped it
 * in the poll before knowing whether the tick would run, which silently swallowed scheduled
 * slots behind an in-flight tick (review-confirmed). A forced check-now stamps too, so manual
 * and scheduled ticks can never land closer together than the interval.
 */
/** The route's patch contract, pure and pinned by tests: a malformed or OUT-OF-RANGE field
 *  errors instead of being silently clamped into the most permissive meaning (review caught
 *  max_archive -50 collapsing into the -1 unlimited sentinel; enabled:'yes' being dropped). */
export function parseSweepLoopPatch(
  body: Record<string, unknown>,
): { ok: true; patch: Partial<SweepLoopSettings> } | { ok: false; error: string } {
  const patch: Partial<SweepLoopSettings> = {}
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' }
    patch.enabled = body.enabled
  }
  const fields = [
    ['intervalMin', 5, 24 * 60],
    ['maxArchive', -1, 10_000],
    ['maxSurface', 0, 100],
  ] as const
  for (const [k, min, max] of fields) {
    const v = body[k]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
      return { ok: false, error: `${k} must be a number between ${min} and ${max}` }
    patch[k] = Math.floor(v)
  }
  return { ok: true, patch }
}

export async function runSweepLoopOnce(
  deps: SweepDeps & {
    sweep?: typeof sweepGateActions
    force?: boolean
    reconcile?: typeof reconcileDeliveries
    courier?: typeof courierPass
  } = {},
): Promise<SweepReport | null> {
  const s = getSweepLoopSettings()
  if (!s.enabled && !deps.force) return null
  if (ticking) {
    overlapSkips++
    return null
  }
  ticking = true
  const sweep = deps.sweep ?? sweepGateActions
  const started = Date.now()
  lastTickAt = started
  try {
    const report = await sweep(
      {
        maxArchive: s.maxArchive === -1 ? undefined : s.maxArchive,
        maxSurface: s.maxSurface,
      },
      deps,
    )
    // Settle the delivery ledger on every tick: staged prompts that got delivered (or turned
    // out deaf, or aged out) resolve here without anyone asking. A throwing reconcile is a
    // DURABLE status fact (review-confirmed: console-only meant a permanently-broken ledger
    // read as healthy), cleared by the next clean pass.
    try {
      ;(deps.reconcile ?? reconcileDeliveries)()
      lastReconcileError = null
    } catch (err) {
      lastReconcileError = {
        at: new Date().toISOString(),
        message: err instanceof Error ? err.message : String(err),
      }
      console.error('[agenthydra] delivery reconcile error:', err)
    }
    // Arm/disarm couriers from the settled ledger, freshly after the acts above.
    await runCourierHousekeeping({ courier: deps.courier, force: true })
    lastRun = {
      at: new Date(started).toISOString(),
      tookMs: Date.now() - started,
      report: trimForStatus(report),
    }
    return report
  } catch (err) {
    lastError = {
      at: new Date().toISOString(),
      message: err instanceof Error ? err.message : String(err),
    }
    console.error('[agenthydra] sweep-loop tick error:', err)
    return null
  } finally {
    ticking = false
  }
}

/**
 * Courier housekeeping (arm / re-arm / disarm from the settled ledger) is ALWAYS-ON, not
 * gated behind sweep_enabled (review-confirmed hole: with the sweep off - its documented
 * default - nothing ever DISARMED a cleared courier task, and the one-shot cron is genuinely
 * annual, so it would re-fire an empty courier every year; nothing re-armed failed fires
 * either). Same rationale as the always-on import-delivery sweep: sweep_enabled governs
 * hours-scale autonomy (archiving, surfacing); this only finishes deliveries an authorized
 * act already staged. courier_enabled is its own gate.
 */
const COURIER_HOUSEKEEP_MS = 5 * 60_000
let lastCourierPassAt = 0
let courierTicking = false

export async function runCourierHousekeeping(
  deps: { courier?: typeof courierPass; force?: boolean } = {},
): Promise<boolean> {
  if (getSetting('courier_enabled') !== '1') return false
  // In-flight guard (review-confirmed): the poll's unforced call and the sweep tick's forced
  // one can land together, and a cycle takes real seconds - two concurrent passes would each
  // decide from their own snapshot and quit/relaunch the same app twice. (courierPass also
  // serializes through the act lock, but skipping here is cheaper than queueing a duplicate.)
  if (courierTicking) return false
  if (!deps.force && Date.now() - lastCourierPassAt < COURIER_HOUSEKEEP_MS) return false
  courierTicking = true
  lastCourierPassAt = Date.now()
  try {
    await (deps.courier ?? courierPass)({ act: true })
    lastCourierError = null
  } catch (err) {
    lastCourierError = {
      at: new Date().toISOString(),
      message: err instanceof Error ? err.message : String(err),
    }
    console.error('[agenthydra] courier pass error:', err)
  } finally {
    courierTicking = false
  }
  return true
}

const POLL_MS = 60_000
let timer: ReturnType<typeof setInterval> | null = null

/** The poll wakes every minute and asks "is a tick due?" - the tick stamps its own start, so
 *  a slot blocked by an in-flight tick is retried on the next poll instead of being silently
 *  consumed. An interval change takes effect without a restart, same trade the monitor makes. */
export function startSweepLoop(): void {
  if (timer) return
  timer = setInterval(() => {
    // Courier housekeeping first, on its own always-on cadence (see its header).
    void runCourierHousekeeping()
    const s = getSweepLoopSettings()
    if (!s.enabled) return
    if (Date.now() - lastTickAt < s.intervalMin * 60_000) return
    void runSweepLoopOnce()
  }, POLL_MS)
}

export function stopSweepLoop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
