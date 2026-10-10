// server/src/climayte-remote.ts — what the owner's OTHER PC's CliMayte is doing, as that PC last
// shared it (core/climayte-queue-sync.ts). Held in memory only: nothing here is ever written into this
// PC's workers.json, and this PC never cancels, sends to or judges these workers. Placement reads it
// for two things, so the two PCs do not step on each other: the workers the other PC has running on an
// account count toward that account's cap here, and a usage reading the other PC took after this
// PC's own counts as the newer one.
//
// Account ids are the same on both PCs: login sync keeps a CLI instance under one id.

import type { CliMayteLiveUsage } from './climayte-lib'
import type { AccountPlacement } from './types'

/** A PC not seen for this long is stale: it is off, or not syncing. Seen is the newer of its snapshot's
 *  `at` and when the store's Worker last saw it poll the changes feed (x-seen, noteSeen). A live PC
 *  polls at least every IDLE_MAX_MS (5 min, core/login-sync-pace.ts), the Worker may lose up to 3
 *  minutes of stamps when it is evicted, and this PC reads them on its own next poll, so 20 minutes
 *  leaves room for a missed poll before a live PC reads as offline. Its queue is not re-uploaded just
 *  to say it is alive. */
export const REMOTE_STALE_MS = 20 * 60_000

/** A folder's last name, never its path ("AgentHydra" for D:/x/AgentHydra): all one PC shares of where its
 *  work runs, so the other PC's Hydra Desk files a chat it does not have under that folder's group (owner,
 *  2026-10-06, choosing it over a "No folder" group). Null for none. */
export function folderName(path: string | null | undefined): string | null {
  const parts = (path ?? '').split(/[\\/]+/).filter(Boolean)
  const name = parts[parts.length - 1]
  return name ? name.slice(0, 120) : null
}

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
  /** Its session, who dispatched it (the chat's session, or the worker and that worker's session
   *  when this PC knows it) and its wave: enough for the other PC's Hydra Desk to draw it under the
   *  chat or the manager that spawned it (owner, 2026-10-04: "I was hoping you'd stick the climayte
   *  chats as sub items in the HD2 sidebar. Under the chat which spawned them"). Never the origin's
   *  Claude home or transcript path. Absent from an older AgentHydra's snapshot. */
  sessionId?: string | null
  originSessionId?: string | null
  originWorkerId?: string | null
  wave?: string | null
  /** The worker's earlier session ids, oldest first (ids only; empty when none): a task dispatched from
   *  an older session still matches its worker. Absent from an older AgentHydra's snapshot. */
  sessions?: string[]
  /** The dispatching chat's title as this PC's session list shows it (trimmed, at most 120 characters;
   *  null when unknown or when a worker dispatched it), for a PC that does not list that chat. Never
   *  the origin's Claude home or transcript path. */
  originTitle?: string | null
  /** The last name of the folder it runs in (folderName), never the path. Absent from an older
   *  AgentHydra's snapshot. */
  folder?: string | null
}

/** One HSwarm job as the other PC shows it: never the job's dir, cwd, prompts or caller key string. */
export interface RemoteSwarmJob {
  id: string
  label: string
  state: string
  tasks: number
  /** Task counts by status (ok, done, failed, error, timeout, cancelled), only those present. */
  counts: Record<string, number>
  /** ISO times as HSwarm gives them; finished is null while the job runs. */
  created: string | null
  finished: string | null
  /** The chat that started the job (HSwarm's caller_ids), null when HSwarm did not say. */
  callerSessionId: string | null
  callerChatId: string | null
  /** The last name of the caller's folder (folderName), never the path. Absent from an older
   *  AgentHydra's snapshot, and null when HSwarm's jobs list does not give it. */
  folder?: string | null
}

/** This PC's newest live reading of one account, as shared. */
export interface RemoteLive {
  sessionPct: number | null
  weekPct: number | null
  at: number
}

/** The AgentHydra build a PC runs: package version, short commit sha and the commit's ISO date. */
export interface QueueBuild {
  version: string
  commit: string | null
  date: string | null
}

/** What one PC shares: its queue and its live readings, as of `at`. `build` is absent from every
 *  snapshot an older AgentHydra uploaded. */
export interface QueueSnapshot {
  pc: string
  name: string
  at: number
  workers: RemoteWorker[]
  live: Record<string, RemoteLive>
  build?: QueueBuild | null
  /** This PC's HSwarm jobs: every running one and the newest finished. Absent from an older
   *  AgentHydra's snapshot (read as none). */
  jobs?: RemoteSwarmJob[]
  /** The owner's priority and caps per account id (AccountPlacement), as that PC holds them; the newer
   *  `updatedAt` wins on every PC (core/cli-instances.ts adoptCliInstancePlacements). Absent from an
   *  older AgentHydra's snapshot. */
  prefs?: Record<string, AccountPlacement>
}

/** A PC whose commit is older than this one's by more than this reads as behind. */
export const BEHIND_MS = 60 * 60_000

// The note around the date is an English sentence, so its month is named in English too.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const fmtDate = (iso: string): string => {
  const d = new Date(iso)
  const mon = MONTHS[d.getUTCMonth()]
  const p = (n: number) => String(n).padStart(2, '0')
  return `${mon} ${d.getUTCDate()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

/** Whether the other PC runs an older (or newer) AgentHydra than this one, and the one line saying so. */
export function buildStatus(
  name: string,
  theirs: QueueBuild | null | undefined,
  mine: QueueBuild | null,
): { build: QueueBuild | null; behind: boolean; behindNote: string | null } {
  const build = theirs ?? null
  const label = build
    ? `${build.commit ?? `v${build.version}`}${build.date ? `, ${fmtDate(build.date)}` : ''}`
    : ''
  if (!build)
    return {
      build: null,
      behind: true,
      behindNote: `${name} runs an older AgentHydra. Update it there in Settings.`,
    }
  const t = build.date ? Date.parse(build.date) : Number.NaN
  const m = mine?.date ? Date.parse(mine.date) : Number.NaN
  if (Number.isNaN(t) || Number.isNaN(m)) return { build, behind: false, behindNote: null }
  if (m - t > BEHIND_MS)
    return {
      build,
      behind: true,
      behindNote: `${name} runs an older AgentHydra (${label}). Update it there in Settings.`,
    }
  if (t - m > BEHIND_MS)
    return {
      build,
      behind: false,
      behindNote: `This PC is behind ${name} (${label}). Update it in Settings.`,
    }
  return { build, behind: false, behindNote: null }
}

const remote = new Map<string, { version: number; snap: QueueSnapshot }>()
const seenAt = new Map<string, number>()

/** When the store last saw each other PC poll (epoch ms, from the changes feed's x-seen). */
export function noteSeen(seen: Record<string, number>): void {
  for (const [pc, at] of Object.entries(seen))
    if (Number.isFinite(at)) seenAt.set(pc, Math.max(seenAt.get(pc) ?? 0, at))
}

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
  seenAt.clear()
}

export const isStale = (snap: QueueSnapshot, now: number): boolean =>
  now - Math.max(snap.at, seenAt.get(snap.pc) ?? 0) > REMOTE_STALE_MS

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
