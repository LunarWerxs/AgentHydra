// server/tests/watchdog.test.ts - the daemon supervisor's one judgement call, pinned.
//
// The dangerous failure is NOT "the process died" - that one is obvious the moment anything
// probes it. It is the daemon alive and answering HTTP while its sweep loop has stopped ticking:
// every reading says healthy, and the fleet quietly stops being managed. So the wedged test is
// the part worth pinning, along with the two shapes that must NEVER alarm, because a watchdog
// that cries wolf gets ignored and then misses the real thing.
import { expect, test } from 'bun:test'

import { wedgedVerdict } from '../src/watchdog-health'

const NOW = Date.parse('2026-08-31T04:00:00.000Z')
const status = (enabled: boolean, intervalMin: number, lastRunMinsAgo: number | null) => ({
  settings: { enabled, intervalMin },
  lastRun:
    lastRunMinsAgo === null ? null : { at: new Date(NOW - lastRunMinsAgo * 60_000).toISOString() },
})

test('a loop ticking on schedule is healthy', () => {
  expect(wedgedVerdict(status(true, 2, 1), NOW).wedged).toBe(false)
})

test('a loop that stopped ticking is WEDGED even though the daemon answers', () => {
  const v = wedgedVerdict(status(true, 2, 45), NOW)
  expect(v.wedged).toBe(true)
  expect(v.why).toContain('has not ticked')
})

test('a switched-off loop is not wedged - it is off, and alarming would be a false positive', () => {
  expect(wedgedVerdict(status(false, 2, 600), NOW).wedged).toBe(false)
})

test('one slow tick on a fast interval is not a fault', () => {
  // At a 1-minute interval three missed ticks is only three minutes, which a sweep driving real
  // UI can legitimately exceed. The floor keeps a fast cadence from turning into a false alarm.
  expect(wedgedVerdict(status(true, 1, 6), NOW).wedged).toBe(false)
  expect(wedgedVerdict(status(true, 1, 20), NOW).wedged).toBe(true)
})

test('enabled but never ticked is not yet a fault, and a missing status is not a pass', () => {
  expect(wedgedVerdict(status(true, 2, null), NOW).wedged).toBe(false)
  // No settings at all: unknown, and unknown must not read as wedged (that would alarm on every
  // malformed response) nor be treated as proof of health by the caller, which checks `up` first.
  expect(wedgedVerdict(undefined, NOW).wedged).toBe(false)
})
