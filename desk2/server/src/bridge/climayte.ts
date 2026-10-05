// CliMayte workers through AgentHydra (GET /api/corch/workers, POST /api/corch/cancel,
// POST /api/corch/workers/:id/send), and the other PCs' read-only ones (GET /api/corch/remote), mapped to
// the protocol's CliMayteWorker.

import type { CliMayteWorker } from '@shared/protocol'
import type { AhRemoteQueues, AhRemoteWorker, AhTokens, AhWorker } from './client'

/** How many finished workers the default list keeps beside every active one (SPEC REST row). */
export const RECENT_FINISHED = 20

const ACTIVE = new Set(['queued', 'running', 'waiting', 'checking'])

export const isActiveWorkerStatus = (s: string): boolean => ACTIVE.has(s)

/** Every token a worker's attempts were charged: input, output and both cache kinds. */
export const tokenTotal = (t: AhTokens | undefined): number | null =>
  t ? t.input + t.output + t.cacheRead + t.cacheWrite : null

/** The first non-empty line of a worker's task, at most 300 characters. */
export const firstLine = (s: string | null | undefined): string | null =>
  (s ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 300) ?? null

/** '#68' from AgentHydra's '#68 name' (the name is often the login's email, kept out of the label). */
export function workerAccountLabel(w: Pick<AhWorker, 'account'>): string | null {
  if (!w.account) return null
  const m = /^#\d+/.exec(w.account)
  return m ? m[0] : w.account
}

/**
 * One worker. `originSessionId` is the dispatching chat's session: AgentHydra stores it as
 * `origin: { kind: 'chat', sessionId }`; a worker dispatched by another worker takes that worker's
 * session (looked up in `all`), so its chat's count still finds it through the chain.
 */
export function mapWorker(w: AhWorker, all: ReadonlyMap<string, AhWorker>): CliMayteWorker {
  let originSessionId: string | null = null
  if (w.origin?.kind === 'chat') originSessionId = w.origin.sessionId
  else if (w.origin?.kind === 'worker') originSessionId = all.get(w.origin.workerId)?.sessionId ?? null
  const active = isActiveWorkerStatus(w.status)
  return {
    id: w.id,
    title: w.title,
    description: firstLine(w.prompt),
    group: w.group || null,
    status: w.status,
    active,
    account: workerAccountLabel(w),
    model: w.reportedModel ?? w.model ?? null,
    effort: w.effort ?? null,
    kind: w.kind ?? null,
    cwd: w.cwd || null,
    sessionId: w.sessionId ?? null,
    originSessionId,
    originWorkerId: w.origin?.kind === 'worker' ? w.origin.workerId : null,
    sessions: w.sessions ?? [],
    startedAt: w.createdAt ?? null,
    endedAt: active ? null : (w.updatedAt ?? null),
    lastActivityAt: w.updatedAt ?? null,
    lastActivity: w.lastActivity ?? null,
    usedPct: w.used?.pct ?? null,
    tokens: tokenTotal(w.tokens),
    verdict: w.verdicts?.at(-1)?.verdict ?? null,
    error: w.error ?? null,
  }
}

/** Active workers first (newest first), then finished ones by when they last changed. */
export const byRecency = (a: CliMayteWorker, b: CliMayteWorker): number =>
  a.active !== b.active
    ? a.active
      ? -1
      : 1
    : a.active
      ? (b.startedAt ?? 0) - (a.startedAt ?? 0)
      : (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)

export function mapWorkers(raw: AhWorker[]): CliMayteWorker[] {
  const byId = new Map(raw.map((w) => [w.id, w]))
  return raw.map((w) => mapWorker(w, byId)).sort(byRecency)
}

/**
 * One worker of another PC (`pc`: that PC's name). AgentHydra shares no folder, session or origin for it,
 * so it sits under no chat and opens on CliMayte's tab; its account is '#<num>' and never the login's
 * name (often an email).
 */
