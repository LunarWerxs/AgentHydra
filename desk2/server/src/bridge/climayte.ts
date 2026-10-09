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
export function firstLine(s: string | null | undefined): string | null {
  // Walks the lines instead of splitting the whole task: a worker's prompt can run to many KB and this is
  // mapped for every worker on every poll.
  const text = s ?? ''
  for (let from = 0; from <= text.length; ) {
    const nl = text.indexOf('\n', from)
    const end = nl < 0 ? text.length : nl
    const line = text.slice(from, end).trim()
    if (line) return line.slice(0, 300)
    if (nl < 0) break
    from = nl + 1
  }
  return null
}

/** '#68' from AgentHydra's '#68 name' (the name is often the login's email, kept out of the label). */
export function workerAccountLabel(w: Pick<AhWorker, 'account'>): string | null {
  if (!w.account) return null
  const m = /^#\d+/.exec(w.account)
  return m ? m[0] : w.account
}

type WaveMember = { id: string; kind?: string | null; wave?: string | null }

/** Each wave's manager (its worker of kind 'manage'), by wave id, among one PC's workers. */
function waveManagers<T extends WaveMember>(list: Iterable<T>): Map<string, T> {
  const out = new Map<string, T>()
  for (const w of list) if (w.kind === 'manage' && w.wave) out.set(w.wave, w)
  return out
}

/**
 * The manager a wave's task answers to. AgentHydra dispatches a wave's tasks with no origin, only their
 * `wave`, so without this they sit under no chat (owner, 2026-10-04: "I was hoping you'd stick the
 * climayte chats as sub items in the HD2 sidebar. Under the chat which spawned them").
 */
function managerOf<T extends WaveMember>(w: WaveMember, managers: ReadonlyMap<string, T>): T | undefined {
  if (!w.wave || w.kind === 'manage') return undefined
  const m = managers.get(w.wave)
  return m && m.id !== w.id ? m : undefined
}

/**
 * One worker. `originSessionId` is the dispatching chat's session: AgentHydra stores it as
 * `origin: { kind: 'chat', sessionId }`; a worker dispatched by another worker takes that worker's
 * session (looked up in `all`), so its chat's count still finds it through the chain. A wave's task,
 * which has no origin, is dispatched by its wave's manager (`managers`, from waveManagers): the
 * sidebar nests it under the manager and the chat's count finds it, both from here.
 */
export function mapWorker(w: AhWorker, all: ReadonlyMap<string, AhWorker>, managers: ReadonlyMap<string, AhWorker>): CliMayteWorker {
  let originSessionId: string | null = null
  let originWorkerId: string | null = null
  if (w.origin?.kind === 'chat') originSessionId = w.origin.sessionId
  else originWorkerId = w.origin?.kind === 'worker' ? w.origin.workerId : (managerOf(w, managers)?.id ?? null)
  if (originWorkerId) originSessionId = all.get(originWorkerId)?.sessionId ?? null
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
    originWorkerId,
    sessions: w.sessions ?? [],
    startedAt: w.createdAt ?? null,
    endedAt: active ? null : (w.updatedAt ?? null),
    lastActivityAt: w.updatedAt ?? null,
    lastActivity: w.lastActivity ?? null,
    usedPct: w.used?.pct ?? null,
    tokens: tokenTotal(w.tokens),
    verdict: w.verdicts?.at(-1)?.verdict ?? null,
    error: w.error ?? null,
    eta: w.eta ? { minutes: w.eta.minutes, at: w.eta.at, tookS: w.eta.tookS ?? null } : null,
  }
}

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]))
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/**
 * The list a poll mapped, with each worker that is unchanged since `prev` replaced by the very object of `prev`,
 * and `prev` itself when nothing at all changed. Every poll maps the whole list afresh; the same objects let what
 * is derived from the list (the chats' matching) be kept for as long as the list is the same.
 */
export function reuseWorkers(prev: readonly CliMayteWorker[] | undefined, next: CliMayteWorker[]): CliMayteWorker[] {
  if (!prev?.length) return next
  const before = new Map(prev.map((w) => [w.id, w]))
  const out = next.map((w) => {
    const old = before.get(w.id)
    return old && sameValue(old, w) ? old : w
  })
  return out.length === prev.length && out.every((w, i) => w === prev[i]) ? (prev as CliMayteWorker[]) : out
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

/**
 * What this PC's list lacks to place its running workers under the chat that started their chain: the
 * dispatchers a running worker's chain names by id that `raw` has not, and the waves whose running task has
 * no manager in it. A manager waits, active, while its wave runs, so it goes missing only once it failed or
 * was cancelled and AgentHydra's recent-finished window dropped it.
 */
export function missingAncestors(raw: readonly AhWorker[]): { ids: string[]; waves: string[] } {
  const byId = new Map(raw.map((w) => [w.id, w]))
  const managers = waveManagers(raw)
  const ids = new Set<string>()
  const waves = new Set<string>()
  const seen = new Set<string>()
  for (const w of raw) {
    if (!isActiveWorkerStatus(w.status)) continue
    let cur: AhWorker | undefined = w
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      let up: AhWorker | undefined
      if (cur.origin?.kind === 'worker') {
        up = byId.get(cur.origin.workerId)
        if (!up) ids.add(cur.origin.workerId)
      } else if (!cur.origin && cur.wave && cur.kind !== 'manage') {
        up = managers.get(cur.wave)
        if (!up) waves.add(cur.wave)
      }
      cur = up
    }
  }
  return { ids: [...ids], waves: [...waves] }
}

