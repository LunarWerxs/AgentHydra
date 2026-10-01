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
): UsageLimit | null {
  if (pct === null) return previous
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
): UsageSnapshot | null {
  if (!live) return snap
  if (snap && live.at <= (Date.parse(snap.capturedAt) || 0)) return snap
  return {
    ...(snap ?? { account, weekModel: null }),
    session: limitFrom(live.sessionPct, live.sessionResetsAt, snap?.session ?? null),
    weekAll: limitFrom(live.weekPct, live.weekResetsAt, snap?.weekAll ?? null),
    capturedAt: new Date(live.at).toISOString(),
  } as UsageSnapshot
}
