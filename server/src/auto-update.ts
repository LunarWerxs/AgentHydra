/**
 * Auto-update timer — "keep the app current for me, silently".
 *
 * A single daemon-wide timer that, each time it fires, asks the shared updater engine whether a
 * newer commit is on the update remote AND the working tree is clean (`canApply`). If so it applies
 * the update (git pull --ff-only + reinstall + rebuild — see server/src/updater.ts) and then
 * SELF-RELAUNCHES so the freshly-pulled code takes over. The tray (misc/AgentHydra-Tray.ps1) is a
 * bare supervisor that does NOT relaunch the daemon on exit, so the daemon must relaunch itself; the
 * concrete relaunch (spawn a detached copy of our launch command, then gracefully shut down) is
 * injected from server/src/index.ts, which owns the shutdown handle. The tray then finds the
 * successor via ~/.agenthydra/runtime.json + /api/health exactly as it does after a manual restart.
 *
 * APPLYING is OFF unless the `auto_update_enabled` setting is explicitly '1' — it restarts the
 * daemon unattended, so it's never on by default. CHECKING is not gated on it and never was meant
 * to be: the loop runs either way and records the answer (lastUpdateCheck), because "is there a
 * newer version" is worth knowing whether or not you want it installed for you. Before that split,
 * a default install ran no timer at all and the only code that ever asked was the Settings screen's
 * onMounted — so a user who never opened Settings was never told, which is exactly what was
 * reported.
 *
 * A dirty working tree is NEVER updated (`canApply` gates it), so uncommitted local work is safe.
 * Timer shape is a self-rescheduling setTimeout (never setInterval) so a slow apply can't stack.
 * Settings are persisted via db.ts's setSetting/getSetting (same pattern scheduler.ts uses); primed
 * + toggled live from POST /api/update/settings; started in server/src/index.ts after boot.
 */
import { getSetting, setSetting } from './db'
import { applyUpdate, checkForUpdate, type UpdateStatus } from './updater'

/** Check cadence bounds (seconds): 15 min floor, 7 day ceiling, default 6 h. */
export const AUTO_UPDATE_INTERVAL_MIN_S = 900
export const AUTO_UPDATE_INTERVAL_MAX_S = 604_800
export const AUTO_UPDATE_INTERVAL_DEFAULT_S = 21_600

/** Clamp a requested cadence into [MIN, MAX]; a non-finite value falls back to the default. */
export function clampAutoUpdateInterval(secs: number): number {
  if (!Number.isFinite(secs)) return AUTO_UPDATE_INTERVAL_DEFAULT_S
  return Math.min(
    AUTO_UPDATE_INTERVAL_MAX_S,
    Math.max(AUTO_UPDATE_INTERVAL_MIN_S, Math.round(secs)),
  )
}

// ── injectable side-effects (real impls by default; index.ts wires `relaunch`, tests swap all) ──
export interface AutoUpdateHooks {
  check: typeof checkForUpdate
  apply: typeof applyUpdate
  /** Restart the daemon so the freshly-pulled code takes over. Wired by server/src/index.ts. */
  relaunch: () => void
  /** True when dispatch runs are in flight. An update relaunches the daemon; even though runs now
   *  survive that (they're detached + reattached), we DEFER updating until the queue is idle so a
   *  relaunch never churns a live run's stream. Wired by server/src/index.ts; default: never busy. */
  hasActiveRuns: () => boolean
}
function defaultRelaunch(): void {
  // No relaunch handler wired (e.g. a bare test harness) — the update is applied on disk and takes
  // effect on the next manual restart. Never exit here; we don't own a successor.
  console.warn(
    'agenthydra: auto-update applied, but no relaunch handler is wired — restart to apply the new code.',
  )
}
const realHooks: AutoUpdateHooks = {
  check: checkForUpdate,
  apply: applyUpdate,
  relaunch: defaultRelaunch,
  hasActiveRuns: () => false,
}
let hooks: AutoUpdateHooks = realHooks
/** Override the side-effect hooks (index.ts sets `relaunch`; tests inject fakes for all three so
 *  nothing pulls/spawns/exits). Passing `{}` restores the real hooks. */
export function setAutoUpdateHooks(h: Partial<AutoUpdateHooks>): void {
  hooks = { ...realHooks, ...h }
}

// ── settings persistence (mirrors scheduler.ts's setSetting/getSetting use) ──
const SETTING_ENABLED = 'auto_update_enabled'
const SETTING_INTERVAL = 'auto_update_interval_secs'

