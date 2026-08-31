// server/src/sweep-loop.ts - THE STANDING SWEEP (rebuild backlog, owner: "resume your
// recommended backlog", 2026-08-30): the daemon runs the gate sweep on a schedule, so the
// fleet is gated and the safe deeds happen without any AI awake. Monitor-pattern rails:
//
//   - OFF BY DEFAULT (a standing loop that archives chats must be turned on by a person),
//     with the same settings discipline as the auto-resume monitor.
//   - UNATTENDED-SAFE CAPS by default: archive UNLIMITED (the owner's stated wish,
//     reversible, click-verified) but surface 0 - a surfaced chat is DORMANT until someone
//     delivers its prompt, and an unattended tick has no deliverer, so surfacing would park
//     invisible work.
//   - THE WAITING LANE HAS A CALLER. Every gated chat is running, waiting, or done; the tick
//     finishes 'done' and leaves 'running' alone, but a WAITING chat needs one judgment -
//     autonomous or human - that no daemon can make. This file used to leave those rows in
//     the report "for a courier/caller to work through", and no such caller existed unless a
//     person typed /orchestrate, so waiting chats piled up while the loop reported healthy.
//     A tick that finds them now opens ONE orchestrator to work them (judgeEnabled, with a
//     cooldown so a stuck or refused launch cannot open a window every tick).
//   - One tick at a time (re-entrancy guard), and every act inside the sweep already holds
//     the process-wide act lock, so a tick can never interleave with a manual sweep or the
//     monitor's landing.
//   - The last report is kept and served verbatim - a loop whose work cannot be inspected
//     is v1's mistake with a timer attached.

import { join } from 'node:path'
import { courierPass } from './courier'
import { getSetting, setSetting } from './db'
import { pruneDeliveries, reconcileDeliveries } from './deliveries'
import { type SweepDeps, type SweepReport, sweepGateActions } from './gate-sweep'

export interface SweepLoopSettings {
  enabled: boolean
  /** The COURIER: delivers staged prompts by typing into the target chat and pressing Send.
   *  Separate from `enabled` on purpose - the sweep decides things on its own (archiving,
   *  surfacing), while this only finishes deliveries an authorized act already staged. It is
   *  surfaced here because a mechanism that types into the owner's live windows must be
   *  VISIBLE and switchable, not a setting he has to know exists (readiness audit). */
  courierEnabled: boolean
  /** Minutes between ticks. */
  intervalMin: number
  /** -1 = unlimited (stored sentinel; the sweep gets Infinity). */
  maxArchive: number
  maxSurface: number
  /** THE WAITING LANE'S CALLER. A gated chat is running, waiting, or done. The sweep finishes
   *  'done' on its own and leaves 'running' alone, but a WAITING chat needs one judgment -
   *  autonomous or human - that only an AI can make. This file used to leave those rows in the
   *  report "for a caller to work through", and no such caller existed unless a person typed
   *  /orchestrate, so waiting chats accumulated indefinitely while the loop reported healthy.
   *  With this on, a tick that finds waiting chats opens ONE visible orchestrator session to
   *  work them. Switchable for the same reason the courier is: a mechanism that opens windows
   *  on the owner's machine must be visible and off-able, not a hidden behaviour. */
  judgeEnabled: boolean
  /** Minimum minutes between orchestrator launches. The bound that makes this safe: a judge
   *  that hangs or fails cannot spawn another window every tick, because the waiting rows it
   *  failed to clear are still there on the next one. */
  judgeCooldownMin: number
}

/** THE FLOOR ON THE TICK. Was 5 minutes, which is slower than a person watching a fleet is
 *  willing to wait - the owner's standard is "checking every couple of minutes". A tick is a
 *  metadata scan plus, at most, a few UIA clicks, and every act underneath it is already
 *  serialized by the process-wide act lock and bounded by the circuit breaker, so the cost of
 *  a shorter interval is bounded work, not a storm. */
export const MIN_INTERVAL_MIN = 1

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

/** Same "'' is ABSENT, not a value" discipline as num(), for a flag whose registered default
 *  is ON. Reading a missing row as `=== '1'` would make it OFF, so deleting or failing to
 *  migrate one row would silently switch the waiting-lane caller off and the loop would go
 *  right back to reporting waiting chats at nobody - the exact failure this feature exists to
 *  end, reinstated by a falsy default. */
function bool(key: string, fallback: boolean): boolean {
  const raw = getSetting(key).trim()
  if (raw === '') return fallback
  return raw === '1'
}

