// web/src/lib/usage-pool.ts: the two gauges on the folded CLI accounts table. The number is a
// promise about capacity ("this much is left across my accounts"), so the weighting, the reset rule
// and who is left out are the contract.
import { expect, test } from 'bun:test'
import type { UsageLimit } from './api'
import { pooledRemaining } from './usage-pool'

const NOW = new Date('2026-10-02T12:00:00Z')
const HOUR = 3_600_000
/** A window `pct` used that resets `inHours` from NOW (negative: it already has). */
const limit = (pct: number, inHours: number): UsageLimit => ({
  pct,
  resets: '',
  resetsAt: new Date(NOW.getTime() + inHours * HOUR).toISOString(),
})

test('a Max 5x weighs five Pros: the pool is not the plain average', () => {
  const pool = pooledRemaining(
    [
      { signedIn: true, planLabel: 'Max 5x', limit: limit(0, 2) },
      { signedIn: true, planLabel: 'Pro', limit: limit(100, 2) },
    ],
    NOW,
  )
  // (5 x 100 + 1 x 0) / 6; a plain average would say 50.
  expect(pool).toEqual({ pct: 83, counted: 2, signedOut: 0, unread: 0 })
})

test('a window whose reset has passed counts as full again', () => {
  const pool = pooledRemaining(
    [
      { signedIn: true, planLabel: 'Pro', limit: limit(100, -1) },
      { signedIn: true, planLabel: 'Pro', limit: limit(40, 2) },
    ],
    NOW,
  )
  expect(pool.pct).toBe(80)
})

test('signed-out and unread accounts are left out of the number and counted apart', () => {
  const pool = pooledRemaining(
    [
      { signedIn: true, planLabel: 'Pro', limit: limit(30, 2) },
      { signedIn: false, planLabel: 'Max 20x', limit: limit(0, 2) },
      { signedIn: true, planLabel: 'Max 5x', limit: null },
    ],
    NOW,
  )
  expect(pool).toEqual({ pct: 70, counted: 1, signedOut: 1, unread: 1 })
})

test('no counted account gives no percentage, never a 0 or a 100', () => {
  expect(pooledRemaining([{ signedIn: false, limit: null }], NOW).pct).toBeNull()
})
