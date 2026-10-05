// Hydra Desk 2: CliMayte's running tasks under the session that handed them out, in the sidebar (the
// chrome bar's CliMayte button; Michael, 2026-10-04: "under each active thread, it shows with a little tab
// over in a very compact way, all of these CliMayte running tasks ... if they have a manager, they would
// tab once more and be under the manager"). Pure, so the window and the tests share it.
import { ref, watch } from 'vue'
import type { CliMayteWorker } from '@shared/protocol'

const KEY = 'hydra-desk.sidebar.tasks'
const storage = typeof localStorage === 'undefined' ? null : localStorage
/** The chrome bar's CliMayte button: tasks under their sessions, remembered. */
export const showTasks = ref(storage?.getItem(KEY) === '1')
watch(showTasks, (v) => storage?.setItem(KEY, v ? '1' : '0'))

/** A sidebar row tasks can sit under: its key and the session ids it stands for. */
export interface NestRow {
  key: string
  sessionIds: readonly string[]
}

/** One task under a row: depth 1 under the row itself, 2 under a manager in it, and so on. */
export interface TaskNode {
  worker: CliMayteWorker
  depth: number
}

const MAX_DEPTH = 3

/**
 * Each row's tasks, flattened in order, for the rows the sidebar draws. A task is under a row when the
 * row's session dispatched it, or when the task's dispatcher is the worker that row's session belongs to
 * (a Desk chat that runs as a CliMayte worker, a manager's own session); a manager's wave goes under the
 * manager. Only tasks that can still change are listed, and a finished manager only while a task under
 * it still runs. Each task is listed once: a row that is itself a task listed under another row lists
 * nothing of its own, since its tasks are already there under it.
 */
export function nestTasks(rows: readonly NestRow[], workers: readonly CliMayteWorker[]): Map<string, TaskNode[]> {
  const sessionsOf = (w: CliMayteWorker) => new Set([...(w.sessions ?? []), ...(w.sessionId ? [w.sessionId] : [])])
  const bySession = new Map<string, CliMayteWorker>()
  for (const w of workers) for (const s of sessionsOf(w)) bySession.set(s, w)
  const byId = new Map(workers.map((w) => [w.id, w]))

  /** The tasks a row (its sessions, and the workers those sessions belong to) handed out. */
  function kidsOf(sessions: ReadonlySet<string>, self: ReadonlySet<string>): CliMayteWorker[] {
    return workers
      .filter((w) => {
        if (self.has(w.id)) return false
        if (w.originWorkerId && byId.has(w.originWorkerId)) return self.has(w.originWorkerId)
        return !!w.originSessionId && sessions.has(w.originSessionId)
      })
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }
  function walk(sessions: ReadonlySet<string>, self: ReadonlySet<string>, depth: number, seen: Set<string>): TaskNode[] {
    if (depth > MAX_DEPTH) return []
    const out: TaskNode[] = []
    for (const w of kidsOf(sessions, self)) {
      if (seen.has(w.id)) continue
      seen.add(w.id)
      const below = walk(sessionsOf(w), new Set([w.id]), depth + 1, seen)
      if (!w.active && !below.length) continue
      out.push({ worker: w, depth }, ...below)
    }
    return out
  }

  const lists = new Map<string, TaskNode[]>()
  /** The worker a row's own session belongs to, if any. */
  const own = new Map<string, string>()
  /** Per worker, the rows whose list has it. */
  const listedBy = new Map<string, string[]>()
  for (const r of rows) {
    const self = new Set(r.sessionIds.flatMap((s) => (bySession.has(s) ? [bySession.get(s)!.id] : [])))
    const first = [...self][0]
    if (first) own.set(r.key, first)
    const list = walk(new Set(r.sessionIds), self, 1, new Set(self))
    if (!list.length) continue
    lists.set(r.key, list)
    for (const n of list) listedBy.set(n.worker.id, [...(listedBy.get(n.worker.id) ?? []), r.key])
  }

  // From the outermost rows in: a row whose worker a kept row lists is dropped; one that no row lists,
  // or whose every lister was dropped, is kept. Data that loops (two managers naming each other) has no
  // outermost row: the first row still open is kept to break it.
  const kept = new Set<string>()
  const dropped = new Set<string>()
  let open = rows.map((r) => r.key)
  while (open.length) {
    const still: string[] = []
    for (const key of open) {
      const id = own.get(key)
      const by = (id ? (listedBy.get(id) ?? []) : []).filter((k) => k !== key)
      if (by.some((k) => kept.has(k))) dropped.add(key)
      else if (by.every((k) => dropped.has(k))) kept.add(key)
      else still.push(key)
    }
    if (still.length === open.length) kept.add(still.shift()!)
    open = still
  }
  for (const key of dropped) lists.delete(key)
  return lists
}
