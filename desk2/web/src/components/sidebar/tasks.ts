// Hydra Desk 2: CliMayte's running tasks under the session that handed them out, in the sidebar (the
// chrome bar's CliMayte button; Michael, 2026-10-04: "under each active thread, it shows with a little tab
// over in a very compact way, all of these CliMayte running tasks ... if they have a manager, they would
// tab once more and be under the manager"), another PC's too (owner, 2026-10-04: "I was hoping you'd stick
// the climayte chats as sub items in the HD2 sidebar. Under the chat which spawned them. Not as its own
// stand alone table"). A running task no drawn row spawned is still listed, at the top of the list, per PC
// with the reason, never hidden (owner, 2026-10-05, counting AgentHydra's six against Desk's one: "Is one
// smaller than six? Yes ... Why?"). Pure, so the window and the tests share it.
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
  /** The CliMayte worker the row runs as (a Desk chat): it stands for it before it has a session (still queued). */
  workerId?: string | null
}

/** One task in a list: depth 1 under the row itself, 2 under a manager in it, and so on up to MAX_DEPTH. */
export interface TaskNode {
  worker: CliMayteWorker
  depth: number
}

/**
 * Why a running task sits under no row: its PC does not say which chat started it (another PC's older
 * AgentHydra sends no session, origin or wave), nothing does (a task no chat started), or the chat that
 * started it is not in the list (the filter, the search or the time period leaves it out).
 */
export type UnplacedReason = 'old-pc' | 'no-origin' | 'not-listed'

/** The running tasks of one PC that no drawn row lists, for one reason, with the finished tasks above them. */
export interface UnplacedTasks {
  /** The PC that runs them; null for this PC. */
  pc: string | null
  reason: UnplacedReason
  nodes: TaskNode[]
}

export interface NestedTasks {
  /** Each drawn row's tasks, flattened in order; a row with none is absent. */
  byRow: Map<string, TaskNode[]>
  /** Every running task no row lists (nor draws as itself), this PC's first, then each other PC's. */
  unplaced: UnplacedTasks[]
}

/** The deepest indent: a task further down is still listed, at this one. */
const MAX_DEPTH = 3

/**
 * Each row's tasks, flattened in order, for the rows the sidebar draws. A task is under a row when the
 * row's session dispatched it, or when the task's dispatcher is the worker that row's session belongs to
 * (a Desk chat that runs as a CliMayte worker, a manager's own session); a manager's wave goes under the
 * manager. Only tasks that can still change are listed, and a finished manager only while a task under
 * it still runs. Each task is listed once: a row that is itself a task listed under another row lists
 * nothing of its own, since its tasks are already there under it.
 *
 * Another PC's tasks (`pc`) nest by the same rules within their own PC: their ids may repeat this PC's, so
 * a task and the worker that dispatched it are known by PC and id. Their chats arrive here through the
 * chat sync with the same session id (a cloud row, an outside row in the desk list), so a task sits under
 * the chat that spawned it whichever PC runs it. A running task no row lists, and no row draws as itself,
 * goes in `unplaced` under the topmost of its dispatchers no row lists either, so every running task is
 * shown once.
 */
