// Hydra Desk 2: CliMayte's running tasks under the session that handed them out, in the sidebar (the
// chrome bar's CliMayte button; Michael, 2026-10-04: "under each active thread, it shows with a little tab
// over in a very compact way, all of these CliMayte running tasks ... if they have a manager, they would
// tab once more and be under the manager"), another PC's too (owner, 2026-10-04: "I was hoping you'd stick
// the climayte chats as sub items in the HD2 sidebar. Under the chat which spawned them. Not as its own
// stand alone table"). A running task no drawn row spawned is still listed, at the top of the list, one block
// per PC with a stand-in row for the chat that started it, never hidden (owner, 2026-10-05, counting AgentHydra's six against Desk's one: "Is one
// smaller than six? Yes ... Why?"). Pure, so the window and the tests share it.
import { ref, watch } from 'vue'
import type { CliMayteWorker, SwarmJob } from '@shared/protocol'

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
 * One chat that started running tasks no drawn row lists, as the sidebar stands in for it: its title, why it
 * is here (the note behind its ⓘ), the CliMayte worker it is when it is a Desk chat run as a worker (so its
 * own status shows and a click opens it), and the tasks that follow it, one step in.
 */
export interface UnplacedChat {
  key: string
  title: string
  note: string
  worker: CliMayteWorker | null
  nodes: TaskNode[]
  /** The running HSwarm jobs its chat called, after its tasks (kept apart from `nodes`: a count per kind is each one's length). */
  jobs: SwarmJob[]
}

/** Every unplaced chat of one PC; null for this PC. The sidebar heads it once. */
export interface UnplacedTasks {
  pc: string | null
  chats: UnplacedChat[]
}

export interface NestedTasks {
  /** Each drawn row's tasks, flattened in order; a row with none is absent. */
  byRow: Map<string, TaskNode[]>
  /** Every running task no row lists (nor draws as itself), one block per PC: this PC's first, then each other PC's in first-seen order. */
  unplaced: UnplacedTasks[]
  /** Each drawn row's HSwarm jobs, newest first, drawn after its tasks (kept apart from `byRow`); a row with none is absent. */
  jobsByRow: Map<string, SwarmJob[]>
}

