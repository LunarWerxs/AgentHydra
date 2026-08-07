// Usage-check helpers: pure formatting/derivation over a UsageSnapshot, mirroring
// format.ts's StatusMeta / Badge-variant pattern. See server/src/usage.ts for how a
// snapshot is parsed from `claude -p "/usage"` output, and server/src/usage-service.ts /
// server/src/index.ts for the cache keys (`acct:<id>`, `cli:<id>`) each check lands under.
import type { UsageSnapshot } from './api'
import { formatAgo } from './relativeTime'
import { isWindowSuperseded } from './usage-reset'

/** Mirrors server's `UsageReason` (see server/src/types.ts). Not re-exported from lib/api.ts,
 *  so this is the single local source other modules (useUsage.ts, UsageBadge.vue, and the two
 *  usage-table views) import from rather than each declaring their own copy. */
export type UsageReason =
  | 'ok'
  | 'logged_out'
  | 'no_token'
  | 'not_logged_in'
  | 'check_failed'
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
  if (isWindowSuperseded(limit, now)) return null
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
  const pct = usagePctFor(snap, scope, now)
  if (pct == null) return '—'
  return withScope ? `${pct}% ${scope === 'session' ? '5h' : 'wk'}` : `${pct}%`
}

/** "3m ago" style relative time for a snapshot's `capturedAt`, English fallback (see
 *  lib/relativeTime.ts, the shared LunarWerx formatter). Used for the popover's
 *  "checked <x> ago" line. */
export function usageCheckedAgo(capturedAt: string): string {
  const ms = Date.parse(capturedAt)
  if (!Number.isFinite(ms)) return '—'
  return formatAgo(Date.now(), ms)
}

/** A snapshot older than this is flagged as stale in the UI (a subtle affordance, not
 *  a hard error; the number itself is still the last known reading). */
const STALE_AFTER_MS = 30 * 60 * 1000

export function isStaleSnap(snap: UsageSnapshot | null | undefined): boolean {
  if (!snap) return false
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
    case 'ok':
      return null
    default:
      return 'instances.usageNotChecked'
  }
}
