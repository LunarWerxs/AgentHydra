// What the usage tables show for a CLI account Corch is using (server/src/usage-live.ts).
import { describe, expect, test } from 'bun:test'
import type { UsageSnapshot } from '../src/types'
import { withLimitWall, withLiveReading } from '../src/usage-live'

const now = Date.parse('2026-10-01T01:00:00Z')
const snapshot = (): UsageSnapshot => ({
  account: 'a',
  session: { pct: 43, resets: '11:29pm', resetsAt: '2026-10-01T04:29:59Z', severity: 'normal' },
  weekAll: { pct: 16, resets: 'Oct 7', resetsAt: '2026-10-07T06:59:59Z', severity: 'normal' },
  weekModel: null,
  capturedAt: '2026-10-01T00:14:33Z',
})

describe('withLimitWall', () => {
  test('an account Corch walled at its limit reads at its limit, not the snapshot from before', () => {
    // Field note 19: walled until 11:30pm, the table still read 43% from 19:14.
    const until = Date.parse('2026-10-01T04:31:00Z')
    const walled = withLimitWall(snapshot(), { until, weekly: false }, 'a', now)
    expect(walled?.session).toMatchObject({
      pct: 100,
      resetsAt: '2026-10-01T04:30:00.000Z',
      severity: 'critical',
    })
    expect(walled?.weekAll?.pct).toBe(16)
    // A weekly wall marks the week; a reading already past 100 keeps its number.
    const over = { ...snapshot(), weekAll: { ...snapshot().weekAll!, pct: 104 } }
    expect(withLimitWall(over, { until, weekly: true }, 'a', now)?.weekAll?.pct).toBe(104)
    // A wall that has ended changes nothing.
    expect(withLimitWall(snapshot(), { until: now - 1, weekly: false }, 'a', now)).toEqual(
      snapshot(),
    )
  })
})

describe('withLiveReading', () => {
  test('a reading of a window that has since reset is not shown', () => {
    // Readings are kept across restarts now, so an old 104% must not outlive its window.
    const live = {
      sessionPct: 104,
      sessionResetsAt: now - 60_000,
      weekPct: 20,
      weekResetsAt: Date.parse('2026-10-07T06:59:59Z'),
      overageAllowed: false,
      at: Date.parse('2026-10-01T00:40:00Z'),
    }
    const shown = withLiveReading(snapshot(), live, 'a', now)
    expect(shown?.session?.pct).toBe(43)
    expect(shown?.weekAll?.pct).toBe(20)
  })
})
