// server/tests/quota-calibration.test.ts - quota windows calibrated into dollars
// (server/src/quota-calibration.ts).
//
// Pins the three things that make the dollar figure trustworthy: jittered reset times land in ONE
// window, a polluted window is outvoted by the median rather than averaged in, and the censoring
// rules drop windows whose (percent, dollars) pair no longer describes the account. The last test
// runs the disk-backed path end to end against a throwaway kit store (tests/setup.ts points
// DATA_DIR at a temp dir).

import { describe, expect, test } from 'bun:test'
import { sharedKitStore } from '../src/kit/query'
import type { UsageEventInput } from '../src/kit/store'
import {
  calibrateQuotaDollars,
  capacityFrom,
  foldWindow,
  groupWindows,
  type QuotaReading,
  storedQuotaDollars,
  theilSenSlope,
} from '../src/quota-calibration'
import type { UsageSample, UsageSnapshot } from '../src/types'
import { defaultConfigDir } from '../src/usage-tokens'

// Nothing here reads the real clock (the transcript is written now, long after every reading), so
// every instant hangs off one fixed far-past origin and keeps its spacing whenever the suite runs.
const T0 = Date.parse('2020-01-01T00:00:00.000Z')
const HOUR = 3600_000
const WEEK_END = T0 + 7 * 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()
const reading = (h: number, pct: number, resetsAt: string, higherPct: number | null = null) =>
  ({ at: T0 + h * HOUR, pct, resetsAt, higherPct }) satisfies QuotaReading

describe('window keys', () => {
  test('reset times that differ by seconds fall into one window', () => {
    const windows = groupWindows([
      reading(0, 10, iso(WEEK_END + 10_000)),
      reading(1, 20, iso(WEEK_END - 5_000)),
      reading(2, 5, iso(WEEK_END + 7 * 24 * HOUR)),
    ])
    expect([...windows.values()].map((w) => w.length)).toEqual([2, 1])
  })
})

describe('theilSenSlope', () => {
  test('one polluted window is outvoted by the median, not averaged in', () => {
    // Two clean windows at $3/% and one where the % barely moved while $400 was spent.
    expect(
      theilSenSlope([
        { x: 10, y: 30 },
        { x: 20, y: 60 },
        { x: 5, y: 400 },
      ]),
    ).toBe(3)
  })

  test('a single window calibrates through the origin', () => {
    expect(theilSenSlope([{ x: 8, y: 20 }])).toBe(2.5)
  })
})

describe('censoring', () => {
  const flat = () => ({ usd: 4, unpriced: false })

  test('a 5-hour window the weekly cap cut short is left out', () => {
    const cut = foldWindow([reading(0, 10, 'k', 90), reading(1, 30, 'k', 100)], () => ({
      usd: 40,
      unpriced: false,
    }))
    const clean = foldWindow([reading(0, 10, 'j', 50), reading(1, 30, 'j', 60)], flat)
    const cap = capacityFrom([cut!, clean!], 50)
    expect(cap.censored).toEqual({ higher_tier_capped: 1 })
    expect(cap.windows).toBe(1)
    expect(cap.usdPerPct).toBe(0.2)
  })

  test('a rise with no recorded turn behind it is left out', () => {
    const unseen = foldWindow(
      [reading(0, 10, 'k'), reading(1, 20, 'k'), reading(2, 30, 'k')],
      (from) => ({ usd: from === T0 ? 10 : 0, unpriced: false }),
    )
    const cap = capacityFrom([unseen!], 30)
    expect(cap.censored).toEqual({ unrecorded_usage: 1 })
    expect(cap.usdPerPct).toBeNull()
    expect(cap.dollarsLeft).toBeNull()
  })

  test('a window that reached 100% is left out', () => {
    const capped = foldWindow([reading(0, 60, 'k'), reading(1, 100, 'k')], flat)
    expect(capacityFrom([capped!], 100).censored).toEqual({ capped: 1 })
  })
})

