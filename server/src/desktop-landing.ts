// server/src/desktop-landing.ts - LAND A HOMELESS CHAT IN A DESKTOP APP, and the act lock that
// serialises every deed that drives an app.
//
// WHY THIS MODULE EXISTS (owner order, Michael, 2026-08-31): landing is a PRIMITIVE, in the same
// family as `desktop-archive` and `import-desktop` - "put this chat in an app" and nothing more.
// It used to live inside a larger subsystem that was cut out of this repo entirely, and the
// auto-resume monitor depends on it: when a rate-limited chat's window resets and that chat has
// no home, the monitor lands it in an app so a person can resume it there. So the landing and the
// act lock were extracted here before that subsystem left, rather than being deleted with it.
//
// It deliberately does NOT stage any prompt for the chat it lands. The landing's whole contract
// is "this chat is now visible in that app"; deciding what to say to it belonged to the caller
// and left with it.
//
// The PICKER (closedLandingEligible / pickLandingInstance / underLandingThreshold) stays in
// monitor.ts, where it always lived, so the auto-resume path and this module cannot drift apart
// on where chats are allowed to go - including the owner's 85% overflow rule for booting a
// closed instance.

import { resolveAutomatedTitle } from './chat-title'
import { openInstance } from './core/instances'
import { type FleetInstanceEntry, fleetInstances, planRank } from './fleet-instances'
import { type FleetUsageEntry, fleetUsage, LANDING_OVERFLOW_PCT } from './fleet-usage'
import { pickLandingInstance } from './monitor'
import { pathKey } from './path-key'
import { importSessionToDesktop } from './session-launch'