export function mapRemoteWorker(w: AhRemoteWorker, pc: string): CliMayteWorker {
  const active = isActiveWorkerStatus(w.status)
  const num = w.account?.num
  return {
    id: w.id,
    title: w.title,
    description: null,
    group: w.group || null,
    status: w.status,
    active,
    account: typeof num === 'number' ? `#${num}` : null,
    model: w.model ?? null,
    effort: w.effort ?? null,
    kind: w.kind ?? null,
    cwd: null,
    sessionId: null,
    originSessionId: null,
    originWorkerId: null,
    sessions: [],
    startedAt: w.createdAt ?? null,
    endedAt: active ? null : (w.updatedAt ?? null),
    lastActivityAt: w.updatedAt ?? null,
    lastActivity: w.lastActivity ?? null,
    usedPct: null,
    tokens: null,
    verdict: w.verdict ?? null,
    error: w.error ?? null,
    pc,
  }
}

/**
 * The other PCs' workers: every active one and, unless `all`, only the RECENT_FINISHED newest finished
 * ones, as this PC's list keeps (each PC shares its last day, which can be hundreds). Sharing off, or no
 * answer, is none. A stale PC (off, asleep or not syncing; AgentHydra counts its workers for nothing) is
 * left out: its last snapshot would show its tasks running for as long as it stays away.
 */
export function mapRemote(answer: AhRemoteQueues | null | undefined, o: { all?: boolean } = {}): CliMayteWorker[] {
  if (!answer?.enabled || !Array.isArray(answer.pcs)) return []
  const list = answer.pcs.flatMap((p) =>
    !p.stale && Array.isArray(p.workers) ? p.workers.map((w) => mapRemoteWorker(w, p.name || 'another PC')) : [],
  )
  const finished = list.filter((w) => !w.active).sort(byRecency)
  return [...list.filter((w) => w.active), ...(o.all ? finished : finished.slice(0, RECENT_FINISHED))].sort(byRecency)
}

/** The active workers a chat dispatched (by its Claude Code session id); never another PC's. */
export function activeFor(workers: CliMayteWorker[], originSessionId: string): CliMayteWorker[] {
  return workers.filter((w) => w.active && !w.pc && w.originSessionId === originSessionId)
}

/** What ties workers to a Desk chat: its current session, the worker it runs as, and the workers matched before. */
export interface ChatWorkerRef {
  sessionId: string | null
  workerId?: string | null
  workerIds?: readonly string[]
}

/**
 * The workers that belong to a chat, running and finished. A worker belongs when its origin session is ANY session the
 * chat has had (its sessionId, and for a worker-backed chat that worker's sessionId and every id in its `sessions`: a
 * handoff gives the worker a new session and keeps the old ones), when its origin is the chat's own worker, or when its
 * origin is a worker that (through any depth, cycle-safe) belongs. Workers already matched (`workerIds`) still count,
 * so a chain survives AgentHydra dropping a middle worker from its list. Another PC's workers never belong: their
 * ids may equal this PC's (the chat's matched `workerIds` among them).
 */
export function workersOfChat(all: readonly CliMayteWorker[], chat: ChatWorkerRef): CliMayteWorker[] {
  const workers = all.filter((w) => !w.pc)
  const byId = new Map(workers.map((w) => [w.id, w]))
  const own = chat.workerId ? byId.get(chat.workerId) : undefined
  const sessions = new Set<string>()
  for (const s of [chat.sessionId, own?.sessionId, ...(own?.sessions ?? [])]) if (s) sessions.add(s)
  const known = new Set(chat.workerIds ?? [])
  const memo = new Map<string, boolean>()
  const belongs = (w: CliMayteWorker, path: Set<string>): boolean => {
    if (w.id === chat.workerId) return false
    const hit = memo.get(w.id)
    if (hit !== undefined) return hit
    if (path.has(w.id)) return false
    path.add(w.id)
    let yes = known.has(w.id) || (w.originSessionId !== null && sessions.has(w.originSessionId))
    if (!yes && w.originWorkerId) {
      const parent = byId.get(w.originWorkerId)
      yes = w.originWorkerId === chat.workerId || (parent ? belongs(parent, path) : known.has(w.originWorkerId))
    }
    path.delete(w.id)
    memo.set(w.id, yes)
    return yes
  }
  return workers.filter((w) => belongs(w, new Set()))
}