describe('incremental folding', () => {
  test('a persisted fold prices only the readings after it', () => {
    const calls: number[] = []
    const cost = (from: number) => {
      calls.push(from)
      return { usd: 5, unpriced: false }
    }
    const first = foldWindow([reading(0, 10, 'k'), reading(1, 15, 'k')], cost)
    calls.length = 0
    const next = foldWindow(
      [reading(0, 10, 'k'), reading(1, 15, 'k'), reading(2, 22, 'k')],
      cost,
      first,
    )
    expect(calls).toEqual([T0 + HOUR])
    expect(next).toMatchObject({ fromPct: 10, throughPct: 22, usd: 10 })
  })
})

describe('calibrateQuotaDollars (disk-backed)', () => {
  const turn = (ts: number, id: string, input: number): UsageEventInput => ({
    id,
    ts,
    source: 'cli',
    instance: 'default',
    model: 'claude-sonnet-4-5',
    input,
    list_usd: (input / 1_000_000) * 3,
  })

  const snap = (weekPct: number): UsageSnapshot => ({
    account: null,
    session: null,
    weekAll: { pct: weekPct, resets: '', resetsAt: iso(WEEK_END) },
    weekModel: null,
    capturedAt: iso(T0 + HOUR),
  })

  test('prices the turns between the readings of a window into dollars per percent, then re-prices', async () => {
    // The readings sit in 2020, below a fresh store's raw cut, where a call is settled without a raw row.
    sharedKitStore()
      .db.query("insert or replace into meta (key, value) values ('raw_cut', '0')")
      .run()
    sharedKitStore().upsertEvents([
      // $30 at $3 per million input tokens, inside the window.
      turn(T0 + HOUR / 2, 'r1', 10_000_000),
      // After the window's last reading: must not count.
      turn(T0 + 2 * HOUR, 'r2', 50_000_000),
    ])
    {
      const samples: UsageSample[] = [
        {
          at: iso(T0),
          sessionPct: null,
          weekAllPct: 10,
          weekResetsAt: iso(WEEK_END + 10_000),
        },
        {
          at: iso(T0 + HOUR),
          sessionPct: null,
          weekAllPct: 20,
          weekResetsAt: iso(WEEK_END - 5_000),
        },
      ]
      const key = 'test:quota-dollars'
      const d = await calibrateQuotaDollars(key, snap(40), samples, [defaultConfigDir()])
      expect(d.weekly.usdPerPct).toBeCloseTo(3, 6)
      expect(d.weekly.capacityUsd).toBeCloseTo(300, 6)
      expect(d.weekly.dollarsLeft).toBeCloseTo(180, 6)
      expect(d.weekly.confidence).toBe('rough')
      expect(d.session.usdPerPct).toBeNull()

      // The quick self-check path: no transcript walk, same slope, the newer reading's %.
      expect(storedQuotaDollars(key, snap(70)).weekly.dollarsLeft).toBeCloseTo(90, 6)
    }
  })

  // Contract: only an account's own config dirs are priced, and never for Codex. Regression: the
  // budget used to fall back to ~/.claude (another login) and to price Claude turns against a
  // Codex window, persisting an inflated dollarsLeft that check_my_usage replayed.
  test('refuses to calibrate a Codex account or an account with no config dir of its own', async () => {
    const samples: UsageSample[] = [
      {
        at: iso(T0),
        sessionPct: null,
        weekAllPct: 10,
        weekResetsAt: iso(WEEK_END),
      },
      {
        at: iso(T0 + HOUR),
        sessionPct: null,
        weekAllPct: 20,
        weekResetsAt: iso(WEEK_END),
      },
    ]
    for (const [key, dirs] of [
      ['codex:x', ['unused-dir']],
      ['desktop:x', undefined],
      ['desktop:y', []],
    ] as const) {
      const d = await calibrateQuotaDollars(key, snap(40), samples, dirs ? [...dirs] : undefined)
      expect(d.calibratedAt).toBeNull()
      expect(d.weekly.dollarsLeft).toBeNull()
      expect(d.caveat).toStartWith('Not calibrated:')
      expect(storedQuotaDollars(key, snap(40)).weekly.usdPerPct).toBeNull()
    }
  })
})