export function getSweepLoopSettings(): SweepLoopSettings {
  return {
    enabled: getSetting('sweep_enabled') === '1',
    courierEnabled: getSetting('courier_enabled') === '1',
    intervalMin: num('sweep_interval_min', 15, MIN_INTERVAL_MIN, 24 * 60),
    maxArchive: num('sweep_max_archive', -1, -1, 10_000),
    maxSurface: num('sweep_max_surface', 0, 0, 100),
    judgeEnabled: bool('sweep_judge_enabled', true),
    judgeCooldownMin: num('sweep_judge_cooldown_min', 60, 5, 24 * 60),
  }
}

export function setSweepLoopSettings(patch: Partial<SweepLoopSettings>): SweepLoopSettings {
  if (typeof patch.enabled === 'boolean') setSetting('sweep_enabled', patch.enabled ? '1' : '0')
  if (typeof patch.courierEnabled === 'boolean')
    setSetting('courier_enabled', patch.courierEnabled ? '1' : '0')
  if (typeof patch.judgeEnabled === 'boolean')
    setSetting('sweep_judge_enabled', patch.judgeEnabled ? '1' : '0')
  if (typeof patch.judgeCooldownMin === 'number' && Number.isFinite(patch.judgeCooldownMin))
    setSetting(
      'sweep_judge_cooldown_min',
      String(Math.min(24 * 60, Math.max(5, Math.floor(patch.judgeCooldownMin)))),
    )
  if (typeof patch.intervalMin === 'number' && Number.isFinite(patch.intervalMin))
    setSetting(
      'sweep_interval_min',
      String(Math.min(24 * 60, Math.max(MIN_INTERVAL_MIN, Math.floor(patch.intervalMin)))),
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
  /** What the last AUTONOMOUS courier pass actually did. Without this a timer-driven pass
   *  that ran and refused every row is indistinguishable from one that never ran - and
   *  "nothing happened, no error" is exactly the shape of a silently broken loop. */
  lastCourierRun: {
    at: string
    delivered: number
    attempts: Array<{ sessionId: string; outcome: string; detail: string }>
    held: number
    unroutable: number
  } | null
  /** ISO of the next tick when enabled (never earlier than now; before the first tick it
   *  reads as imminent, not as 1970); null when off. */
  nextDueAt: string | null
  /** What the last tick did about WAITING chats. Recorded even when it declined to launch,
   *  and only when something was actually waiting - a loop that quietly stops working the
   *  waiting lane must not look identical to a fleet with nothing waiting, which is exactly
   *  how the missing caller went unnoticed in the first place. */
  lastJudgeRun: { at: string; waiting: number; launched: boolean; why: string } | null
}

let lastRun: SweepLoopStatus['lastRun'] = null
let lastError: SweepLoopStatus['lastError'] = null
let lastReconcileError: { at: string; message: string } | null = null
let lastCourierError: { at: string; message: string } | null = null
let lastCourierRun: SweepLoopStatus['lastCourierRun'] = null
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
    lastCourierRun,
    nextDueAt: s.enabled
      ? new Date(Math.max(Date.now(), lastTickAt + s.intervalMin * 60_000)).toISOString()
      : null,
    lastJudgeRun,
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
    report.stalled.length > MAX_STATUS_ROWS ||
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
    stalled: report.stalled.slice(0, MAX_STATUS_ROWS),
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
  if (body.courierEnabled !== undefined) {
    if (typeof body.courierEnabled !== 'boolean')
      return { ok: false, error: 'courierEnabled must be a boolean' }
    patch.courierEnabled = body.courierEnabled
  }
  if (body.judgeEnabled !== undefined) {
    if (typeof body.judgeEnabled !== 'boolean')
      return { ok: false, error: 'judgeEnabled must be a boolean' }
    patch.judgeEnabled = body.judgeEnabled
  }
  const fields = [
    ['intervalMin', MIN_INTERVAL_MIN, 24 * 60],
    ['maxArchive', -1, 10_000],
    ['maxSurface', 0, 100],
    ['judgeCooldownMin', 5, 24 * 60],
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

/**
 * Should this tick open an orchestrator for the WAITING lane, and if not, why not?
 *
 * Pure, so the one behaviour in this file that opens a window on the owner's machine can be
 * pinned by tests without opening any. `waiting` is the count of rows that need the AI
 * judgment: needs-input reviews, plus crashed chats the tick declined to surface because
 * maxSurface capped it - both are chats sitting still that automation alone cannot move.
 */
/**
 * How many chats are genuinely WAITING on the one judgment a daemon cannot make.
 *
 * Pure and deliberately narrow, because this number decides whether a window opens. It counts
 * only chats that are stuck AND actionable:
 *   · needs-input reviews the owner has not put on hold. A held chat is the owner saying
 *     "leave this alone"; summoning an orchestrator to re-learn that on every cooldown is a
 *     futile cycle, and this file must not manufacture one.
 *   · crashed chats the tick did NOT surface - report-only or over the surface cap. A chat it
 *     did surface already has its prompt staged and the courier delivering, so it is moving;
 *     one it PARKED was refused for a reason (a hold, the breaker) that a new session cannot
 *     talk its way past either.
 */
export function countWaiting(report: SweepReport): number {
  const judging = report.needsJudgment.filter((r) => !r.heldReason).length
  const stuckCrashed = report.crashedRows.filter(
    (r) => r.action === 'report-only' || r.action === 'over-cap',
  ).length
  return judging + stuckCrashed
}

export function judgeDecision(input: {
  enabled: boolean
  judgeEnabled: boolean
  waiting: number
  lastJudgeAt: number
  cooldownMin: number
  now: number
}): { launch: boolean; why: string } {
  if (!input.enabled) return { launch: false, why: 'the standing sweep is off' }
  if (!input.judgeEnabled) return { launch: false, why: 'the waiting-lane caller is switched off' }
  if (input.waiting <= 0) return { launch: false, why: 'no chats are waiting' }
  const readyAt = input.lastJudgeAt + input.cooldownMin * 60_000
  if (input.lastJudgeAt > 0 && input.now < readyAt)
    return {
      launch: false,
      // Not an error: the previous orchestrator may still be working these very rows. Saying
      // so beats silence, which is indistinguishable from the caller being broken again.
      why: `an orchestrator was opened ${Math.round((input.now - input.lastJudgeAt) / 60_000)}m ago; the next may open at ${new Date(readyAt).toISOString()}`,
    }
  return { launch: true, why: `${input.waiting} chat(s) waiting on a judgment` }
}

/** What a launched orchestrator is told to do. Kept here, and kept SHORT: the /orchestrate
 *  command itself carries the procedure, so duplicating it would create a second copy to
 *  drift. This only says which pass to run and why it was opened. */
export function judgePrompt(waiting: number): string {
  return (
    '/orchestrate The standing sweep opened this session because ' +
    `${waiting} chat(s) across the open accounts are WAITING on a judgment that only an AI ` +
    'can make - they are neither running nor done, and the daemon cannot decide autonomous ' +
    'vs human on its own. Most will be chats whose process is alive but which finished their ' +
    'turn and went quiet: idle is WAITING, not working, and they are the job. Work every one, ' +
    'not just the first: gate, judge each (the owner prefers autonomous whenever the answer is ' +
    'determinable), act, and deliver. A pass that changes nothing and reports status is a ' +
    'FAILED pass - decide each chat or state plainly why it must be left.'
  )
}

export async function runSweepLoopOnce(
  deps: SweepDeps & {
    sweep?: typeof sweepGateActions
    force?: boolean
    reconcile?: typeof reconcileDeliveries
    courier?: typeof courierPass
    /** Seam for tests; the default opens a real terminal orchestrator. */
    launchJudge?: (prompt: string) => Promise<{ ok: boolean; reason?: string }>
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
    // THE WAITING LANE, worked rather than merely reported. Runs AFTER the courier so a chat
    // whose prompt just got delivered is no longer waiting by the time we count.
    await runJudgePass(report, s, deps.launchJudge)
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

let lastJudgeRun: SweepLoopStatus['lastJudgeRun'] = null

/** THE COOLDOWN IS PERSISTED, NOT HELD IN MEMORY. Module state resets when the daemon
 *  restarts, and the daemon restarts on every auto-update - so an in-memory stamp would let a
 *  restart open another orchestrator immediately, which is precisely the window storm the
 *  cooldown exists to prevent. A settings row survives it. */
function judgeStamp(): number {
  const raw = getSetting('sweep_judge_last_at').trim()
  const n = Number(raw)
  return raw === '' || !Number.isFinite(n) ? 0 : n
}

/**
 * Open ONE orchestrator for the waiting lane, when this tick's state says to.
 *
 * The launch runs in the app's own directory (always trusted, so the terminal cannot stall on
 * a folder-trust prompt with nobody there to answer) and in bypassPermissions, because an
 * unattended window that stops on the first shell approval is a deadlock, not a safeguard -
 * the same reasoning the import stamp already applies to surfaced chats.
 *
 * A REFUSED OR THROWN LAUNCH STILL STAMPS THE COOLDOWN. Retrying a broken launch every tick
 * would open windows in a loop, which is the one failure mode that would make this worse than
 * the silence it replaces. The reason is recorded instead, and the next tick sees the rows are
 * still waiting.
 */
async function runJudgePass(
  report: SweepReport,
  s: SweepLoopSettings,
  launch?: (prompt: string) => Promise<{ ok: boolean; reason?: string }>,
): Promise<void> {
  const waiting = countWaiting(report)
  const decision = judgeDecision({
    enabled: s.enabled,
    judgeEnabled: s.judgeEnabled,
    waiting,
    lastJudgeAt: judgeStamp(),
    cooldownMin: s.judgeCooldownMin,
    now: Date.now(),
  })
  if (!decision.launch) {
    // Only worth recording when there was something to do; "no chats are waiting" every tick
    // is noise that would bury the one line that matters.
    if (waiting > 0)
      lastJudgeRun = { at: new Date().toISOString(), waiting, launched: false, why: decision.why }
    return
  }
  setSetting('sweep_judge_last_at', String(Date.now()))
  const prompt = judgePrompt(waiting)
  try {
    const run =
      launch ??
      (async (p: string) => {
        const { launchTerminalSession } = await import('./session-launch')
        return launchTerminalSession({
          cwd: join(import.meta.dir, '..', '..'),
          prompt: p,
          permissionMode: 'bypassPermissions',
        })
      })
    const res = await run(prompt)
    lastJudgeRun = {
      at: new Date().toISOString(),
      waiting,
      launched: res.ok,
      why: res.ok ? decision.why : `launch refused: ${res.reason ?? 'unknown'}`,
    }
    if (!res.ok) console.error('[agenthydra] waiting-lane orchestrator refused:', res.reason)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    lastJudgeRun = {
      at: new Date().toISOString(),
      waiting,
      launched: false,
      why: `threw: ${message}`,
    }
    console.error('[agenthydra] waiting-lane orchestrator error:', err)
  }
}

/**
 * THE COURIER PASS ON A TIMER - this is what makes delivery autonomous rather than
 * on-demand: every 5 minutes (and immediately after each sweep tick) the daemon delivers any
 * staged prompt that has cleared its grace window, through the target chat's own composer.
 *
 * ALWAYS-ON, not gated behind sweep_enabled, and the distinction is deliberate: sweep_enabled
 * governs hours-scale autonomy (deciding to archive or surface chats on its own); this only
 * FINISHES deliveries an authorized act already staged. Same rationale as the always-on
 * import-delivery sweep. courier_enabled is its own gate.
 */
const COURIER_HOUSEKEEP_MS = 5 * 60_000
let lastCourierPassAt = 0
let courierTicking = false

export async function runCourierHousekeeping(
  deps: { courier?: typeof courierPass; force?: boolean } = {},
): Promise<boolean> {
  if (getSetting('courier_enabled') !== '1') return false
  // In-flight guard (review-confirmed): the poll's unforced call and the sweep tick's forced
  // one can land together, and a delivery pass takes real seconds of UI driving - two
  // concurrent passes would each read their own snapshot and could type the same prompt
  // twice. (courierPass also serializes through the act lock, but skipping here is cheaper
  // than queueing a duplicate.)
  if (courierTicking) return false
  if (!deps.force && Date.now() - lastCourierPassAt < COURIER_HOUSEKEEP_MS) return false
  courierTicking = true
  lastCourierPassAt = Date.now()
  try {
    // Retention lives HERE, not in the sweep tick: the sweep is off by default, so a fleet
    // that only ever runs the courier would have grown its ledger forever (readiness audit).
    // This path is the always-on one, so it is the honest home for housekeeping.
    try {
      pruneDeliveries()
    } catch (err) {
      console.error('[agenthydra] delivery prune error:', err)
    }
    const report = await (deps.courier ?? courierPass)({ act: true })
    lastCourierRun = {
      at: new Date().toISOString(),
      delivered: report.attempts.filter((a) => a.outcome === 'delivered').length,
      // Kept small but COMPLETE per attempt: a refusal's reason is the whole point of
      // recording this, so it is never trimmed away.
      attempts: report.attempts.map((a) => ({
        sessionId: a.sessionId,
        outcome: a.outcome,
        detail: a.detail,
      })),
      held: report.held.length,
      unroutable: report.unroutable.length,
    }
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
  // EVERY path out of this tick is caught. A bare `void fn()` turns a synchronous throw
  // before the callee's own try/catch - a locked or corrupt sqlite in getSetting(), say -
  // into an unhandled rejection, and this process exits on those: one bad tick would kill
  // the whole daemon instead of being skipped (readiness audit). A timer that runs forever
  // must never be able to take the process down with it.
  timer = setInterval(() => {
    try {
      // Courier housekeeping first, on its own always-on cadence (see its header).
      void runCourierHousekeeping().catch((err) => {
        console.error('[agenthydra] courier housekeeping tick failed:', err)
      })
      const s = getSweepLoopSettings()
      if (!s.enabled) return
      if (Date.now() - lastTickAt < s.intervalMin * 60_000) return
      void runSweepLoopOnce().catch((err) => {
        console.error('[agenthydra] sweep tick failed:', err)
      })
    } catch (err) {
      console.error('[agenthydra] sweep-loop poll failed (skipping this tick):', err)
    }
  }, POLL_MS)
}

export function stopSweepLoop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
