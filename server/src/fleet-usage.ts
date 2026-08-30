// server/src/fleet-usage.ts - PIECE 2 of the orchestrator rebuild (owner-picked, 2026-08-29):
// per-account usage bands, observed deterministically from the existing usage cache.
//
// Same doctrine as fleet.ts: 100% programmatic, read-only, zero AI, zero network - this module
// never probes anything, it reads the cache that usage-refresh already keeps warm (~1/min while
// the app runs) and derives facts. Deriving is all it does: what to DO about a hot account is a
// later piece's judgment, not this one's.
//
// The bands are the fleet-wide vocabulary v1 proved out: ok < 80 <= elevated < 85 <= high
// < 90 <= critical. NAMED CONSTANTS, deliberately not settings - tuning knobs return only when
// a piece that ACTS on bands exists to need them (same reasoning the v1 breaker recorded).
//
// Staleness is a first-class fact, not a filter: the real cache on this machine carries entries
// captured weeks ago (instances nobody has opened since). Hiding them would make "no data" and
// "fine" look alike, which is the exact confusion a fleet view exists to prevent.

import type { UsageLimit, UsageSnapshot } from './types'
import { parseResetTime } from './usage'
import { allCachedUsage } from './usage-cache'

export type UsageBand = 'ok' | 'elevated' | 'high' | 'critical' | 'unknown'

const SOFT_PCT = 80
const WARN_PCT = 85
const HARD_PCT = 90
/** The owner's overflow line (2026-08-30, hard-coded at 85 by his word): load balancing may
 *  open a CLOSED instance only when every OPEN candidate has provably exceeded this on either
 *  the 5-hour or the weekly window. Deliberately the same number as the 'high' band boundary -
 *  one vocabulary, one place to change it when he says so. */
export const LANDING_OVERFLOW_PCT = WARN_PCT
/** A cache entry older than this is not being refreshed (the refresher runs ~1/min while its
 *  app is up), so its numbers describe some earlier week, not now. */
const STALE_MINS = 30

export function bandFor(pct: number | null): UsageBand {
  if (pct === null || !Number.isFinite(pct)) return 'unknown'
  if (pct < SOFT_PCT) return 'ok'
  if (pct < WARN_PCT) return 'elevated'
  if (pct < HARD_PCT) return 'high'
  return 'critical'
}

const BAND_RANK: Record<UsageBand, number> = {
  critical: 0,
  high: 1,
  elevated: 2,
  ok: 3,
  unknown: 4,
}

export interface FleetUsageEntry {
  /** The cache key, verbatim: 'desktop:<dir>' or 'cli:<id>'. */
  ref: string
  account: string | null
  weeklyPct: number | null
  weeklyBand: UsageBand
  weeklyResetsAt: string | null
  weeklyResetsInMins: number | null
  sessionPct: number | null
  sessionBand: UsageBand
  sessionResetsAt: string | null
  sessionResetsInMins: number | null
  capturedAt: string | null
  /** Minutes since the snapshot was captured; null when capturedAt is unparseable. */
  ageMins: number | null
  /** True when the entry is older than {@link STALE_MINS}: numbers from a window that may have
   *  reset since. Reported, never filtered. */
  stale: boolean
}

function pctOf(limit: UsageLimit | null | undefined): number | null {
  return typeof limit?.pct === 'number' && Number.isFinite(limit.pct) ? limit.pct : null
}

/** The ISO reset time of a limit: the API path's exact timestamp when present, else the parsed
 *  human string (parseResetTime - the same fallback the monitor trusts), else null. */
function resetIsoOf(limit: UsageLimit | null | undefined): string | null {
  if (!limit) return null
  if (typeof limit.resetsAt === 'string' && limit.resetsAt) return limit.resetsAt
  return limit.resets ? parseResetTime(limit.resets) : null
}

function minsUntil(iso: string | null, nowMs: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.round((t - nowMs) / 60_000)
}

export interface FleetUsageDeps {
  nowMs?: number
  /** Seam for tests; the default is the real cache read. */
  cache?: () => Record<string, UsageSnapshot>
}

/** Every cached account's usage, banded, worst first. Deterministic order: band severity, then
 *  weekly percent (desc), then ref - so two reads of the same cache always agree. */
export function fleetUsage(deps: FleetUsageDeps = {}): FleetUsageEntry[] {
  const nowMs = deps.nowMs ?? Date.now()
  const cache = (deps.cache ?? allCachedUsage)()
  const out: FleetUsageEntry[] = []
  for (const [ref, snap] of Object.entries(cache)) {
    const weeklyPct = pctOf(snap.weekAll)
    const sessionPct = pctOf(snap.session)
    const weeklyResetsAt = resetIsoOf(snap.weekAll)
    const sessionResetsAt = resetIsoOf(snap.session)
    const capturedAt = typeof snap.capturedAt === 'string' ? snap.capturedAt : null
    const capturedMs = capturedAt ? Date.parse(capturedAt) : Number.NaN
    const ageMins = Number.isFinite(capturedMs) ? Math.round((nowMs - capturedMs) / 60_000) : null
    out.push({
      ref,
      account: snap.account ?? null,
      weeklyPct,
      weeklyBand: bandFor(weeklyPct),
      weeklyResetsAt,
      weeklyResetsInMins: minsUntil(weeklyResetsAt, nowMs),
      sessionPct,
      sessionBand: bandFor(sessionPct),
      sessionResetsAt,
      sessionResetsInMins: minsUntil(sessionResetsAt, nowMs),
      capturedAt,
      ageMins,
      stale: ageMins === null || ageMins > STALE_MINS,
    })
  }
  out.sort(
    (a, b) =>
      BAND_RANK[a.weeklyBand] - BAND_RANK[b.weeklyBand] ||
      (b.weeklyPct ?? -1) - (a.weeklyPct ?? -1) ||
      a.ref.localeCompare(b.ref),
  )
  return out
}
