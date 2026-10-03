// server/src/climayte-remote.ts — what the owner's OTHER PC's CliMayte is doing, as that PC last
// shared it (core/climayte-queue-sync.ts). Held in memory only: nothing here is ever written into this
// PC's workers.json, and this PC never cancels, sends to or judges these workers. Placement reads it
// for two things, so the two PCs do not step on each other: the workers the other PC has running on an
// account count toward that account's cap here, and a usage reading the other PC took after this
// PC's own counts as the newer one.
//
// Account ids are the same on both PCs: login sync keeps a CLI instance under one id.

import type { CliMayteLiveUsage } from './climayte-lib'

/** A snapshot older than this is stale: that PC is off, or not syncing. A live PC uploads at least
 *  every HEARTBEAT_MS (15 min, core/climayte-queue-sync.ts) and the other PC sees it one sync pass
 *  later, so 40 minutes leaves room for two missed heartbeats before a live PC reads as offline. */
export const REMOTE_STALE_MS = 40 * 60_000

/** One worker as the other PC shows it: never the prompt, results, logs or paths. */
export interface RemoteWorker {
  id: string
  title: string
  group: string
  status: string
  kind: string | null
  model: string | null
  effort: string | null
  account: { id: string; num: number | null; name: string } | null
  createdAt: number
  updatedAt: number
  /** Seconds its sessions actually ran (the CliMayte view's active time). */
  activeS: number
  costUsd: number
  lastActivity: string | null
  error: string | null
  verdict: 'pass' | 'fail' | null
}

/** This PC's newest live reading of one account, as shared. */
export interface RemoteLive {
  sessionPct: number | null
  weekPct: number | null
  at: number
}

/** What one PC shares: its queue and its live readings, as of `at`. */
export interface QueueSnapshot {
  pc: string
  name: string
  at: number
  workers: RemoteWorker[]
  live: Record<string, RemoteLive>
}

const remote = new Map<string, { version: number; snap: QueueSnapshot }>()

export function remoteVersion(pc: string): number | undefined {
  return remote.get(pc)?.version
}

export function setRemote(snap: QueueSnapshot, version: number): void {
  remote.set(snap.pc, { version, snap })
}

/** Keep only the PCs the store still lists (every other PC's row, never this PC's own). */
export function keepRemote(pcs: Set<string>): void {
  for (const pc of remote.keys()) if (!pcs.has(pc)) remote.delete(pc)
}

export function clearRemote(): void {
  remote.clear()
}

export const isStale = (snap: QueueSnapshot, now: number): boolean =>
  now - snap.at > REMOTE_STALE_MS

/** Every other PC's snapshot, newest first, with whether it is stale. */
export function remoteSnapshots(now = Date.now()): Array<QueueSnapshot & { stale: boolean }> {
  return [...remote.values()]
    .map(({ snap }) => ({ ...snap, stale: isStale(snap, now) }))
    .sort((a, b) => b.at - a.at)
}

/** Workers the other PCs have running or checking, per account (stale snapshots count for nothing). */
export function remoteActiveCounts(now = Date.now()): Map<string, number> {
  const out = new Map<string, number>()
  for (const { snap } of remote.values()) {
    if (isStale(snap, now)) continue
    for (const w of snap.workers)
      if ((w.status === 'running' || w.status === 'checking') && w.account)
        out.set(w.account.id, (out.get(w.account.id) ?? 0) + 1)
  }
  return out
}

/** The account's newest live reading: another PC's when it was taken after `own`, else `own`. The
 *  other PC's carries its own `at` and no reset times, so it ages as it should. */
export function newestLive(
  accountId: string,
  own: CliMayteLiveUsage | null,
  now = Date.now(),
): CliMayteLiveUsage | null {
  let best = own
  for (const { snap } of remote.values()) {
    if (isStale(snap, now)) continue
    const r = snap.live[accountId]
    if (!r || typeof r.at !== 'number' || r.at <= (best?.at ?? 0)) continue
    best = {
      sessionPct: r.sessionPct,
      sessionResetsAt: null,
      weekPct: r.weekPct,
      weekResetsAt: null,
      overageAllowed: own?.overageAllowed ?? false,
      at: r.at,
    }
  }
  return best
}
