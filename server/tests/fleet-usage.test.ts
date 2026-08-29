// server/tests/fleet-usage.test.ts - Piece 2 pinned: band edges exactly at 80/85/90, reset-time
// derivation (ISO preferred over parsed text), staleness, missing data as 'unknown', and the
// deterministic worst-first ordering.
import { expect, test } from 'bun:test'
import { bandFor, fleetUsage } from '../src/fleet-usage'
import type { UsageSnapshot } from '../src/types'

test('band edges sit exactly on 80 / 85 / 90', () => {
  expect(bandFor(0)).toBe('ok')
  expect(bandFor(79.99)).toBe('ok')
  expect(bandFor(80)).toBe('elevated')
  expect(bandFor(84.99)).toBe('elevated')
  expect(bandFor(85)).toBe('high')
  expect(bandFor(89.99)).toBe('high')
  expect(bandFor(90)).toBe('critical')
  expect(bandFor(100)).toBe('critical')
  expect(bandFor(null)).toBe('unknown')
  expect(bandFor(Number.NaN)).toBe('unknown')
})

const NOW = Date.parse('2026-08-29T12:00:00Z')

function snap(over: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    account: null,
    session: null,
    weekAll: null,
    weekModel: null,
    capturedAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  }
}

test('reset minutes come from the ISO timestamp when present', () => {
  const [e] = fleetUsage({
    nowMs: NOW,
    cache: () => ({
      'desktop:a': snap({
        weekAll: { pct: 50, resets: 'whenever', resetsAt: '2026-08-29T14:00:00Z' },
        session: { pct: 10, resets: '', resetsAt: null },
      }),
    }),
  })
  expect(e?.weeklyResetsInMins).toBe(120)
  expect(e?.weeklyBand).toBe('ok')
  expect(e?.sessionResetsAt).toBe(null)
  expect(e?.sessionResetsInMins).toBe(null)
})

test('a fresh entry is not stale; an old or undated one is', () => {
  const rows = fleetUsage({
    nowMs: NOW,
    cache: () => ({
      'desktop:fresh': snap({ capturedAt: new Date(NOW - 5 * 60_000).toISOString() }),
      'desktop:old': snap({ capturedAt: new Date(NOW - 60 * 60_000).toISOString() }),
      'desktop:undated': snap({ capturedAt: undefined as unknown as string }),
    }),
  })
  const by = Object.fromEntries(rows.map((r) => [r.ref, r]))
  expect(by['desktop:fresh']?.stale).toBe(false)
  expect(by['desktop:fresh']?.ageMins).toBe(5)
  expect(by['desktop:old']?.stale).toBe(true)
  expect(by['desktop:undated']?.stale).toBe(true)
  expect(by['desktop:undated']?.ageMins).toBe(null)
})

test('missing limits band as unknown, never as fine', () => {
  const [e] = fleetUsage({ nowMs: NOW, cache: () => ({ 'cli:x': snap({}) }) })
  expect(e?.weeklyPct).toBe(null)
  expect(e?.weeklyBand).toBe('unknown')
  expect(e?.sessionBand).toBe('unknown')
})

test('ordering is worst band first, then weekly pct desc, then ref - and repeatable', () => {
  const cache = () => ({
    'desktop:ok': snap({ weekAll: { pct: 10, resets: '' } }),
    'desktop:crit': snap({ weekAll: { pct: 95, resets: '' } }),
    'desktop:high': snap({ weekAll: { pct: 86, resets: '' } }),
    'desktop:unknown': snap({}),
    'desktop:crit2': snap({ weekAll: { pct: 92, resets: '' } }),
  })
  const order = fleetUsage({ nowMs: NOW, cache }).map((r) => r.ref)
  expect(order).toEqual([
    'desktop:crit',
    'desktop:crit2',
    'desktop:high',
    'desktop:ok',
    'desktop:unknown',
  ])
  expect(fleetUsage({ nowMs: NOW, cache }).map((r) => r.ref)).toEqual(order)
})
