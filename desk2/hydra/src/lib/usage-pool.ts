// web/src/lib/usage-pool.ts: how much of one quota window is left across SEVERAL accounts, as one
// number. The folded CLI accounts table shows it as two gauges (PooledUsageGauges.vue).
//
// Pooled by plan size, not averaged: a Max 5x window holds five Pro windows, so its 50% left is
// worth five Pros at 50%. Pure and clock-free like usage-reset.ts: every call takes `now`.

import type { UsageLimit } from './api'
import { windowUsedPct } from './usage'

/** How many Pro windows a plan's window holds: Pro 1, Max 5x 5, Max 20x 20. The same reading of
 *  the plan label as the server's planFactor (server/src/climayte-placement.ts). */
export function planFactor(planLabel: string | null | undefined): number {
  const m = /max\s*(\d+)/i.exec(planLabel ?? '')
  const n = m ? Number(m[1]) : 1
  return Number.isFinite(n) && n > 0 ? n : 1
}

/** A plan column's sort value: its size by planFactor, or undefined (sorts last) with no plan. */
export function planSize(planLabel: string | null | undefined): number | undefined {
  return planLabel ? planFactor(planLabel) : undefined
}

/** One account's part in a pool: whether it is signed in, its plan, and its reading of the window
 *  being pooled (null or undefined when that window was never read). */
export interface PoolAccount {
  signedIn: boolean
  planLabel?: string | null
  limit: UsageLimit | null | undefined
}

export interface PooledRemaining {
  /** 0-100 left across the counted accounts, weighted by plan size; null when none is counted. */
  pct: number | null
  /** Signed-in accounts with a reading: the ones behind `pct`. */
  counted: number
  /** Left out: not signed in. */
  signedOut: number
  /** Left out: signed in, but this window has no reading. */
  unread: number
}

/**
 * sum(factor x left%) / sum(factor) over the signed-in accounts that have a reading.
 *
 * A window whose reset instant has passed counts as full again: its percentage describes a window
 * that has ended, and the quota behind it is back.
 */
export function pooledRemaining(accounts: PoolAccount[], now: Date = new Date()): PooledRemaining {
  let weighted = 0
  let weight = 0
  let counted = 0
  let signedOut = 0
  let unread = 0
  for (const a of accounts) {
    if (!a.signedIn) {
      signedOut++
      continue
    }
    if (!a.limit) {
      unread++
      continue
    }
    const left = 100 - (windowUsedPct(a.limit, now.getTime()) ?? 0)
    const factor = planFactor(a.planLabel)
    weighted += factor * left
    weight += factor
    counted++
  }
  return { pct: counted > 0 ? Math.round(weighted / weight) : null, counted, signedOut, unread }
}
