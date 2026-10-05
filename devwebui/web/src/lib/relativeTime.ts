/**
 * Shared "time ago" formatting for all LunarWerx apps.
 *
 * `formatAgo(nowMs, ts, t?)` buckets an elapsed duration to seconds / minutes /
 * hours / days. Pass the caller's clock as `nowMs` (callers own "now", testable
 * and stable within a render pass) and the target timestamp as `ts`. Optionally
 * pass an i18n translator `t(key, { n })` using the keys `time.secondsAgo` /
 * `time.minutesAgo` / `time.hoursAgo` / `time.daysAgo`; when omitted it falls
 * back to plain English ("12s ago"). Buckets round (not floor) at each boundary.
 */
export type RelativeTimeT = (key: string, params: { n: number }) => string;

export function formatAgo(nowMs: number, ts: number, t?: RelativeTimeT): string {
  const s = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (s < 60) return t ? t("time.secondsAgo", { n: s }) : `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return t ? t("time.minutesAgo", { n: m }) : `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return t ? t("time.hoursAgo", { n: h }) : `${h}h ago`;
  const d = Math.round(h / 24);
  return t ? t("time.daysAgo", { n: d }) : `${d}d ago`;
}

/**
 * Coarser variant for notification-style timestamps: "just now" under 10s,
 * rounded to the nearest 10s under a minute, then delegates to `formatAgo`. The
 * sub-minute labels are English-only (callers needing localised sub-minute copy
 * should add keys and branch here).
 */
export function formatAgoCoarse(nowMs: number, ts: number, t?: RelativeTimeT): string {
  const s = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${Math.floor(s / 10) * 10}s ago`;
  return formatAgo(nowMs, ts, t);
}