/** Load enabled/interval from the settings table into the runtime state. Call once at boot before
 *  startAutoUpdate() (index.ts) so the loop starts with the persisted configuration. */
export function loadAutoUpdateSettings(): void {
  enabled = getSetting(SETTING_ENABLED) === '1'
  intervalSecs = clampAutoUpdateInterval(Number(getSetting(SETTING_INTERVAL)))
}

// ── runtime state ────────────────────────────────────────────────────────────────────────────
let enabled = false // OFF by default — it restarts the daemon → opt-in
let intervalSecs = AUTO_UPDATE_INTERVAL_DEFAULT_S
let started = false // true only after the daemon finishes booting (startAutoUpdate)
let timer: ReturnType<typeof setTimeout> | null = null
let ticking = false
let applying = false // an apply is in flight — never overlap checks/applies

/**
 * The last background check's answer, so the UI can ask "is there an update?" without paying for a
 * network round trip — and, more to the point, without the user having to go looking.
 *
 * This is the fix for a real report: someone ran an old version for weeks and was never told. The
 * cause was that `enabled` gated the whole loop, so with auto-APPLY off (the default, because
 * applying restarts the daemon) NOTHING ran — not even the check — and the only code that ever
 * asked was SettingsView's onMounted. Open Settings and you'd find out; otherwise never.
 *
 * Checking and applying are now separate decisions. The check is cheap and side-effect-free (one
 * GitHub API call, or a `git ls-remote`), so it always runs; applying stays opt-in exactly as
 * before. Nothing about the restart-on-apply behaviour changes.
 */
let lastCheck: { status: UpdateStatus; at: number } | null = null

export function autoUpdateEnabled(): boolean {
  return enabled
}
export function getAutoUpdateIntervalSecs(): number {
  return intervalSecs
}
/** The last check, or null before any has landed. Read by GET /api/update/available — a plain
 *  memory read, so the whole app can poll it cheaply. */
export function lastUpdateCheck(): { status: UpdateStatus; at: number } | null {
  return lastCheck
}

/**
 * Record a check this module did not run — specifically the real one behind GET /api/update, which
 * the Settings screen performs on open and on its Check button.
 *
 * Without this, the freshest information in the process would be the one thing the passive hint
 * ignored: open Settings, see "an update is available", close it, and the dot would stay dark until
 * the background tick came round up to six hours later. The signal should never be staler than what
 * the app has already been told.
 */
export function recordUpdateCheck(status: UpdateStatus, at = Date.now()): void {
  lastCheck = { status, at }
}

/** How often the background CHECK runs when auto-apply is off. Independent of the apply cadence:
 *  the check is one cheap request that changes nothing, so it does not need the interval a
 *  daemon-restarting apply does — but it also has no reason to be aggressive. Six hours matches
 *  AUTO_UPDATE_INTERVAL_DEFAULT_S and stays far inside GitHub's unauthenticated rate limit. */
export const UPDATE_CHECK_INTERVAL_S = 21_600

/** Outcome of one check→apply→relaunch pass. Returned (not just logged) so it's unit-testable. */
export interface AutoUpdateRunResult {
  checked: boolean
  applied: boolean
  relaunched: boolean
  reason?: string
}

/**
 * One check → maybe apply → maybe relaunch. Applies ONLY when the engine reports an update is
 * available AND applicable (`canApply`: clean tree, on a branch with an update remote) — so a dirty
 * working tree is never touched. On a successful apply that needs a restart, it fires the injected
 * relaunch. Exported + returns a result so the timer AND the test can drive it identically.
 */
export async function runAutoUpdateOnce(): Promise<AutoUpdateRunResult> {
  if (applying) return { checked: false, applied: false, relaunched: false, reason: 'busy' }
  let status: Awaited<ReturnType<typeof checkForUpdate>>
  try {
    status = await hooks.check()
  } catch {
    return { checked: false, applied: false, relaunched: false, reason: 'check-failed' }
  }
  lastCheck = { status, at: Date.now() }
  if (!status.ok)
    return {
      checked: true,
      applied: false,
      relaunched: false,
      reason: status.reason ?? 'check-error',
    }
  if (!status.updateAvailable)
    return { checked: true, applied: false, relaunched: false, reason: 'up-to-date' }
  // Hard gate: canApply is false on a dirty tree / detached HEAD / no update remote — never update then.
  if (!status.canApply)
    return {
      checked: true,
      applied: false,
      relaunched: false,
      reason: status.reason ?? 'cannot-apply',
    }
  // Defer while dispatch runs are in flight: applying relaunches the daemon, and even though runs
  // survive that now, we'd rather not churn a live run's stream mid-flight. Re-checked next window.
  if (hooks.hasActiveRuns())
    return { checked: true, applied: false, relaunched: false, reason: 'busy-runs' }

  applying = true
  try {
    const res = await hooks.apply()
    if (!res.ok) return { checked: true, applied: false, relaunched: false, reason: 'apply-failed' }
    if (res.restartRequired) {
      hooks.relaunch()
      return { checked: true, applied: true, relaunched: true }
    }
    return { checked: true, applied: true, relaunched: false }
  } catch {
    return { checked: true, applied: false, relaunched: false, reason: 'apply-threw' }
  } finally {
    applying = false
  }
}

