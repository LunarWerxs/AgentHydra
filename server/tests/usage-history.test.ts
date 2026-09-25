// server/tests/usage-history.test.ts — the burn-rate + forecast math (server/src/usage-history.ts).
//
// Only the pure functions are exercised here (burnRateBounds, burnRatePctPerHour, forecastUsage); the
// disk-backed recordUsageSample/usageSamples are intentionally left untested per the module's own doc
// comment ("The pure math is separated from the storage so it is unit-testable without touching the
// disk").
//
// THE REGRESSION THIS FILE GUARDS: weekAllPct is an integer. A delta of 0 measured over a short span
// does NOT mean "not burning" — it means "burning slower than this span can resolve". The old code
// treated a measured 0 as a real zero and set exhaustsBeforeReset = false, a false "work freely" that
// could arrive while sitting at 98% used. The fix computes every downstream figure from burnRateBounds'
// `upper` (a quantization-safe upper bound that is always > 0), never from the point estimate. See the
// tests tagged REGRESSION below for the concrete case.

import { describe, expect, test } from 'bun:test'
import type { UsageSample, UsageSnapshot } from '../src/types'
import { burnRateBounds, burnRatePctPerHour, forecastUsage } from '../src/usage-history'

const mkSample = (at: string, weekAllPct: number): UsageSample => ({
  at,
  sessionPct: null,
  weekAllPct,
  weekResetsAt: null,
})

describe('burnRatePctPerHour', () => {
  test('null when the measured span is under 45 minutes (MIN_SPAN_MIN)', () => {
    const now = new Date('2024-07-14T02:00:00.000Z')
    const samples = [
      mkSample('2024-07-14T01:15:00.000Z', 10),
      mkSample('2024-07-14T01:59:00.000Z', 12), // 44 minutes apart - just under the 45-min floor
    ]
    expect(burnRatePctPerHour(samples, now)).toBeNull()
  })

  test('reset-crossing guard: 90 -> 95 -> 5 -> 15 only measures the post-reset leg', () => {
    const now = new Date('2024-07-14T03:00:00.000Z')
    const samples = [
      mkSample('2024-07-14T00:00:00.000Z', 90),
      mkSample('2024-07-14T01:00:00.000Z', 95),
      mkSample('2024-07-14T02:00:00.000Z', 5), // reset happened between 01:00 and 02:00
      mkSample('2024-07-14T03:00:00.000Z', 15), // 1h post-reset leg (>= 45min floor)
    ]
    // Must NOT be (15 - 90) / 3h = -25 (a large bogus negative). Must be (15-5)/1h = 10, and in
    // particular must be positive.
    const rate = burnRatePctPerHour(samples, now)
    expect(rate).toBe(10)
    expect(rate).not.toBeLessThan(0)
  })

  test('truncates to the lookback window (plus one sample past the edge)', () => {
    // One reading per hour from t-10h to t-0h (now), pct rising by 1/hour throughout. Default
    // lookback is 6h, so the measured leg should be roughly the last 6-7h, not the full 10h —
    // and since the underlying rate is a constant 1%/hour, the truncated measurement should still
    // read 1, which confirms it kept a contiguous, correctly-ordered sub-window.
    const now = new Date('2024-07-14T10:00:00.000Z')
    const samples: UsageSample[] = []
    for (let h = 0; h <= 10; h++) {
      const t = new Date(now.getTime() - (10 - h) * 3600_000).toISOString()
      samples.push(mkSample(t, h))
    }
    expect(burnRatePctPerHour(samples, now)).toBe(1)
  })

  test('respects an explicit lookbackHours override', () => {
    const now = new Date('2024-07-14T04:00:00.000Z')
    const samples = [
      mkSample('2024-07-14T00:00:00.000Z', 0),
      mkSample('2024-07-14T02:00:00.000Z', 10),
      mkSample('2024-07-14T04:00:00.000Z', 20),
    ]
    // lookback 1h: cutoff is 03:00, so only the last two samples (02:00->04:00) qualify... but the
    // walk includes "the first sample past the edge" too, which here is 02:00 itself (< cutoff),
    // so the window is [02:00 pct10, 04:00 pct20] -> rate (20-10)/2h = 5.
    expect(burnRatePctPerHour(samples, now, 1)).toBe(5)
  })
})