/** The group both Hydra Desk and Desk 2 run each chat's worker in (server/src/engine/chat-manager.ts). */
const DESK_GROUP = 'hydra-desk'
const NOT_LISTED = 'The chat that started them is not in this list: the filter, the search or the time period leaves it out.'

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
/** `jobs` nest under `o.jobRows` (default `rows`): a list that draws no jobs under its rows passes none. */
export function nestTasks(rows: readonly NestRow[], workers: readonly CliMayteWorker[], jobs: readonly SwarmJob[] = [], o: { jobRows?: readonly NestRow[] } = {}): NestedTasks {
  const keyOf = (w: CliMayteWorker) => (w.pc ? `${w.pc}:${w.id}` : w.id)
  /** The worker that dispatched it, on its own PC. */
  const parentKey = (w: CliMayteWorker) => (w.originWorkerId ? (w.pc ? `${w.pc}:${w.originWorkerId}` : w.originWorkerId) : null)
  const sessionsOf = (w: CliMayteWorker) => new Set([...(w.sessions ?? []), ...(w.sessionId ? [w.sessionId] : [])])
  const bySession = new Map<string, CliMayteWorker>()
  for (const w of workers) for (const s of sessionsOf(w)) bySession.set(s, w)
  const byKey = new Map(workers.map((w) => [keyOf(w), w]))

  // Workers indexed once: under the worker that dispatched them when it is listed, else under the session
  // they came from, so a row's tasks are lookups and not a filter over every worker.
  const place = new Map<CliMayteWorker, number>(workers.map((w, i) => [w, i]))
  const byParent = new Map<string, CliMayteWorker[]>()
  const byOrigin = new Map<string, CliMayteWorker[]>()
  const addTo = (index: Map<string, CliMayteWorker[]>, key: string, w: CliMayteWorker) => {
    const list = index.get(key)
    if (list) list.push(w)
    else index.set(key, [w])
  }
  for (const w of workers) {
    const parent = parentKey(w)
    if (parent && byKey.has(parent)) addTo(byParent, parent, w)
    else if (w.originSessionId) addTo(byOrigin, w.originSessionId, w)
  }

  /** The tasks a row (its sessions, and the workers those sessions belong to) handed out. */
  function kidsOf(sessions: ReadonlySet<string>, self: ReadonlySet<string>): CliMayteWorker[] {
    const found = new Set<CliMayteWorker>()
    for (const key of self) for (const w of byParent.get(key) ?? []) found.add(w)
    for (const id of sessions) for (const w of byOrigin.get(id) ?? []) found.add(w)
    return [...found]
      .filter((w) => !self.has(keyOf(w)))
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || place.get(a)! - place.get(b)!)
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
  const selves = rows.map((r) => {
    const self = new Set(r.sessionIds.flatMap((s) => (bySession.has(s) ? [keyOf(bySession.get(s)!)] : [])))
    // A Desk chat's worker is this PC's: its id is its key.
    if (r.workerId && byKey.has(r.workerId)) self.add(r.workerId)
    return self
  })
  // One row lists a worker's tasks: a worker that handed off has two sessions, so two rows can stand for
  // it; the one on its current session (else the first) lists them, the other lists nothing.
  const owner = new Map<string, string>()
  rows.forEach((r, i) => {
    for (const k of selves[i]!) {
      const current = byKey.get(k)?.sessionId
      if (!owner.has(k) || (current && r.sessionIds.includes(current))) owner.set(k, r.key)
    }
  })
  rows.forEach((r, i) => {
    const self = selves[i]!
    const first = [...self][0]
    if (first) own.set(r.key, first)
    for (const k of self) drawn.add(k)
    if (self.size && ![...self].some((k) => owner.get(k) === r.key)) return
    // Its own sessions, and every session of the workers it stands for.
    const sessions = new Set([...r.sessionIds, ...[...self].flatMap((k) => [...sessionsOf(byKey.get(k)!)])])
    const list = walk(sessions, self, 1, new Set(self))
    if (!list.length) return
    lists.set(r.key, list)
    for (const n of list) {
      const key = keyOf(n.worker)
      listedBy.set(key, [...(listedBy.get(key) ?? []), r.key])
    }
  })

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
      // Its dispatcher, else the worker whose session (an earlier one too) dispatched it, on its own PC.
      const bySess = !parent && top.originSessionId ? bySession.get(top.originSessionId) : undefined
      const up = parent ? byKey.get(parent) : bySess?.pc === top.pc ? bySess : undefined
      if (!up || shown.has(keyOf(up)) || path.has(keyOf(up))) break
      path.add(keyOf(up))
      top = up
    }
    if (!roots.includes(top)) roots.push(top)
  }
  const seen = new Set([...shown, ...roots.map(keyOf)])
  // Another PC whose AgentHydra predates sharing sessions and origins sends none for any task; a newer one
  // sends a session for every task that has started.
  const oldPcs = new Set(workers.filter((w) => w.pc).map((w) => w.pc!))
  for (const w of workers) if (w.pc && (w.sessionId || w.sessions?.length || w.originSessionId || w.originWorkerId)) oldPcs.delete(w.pc)
  const blocks = new Map<string, UnplacedTasks>()
  const chatsByKey = new Map<string, UnplacedChat>()
  /** The first non-empty title of the chat each origin stands for, as its PC sent it. */
  const titles = new Map<string, string>()
  for (const r of roots) if (r.originSessionId && r.originTitle && !titles.has(`${r.pc ?? ''}|${r.originSessionId}`)) titles.set(`${r.pc ?? ''}|${r.originSessionId}`, r.originTitle)
  const chatFor = (pc: string | null, key: string, make: () => Omit<UnplacedChat, 'key' | 'nodes' | 'jobs'>): UnplacedChat => {
    let chat = chatsByKey.get(`${pc ?? ''}|${key}`)
    if (!chat) {
      chat = { key: `${pc ?? ''}|${key}`, ...make(), nodes: [], jobs: [] }
      chatsByKey.set(chat.key, chat)
      const block = blocks.get(pc ?? '') ?? { pc, chats: [] }
      block.chats.push(chat)
      blocks.set(pc ?? '', block)
    }
    return chat
  }
  for (const r of roots.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    const pc = r.pc ?? null
    const where = pc ? `on ${pc}` : ''
    // A Hydra Desk chat run as a worker on a PC whose chat list is not here: it is the chat.
    const deskChat = r.group === DESK_GROUP && !r.originSessionId && !r.originWorkerId
    const below = walk(sessionsOf(r), new Set([keyOf(r)]), deskChat ? 1 : 2, seen)
    let key: string
    let make: () => Omit<UnplacedChat, 'key' | 'nodes' | 'jobs'>
    if (deskChat) {
      key = `desk:${keyOf(r)}`
      make = () => ({
        title: r.title,
        worker: r,
        note: pc ? `This chat runs on ${pc} and is not in this PC's session list, so it is listed here with its tasks.` : NOT_LISTED
      })
    } else if (r.originSessionId) {
      const sid = r.originSessionId
      key = `origin:${pc ?? ''}|${sid}`
      make = () => {
        const wording = pc ? `A chat ${where}` : 'A chat'
        const named = titles.get(`${pc ?? ''}|${sid}`)
        return {
          title: named ?? `${wording} · ${sid.slice(0, 8)}`,
          worker: null,
          note: pc ? `${named ?? wording} is ${where} and is not in this PC's session list, so its tasks are listed here under it.` : NOT_LISTED
        }
      }
    } else if (pc && oldPcs.has(pc)) {
      key = `old:${pc}`
      make = () => ({ title: 'Unknown chat', worker: null, note: `${pc}'s AgentHydra is too old to say which chat started these tasks. Update it there and they move under their chats.` })
    } else {
      key = `none:${pc ?? ''}`
      make = () => ({ title: 'No chat', worker: null, note: 'Not under a chat: nothing here says which chat started them.' })
    }
    const chat = chatFor(pc, key, make)
    chat.nodes.push(...(deskChat ? [] : [{ worker: r, depth: 1 }]), ...below)
  }
  // HSwarm jobs: under the first row that has the caller's session (the job's id may be the 8-character prefix the
  // jobs list stamps), else a running one under a stand-in for its caller, on this PC (a CliMayte task of that chat, if any, shares it).
  const jobsByRow = new Map<string, SwarmJob[]>()
  const rowOfSession = new Map<string, string>()
  for (const r of o.jobRows ?? rows) for (const s of r.sessionIds) if (!rowOfSession.has(s)) rowOfSession.set(s, r.key)
  const rowsByPrefix = new Map<string, string>()
  for (const [s, key] of rowOfSession) if (!rowsByPrefix.has(s.slice(0, 8))) rowsByPrefix.set(s.slice(0, 8), key)
  const rowFor = (id: string | null | undefined): string | undefined => {
    if (!id) return undefined
    const exact = rowOfSession.get(id)
    if (exact || id.length > 8) return exact
    return rowsByPrefix.get(id)
  }
  for (const j of [...jobs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))) {
    const row = rowFor(j.callerSessionId) ?? rowFor(j.callerHostSessionId)
    if (row) {
      jobsByRow.set(row, [...(jobsByRow.get(row) ?? []), j])
      continue
    }
    if (!j.active) continue
    const sid = j.callerSessionId ?? j.callerHostSessionId
    const sameChat = sid ? [...chatsByKey.values()].find((c) => c.key.startsWith('|origin:|') && c.key.slice('|origin:|'.length).startsWith(sid)) : undefined
    const chat =
      sameChat ??
      (sid
        ? chatFor(null, `origin:|${sid}`, () => ({ title: j.callerTitle || `A chat · ${sid.slice(0, 8)}`, worker: null, note: NOT_LISTED }))
        : chatFor(null, 'none:', () => ({ title: 'No chat', worker: null, note: 'Not under a chat: nothing here says which chat started them.' })))
    chat.jobs.push(j)
  }
  const unplaced = [...blocks.values()].sort((a, b) => Number(!!a.pc) - Number(!!b.pc))
  return { byRow: lists, unplaced, jobsByRow }
}

