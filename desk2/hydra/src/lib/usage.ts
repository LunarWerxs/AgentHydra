// Usage-check helpers: pure formatting/derivation over a UsageSnapshot, mirroring
// format.ts's StatusMeta / Badge-variant pattern. See server/src/usage.ts for how a
// snapshot is parsed from `claude -p "/usage"` output, and server/src/usage-service.ts /
// server/src/index.ts for the cache keys (`acct:<id>`, `cli:<id>`) each check lands under.
import type { ClaudeCodeCredit, UsageSnapshot } from './api'
import { formatAgo } from './relativeTime'
import { isWindowSuperseded, msUntilReset, SESSION_WINDOW_MS, WEEK_WINDOW_MS } from './usage-reset'

/** Mirrors server's `UsageReason` (see server/src/types.ts). Not re-exported from lib/api.ts,
 *  so this is the single local source other modules (useUsage.ts, UsageBadge.vue, and the two
 *  usage-table views) import from rather than each declaring their own copy. */
export type UsageReason =
  | 'ok'
  | 'logged_out'
  | 'no_token'
  | 'not_logged_in'
  | 'check_failed'
  | 'stale_token_app_closed'
  | 'rate_limited'
  | 'unknown'

/** The binding weekly-all-models percentage used for pacing decisions. Null when the
 *  snapshot never captured a weekly figure (no data yet, or a parse miss). */
export function bindingWeeklyPct(snap: UsageSnapshot): number | null {
  return snap.weekAll?.pct ?? null
}

/** True when a snapshot carries no usable data at all (e.g. a probe that never parsed,
 *  or an identity with no matching dispatch account to check against). */
export function isNoDataSnap(snap: UsageSnapshot): boolean {
  return snap.session == null && snap.weekAll == null && snap.weekModel == null
}

/** Kit Badge variant names this module ever returns (a narrow subset of format.ts's
 *  BadgeVariant, kept separate so callers don't need the wider type). */
export type UsageBadgeVariant = 'success' | 'warning' | 'destructive'

/** Color-code a usage percentage: green under 70, amber 70-90, red over 90. */
export function usageBadgeVariant(pct: number): UsageBadgeVariant {
  if (pct > 90) return 'destructive'
  if (pct >= 70) return 'warning'
  return 'success'
}

/** Which window a usage chip is reporting. 'week' is the binding all-models cap; 'session' is the
 *  rolling 5-hour one, which the Instances table shows as its own chip beside it. */
export type UsageScope = 'week' | 'session'

/**
 * The percentage a chip of this scope reports, or null when that window has no CURRENT reading.
 *
 * Null covers two cases that must read identically: the window was never measured, and the window
 * was measured but has since reset (isWindowSuperseded). A percentage from a window that has ended
 * says nothing about the one running now — reporting it is not "slightly out of date", it is a
 * different window's number. See the note on isWindowSuperseded for the reading this fixes.
 */
export function usagePctFor(
  snap: UsageSnapshot | null | undefined,
  scope: UsageScope = 'week',
  now: Date = new Date(),
): number | null {
  if (!snap) return null
  const limit = scope === 'session' ? snap.session : snap.weekAll
  // A signed-out account's kept reading shows its last numbers whatever has reset since: it is
  // shown dimmed as the last reading (owner, 2026-10-01: "don't clear the last usage stats").
  if (!snap.signedOutAt && isWindowSuperseded(limit, now)) return null
  return scope === 'session' ? (snap.session?.pct ?? null) : bindingWeeklyPct(snap)
}

/**
 * Short chip label for a usage snapshot ("42%"), or "—" when there's nothing current to show (never
 * checked, a checked-but-empty snapshot, or a window that has since reset).
 *
 * `withScope` appends the window ("42% wk" / "13% 5h") and is OFF by default. In the instances
 * tables the column heading already names the window, so the suffix repeated it on every row; the
 * quick-instances window has no headings, and there the chip has to say which window it means.
 */
export function usageCellLabel(
  snap: UsageSnapshot | null | undefined,
  scope: UsageScope = 'week',
  withScope = false,
  now: Date = new Date(),
): string {
  if (!snap || isNoDataSnap(snap)) return '—'
  if (scope === 'session' && snap.sessionLimitUnavailable) return 'N/A'
  const pct = usagePctFor(snap, scope, now)
  if (pct == null) return '—'
  const shown = pctText(pct)
  return withScope ? `${shown} ${scope === 'session' ? '5h' : 'wk'}` : shown
}

/** "42%", or "Limit" at or past 100%. Anthropic reports a window over 100% once it is spent
 *  (measured 2026-09-30: 101-106% on four Pro accounts) because requests already running when the
 *  limit hit still count; "104%" read as a bug (owner, 2026-09-30). `pctDetail` keeps the number. */
export function pctText(pct: number): string {
  return pct >= 100 ? 'Limit' : `${pct}%`
}
export function pctDetail(pct: number): string {
  return pct >= 100 ? `Limit reached (${pct}% used)` : `${pct}%`
}

/** "3m ago" style relative time for a snapshot's `capturedAt`, English fallback (see
 *  lib/relativeTime.ts, the shared LunarWerx formatter). Used for the popover's
 *  "checked <x> ago" line. */
