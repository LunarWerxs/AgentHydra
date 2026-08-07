// web/src/lib/usage-reset.ts — "how long until this window resets", as a string.
//
// Pure formatting/derivation over a UsageLimit, mirroring lib/usage.ts. Nothing here touches Vue,
// the network, or `Date.now()` implicitly — every function takes `now`, so the whole module is
// unit-testable and a component can drive it off one ticking ref instead of each cell reading its
// own clock (which is how a table ends up with rows a second apart).
//
// The reset instant comes from `resetsAt` (a real ISO-8601 timestamp on the API path). The CLI
// fallback path only has a yearless human string like "Aug 6, 4:59am", which cannot be parsed
// safely on the client without re-deriving the year — so when `resetsAt` is missing we render that
// human string as-is rather than guessing. A wrong countdown is worse than no countdown.

import type { UsageLimit } from '@/lib/api'

/** Milliseconds until `limit` resets, or null when the reset instant isn't known. */
export function msUntilReset(
  limit: UsageLimit | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!limit?.resetsAt) return null
  const at = new Date(limit.resetsAt).getTime()
  if (!Number.isFinite(at)) return null
  return at - now.getTime()
}

/**
 * How far a reset instant may sit in the past before the reading is treated as SUPERSEDED rather
 * than as "resetting right now".
 *
 * Not zero: a window that reset seconds ago is a real, momentary state, and "now" is the honest
 * word for it. Two minutes is longer than the countdown's own tick and than a refresh sweep's
 * turnaround, so a genuinely-current reading is never called superseded.
 */
export const RESET_GRACE_MS = 2 * 60_000

/**
 * True when this limit's window has ENDED — its reset instant is meaningfully in the past.
 *
 * This is a stronger condition than lib/usage.ts's `isStaleSnap` (a reading merely older than half
 * an hour, which is still the best number we have and is shown dimmed). A superseded window is one
 * whose quota has already rolled over, so its percentage does not describe the CURRENT window at
 * all — it is a historical number, not an old one.
 *
 * Owner-reported 2026-08-07: an instance sat at "100% · resets now" because the cached snapshot was
 * eleven days old and both of its windows had reset long since. The countdown said "now" (formally
 * true: the instant had passed) and the chip kept asserting 100%, so a fully-reset account read as
 * exhausted.
 */
export function isWindowSuperseded(
  limit: UsageLimit | null | undefined,
  now: Date = new Date(),
): boolean {
  const ms = msUntilReset(limit, now)
  return ms !== null && ms < -RESET_GRACE_MS
}

/**
 * A compact countdown: "2h 14m", "47m", "31s", or "now" once the instant has passed.
 *
 * Deliberately coarse above an hour — nobody reading a quota table needs the seconds on a
 * four-hour window, and a per-second re-render of the minutes column is churn for nothing.
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return `${Math.max(1, Math.floor(ms / 1000))}s`
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const minutes = totalMin % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/**
 * What a "resets in" cell should say for one limit.
 *
 * Returns null when the window has no reset at all — an unstarted (0%) window prints no reset
 * time, and rendering "—" for it is the honest answer, not "0s" — and equally when the window is
 * SUPERSEDED, because "now" would claim a reset is happening this instant when it happened days ago.
 */
export function resetLabel(
  limit: UsageLimit | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!limit) return null
  const ms = msUntilReset(limit, now)
  if (ms !== null) return ms < -RESET_GRACE_MS ? null : formatCountdown(ms)
  // No ISO instant (the `claude -p "/usage"` fallback path). Show the human string it did give us
  // rather than inventing a countdown from a yearless date.
  return limit.resets ? limit.resets : null
}

// --- the WAIT, as a bar -------------------------------------------------------
//
// The usage-mode bars encode ONE thing: how much of this window is still to run. Length and colour
// are the same number rendered twice, which is what makes the column scannable without reading it:
//
//   SHORT bar + GREEN  = the wait is nearly over
//   LONG bar  + RED    = most of the window is still ahead of you
//
// This is deliberately NOT the burn percentage. The burn already has a column of its own (Usage),
// and a bar that meant "how much I've spent" in one column and "how long until it comes back" in
// the next would make the row read as two different scales side by side. The caption under each bar
// still carries the percentage, so nothing is lost — it just stops competing for the same channel.
//
// The endpoint reports when a window ENDS, never when it started, but the window lengths are fixed
// properties of the plan, so the remaining FRACTION is arithmetic rather than another API call.

/** The rolling session window Anthropic bills against. */
export const SESSION_WINDOW_MS = 5 * 60 * 60_000
/** The weekly window (both the all-models cap and the per-model sub-limit share it). */
export const WEEK_WINDOW_MS = 7 * 24 * 60 * 60_000

/**
 * How much of the window is still to run, 0-100 — the bar's LENGTH. Shorter wait, shorter bar.
 *
 * Clamped at both ends: a reset that has just passed reads 0 rather than going negative, and a
 * `resetsAt` further out than one window length (which happens when a window has not started, so
 * the server quotes the next boundary) reads 100 rather than overflowing.
 */
export function windowRemainingPct(
  limit: UsageLimit | null | undefined,
  windowMs: number,
  now: Date = new Date(),
): number | null {
  const remaining = msUntilReset(limit, now)
  if (remaining === null) return null
  return Math.round(Math.min(100, Math.max(0, (remaining / windowMs) * 100)))
}

/** Colour bands for a wait, matching the kit's Badge variants. */
export type WaitSeverity = 'success' | 'warning' | 'destructive'

/**
 * The bands, as a FRACTION of whatever window is asking.
 *
 * Calibrated on the weekly window, where the intuitive reading is in days: under a day left is a
 * short wait, one to two days is a middling one, beyond that is long. One day of seven is 1/7, two
 * is 2/7 — so those are the thresholds, and every window gets the proportional equivalent.
 *
 * Proportional rather than absolute is the whole point. A 5-hour session window can never make you
 * wait more than five hours, so absolute day-scale thresholds paint that entire column green and it
 * stops carrying any signal at all. Scaled to its own window, "3h 25m left of five hours" is the
 * same kind of long wait that "5d 13h left of a week" is, and it reads the same colour.
 */
const WAIT_WARNING_FRACTION = 1 / 7
const WAIT_CRITICAL_FRACTION = 2 / 7

/**
 * The bar's COLOUR, taken from the SAME number that drives its length (windowRemainingPct).
 *
 * Passing the fraction in rather than re-deriving it here is deliberate: length and colour are then
 * provably one quantity rendered two ways, and they cannot drift apart.
 */
export function waitSeverity(remainingPct: number | null): WaitSeverity {
  if (remainingPct === null) return 'success'
  const fraction = remainingPct / 100
  if (fraction < WAIT_WARNING_FRACTION) return 'success'
  if (fraction < WAIT_CRITICAL_FRACTION) return 'warning'
  return 'destructive'
}
