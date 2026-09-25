// server/tests/quota-calibration.test.ts - quota windows calibrated into dollars
// (server/src/quota-calibration.ts).
//
// Pins the three things that make the dollar figure trustworthy: jittered reset times land in ONE
// window, a polluted window is outvoted by the median rather than averaged in, and the censoring
// rules drop windows whose (percent, dollars) pair no longer describes the account. The last test
// runs the disk-backed path end to end against a throwaway transcript store (tests/setup.ts points
// DATA_DIR at a temp dir).

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const HOUR = 3600_000
const reading = (h: number, pct: number, resetsAt: string, higherPct: number | null = null) =>
  ({ at: T0 + h * HOUR, pct, resetsAt, higherPct }) satisfies QuotaReading

describe('window keys', () => {
  test('reset times that differ by seconds fall into one window', () => {
    const windows = groupWindows([
      reading(0, 10, '2026-01-08T00:00:10.000Z'),
      reading(1, 20, '2026-01-07T23:59:55.000Z'),
      reading(2, 5, '2026-01-15T00:00:00.000Z'),
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
  const turn = (ts: string, id: string, inputTokens: number) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      requestId: id,
      message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: inputTokens } },
    })

  const snap = (weekPct: number): UsageSnapshot => ({
    account: null,
    session: null,
    weekAll: { pct: weekPct, resets: '', resetsAt: '2026-01-08T00:00:00.000Z' },
    weekModel: null,
    capturedAt: '2026-01-01T01:00:00.000Z',
  })

  test('prices the turns between the readings of a window into dollars per percent, then re-prices', () => {
    const home = mkdtempSync(join(tmpdir(), 'ah-quota-dollars-'))
    try {
      mkdirSync(join(home, 'projects', 'p'), { recursive: true })
      writeFileSync(
        join(home, 'projects', 'p', 's.jsonl'),
        [
          // $30 at $3 per million input tokens, inside the window.
          turn('2026-01-01T00:30:00.000Z', 'r1', 10_000_000),
          // After the window's last reading: must not count.
          turn('2026-01-01T02:00:00.000Z', 'r2', 50_000_000),
        ].join('\n'),
      )
      const samples: UsageSample[] = [
        {
          at: '2026-01-01T00:00:00.000Z',
          sessionPct: null,
          weekAllPct: 10,
          weekResetsAt: '2026-01-08T00:00:10.000Z',
        },
        {
          at: '2026-01-01T01:00:00.000Z',
          sessionPct: null,
          weekAllPct: 20,
          weekResetsAt: '2026-01-07T23:59:55.000Z',
        },
      ]
      const key = 'test:quota-dollars'
      const d = calibrateQuotaDollars(key, snap(40), samples, [home])
      expect(d.weekly.usdPerPct).toBeCloseTo(3, 6)
      expect(d.weekly.capacityUsd).toBeCloseTo(300, 6)
      expect(d.weekly.dollarsLeft).toBeCloseTo(180, 6)
      expect(d.weekly.confidence).toBe('rough')
      expect(d.session.usdPerPct).toBeNull()

      // The quick self-check path: no transcript walk, same slope, the newer reading's %.
      expect(storedQuotaDollars(key, snap(70)).weekly.dollarsLeft).toBeCloseTo(90, 6)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  // Contract: only an account's own config dirs are priced, and never for Codex. Regression: the
  // budget used to fall back to ~/.claude (another login) and to price Claude turns against a
  // Codex window, persisting an inflated dollarsLeft that check_my_usage replayed.
  test('refuses to calibrate a Codex account or an account with no config dir of its own', () => {
    const samples: UsageSample[] = [
      {
        at: '2026-01-01T00:00:00.000Z',
        sessionPct: null,
        weekAllPct: 10,
        weekResetsAt: '2026-01-08T00:00:00.000Z',
      },
      {
        at: '2026-01-01T01:00:00.000Z',
        sessionPct: null,
        weekAllPct: 20,
        weekResetsAt: '2026-01-08T00:00:00.000Z',
      },
    ]
    for (const [key, dirs] of [
      ['codex:x', ['unused-dir']],
      ['desktop:x', undefined],
      ['desktop:y', []],
    ] as const) {
      const d = calibrateQuotaDollars(key, snap(40), samples, dirs ? [...dirs] : undefined)
      expect(d.calibratedAt).toBeNull()
      expect(d.weekly.dollarsLeft).toBeNull()
      expect(d.caveat).toStartWith('Not calibrated:')
      expect(storedQuotaDollars(key, snap(40)).weekly.usdPerPct).toBeNull()
    }
  })
})