export function nestTasks(rows: readonly NestRow[], workers: readonly CliMayteWorker[]): NestedTasks {
  const keyOf = (w: CliMayteWorker) => (w.pc ? `${w.pc}:${w.id}` : w.id)
  /** The worker that dispatched it, on its own PC. */
  const parentKey = (w: CliMayteWorker) => (w.originWorkerId ? (w.pc ? `${w.pc}:${w.originWorkerId}` : w.originWorkerId) : null)
  const sessionsOf = (w: CliMayteWorker) => new Set([...(w.sessions ?? []), ...(w.sessionId ? [w.sessionId] : [])])
  const bySession = new Map<string, CliMayteWorker>()
  for (const w of workers) for (const s of sessionsOf(w)) bySession.set(s, w)
  const byKey = new Map(workers.map((w) => [keyOf(w), w]))

  /** The tasks a row (its sessions, and the workers those sessions belong to) handed out. */
  function kidsOf(sessions: ReadonlySet<string>, self: ReadonlySet<string>): CliMayteWorker[] {
    return workers
      .filter((w) => {
        if (self.has(keyOf(w))) return false
        const parent = parentKey(w)
        if (parent && byKey.has(parent)) return self.has(parent)
        return !!w.originSessionId && sessions.has(w.originSessionId)
      })
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }
  // `seen` ends it: each task is walked once, however deep or looped the data.
  function walk(sessions: ReadonlySet<string>, self: ReadonlySet<string>, depth: number, seen: Set<string>): TaskNode[] {
    const out: TaskNode[] = []
    for (const w of kidsOf(sessions, self)) {
      const key = keyOf(w)
      if (seen.has(key)) continue
      seen.add(key)
      const below = walk(sessionsOf(w), new Set([key]), depth + 1, seen)
      if (!w.active && !below.length) continue
      out.push({ worker: w, depth: Math.min(depth, MAX_DEPTH) }, ...below)
    }
    return out
  }

  const lists = new Map<string, TaskNode[]>()
  /** The worker a row's own session belongs to, if any. */
  const own = new Map<string, string>()
  /** Every worker a row stands for: drawn as that row, so never missing. */
  const drawn = new Set<string>()
  /** Per worker, the rows whose list has it. */
  const listedBy = new Map<string, string[]>()
  for (const r of rows) {
    const self = new Set(r.sessionIds.flatMap((s) => (bySession.has(s) ? [keyOf(bySession.get(s)!)] : [])))
    // A Desk chat's worker is this PC's: its id is its key.
    if (r.workerId && byKey.has(r.workerId)) self.add(r.workerId)
    const first = [...self][0]
    if (first) own.set(r.key, first)
    for (const k of self) drawn.add(k)
    const list = walk(new Set(r.sessionIds), self, 1, new Set(self))
    if (!list.length) continue
    lists.set(r.key, list)
    for (const n of list) {
      const key = keyOf(n.worker)
      listedBy.set(key, [...(listedBy.get(key) ?? []), r.key])
    }
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

  const shown = new Set(drawn)
  for (const list of lists.values()) for (const n of list) shown.add(keyOf(n.worker))
  // The topmost dispatcher no row lists above each running task no row lists: its list starts there.
  const roots: CliMayteWorker[] = []
  for (const w of workers) {
    if (!w.active || shown.has(keyOf(w))) continue
    let top = w
    const path = new Set([keyOf(w)])
    for (;;) {
      const parent = parentKey(top)
      const up = parent ? byKey.get(parent) : undefined
      if (!up || shown.has(keyOf(up)) || path.has(keyOf(up))) break
      path.add(keyOf(up))
      top = up
    }
    if (!roots.includes(top)) roots.push(top)
  }
  const seen = new Set([...shown, ...roots.map(keyOf)])
  const groups = new Map<string, UnplacedTasks>()
  for (const r of roots.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    const nodes = [{ worker: r, depth: 1 }, ...walk(sessionsOf(r), new Set([keyOf(r)]), 2, seen)]
    const told = !!(r.originSessionId || r.originWorkerId)
    const reason: UnplacedReason = told ? 'not-listed' : r.pc && !r.sessionId ? 'old-pc' : 'no-origin'
    const key = `${r.pc ?? ''}|${reason}`
    const g = groups.get(key) ?? { pc: r.pc ?? null, reason, nodes: [] }
    g.nodes.push(...nodes)
    groups.set(key, g)
  }
  const unplaced = [...groups.values()].sort((a, b) => Number(!!a.pc) - Number(!!b.pc))
  return { byRow: lists, unplaced }
}

/** A block of tasks under no row, as the sidebar heads it: the PC, how many run, and why they are there. */
export function unplacedText(g: UnplacedTasks): { title: string; count: number; note: string } {
  const count = g.nodes.filter((n) => n.worker.active).length
  const one = count === 1
  const them = one ? 'it' : 'them'
  const note =
    g.reason === 'old-pc'
      ? `Not under ${one ? 'its chat' : 'their chats'}: ${g.pc}'s AgentHydra is too old to say which chat started ${them}. Update it there and ${one ? 'it moves under its chat' : 'they move under their chats'}.`
      : g.reason === 'no-origin'
        ? `Not under a chat: nothing says which chat started ${them}.`
        : `Not under ${one ? 'its chat' : 'their chats'}: the chat that started ${them} is not in this list.`
  return { title: g.pc ? `On ${g.pc}` : 'On this PC', count, note }
}

/** How many of these lists' tasks run: a folded group's heading shows it (RunningBadge.vue). */
export function runningIn(lists: readonly (readonly TaskNode[] | null | undefined)[]): number {
  return lists.reduce((n, l) => n + (l?.filter((t) => t.worker.active).length ?? 0), 0)
}
