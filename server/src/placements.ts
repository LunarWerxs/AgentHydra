// server/src/placements.ts - the placement ledger, which is what makes load balancing real
// rather than aspirational.
//
// THE BUG THIS EXISTS FOR. The routing table (buildInstanceRows) is a pure function of the
// usage cache, and the usage cache refreshes on the order of a minute. So every placement
// decision taken inside that window sees byte-identical numbers and therefore picks the
// SAME top row. The reviewer's rubric has always said "spread across the top eligible rows
// round-robin, never stack one account", but round-robin is not something a stateless sort
// can do: nothing in the system remembered that it had just placed work somewhere. Land four
// handoffs in one wake and all four went to one account, which is precisely the stacking the
// rubric forbids (owner report 2026-08-26: "do your best to not blow over that by moving all
// of them into a single account").
//
// So a placement is now WRITTEN DOWN. The ledger is the memory the sort was missing: an
// account that just received work sinks below its equally-loaded peers until the usage
// numbers catch up and speak for themselves. It is deliberately a weak signal - it only ever
// reorders accounts that are already in the same load tier, and it never promotes a hot
// account over a cold one. Balancing must not override headroom; it only breaks ties that
// headroom cannot see yet.

import { db } from './db'

/** How a placement was made. Recorded for the audit trail, not used in the ranking. */
export type PlacementKind = 'seed' | 'terminal' | 'migrate' | 'queue' | 'manual'

export interface PlacementRow {
  instanceRef: string
  sessionId: string | null
  kind: PlacementKind
  at: string
}

/** Instance refs are 'desktop:<dir>' and the dir's casing and trailing slash vary by caller
 *  (the registry, the app's own config, a hand-typed API body). Every read and write of this
 *  ledger goes through one normalizer so a placement recorded by the monitor is seen by the
 *  reviewer's next lookup. Same rule the migration-target filter already applies inline. */
export function normalizeRef(ref: string | null | undefined): string | null {
  const t = ref?.trim()
  if (!t) return null
  return t.replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * Record that work was placed on an instance. Called from the PRIMITIVES (seed a desktop chat,
 * launch a terminal, migrate a chat) rather than from the callers of those primitives, so a
 * placement counts no matter who made it: the monitor, the reviewer, or the owner clicking
 * Migrate in the app. A ledger that only the polite callers write to would balance against a
 * fiction.
 */
export function recordPlacement(
  instanceRef: string | null | undefined,
  kind: PlacementKind,
  sessionId?: string | null,
  nowMs: number = Date.now(),
): void {
  const ref = normalizeRef(instanceRef)
  if (!ref) return
  try {
    db.query(
      'insert into orchestrator_placements (instance_ref, session_id, kind, at) values (?, ?, ?, ?)',
    ).run(ref, sessionId ?? null, kind, new Date(nowMs).toISOString())
  } catch (err) {
    // A placement that cannot be recorded must never break the placement itself. Losing one
    // row degrades the balancing to what it was before this file existed; failing the seed
    // loses the work.
    console.error('[agenthydra] placement ledger write failed:', err)
  }
}

/** Placements per instance ref within the balancing window, keyed by normalized ref. */
export function recentPlacements(
  windowMins: number,
  nowMs: number = Date.now(),
): Record<string, number> {
  const since = new Date(nowMs - windowMins * 60_000).toISOString()
  const out: Record<string, number> = {}
  try {
    const rows = db
      .query<{ instance_ref: string; n: number }, [string]>(
        'select instance_ref, count(*) as n from orchestrator_placements where at >= ? group by instance_ref',
      )
      .all(since)
    for (const r of rows) out[r.instance_ref] = r.n
  } catch (err) {
    console.error('[agenthydra] placement ledger read failed:', err)
  }
  return out
}

/** The last few placements, newest first - the audit trail the feed shows so a balancing
 *  decision can be argued with rather than merely trusted. */
export function listRecentPlacements(limit = 20, nowMs: number = Date.now()): PlacementRow[] {
  const since = new Date(nowMs - 7 * 24 * 3600 * 1000).toISOString()
  try {
    return db
      .query<
        { instance_ref: string; session_id: string | null; kind: string; at: string },
        [string, number]
      >(
        'select instance_ref, session_id, kind, at from orchestrator_placements where at >= ? order by at desc limit ?',
      )
      .all(since, limit)
      .map((r) => ({
        instanceRef: r.instance_ref,
        sessionId: r.session_id,
        kind: r.kind as PlacementKind,
        at: r.at,
      }))
  } catch {
    return []
  }
}

/** Drop rows older than 14 days, matching how decided proposals are pruned. Called from the
 *  same housekeeping pass, so the ledger cannot grow without bound on a long-lived machine. */
export function prunePlacements(nowMs: number = Date.now()): number {
  const cutoff = new Date(nowMs - 14 * 24 * 3600 * 1000).toISOString()
  try {
    const before = db
      .query<{ n: number }, []>('select count(*) as n from orchestrator_placements')
      .get()?.n
    db.query('delete from orchestrator_placements where at < ?').run(cutoff)
    const after = db
      .query<{ n: number }, []>('select count(*) as n from orchestrator_placements')
      .get()?.n
    return (before ?? 0) - (after ?? 0)
  } catch {
    return 0
  }
}