/**
 * Check ONLY — record whether a newer version exists, and stop there.
 *
 * The notify half of the loop, run when auto-apply is off. Kept separate from runAutoUpdateOnce
 * rather than short-circuiting inside it: that function's contract is "one check → maybe apply →
 * maybe relaunch" and its guard ORDER (available → canApply → no active runs) is what the
 * auto-update tests pin down. Threading an `enabled` early-return through it would have quietly
 * moved a gate ahead of `busy-runs`, which is the kind of change that reads as harmless and is not.
 */
export async function runUpdateCheckOnce(): Promise<{ ok: boolean; updateAvailable: boolean }> {
  if (applying) return { ok: false, updateAvailable: false }
  try {
    const status = await hooks.check()
    lastCheck = { status, at: Date.now() }
    return { ok: status.ok, updateAvailable: status.ok && status.updateAvailable }
  } catch {
    return { ok: false, updateAvailable: false }
  }
}

// ── timer plumbing ───────────────────────────────────────────────────────────────────────────
//
// The loop now runs in BOTH states, at whichever cadence fits, doing whichever pass fits: apply
// when auto-apply is on, check-only when it is off. It used to arm only when `enabled`, which is
// what made "I was never told there was an update" the default experience — see lastCheck above.
/** Seconds until the next tick, given what this loop is currently for. */
function tickIntervalSecs(): number {
  return enabled ? intervalSecs : UPDATE_CHECK_INTERVAL_S
}
function schedule(): void {
  timer = setTimeout(() => void runTick(), tickIntervalSecs() * 1000)
}
async function runTick(): Promise<void> {
  timer = null
  ticking = true
  try {
    if (enabled) await runAutoUpdateOnce()
    else await runUpdateCheckOnce()
  } catch {
    /* a round failing is non-fatal — we just try again next window */
  } finally {
    ticking = false
  }
  if (started && !timer) schedule()
}
/** Bring the timer in line with the current started state (idempotent). Armed whenever the daemon
 *  is up: with auto-apply off the tick still checks, it just stops short of applying. */
function reconcile(): void {
  if (!started) return
  if (!timer && !ticking) schedule()
}
/** Re-arm a running loop with the current cadence (no-op mid-tick). Also covers the auto-apply
 *  toggle, which changes WHICH cadence applies. */
function retime(): void {
  if (started && !ticking) {
    if (timer) clearTimeout(timer)
    timer = null
    schedule()
  }
}

/** Begin the loop once the daemon has booted (server/src/index.ts). The first tick is one interval
 *  out (never in the boot stampede, so a fresh launch is never interrupted by an immediate restart,
 *  and a cold boot never spends a network round trip it was not asked for). */
export function startAutoUpdate(): void {
  started = true
  reconcile()
}
/** Stop the loop (daemon shutdown). Safe to call when it was never started. */
export function stopAutoUpdate(): void {
  started = false
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
/** Enable/disable AUTO-APPLY, persisting to settings. The loop keeps running either way (it checks
 *  regardless); this only changes whether a found update is installed, and at which cadence the
 *  loop ticks — so re-time rather than merely reconcile. */
export function setAutoUpdateEnabled(value: boolean): void {
  enabled = value
  setSetting(SETTING_ENABLED, value ? '1' : '0')
  retime()
}
/** Set the check cadence in seconds (clamped), persisting to settings. Re-times a running loop.
 *  Returns the clamped value. */
export function setAutoUpdateIntervalSecs(secs: number): number {
  intervalSecs = clampAutoUpdateInterval(secs)
  setSetting(SETTING_INTERVAL, String(intervalSecs))
  retime()
  return intervalSecs
}
