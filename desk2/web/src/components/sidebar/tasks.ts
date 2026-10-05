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

/** A sidebar row tasks can sit under: its key, the session ids it stands for, and whether a row that is
 *  itself a task (an outside session that is a worker's) may be folded into the row it came from. */
export interface NestRow {
  key: string
  sessionIds: readonly string[]
  hideable: boolean
}

/** One task under a row: depth 1 under the row itself, 2 under a manager in it, and so on. */
export interface TaskNode {
  worker: CliMayteWorker
  depth: number
}

const MAX_DEPTH = 3

/**
 * Each row's tasks, flattened in order, and the rows to leave out because their task is already shown
 * under the row that handed it out. A task is under a row when the row's session dispatched it, or when
 * the task's dispatcher is the worker that row's session belongs to (a Desk chat that runs as a CliMayte
 * worker, a manager's own session); a manager's wave goes under the manager. Only tasks that can still
 * change are listed, and a finished manager only while a task under it still runs.
 */
export function nestTasks(rows: readonly NestRow[], workers: readonly CliMayteWorker[]): { tasks: Map<string, TaskNode[]>; hidden: Set<string> } {
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
  function walk(sessions: ReadonlySet<string>, self: ReadonlySet<string>, depth: number, seen: Set<string>, nested: Set<string>): TaskNode[] {
    if (depth > MAX_DEPTH) return []
    const out: TaskNode[] = []
    for (const w of kidsOf(sessions, self)) {
      if (seen.has(w.id)) continue
      seen.add(w.id)
      const below = walk(sessionsOf(w), new Set([w.id]), depth + 1, seen, nested)
      if (!w.active && !below.length) continue
      nested.add(w.id)
      out.push({ worker: w, depth }, ...below)
    }
    return out
  }

  const tasks = new Map<string, TaskNode[]>()
  const nested = new Set<string>()
  for (const r of rows) {
    const sessions = new Set(r.sessionIds)
    const self = new Set(r.sessionIds.flatMap((s) => (bySession.has(s) ? [bySession.get(s)!.id] : [])))
    const list = walk(sessions, self, 1, new Set(self), nested)
    if (list.length) tasks.set(r.key, list)
  }
  const hidden = new Set<string>()
  for (const r of rows) {
    if (!r.hideable) continue
    const own = r.sessionIds.map((s) => bySession.get(s)).find(Boolean)
    if (own && nested.has(own.id)) {
      hidden.add(r.key)
      tasks.delete(r.key)
    }
  }
  return { tasks, hidden }
}