describe('burnRateBounds', () => {
  test('null under the same conditions as burnRatePctPerHour: <2 samples, or span < 45min', () => {
    expect(burnRateBounds([])).toBeNull()
    expect(burnRateBounds([mkSample('2024-07-14T00:00:00.000Z', 10)])).toBeNull()
    const now = new Date('2024-07-14T02:00:00.000Z')
    const tooShort = [
      mkSample('2024-07-14T01:15:00.000Z', 10),
      mkSample('2024-07-14T01:59:00.000Z', 12), // 44 minutes
    ]
    expect(burnRateBounds(tooShort, now)).toBeNull()
  })

  test('upper stays > 0 even when the point estimate is exactly 0 (the quantization guard)', () => {
    const now = new Date('2024-07-14T02:00:00.000Z')
    const idle = [
      mkSample('2024-07-14T00:00:00.000Z', 30),
      mkSample('2024-07-14T01:00:00.000Z', 30), // 1 hour span, delta 0
    ]
    const bounds = burnRateBounds(idle, now)
    expect(bounds).not.toBeNull()
    expect(bounds?.point).toBe(0)
    expect(bounds?.upper).toBe(1) // (delta=0 + 1) / hours=1
    expect(bounds!.upper).toBeGreaterThan(bounds!.point)
    expect(bounds?.spanHours).toBe(1)
  })

  test('upper exceeds point by exactly 1/spanHours, and spanHours matches the measured window', () => {
    const now = new Date('2024-07-14T02:00:00.000Z')
    const samples = [
      mkSample('2024-07-14T00:00:00.000Z', 10),
      mkSample('2024-07-14T02:00:00.000Z', 20), // 2 hours, delta 10
    ]
    const bounds = burnRateBounds(samples, now)
    expect(bounds).toEqual({ point: 5, upper: 5.5, spanHours: 2 })
    expect(bounds!.upper - bounds!.point).toBeCloseTo(1 / bounds!.spanHours, 10)
  })

  test('burnRatePctPerHour is exactly burnRateBounds(...)?.point', () => {
    const now = new Date('2024-07-14T02:00:00.000Z')
    const samples = [
      mkSample('2024-07-14T00:00:00.000Z', 10),
      mkSample('2024-07-14T02:00:00.000Z', 20),
    ]
    expect(burnRatePctPerHour(samples, now)).toBe(burnRateBounds(samples, now)!.point)
  })
})

const baseSnap = (weekAll: UsageSnapshot['weekAll']): UsageSnapshot => ({
  account: null,
  session: null,
  weekAll,
  weekModel: null,
  capturedAt: '2024-07-14T02:00:00.000Z',
  source: 'api',
})

