// web/src/lib/usage-filter.ts — "is this instance too far into its quota to be worth using?"
//
// Pure derivation over a UsageSnapshot, in the same spirit as lib/usage.ts and lib/usage-reset.ts:
// nothing here touches Vue, the network or a clock, so the rule the tables act on is unit-testable
// on its own. The reactive, persisted knobs live in composables/useUsageFilter.ts.
//
// The question the filter answers is "which accounts can I still work on", and the default window is
// the WEEKLY cap — the Usage column, the one that decides whether an account is worth starting on at
// all. The 5-hour session is a much shorter-lived reading (it comes back the same day), so having it
// drive the filter by default meant accounts kept dropping out and back in over an afternoon.
// 'session' and 'either' are there for the times that IS the question; they are not the default.
//
// The one thing this must never do is treat "no reading" as "over the limit". An instance that has
// never been checked (or came back empty) is UNKNOWN, not exhausted — dimming or hiding it would
// quietly remove a perfectly usable account from the table on the strength of a missing number.
// A reading whose window has since RESET counts as no reading for exactly the same reason: it is
// the strongest form of the trap, because the number it hides the account on is one that provably
// no longer applies (see isWindowSuperseded).

import type { UsageSnapshot } from '@/lib/api'
import { bindingWeeklyPct } from '@/lib/usage'
import { isWindowSuperseded } from '@/lib/usage-reset'

/** Which quota window the threshold is measured against. */
export type UsageFilterScope = 'either' | 'week' | 'session'

/** The weekly cap, i.e. the Usage column. Named so the default is stated once and every caller's
 *  fallback parameter reads the same. */
export const DEFAULT_USAGE_FILTER_SCOPE: UsageFilterScope = 'week'

/** Default threshold, in percent. 80 is the point where an account stops being somewhere you'd
 *  start new work — high enough not to fire constantly, low enough to leave headroom. */
export const DEFAULT_USAGE_THRESHOLD = 80

/** The one-click threshold choices offered in the filter flyout. */
export const USAGE_THRESHOLD_PRESETS = [50, 70, 80, 90] as const

/**
 * The percentage this filter compares against its threshold, or null when the snapshot has no
 * usable reading for the chosen scope (never checked, logged out, parse miss).
 *
 * For 'either' a single known window is enough — a snapshot with only a weekly figure still
 * answers the question for the weekly cap, and returning null there would make partial data
 * behave like no data.
 */
export function usageFilterPct(
  snap: UsageSnapshot | null | undefined,
  scope: UsageFilterScope = DEFAULT_USAGE_FILTER_SCOPE,
  now: Date = new Date(),
): number | null {
  if (!snap) return null
  const week = isWindowSuperseded(snap.weekAll, now) ? null : bindingWeeklyPct(snap)
  const session = isWindowSuperseded(snap.session, now) ? null : (snap.session?.pct ?? null)
  if (scope === 'week') return week
  if (scope === 'session') return session
  if (week == null) return session
  if (session == null) return week
  return Math.max(week, session)
}

/**
 * Is this snapshot AT OR ABOVE the threshold?
 *
 * At-or-above, not strictly-above: a threshold of 80 is read as "80% is where I stop", so an
 * account sitting exactly on it belongs with the ones being set aside, not with the fresh ones.
 *
 * Always false for an unknown reading — see the note at the top of this file.
 */
export function isOverUsageThreshold(
  snap: UsageSnapshot | null | undefined,
  threshold: number,
  scope: UsageFilterScope = DEFAULT_USAGE_FILTER_SCOPE,
  now: Date = new Date(),
): boolean {
  const pct = usageFilterPct(snap, scope, now)
  if (pct == null) return false
  return pct >= threshold
}

/**
 * Clamp a typed/pasted threshold into 0-100, keeping the previous value when the input is junk.
 *
 * An EMPTY box counts as junk, not as zero. `Number('')` is 0, so the obvious implementation turns
 * "select all, delete, type 85" into a threshold of 0 for the keystroke in between — which with
 * hiding on empties the table under the user's hands.
 */
export function clampThreshold(value: unknown, fallback = DEFAULT_USAGE_THRESHOLD): number {
  if (typeof value === 'string' && value.trim() === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(100, Math.max(0, Math.round(n)))
}
