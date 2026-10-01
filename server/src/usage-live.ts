// server/src/usage-live.ts — the usage numbers the tables show, kept as fresh as Corch's workers.
//
// The usage sweep reads each account every 30 minutes (usage-refresh.ts, an owner ceiling), so a
// busy account's numbers can lag by most of half an hour. Found 2026-09-30: #84 read 34% in the
// CLI table while Corch's workers on it were streaming 85-88%, and a worker handing off "at 85%"
// looked like a bug when it was the table that was behind. Every running Corch worker's CLI streams
// its account's usage with each request (corch-lib liveUsage), so the routes that feed the tables
// lay those seconds-old readings over the cached snapshot. The cache itself keeps only real
// usage-endpoint readings.

import type { CorchLiveUsage } from './corch-lib'
import type { UsageLimit, UsageSnapshot } from './types'
import { formatResetLocal } from './usage-api'

function limitFrom(
  pct: number | null,
  resetsAtMs: number | null,
  previous: UsageLimit | null,
  now: number,
): UsageLimit | null {
  // A reading of a window that has since reset describes nothing now (it is kept on disk across
  // restarts, so an old 104% would otherwise outlive its window).
  if (pct === null || (resetsAtMs !== null && resetsAtMs <= now)) return previous
  const resetsAt = resetsAtMs ? new Date(resetsAtMs).toISOString() : (previous?.resetsAt ?? null)
  return {
    pct: Math.round(pct),
    resets: formatResetLocal(resetsAt),
    resetsAt,
    // The stream carries no severity; a reading this close to the line is what "critical" means.
    severity: pct >= 90 ? 'critical' : pct >= 75 ? 'warning' : 'normal',
  }
}

/** The snapshot with a newer live reading laid over its 5-hour and weekly windows, or the snapshot
 *  unchanged when the live reading is older (or there is none). */
export function withLiveReading(
  snap: UsageSnapshot | null,
  live: CorchLiveUsage | undefined,
  account: string | null = null,
  now = Date.now(),
): UsageSnapshot | null {
  if (!live) return snap
  if (snap && live.at <= (Date.parse(snap.capturedAt) || 0)) return snap
  return {
    ...(snap ?? { account, weekModel: null }),
    session: limitFrom(live.sessionPct, live.sessionResetsAt, snap?.session ?? null, now),
    weekAll: limitFrom(live.weekPct, live.weekResetsAt, snap?.weekAll ?? null, now),
    capturedAt: new Date(live.at).toISOString(),
  } as UsageSnapshot
}

/** The snapshot with a Corch limit wall laid over it: an account Corch saw hit its 5-hour (or
 *  weekly) limit shows that window at its limit, at least 100%, until the wall ends. Field note 19
 *  (2026-09-30): five accounts walled until 11:20pm-12:10am still read 43-50% from snapshots taken
 *  before they hit the limit, and the owner read "plenty left" next to "no account available". */
export function withLimitWall(
  snap: UsageSnapshot | null,
  wall: { until: number; weekly: boolean } | undefined,
  account: string | null = null,
  now = Date.now(),
): UsageSnapshot | null {
  if (!wall || wall.until <= now) return snap
  // The wall ends a minute after the reset (WALL_MARGIN_MS), so the reset shown is that minute earlier.
  const resetsAt = new Date(wall.until - 60_000).toISOString()
  const key = wall.weekly ? 'weekAll' : 'session'
  const prev = snap?.[key] ?? null
  return {
    ...(snap ?? { account, weekModel: null, session: null, weekAll: null }),
    [key]: {
      pct: Math.max(prev?.pct ?? 0, 100),
      resets: formatResetLocal(resetsAt),
      resetsAt,
      severity: 'critical',
    },
    capturedAt: snap?.capturedAt ?? new Date(now).toISOString(),
  } as UsageSnapshot
}