export interface DesktopLandingDeps {
  instances?: () => Promise<FleetInstanceEntry[]>
  usage?: () => FleetUsageEntry[]
  importSession?: typeof importSessionToDesktop
  open?: (dir: string) => Promise<{ ok: boolean }>
  resolveTitle?: typeof resolveAutomatedTitle
  /** How long to wait for a booted instance to report running before giving up. */
  openWaitMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

function real(deps: DesktopLandingDeps) {
  return {
    instances: deps.instances ?? (() => fleetInstances()),
    usage: deps.usage ?? (() => fleetUsage()),
    importSession: deps.importSession ?? importSessionToDesktop,
    open: deps.open ?? ((dir: string) => openInstance(dir)),
    resolveTitle: deps.resolveTitle ?? resolveAutomatedTitle,
    openWaitMs: deps.openWaitMs ?? 45_000,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
  }
}

/** Refs (and dirs) compare under the one path key; the 'desktop:' scheme folds harmlessly. */
const norm = (p: string) => pathKey(p, true)

/** Boot a closed instance and wait until the fleet list reports it running, so the import that
 *  follows targets a live single-instance lock instead of racing the app's own startup. */
async function openAndAwait(
  entry: { ref: string; num: number; dir: string },
  d: ReturnType<typeof real>,
): Promise<{ ok: boolean; reason?: string }> {
  const opened = await d.open(entry.dir).catch(() => ({ ok: false }))
  if (!opened.ok) return { ok: false, reason: `could not open instance #${entry.num}` }
  const deadline = d.now() + d.openWaitMs
  for (;;) {
    const running = (await d.instances()).some(
      (i) => i.isRunning && norm(i.ref) === norm(entry.ref),
    )
    if (running) return { ok: true }
    if (d.now() >= deadline) {
      return {
        ok: false,
        reason: `opened instance #${entry.num} but it did not reach running within ${Math.round(d.openWaitMs / 1000)}s`,
      }
    }
    await d.sleep(1000)
  }
}

export type LandingOutcome =
  | { ok: true; instance: { ref: string; num: number }; openedInstance: boolean }
  | { ok: false; reason: string }

/**
 * Land a HOMELESS chat in a desktop instance: naming law first (fail before booting anything),
 * then the picker - which may name a CLOSED instance only under the owner's 85% overflow rule -
 * then the boot-and-wait when it did, then the import.
 */
export async function landSessionInDesktop(opts: {
  sessionId: string
  pinnedRef: string | null
  /** A better name the caller already holds (e.g. a queue row title); the transcript-derived
   *  name backs it up. Naming law: no real name, no landing. */
  fallbackTitle?: string | null
  /** Instances the picker must not choose - the load-balancing path excludes the saturated
   *  home it is migrating AWAY from. */
  excludeRefs?: string[]
  /** Refuse a target that is itself provably at/over the threshold - moving work hot-to-hot
   *  buys nothing. */
  requireUnsaturated?: boolean
  deps?: DesktopLandingDeps
}): Promise<LandingOutcome> {
  const d = real(opts.deps ?? {})
  // Eligibility first (pure, no side effects), THEN the naming law, THEN any boot: a caller
  // hears about the real blocker - no instance - before being sent off to rename a chat that
  // could not land anyway, and nothing boots or imports until both checks pass.
  const [allInstances, usage] = [await d.instances(), d.usage()]
  const excluded = new Set((opts.excludeRefs ?? []).map(norm))
  const instances = allInstances.filter((i) => !excluded.has(norm(i.ref)))
  const usageRows = usage.map((u) => ({
    ref: u.ref,
    weeklyPct: u.weeklyPct,
    sessionPct: u.sessionPct,
    stale: u.stale,
    ageMins: u.ageMins,
  }))
  const target = pickLandingInstance(
    opts.pinnedRef,
    instances.map((i) => ({
      ref: i.ref,
      num: i.num,
      isRunning: i.isRunning,
      signedIn: i.signedIn,
      // The owner's tier order (2026-08-30): highest plan first, then lowest usage.
      planRank: planRank(i.account?.planLabel ?? null),
    })),
    usageRows,
  )
  if (!target)
    return {
      ok: false,
      reason:
        'no eligible instance: no running signed-in instance to land in, and no closed ' +
        'signed-in instance the overflow rule would allow opening',
    }
  if (opts.requireUnsaturated && !target.mustOpen) {
    // Migrating onto a RUNNING account demands POSITIVE proof of headroom: a fresh reading
    // with both windows under the line. Unknown or stale is not "cool" (review-confirmed:
    // a missing reading passed as unsaturated and licensed migrating onto an unverified
    // account). A mustOpen target needs no re-check here - the picker only offers closed
    // candidates that already passed underLandingThreshold, the owner's proof standard for
    // opening an app.
    const tu = usageRows.find((u) => norm(u.ref) === norm(target.ref))
    const provenCool =
      !!tu &&
      !tu.stale &&
      (tu.weeklyPct ?? 101) < LANDING_OVERFLOW_PCT &&
      (tu.sessionPct ?? 101) < LANDING_OVERFLOW_PCT
    if (!provenCool)
      return {
        ok: false,
        reason: `the best available instance is not fresh-proven under ${LANDING_OVERFLOW_PCT}% on both windows - migration demands positive proof of headroom`,
      }
  }
  const title = await d.resolveTitle(opts.sessionId, opts.fallbackTitle ?? null)
  if (title === null)
    return {
      ok: false,
      reason: 'no real name available for this chat (naming law); name it, then retry',
    }
  const entry = instances.find((i) => norm(i.ref) === norm(target.ref))
  if (!entry) return { ok: false, reason: 'picked instance vanished between list and landing' }
  if (target.mustOpen) {
    const booted = await openAndAwait(entry, d)
    if (!booted.ok) return { ok: false, reason: booted.reason ?? 'open failed' }
  }
  const imported = await d.importSession({
    sessionId: opts.sessionId,
    instanceDir: entry.dir,
    title,
  })
  if (!imported.ok)
    return {
      ok: false,
      reason: `could not land in instance #${entry.num}: ${imported.reason ?? 'unknown'}`,
    }
  return {
    ok: true,
    instance: { ref: entry.ref, num: entry.num },
    openedInstance: target.mustOpen,
  }
}

/** ONE deed at a time, process-wide (review-confirmed): concurrent deeds can drive the app's
 *  UIA menus or Electron's single-instance import twice at once for the same chat. Every
 *  mutating entry point queues here; landSessionInDesktop itself stays unlocked because it
 *  always runs UNDER this lock. */
let actLock: Promise<void> = Promise.resolve()
let actBusyCount = 0

/** Is any deed queued or executing RIGHT NOW? Auto-update's busy check reads this so a
 *  daemon relaunch never lands mid-UIA-click or mid-instance-boot (review-confirmed). */
export function isActBusy(): boolean {
  return actBusyCount > 0
}

export function withActSerialized<T>(fn: () => Promise<T>): Promise<T> {
  actBusyCount++
  const run = actLock.then(fn)
  actLock = run.then(
    () => undefined,
    () => undefined,
  )
  return run.finally(() => {
    actBusyCount--
  })
}