export function mapWorkers(raw: AhWorker[]): CliMayteWorker[] {
  const byId = new Map(raw.map((w) => [w.id, w]))
  const managers = waveManagers(raw)
  return raw.map((w) => mapWorker(w, byId, managers)).sort(byRecency)
}

/**
 * One worker of another PC (`pc`: that PC's name). AgentHydra shares no path for it, only its folder's last
 * name (`folder`, which files its chat in the sidebar), so it opens on CliMayte's tab; its account is '#<num>' and never the login's name (often an email). Its session and
 * origin are its own PC's ids (absent from an older AgentHydra): it sits under the chat that spawned it,
 * which the chat sync brings here with the same session id, or under a worker of its own PC; a wave's
 * task goes under that PC's manager of the wave (`managers`, from waveManagers), as this PC's do.
 */
export function mapRemoteWorker(w: AhRemoteWorker, pc: string, managers: ReadonlyMap<string, AhRemoteWorker>): CliMayteWorker {
  const active = isActiveWorkerStatus(w.status)
  const num = w.account?.num
  const manager = w.originSessionId || w.originWorkerId ? undefined : managerOf(w, managers)
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
    sessionId: w.sessionId ?? null,
    originSessionId: w.originSessionId ?? manager?.sessionId ?? null,
    originWorkerId: w.originWorkerId ?? manager?.id ?? null,
    sessions: w.sessions ?? [],
    folder: w.folder ?? null,
    originTitle: manager ? null : (w.originTitle ?? null),
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
 * left out: its last snapshot would show its tasks running for as long as it stays away. A wave's managers
 * are found among each PC's whole list, before the finished ones are cut, and a finished worker an active one
 * hangs from (its dispatcher, that one's, and so on) is never cut: the sidebar places the active one through it.
 */
export function mapRemote(answer: AhRemoteQueues | null | undefined, o: { all?: boolean } = {}): CliMayteWorker[] {
  if (!answer?.enabled || !Array.isArray(answer.pcs)) return []
  const held = new Set<CliMayteWorker>()
  const list = answer.pcs.flatMap((p) => {
    if (p.stale || !Array.isArray(p.workers)) return []
    const managers = waveManagers(p.workers)
    const mapped = p.workers.map((w) => mapRemoteWorker(w, p.name || 'another PC', managers))
    // Ids repeat only across PCs, so each PC's chains are walked within it.
    const byId = new Map(mapped.map((w) => [w.id, w]))
    const upOf = (w: CliMayteWorker) => (w.originWorkerId ? byId.get(w.originWorkerId) : undefined)
    for (const w of mapped) if (w.active) for (let up = upOf(w); up && !held.has(up); up = upOf(up)) held.add(up)
    return mapped
  })
  if (o.all) return list.sort(byRecency)
  const finished = list.filter((w) => !w.active && !held.has(w)).sort(byRecency)
  return [...list.filter((w) => w.active || held.has(w)), ...finished.slice(0, RECENT_FINISHED)].sort(byRecency)
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
  const { workers, byId, byOriginSession, byOriginWorker } = workerIndexOf(all)
  const own = chat.workerId ? byId.get(chat.workerId) : undefined
  const sessions = new Set<string>()
  for (const s of [chat.sessionId, own?.sessionId, ...(own?.sessions ?? [])]) if (s) sessions.add(s)
  const known = new Set(chat.workerIds ?? [])
  // Walks out from what ties a worker to the chat instead of testing every worker: its origin session, a worker
  // matched before, the chat's own worker as origin, then whatever those dispatched.
  const mine = new Set<string>()
  const queue: string[] = []
  const take = (id: string): void => {
    if (id === chat.workerId || mine.has(id)) return
    mine.add(id)
    queue.push(id)
  }
  for (const s of sessions) for (const id of byOriginSession.get(s) ?? []) take(id)
  for (const id of known) {
    if (byId.has(id)) take(id)
    // A worker matched before that the list dropped still brings the workers it dispatched.
    else for (const child of byOriginWorker.get(id) ?? []) take(child)
  }
  if (chat.workerId) for (const child of byOriginWorker.get(chat.workerId) ?? []) take(child)
  for (let i = 0; i < queue.length; i++) for (const child of byOriginWorker.get(queue[i]!) ?? []) take(child)
  return mine.size ? workers.filter((w) => mine.has(w.id)) : []
}

interface WorkerIndex {
  workers: CliMayteWorker[]
  byId: Map<string, CliMayteWorker>
  byOriginSession: Map<string, string[]>
  byOriginWorker: Map<string, string[]>
}

const indexes = new WeakMap<readonly CliMayteWorker[], WorkerIndex>()

/** This PC's workers of one list, by id and by what they were dispatched from: built once per list however many chats ask. */
function workerIndexOf(all: readonly CliMayteWorker[]): WorkerIndex {
  const hit = indexes.get(all)
  if (hit) return hit
  const workers = all.filter((w) => !w.pc)
  const byOriginSession = new Map<string, string[]>()
  const byOriginWorker = new Map<string, string[]>()
  const push = (m: Map<string, string[]>, key: string, id: string): void => {
    const list = m.get(key)
    if (list) list.push(id)
    else m.set(key, [id])
  }
  for (const w of workers) {
    if (w.originSessionId !== null) push(byOriginSession, w.originSessionId, w.id)
    if (w.originWorkerId) push(byOriginWorker, w.originWorkerId, w.id)
  }
  const index = { workers, byId: new Map(workers.map((w) => [w.id, w])), byOriginSession, byOriginWorker }
  indexes.set(all, index)
  return index
}
