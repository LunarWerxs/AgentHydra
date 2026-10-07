// web/src/lib/instance-headroom.ts — how many accounts can take work now, and which are nearest a limit.
// Pure and clock-free: every call takes `at` (ms), so the figures never shift between refreshes.

import { windowUsedPct } from './usage'

export interface HeadroomRow {
  key: string
  label: string
  /** % used, 0-100; null when that window was never read. */
  session: number | null
  week: number | null
}

const worst = (r: HeadroomRow) => Math.max(r.session ?? -1, r.week ?? -1)

/** Accounts with at least one reading, most used first (the one about to hit a limit on top). */
export function sortHeadroom(rows: HeadroomRow[]): HeadroomRow[] {
  return rows.filter((r) => worst(r) >= 0).sort((a, b) => worst(b) - worst(a))
}

type UsageWindow = { pct: number; resetsAt?: string | null } | null | undefined

/**
 * Usable = signed in, with neither its 5-hour nor its weekly window used up. A window whose reset
 * has passed is back (windowUsedPct), and one never read does not hold an account back.
 */
export function usableNow(
  accounts: Array<{ signedIn: boolean; session: UsageWindow; week: UsageWindow }>,
  at: number,
): { signedIn: number; spent: number; usable: number } {
  let signedIn = 0
  let spent = 0
  for (const a of accounts) {
    if (!a.signedIn) continue
    signedIn++
    if ([a.session, a.week].some((w) => (windowUsedPct(w, at) ?? 0) >= 100)) spent++
  }
  return { signedIn, spent, usable: signedIn - spent }
}
