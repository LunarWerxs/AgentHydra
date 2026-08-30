// OWNER LAW (Michael, 2026-08-29, after the courier janitor threw all 18 accounts open at once):
// "You're only supposed to open an account if you absolutely MUST. Bc all open ones aren't
// accessible." The archive-visibility RESTART exists to make a running app redraw its sidebar;
// for a closed app there is nothing to redraw, and quitting-then-opening one is pure harm. These
// tests pin the shape of that rule at the level it can be tested without driving real apps.
//
// "Absolutely MUST" got its one defined exception on 2026-08-30: LANDING may open a closed
// signed-in instance when at least one account is open AND every open candidate is provably
// at/over the 85% overflow threshold (closedLandingEligible in monitor.ts, pinned by
// gate-actions.test.ts - an all-closed fleet still parks). Restarts stay unconditional:
// nothing here changed.
import { describe, expect, test } from 'bun:test'

/** The decision the sweep makes per instance, extracted so the rule is testable: a pickup
 *  restart is queued ONLY for a running app. Mirrors sweepCourierTasks' guard exactly. */
function shouldQueuePickupRestart(inst: { isRunning?: boolean } | undefined): boolean {
  return !!inst?.isRunning
}

/** The decision restartOneArchivePendingDir makes: a closed app's pending marker is DROPPED,
 *  never acted on. Mirrors its guard. */
function restartAction(isRunning: boolean): 'restart' | 'drop-marker' {
  return isRunning ? 'restart' : 'drop-marker'
}

describe('never open a closed account', () => {
  test('a pickup restart is queued only for a RUNNING instance', () => {
    expect(shouldQueuePickupRestart({ isRunning: true })).toBe(true)
    expect(shouldQueuePickupRestart({ isRunning: false })).toBe(false)
    // Unknown state is treated as closed - the safe direction, since the cost of skipping is one
    // late courier pickup and the cost of guessing wrong is an account thrown open.
    expect(shouldQueuePickupRestart({})).toBe(false)
    expect(shouldQueuePickupRestart(undefined)).toBe(false)
  })

  test('a pending restart for a CLOSED app is dropped, not carried out', () => {
    expect(restartAction(false)).toBe('drop-marker')
    expect(restartAction(true)).toBe('restart')
  })
})
