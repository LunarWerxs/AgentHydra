/**
 * Auto-update check cadence: bounds, default, and clamping.
 *
 * Split out of auto-update.ts so runtime.ts (which auto-update.ts depends on, via
 * updater.ts -> github-updater.ts -> runtime.ts) can read the cadence settings without
 * importing auto-update.ts back and creating a cycle. This module has no imports of its
 * own, so it cannot itself be part of one.
 */

/** Check cadence bounds (seconds): 15 min floor, 7 day ceiling, default 6 h. */
export const AUTO_UPDATE_INTERVAL_MIN_S = 900;
export const AUTO_UPDATE_INTERVAL_MAX_S = 604_800;
export const AUTO_UPDATE_INTERVAL_DEFAULT_S = 21_600;

/** Clamp a requested cadence into [MIN, MAX]; a non-finite value falls back to the default. */
export function clampAutoUpdateInterval(secs: number): number {
  if (!Number.isFinite(secs)) return AUTO_UPDATE_INTERVAL_DEFAULT_S;
  return Math.min(
    AUTO_UPDATE_INTERVAL_MAX_S,
    Math.max(AUTO_UPDATE_INTERVAL_MIN_S, Math.round(secs)),
  );
}

/** Update cooldown bounds (whole days): 0 = off, 90 ceiling so a typo cannot freeze updates for years. */
export const UPDATE_COOLDOWN_MAX_DAYS = 90;

/** Clamp a requested cooldown into [0, MAX] whole days; a non-finite value means off. */
export function clampUpdateCooldownDays(days: number): number {
  if (!Number.isFinite(days)) return 0;
  return Math.min(UPDATE_COOLDOWN_MAX_DAYS, Math.max(0, Math.round(days)));
}