export function usageCheckedAgo(capturedAt: string, now: Date = new Date()): string {
  const ms = Date.parse(capturedAt)
  if (!Number.isFinite(ms)) return '—'
  return formatAgo(now.getTime(), ms)
}

const moneyFormats = new Map<string, Intl.NumberFormat>()

/** "$246.11"; "—" for an amount claude.ai did not report (never "$0.00", which is a claim). The
 *  currency code comes from claude.ai, and Intl throws on one it does not know; a table row must
 *  never die of that. */
export function formatMoney(
  amount: number | null | undefined,
  currency: string | null = 'USD',
): string {
  if (amount == null) return '—'
  try {
    const code = currency ?? 'USD'
    let fmt = moneyFormats.get(code)
    if (!fmt) {
      fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: code })
      moneyFormats.set(code, fmt)
    }
    return fmt.format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

/** "Nov 5": the day a credit or banked reset ends. */
export function shortDate(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : Number.NaN
  return Number.isNaN(ms)
    ? '—'
    : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Whether the account bills usage past its limits instead of stopping (claude.ai "extra usage"):
 *  the usage endpoint's reading, or the running desktop app's usage credits. */
export function billsPastLimit(snap: UsageSnapshot | null | undefined): boolean {
  return snap?.extraUsage === true || snap?.claudeApp?.usageCredits?.enabled === true
}

/** The Code credit worth a row icon: spendable money left, or one held back or never claimed
 *  (both are money the account is not getting). A spent-out credit is not news. */
export function flaggedCodeCredit(snap: UsageSnapshot | null | undefined): ClaudeCodeCredit | null {
  const credit = snap?.claudeApp?.codeCredit
  if (!credit) return null
  return credit.state !== 'active' || (credit.remainingUsd ?? 0) >= 1 ? credit : null
}

/** A snapshot older than this is flagged as stale in the UI (a subtle affordance, not
 *  a hard error; the number itself is still the last known reading). */
const STALE_AFTER_MS = 30 * 60 * 1000

export function isStaleSnap(snap: UsageSnapshot | null | undefined): boolean {
  if (!snap) return false
  // A signed-out account's kept reading is old by definition, whatever its age.
  if (snap.signedOutAt) return true
  const ms = Date.parse(snap.capturedAt)
  if (!Number.isFinite(ms)) return false
  return Date.now() - ms > STALE_AFTER_MS
}

/** i18n key (in the shared `instances` namespace, same one UsageBadge already uses for every
 *  usage string regardless of which table renders it) for the message explaining WHY a
 *  no-data reading came back. Returns null for 'ok' (real data, no explanation needed); falls
 *  back to the existing "not checked yet" copy for 'unknown' / undefined (never checked). */
export function usageReasonMessageKey(reason: UsageReason | undefined): string | null {
  switch (reason) {
    case 'logged_out':
      return 'instances.usageReasonLoggedOut'
    case 'no_token':
      return 'instances.usageReasonNoToken'
    case 'not_logged_in':
      return 'instances.usageReasonNotLoggedIn'
    case 'check_failed':
      return 'instances.usageReasonCheckFailed'
    case 'stale_token_app_closed':
      return 'instances.usageReasonAppClosed'
    case 'rate_limited':
      return 'instances.usageReasonRateLimited'
    case 'ok':
      return null
    default:
      return 'instances.usageNotChecked'
  }
}

// ---- One quota-window rule -------------------------------------------------------------------
// The API reports when a window ENDS (`resetsAt`), never when it started. Everything that needs a
// window's start, or to know whether a reading still describes a live window, goes through these.

export type WindowKind = '5h' | 'week'

/** Length of a window of this kind. */
export function windowLengthMs(kind: WindowKind): number {
  return kind === '5h' ? SESSION_WINDOW_MS : WEEK_WINDOW_MS
}

/** The reset instant (ms) of a window, or null when `resetsAt` is missing or unparseable. */
export function windowResetMs(resetsAt: string | null | undefined): number | null {
  return msUntilReset({ pct: 0, resets: '', resetsAt }, new Date(0))
}

/** When the window began: its reset instant minus its length; null without a usable reset. */
export function windowStartMs(
  resetsAt: string | null | undefined,
  kind: WindowKind,
): number | null {
  const reset = windowResetMs(resetsAt)
  return reset === null ? null : reset - windowLengthMs(kind)
}

/** True when the reset instant has passed (at or before `nowMs`); false when it is missing. */
export function windowHasReset(resetsAt: string | null | undefined, nowMs: number): boolean {
  const reset = windowResetMs(resetsAt)
  return reset !== null && reset <= nowMs
}

/** The % used to show: 0 once the window has reset (the stored % describes the ended window),
 *  else the stored % clamped to 0-100; null with no reading. */
export function windowUsedPct(
  limit: { pct: number; resetsAt?: string | null } | null | undefined,
  nowMs: number,
): number | null {
  if (!limit) return null
  if (windowHasReset(limit.resetsAt, nowMs)) return 0
  return Math.min(100, Math.max(0, limit.pct))
}