describe('forecastUsage', () => {
  const NOW = new Date('2024-07-14T02:00:00.000Z')

  test('pct null (no weekAll) -> everything derived stays null', () => {
    const snap = baseSnap(null)
    const forecast = forecastUsage(snap, [], NOW)
    expect(forecast).toEqual({
      burnPctPerHour: null,
      burnPctPerHourUpper: null,
      remainingPct: null,
      headroomHours: null,
      exhaustsAt: null,
      hoursToReset: null,
      exhaustsBeforeReset: null,
      samples: 0,
    })
  })

  test('burn null (insufficient samples) -> remainingPct/hoursToReset still computed, rest null', () => {
    const snap = baseSnap({ pct: 50, resets: '', resetsAt: '2024-07-19T00:00:00.000Z' })
    const forecast = forecastUsage(snap, [], NOW)
    expect(forecast.burnPctPerHour).toBeNull()
    expect(forecast.burnPctPerHourUpper).toBeNull()
    expect(forecast.remainingPct).toBe(50)
    expect(forecast.headroomHours).toBeNull()
    expect(forecast.exhaustsAt).toBeNull()
    expect(forecast.exhaustsBeforeReset).toBeNull()
    expect(forecast.samples).toBe(0)
    const expectedHoursToReset = (Date.parse('2024-07-19T00:00:00.000Z') - NOW.getTime()) / 3600_000
    expect(forecast.hoursToReset).toBeCloseTo(expectedHoursToReset, 10)
  })

  test('idle point-burn (0) still yields a finite, nonzero upper bound and finite headroom', () => {
    // Same fixture as the old "idle" test, but the whole point of the fix is that a measured-flat
    // window no longer means "infinite headroom, never exhausts" — it means "at most `upper`", and
    // headroom is computed from that, so it stays a real (large but finite) number.
    const snap = baseSnap({ pct: 30, resets: '', resetsAt: '2024-07-19T00:00:00.000Z' }) // +118h
    const samples = [
      mkSample('2024-07-14T00:00:00.000Z', 30),
      mkSample('2024-07-14T01:00:00.000Z', 30),
    ]
    const forecast = forecastUsage(snap, samples, NOW)
    expect(forecast.burnPctPerHour).toBe(0)
    expect(forecast.burnPctPerHourUpper).toBe(1) // (0 + 1) / 1h
    expect(forecast.remainingPct).toBe(70)
    expect(forecast.headroomHours).toBe(70) // 70 / 1, NOT null/Infinity
    expect(forecast.exhaustsAt).not.toBeNull()
  })

  // REGRESSION: this is the exact shape of the bug. A slow burn that hasn't ticked the integer % yet,
  // sitting near the cap, with the reset far away. The old code measured delta=0 and reported
  // "never exhausts" (exhaustsBeforeReset: false) — a false green light at 98% used. The fix must
  // report a real, pessimistic verdict instead.
  test('REGRESSION: same-pct samples (98,98,98) over 2h at 98% used -> burn reads 0 BUT exhaustsBeforeReset is TRUE, not the old false "work freely"', () => {
    const snap = baseSnap({
      pct: 98,
      resets: '',
      resetsAt: new Date(NOW.getTime() + 100 * 3600_000).toISOString(), // reset far away: 100h
    })
    const samples = [
      mkSample('2024-07-14T00:00:00.000Z', 98),
      mkSample('2024-07-14T01:00:00.000Z', 98),
      mkSample('2024-07-14T02:00:00.000Z', 98),
    ]
    const forecast = forecastUsage(snap, samples, NOW)
    expect(forecast.samples).toBe(3)
    expect(forecast.burnPctPerHour).toBe(0) // the point estimate genuinely reads 0
    expect(forecast.burnPctPerHourUpper).toBe(0.5) // (0 + 1) / 2h
    expect(forecast.remainingPct).toBe(2)
    expect(forecast.headroomHours).toBe(4) // 2 / 0.5 - finite, not null, not Infinity
    expect(forecast.hoursToReset).toBeCloseTo(100, 10)
    // THE ASSERTION THAT MATTERS: NOT false, despite burnPctPerHour === 0.
    expect(forecast.exhaustsBeforeReset).toBe(true)
    expect(forecast.exhaustsAt).not.toBeNull()
  })

  test('idle point-burn (0) CAN still legitimately be false, when the reset is imminent', () => {
    // Same idle fixture as above, but the reset arrives in 2h — sooner than the 4h worst-case
    // headroom — so the reset genuinely wins. Proves exhaustsBeforeReset is a real comparison against
    // `upper`, not a rubber stamp of `true` whenever the point estimate is 0.
    const snap = baseSnap({
      pct: 98,
      resets: '',
      resetsAt: new Date(NOW.getTime() + 2 * 3600_000).toISOString(), // reset in 2h
    })
    const samples = [
      mkSample('2024-07-14T00:00:00.000Z', 98),
      mkSample('2024-07-14T01:00:00.000Z', 98),
      mkSample('2024-07-14T02:00:00.000Z', 98),
    ]
    const forecast = forecastUsage(snap, samples, NOW)
    expect(forecast.burnPctPerHour).toBe(0)
    expect(forecast.headroomHours).toBe(4)
    expect(forecast.hoursToReset).toBeCloseTo(2, 10)
    expect(forecast.exhaustsBeforeReset).toBe(false)
  })

  test('exhaustsBeforeReset === true: cap is hit before the weekly reset', () => {
    // Measured delta 10 over 2h -> point 5%/hour, upper (10+1)/2 = 5.5%/hour. Every downstream figure
    // is derived from `upper`, so headroom = 10% remaining / 5.5%/hour = 20/11 h, not the naive 2h.
    const snap = baseSnap({ pct: 90, resets: '', resetsAt: '2024-07-14T07:00:00.000Z' }) // +5h
    const samples = [
      mkSample('2024-07-14T00:00:00.000Z', 10),
      mkSample('2024-07-14T02:00:00.000Z', 20),
    ]
    const forecast = forecastUsage(snap, samples, NOW)
    expect(forecast.burnPctPerHour).toBe(5)
    expect(forecast.burnPctPerHourUpper).toBe(5.5)
    expect(forecast.remainingPct).toBe(10)
    const expectedHeadroom = 10 / 5.5
    expect(forecast.headroomHours).toBe(expectedHeadroom)
    expect(forecast.hoursToReset).toBeCloseTo(5, 10)
    expect(forecast.exhaustsBeforeReset).toBe(true)
    expect(forecast.exhaustsAt).toBe(
      new Date(NOW.getTime() + expectedHeadroom * 3600_000).toISOString(),
    )
  })

  test('burn > 0 but no resetsAt -> exhaustsBeforeReset is null (unknown, not false)', () => {
    const snap = baseSnap({ pct: 90, resets: '', resetsAt: null })
    const samples = [
      mkSample('2024-07-14T00:00:00.000Z', 10),
      mkSample('2024-07-14T02:00:00.000Z', 20),
    ]
    const forecast = forecastUsage(snap, samples, NOW)
    expect(forecast.burnPctPerHour).toBe(5)
    expect(forecast.burnPctPerHourUpper).toBe(5.5)
    expect(forecast.hoursToReset).toBeNull()
    expect(forecast.exhaustsBeforeReset).toBeNull()
    expect(forecast.headroomHours).toBe(10 / 5.5) // still computed independent of hoursToReset
    expect(forecast.exhaustsAt).not.toBeNull()
  })

  test('REGRESSION: a resetsAt in the PAST (stale snapshot) is UNKNOWN, never a free pass', () => {
    // The false-green-light bug through a side door. If resetsAt is clamped to 0 hours instead of
    // reported as unknown, then `headroomHours < hoursToReset` is false for ANY positive headroom,
    // and a stale reading at 98% used would report "you will not hit the cap, work freely".
    const snap = baseSnap({
      pct: 98,
      resets: '',
      resetsAt: '2024-07-13T00:00:00.000Z', // a full day BEFORE NOW
    })
    const samples = [
      mkSample('2024-07-14T00:00:00.000Z', 98),
      mkSample('2024-07-14T02:00:00.000Z', 98),
    ]
    const forecast = forecastUsage(snap, samples, NOW)
    expect(forecast.hoursToReset).toBeNull() // NOT 0
    expect(forecast.exhaustsBeforeReset).toBeNull() // NOT false
    expect(forecast.exhaustsBeforeReset).not.toBe(false)
  })
})
