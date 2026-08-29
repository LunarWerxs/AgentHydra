// A rejection silences an item, and HOW LONG is a real decision (owner, 2026-08-29: "let's
// shorten"). A state judgment - "this chat is fine as it is" - goes stale fast, and while it is
// silenced a wrongly-rejected chat sits in the phantom state the three-state law bans. Noise
// items keep the long window, because re-offering those every tick is the loop the breaker
// exists to stop.
import { describe, expect, test } from 'bun:test'

/** Mirrors the cooldown choice in resolveWorkItem's reject branch. */
function rejectCooldownMins(kind: string): number {
  return kind === 'idle_pending' ? 20 : 120
}

describe('reject cooldown', () => {
  test('state judgments come back in 20 minutes', () => {
    // Every shape of "is this chat running?" arrives as idle_pending: the plain idle nudge, the
    // waiting-on-input answer, the stale-task nudge, and the settled-open resume-or-retire.
    expect(rejectCooldownMins('idle_pending')).toBe(20)
  })

  test('noise items keep the long window', () => {
    for (const kind of ['repo_dirty', 'branch_off_main', 'usage_alert', 'errored', 'handoff_due'])
      expect(rejectCooldownMins(kind)).toBe(120)
  })

  test('the short window is long enough to not re-litigate on the next tick', () => {
    // The daemon ticks every 60s by default; 20 minutes is 20 ticks of silence, so a considered
    // rejection is never re-asked immediately - the property that made 120 defensible at all.
    const TICK_SECS = 60
    expect((rejectCooldownMins('idle_pending') * 60) / TICK_SECS).toBeGreaterThanOrEqual(20)
  })
})