/** A PC's block of unplaced chats as the sidebar heads it: the PC and how many of its tasks run (a running Desk chat counts). */
export function unplacedHeading(b: UnplacedTasks): { title: string; count: number } {
  const count = b.chats.reduce((n, c) => n + runningIn([c.nodes], [c.jobs]) + (c.worker?.active ? 1 : 0), 0)
  return { title: b.pc ? `On ${b.pc}` : 'On this PC', count }
}

/** How many of these lists' tasks run: a folded group's heading shows it (RunningBadge.vue). */
export function runningIn(lists: readonly (readonly TaskNode[] | null | undefined)[], jobLists: readonly (readonly SwarmJob[] | null | undefined)[] = []): number {
  return runningTasksIn(lists) + runningJobsIn(jobLists)
}

/** How many of these lists' CliMayte tasks run. */
export function runningTasksIn(lists: readonly (readonly TaskNode[] | null | undefined)[]): number {
  return lists.reduce((n, l) => n + (l?.filter((t) => t.worker.active).length ?? 0), 0)
}

/** How many of these lists' HSwarm jobs run. */
export function runningJobsIn(lists: readonly (readonly SwarmJob[] | null | undefined)[]): number {
  return lists.reduce((n, l) => n + (l?.filter((j) => j.active).length ?? 0), 0)
}
