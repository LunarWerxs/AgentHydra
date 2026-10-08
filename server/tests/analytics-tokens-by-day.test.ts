// server/tests/analytics-tokens-by-day.test.ts — the Instances usage card's daily bars.
//
// THE FAILURE THIS PINS. The new read must draw the SAME bars the card drew from spendReport:
// one day per local day, one figure per source, the same weighting and the same source attribution.
// A rewrite that counted calls, or kept the wrong source, would move the chart without a test noticing.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resetSessionProjects, resetTokensByDay, spendReport, tokensByDay } from '../src/analytics'
import { KitStore, type UsageEventInput } from '../src/kit/store'

const H = 3_600_000
const D = 24 * H
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)
const SOURCES = ['desktop', 'cli', 'climayte', 'hswarm'] as const

let n = 0
const call = (ago: number, e: Partial<UsageEventInput>): UsageEventInput => ({
  id: `t${++n}`,
  ts: NOW - ago,
  source: 'cli',
  model: 'claude-opus-5',
  provider: 'anthropic',
  input: 100,
  output: 50,
  cache_read: 1000,
  list_usd: 1,
  weighted: 10,
  ...e,
})

beforeEach(() => resetTokensByDay())

describe('tokensByDay', () => {
  test('per-day, per-source totals equal spendReport byDay for each source on the same rows', async () => {
    const store = new KitStore(':memory:', { now: NOW })
    store.upsertEvents([
      call(1 * D, { source: 'desktop', weighted: 20 }),
      call(1 * D + 3 * H, { source: 'desktop', weighted: 4 }),
      call(3 * D, { source: 'cli', weighted: 7 }),
      call(5 * D, { source: 'climayte', weighted: 9 }),
      call(9 * D, { source: 'hswarm', weighted: 11 }),
      // A source the card does not draw, and a call older than the 14-day list: neither is a bar.
      call(2 * D, { source: 'codex', weighted: 500 }),
      call(20 * D, { source: 'cli', weighted: 300 }),
    ])
    const { days } = await tokensByDay({ days: 14, store, now: NOW })
    expect(days).toHaveLength(14)

    for (const source of SOURCES) {
      const report = await spendReport({
        store,
        now: NOW,
        sinceMs: NOW - 30 * D,
        sources: [source],
      })
      const byDay = new Map(report.byDay.map((b) => [b.key, b.weighted]))
      for (const d of days) expect(d.bySource[source]).toBe(byDay.get(d.key) ?? 0)
    }
    // Not vacuous: the four sources' figures are all really there.
    const total = (s: (typeof SOURCES)[number]) => days.reduce((n, d) => n + d.bySource[s], 0)
    expect(SOURCES.map(total)).toEqual([24, 7, 9, 11])
    store.close()
  })
})

// spendReport caches the session-to-project map from the shared database for five minutes. This file
// reads it while that database has no sessions, so clear it: the next file seeds its own and reads it.
afterAll(() => {
  resetTokensByDay()
  resetSessionProjects()
})
