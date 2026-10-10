// Hydra Desk 2: CliMayte's running tasks under the session that handed them out, in the sidebar (the
// chrome bar's CliMayte button; Michael, 2026-10-04: "under each active thread, it shows with a little tab
// over in a very compact way, all of these CliMayte running tasks ... if they have a manager, they would
// tab once more and be under the manager"), another PC's too (owner, 2026-10-04: "I was hoping you'd stick
// the climayte chats as sub items in the HD2 sidebar. Under the chat which spawned them. Not as its own
// stand alone table"). A running task no drawn row spawned is still listed, never hidden (owner, 2026-10-05,
// counting AgentHydra's six against Desk's one: "Is one smaller than six? Yes ... Why?"): the chat that
// started it, else the task itself, is added as a row of its folder's group, drawn as the list draws its own
// rows, another PC's with a cloud (owner, 2026-10-05: "it should show up on mine as exactly as if it was the
// other things ... inline identical"). Pure, so the window and the tests share it.
import { ref, watch } from 'vue'
import type { CliMayteWorker, CloudSession, ExternalSession, SwarmJob } from '@shared/protocol'
import type { CloudGroup } from '../cloud/logic'
import { folderKey, folderLabel, NO_FOLDER, sortFolders, stableOrder, type ChatGroup, type SidebarEntry, type SidebarOrder } from './logic'

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

/** What the window knows of a chat by its session id, from any list it holds: a row added for it takes its title and folder. */
export interface KnownChat {
  title: string
  cwd: string | null
  /** Its last activity, for its place among the rows. */
  at: number | null
}

/**
 * A row the sidebar adds for running work no drawn row lists: the chat that started it (the chat a task's
 * origin names, or the caller of an HSwarm job), a Hydra Desk chat run as a CliMayte worker, or, when nothing
 * says which chat started it, the task or the job itself. Each list draws it in its folder's group as one of
 * its own rows (addToDeskGroups, addToCloudGroups); another PC's leads with a cloud.
 */
export interface AddedRow {
  /** `added:`, then its PC, kind and id: never a listed session's id. */
  id: string
  title: string
  /** The PC it runs on; null for this one. */
  pc: string | null
  /** The folder it runs in; null when nothing here says (another PC shares no path for its tasks). */
  cwd: string | null
  /** Another PC's folder by its last name only (all that PC shares of it), for a row `cwd` leaves without one: it
   *  goes in the one group here whose folder has that name, else in a group of its own by that name (owner,
   *  2026-10-06, over a "No folder" group). */
  folder: string | null
  /** Its newest activity, its own or its tasks' and jobs'. */
  at: number
  /** The session it stands for, its PC's id: the chat's, or the worker's own; null for a job, or a caller known only by a short prefix. */
  sessionId: string | null
  /** The CliMayte worker the row is: a Desk chat run as one, or a task nothing says which chat started. */
  worker: CliMayteWorker | null
  /** The HSwarm job the row is, when nothing says which chat called it. */
  job: SwarmJob | null
  /** Its tasks, flattened in order, as under a drawn row. */
  nodes: TaskNode[]
  /** Its HSwarm jobs, newest first, drawn after its tasks (kept apart from `nodes`: a count per kind is each one's length). */
  jobs: SwarmJob[]
}

export interface NestedTasks {
  /** Each drawn row's tasks, flattened in order; a row with none is absent. */
  byRow: Map<string, TaskNode[]>
  /** Each drawn row's HSwarm jobs, newest first, drawn after its tasks (kept apart from `byRow`); a row with none is absent. */
  jobsByRow: Map<string, SwarmJob[]>
  /** The rows added for running work no drawn row lists (nor draws as itself): the tasks' oldest first, then the jobs'. */
  added: AddedRow[]
  /** How many running tasks HSwarm sent wait, drawn nowhere, for their job (ROUTED_WAIT_MS): while any do, the caller works the list out again on a timer. */
  held: number
}

const ADDED = 'added:'
/** Whether a row is one the sidebar added (AddedRow), by its id. */
export const isAddedRow = (id: string): boolean => id.startsWith(ADDED)

/** The deepest indent: a task further down is still listed, at this one. */
const MAX_DEPTH = 3

/** A row the sidebar added for a CliMayte task nothing says which chat started: it carries the CliMayte mark in both lists. */
export const isTaskRow = (id: string): boolean => /^added:[^:]*:task:/.test(id)

/** The group CliMayte gives a task HSwarm sent it: `hswarm-<job>-<task>` (hswarm/climayte_route.py). */
const ROUTED = 'hswarm-'
/** A task HSwarm sent that names nothing that dispatched it: its job is its one tie to a chat. */
const isRouted = (w: CliMayteWorker) => !w.originSessionId && !w.originWorkerId && !!w.group?.startsWith(ROUTED)
const jobKey = (j: Pick<SwarmJob, 'id' | 'pc'>) => `${j.pc ?? ''}|${j.id}`

/**
 * The HSwarm jobs the window has seen, by PC and id, kept by the sidebar across polls (Sidebar.vue) for the tasks HSwarm
 * sent to CliMayte (viaJobs): the job list comes on its own, slower channel than the tasks (every 10 s at most, and
 * nothing while HSwarm does not answer), and a task whose job dropped out of it went from under its chat to a row of
 * its own and back on every poll (owner, 2026-10-09: the sidebar "jackhammers"). Each listed job is kept; one HSwarm no
 * longer lists is dropped once no task names it.
 */
export type SeenJobs = Map<string, SwarmJob>

/**
 * How long a task HSwarm sent waits, drawn nowhere, for a job to name its chat: a new job's first tasks reach the window
 * before the job does (the server reads HSwarm's list at most every 10 s, a slow answer taking up to 15 s more), and a
 * task drawn as a row of its own until then would jump under its chat a moment later (owner, 2026-10-09). A task whose
 * job is still unknown once the wait is over is listed under one row of such tasks per folder (routedRow), never hidden
 * for longer.
 */
export const ROUTED_WAIT_MS = 30_000

/**
 * A task HSwarm sent to CliMayte carries no origin, so the chat is not pinged for every one; it takes its job's caller as
 * its origin, so it sits under the chat that called the job, beside the job (owner, 2026-10-07: "they should probably be
 * under the chat that spawned them"). The job is the one listed now or, while HSwarm's list lacks it, the one `seen`
 * kept from an earlier poll, so a task stays where it was (SeenJobs). The caller is the drawn row's session the job's
 * ids name (an 8-character prefix only when one row has it), else the ids the job itself is placed by (homeOf).
 * `routed` has each such task that still names no chat: its job when that job names no caller, null while no job is
 * known for it.
 */
function viaJobs(
  workers: readonly CliMayteWorker[],
  jobs: readonly SwarmJob[],
  rows: readonly NestRow[],
  seen: SeenJobs
): { workers: CliMayteWorker[]; routed: Map<string, SwarmJob | null> } {
  for (const j of jobs) seen.set(jobKey(j), j)
  const sessions = new Set(rows.flatMap((r) => r.sessionIds))
  const drawnAs = (id: string | null): string | undefined => {
    if (!id) return undefined
    if (id.length > 8) return sessions.has(id) ? id : undefined
    const found = rows.filter((r) => r.sessionIds.some((s) => s.startsWith(id)))
    return found.length === 1 ? found[0]!.sessionIds.find((s) => s.startsWith(id)) : undefined
  }
  const routed = new Map<string, SwarmJob | null>()
  const named = new Set<string>()
  const out = workers.map((w) => {
    if (!isRouted(w)) return w
    let j: SwarmJob | undefined
    for (const x of seen.values()) {
      if ((x.pc ?? null) === (w.pc ?? null) && w.group!.startsWith(`${ROUTED}${x.id}-`)) {
        j = x
        break
      }
    }
    if (j) named.add(jobKey(j))
    const sid = j ? (drawnAs(j.callerSessionId) ?? drawnAs(j.callerHostSessionId) ?? j.callerSessionId ?? j.callerHostSessionId) : null
    if (sid) return { ...w, originSessionId: sid, originTitle: w.originTitle ?? j!.callerTitle }
    routed.set(keyOf(w), j ?? null)
    return w
  })
  const listed = new Set(jobs.map(jobKey))
  for (const k of [...seen.keys()]) if (!listed.has(k) && !named.has(k)) seen.delete(k)
  return { workers: out, routed }
}

/** What nestTasks is told besides the lists: what the sidebar keeps across polls, and the time. */
export interface NestOptions {
  /** The HSwarm jobs seen so far (SeenJobs), kept by the caller across polls; without it only the jobs listed now place a task. */
  seenJobs?: SeenJobs
  /** Now, for how long a task HSwarm sent has waited for its job (ROUTED_WAIT_MS). */
  now?: number
  /** When the window began to listen for HSwarm's jobs: a task older than that waits from then, its job's first list being on its way. */
  since?: number
}

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
 * goes in `added` under the topmost of its dispatchers no row lists either, so every running task is shown
 * once: under the row of the chat that dispatcher came from, titled and placed as `known` (what the window
 * knows of each session) has that chat, else as its PC titles it, else after its first task; or, when
 * nothing says which chat, under the dispatcher's own row (a Desk chat run as a worker is one). A task HSwarm sent
 * to CliMayte counts as dispatched by the chat that called its job (viaJobs); one whose job names no chat goes under
 * the job's row, and one whose job is not known waits for it (ROUTED_WAIT_MS), then goes under a row of such tasks
 * (routedRow): never a row of its own (owner, 2026-10-09).
 */
export function nestTasks(
  rows: readonly NestRow[],
  given: readonly CliMayteWorker[],
  jobs: readonly SwarmJob[] = [],
  known: ReadonlyMap<string, KnownChat> = new Map(),
  o: NestOptions = {}
): NestedTasks {
  const { workers, routed } = viaJobs(given, jobs, rows, o.seenJobs ?? new Map())
  const now = o.now ?? Date.now()
  const held = new Set<string>()
  for (const w of workers) {
    if (w.active && routed.get(keyOf(w)) === null && now - Math.max(w.startedAt ?? 0, o.since ?? 0) < ROUTED_WAIT_MS) held.add(keyOf(w))
  }
  const ix = indexWorkers(workers)
  const rl = listRows(ix, rows)
  dropShadowed(rows, rl)
  const shown = new Set(rl.drawn)
  for (const list of rl.lists.values()) for (const n of list) shown.add(keyOf(n.worker))
  const roots = findRoots(ix, shown, held)
  const seen = new Set([...shown, ...roots.map(keyOf)])
  const st: AddedRows = { known, added: new Map(), bySession: new Map() }
  addRoots(ix, st, roots, seen, routed)
  const jobsByRow = placeJobs(st, rows, jobs)
  settleAdded(st)
  return { byRow: rl.lists, jobsByRow, added: [...st.added.values()], held: held.size }
}

const keyOf = (w: CliMayteWorker) => (w.pc ? `${w.pc}:${w.id}` : w.id)
/** The worker that dispatched it, on its own PC. */
const parentKey = (w: CliMayteWorker) => (w.originWorkerId ? (w.pc ? `${w.pc}:${w.originWorkerId}` : w.originWorkerId) : null)
const sessionsOf = (w: CliMayteWorker) => new Set([...(w.sessions ?? []), ...(w.sessionId ? [w.sessionId] : [])])
const activity = (w: CliMayteWorker) => w.lastActivityAt ?? w.startedAt ?? 0

/** The workers nestTasks places, indexed once. */
interface WorkerIndex {
  workers: CliMayteWorker[]
  bySession: Map<string, CliMayteWorker>
  byKey: Map<string, CliMayteWorker>
  place: Map<CliMayteWorker, number>
  byParent: Map<string, CliMayteWorker[]>
  byOrigin: Map<string, CliMayteWorker[]>
}

function addTo(index: Map<string, CliMayteWorker[]>, key: string, w: CliMayteWorker): void {
  const list = index.get(key)
  if (list) list.push(w)
  else index.set(key, [w])
}

function indexWorkers(workers: CliMayteWorker[]): WorkerIndex {
  const bySession = new Map<string, CliMayteWorker>()
  for (const w of workers) for (const s of sessionsOf(w)) bySession.set(s, w)
  const byKey = new Map(workers.map((w) => [keyOf(w), w]))
  // Workers indexed once: under the worker that dispatched them when it is listed, else under the session
  // they came from, so a row's tasks are lookups and not a filter over every worker.
  const place = new Map<CliMayteWorker, number>(workers.map((w, i) => [w, i]))
  const byParent = new Map<string, CliMayteWorker[]>()
  const byOrigin = new Map<string, CliMayteWorker[]>()
  for (const w of workers) {
    const parent = parentKey(w)
    if (parent && byKey.has(parent)) addTo(byParent, parent, w)
    else if (w.originSessionId) addTo(byOrigin, w.originSessionId, w)
  }
  return { workers, bySession, byKey, place, byParent, byOrigin }
}

/** The tasks a row (its sessions, and the workers those sessions belong to) handed out. */
function kidsOf(ix: WorkerIndex, sessions: ReadonlySet<string>, self: ReadonlySet<string>): CliMayteWorker[] {
  const found = new Set<CliMayteWorker>()
  for (const key of self) for (const w of ix.byParent.get(key) ?? []) found.add(w)
  for (const id of sessions) for (const w of ix.byOrigin.get(id) ?? []) found.add(w)
  return [...found]
    .filter((w) => !self.has(keyOf(w)))
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || ix.place.get(a)! - ix.place.get(b)!)
}

// `seen` ends it: each task is walked once, however deep or looped the data.
function walk(ix: WorkerIndex, sessions: ReadonlySet<string>, self: ReadonlySet<string>, depth: number, seen: Set<string>): TaskNode[] {
  const out: TaskNode[] = []
  for (const w of kidsOf(ix, sessions, self)) {
    const key = keyOf(w)
    if (seen.has(key)) continue
    seen.add(key)
    const below = walk(ix, sessionsOf(w), new Set([key]), depth + 1, seen)
    if (!w.active && !below.length) continue
    out.push({ worker: w, depth: Math.min(depth, MAX_DEPTH) }, ...below)
  }
  return out
}

/** The drawn rows' lists and what nestTasks needs of them later. */
interface RowLists {
  lists: Map<string, TaskNode[]>
  /** The worker a row's own session belongs to, if any. */
  own: Map<string, string>
  /** Every worker a row stands for: drawn as that row, so never missing. */
  drawn: Set<string>
  /** Per worker, the rows whose list has it. */
  listedBy: Map<string, string[]>
}

/** The workers a row stands for, by key: those its sessions belong to, and a Desk chat's own worker. */
function selfOf(ix: WorkerIndex, r: NestRow): Set<string> {
  const self = new Set(r.sessionIds.flatMap((s) => (ix.bySession.has(s) ? [keyOf(ix.bySession.get(s)!)] : [])))
  // A Desk chat's worker is this PC's: its id is its key.
  if (r.workerId && ix.byKey.has(r.workerId)) self.add(r.workerId)
  return self
}

function listRows(ix: WorkerIndex, rows: readonly NestRow[]): RowLists {
  const out: RowLists = { lists: new Map(), own: new Map(), drawn: new Set(), listedBy: new Map() }
  const selves = rows.map((r) => selfOf(ix, r))
  // One row lists a worker's tasks: a worker that handed off has two sessions, so two rows can stand for
  // it; the one on its current session (else the first) lists them, the other lists nothing.
  const owner = new Map<string, string>()
  rows.forEach((r, i) => {
    for (const k of selves[i]!) {
      const current = ix.byKey.get(k)?.sessionId
      if (!owner.has(k) || (current && r.sessionIds.includes(current))) owner.set(k, r.key)
    }
  })
  rows.forEach((r, i) => listRow(ix, r, selves[i]!, owner, out))
  return out
}

function listRow(ix: WorkerIndex, r: NestRow, self: Set<string>, owner: ReadonlyMap<string, string>, out: RowLists): void {
  const first = [...self][0]
  if (first) out.own.set(r.key, first)
  for (const k of self) out.drawn.add(k)
  if (self.size && ![...self].some((k) => owner.get(k) === r.key)) return
  // Its own sessions, and every session of the workers it stands for.
  const sessions = new Set([...r.sessionIds, ...[...self].flatMap((k) => [...sessionsOf(ix.byKey.get(k)!)])])
  const list = walk(ix, sessions, self, 1, new Set(self))
  if (!list.length) return
  out.lists.set(r.key, list)
  for (const n of list) {
    const key = keyOf(n.worker)
    out.listedBy.set(key, [...(out.listedBy.get(key) ?? []), r.key])
  }
}

// From the outermost rows in: a row whose worker a kept row lists is dropped; one that no row lists,
// or whose every lister was dropped, is kept. Data that loops (two managers naming each other) has no
// outermost row: the first row still open is kept to break it.
function dropShadowed(rows: readonly NestRow[], rl: RowLists): void {
  const kept = new Set<string>()
  const dropped = new Set<string>()
  let open = rows.map((r) => r.key)
  while (open.length) {
    const still: string[] = []
    for (const key of open) {
      const id = rl.own.get(key)
      const by = (id ? (rl.listedBy.get(id) ?? []) : []).filter((k) => k !== key)
      if (by.some((k) => kept.has(k))) dropped.add(key)
      else if (by.every((k) => dropped.has(k))) kept.add(key)
      else still.push(key)
    }
    if (still.length === open.length) kept.add(still.shift()!)
    open = still
  }
  for (const key of dropped) rl.lists.delete(key)
}

/** The topmost dispatcher no row lists above each running task no row lists: its list starts there; none for a task HSwarm sent that waits for its job (`held`). */
function findRoots(ix: WorkerIndex, shown: ReadonlySet<string>, held: ReadonlySet<string>): CliMayteWorker[] {
  const roots: CliMayteWorker[] = []
  for (const w of ix.workers) {
    if (!w.active || shown.has(keyOf(w))) continue
    const top = topOf(ix, w, shown)
    if (!held.has(keyOf(top)) && !roots.includes(top)) roots.push(top)
  }
  return roots
}

function topOf(ix: WorkerIndex, w: CliMayteWorker, shown: ReadonlySet<string>): CliMayteWorker {
  let top = w
  const path = new Set([keyOf(w)])
  for (;;) {
    const parent = parentKey(top)
    // Its dispatcher, else the worker whose session (an earlier one too) dispatched it, on its own PC.
    const bySess = !parent && top.originSessionId ? ix.bySession.get(top.originSessionId) : undefined
    const up = parent ? ix.byKey.get(parent) : bySess?.pc === top.pc ? bySess : undefined
    if (!up || shown.has(keyOf(up)) || path.has(keyOf(up))) return top
    path.add(keyOf(up))
    top = up
  }
}

/** The rows nestTasks adds, as it adds them. */
interface AddedRows {
  known: ReadonlyMap<string, KnownChat>
  added: Map<string, AddedRow>
  /** Each added row by the sessions it stands for, on its PC (`<pc>|<session>`): a job of one of them joins it. */
  bySession: Map<string, AddedRow>
}

/** The folder a task runs in: its own, else the one the window knows one of its sessions by (another PC shares no folder for its tasks, but the chat sync may bring their sessions here with theirs). */
function cwdOf(st: AddedRows, w: CliMayteWorker): string | null {
  return w.cwd || [...sessionsOf(w)].map((s) => st.known.get(s)?.cwd).find(Boolean) || null
}

function addRow(st: AddedRows, row: Omit<AddedRow, 'nodes' | 'jobs'>, sessions: Iterable<string>): AddedRow {
  const made: AddedRow = { ...row, nodes: [], jobs: [] }
  st.added.set(made.id, made)
  for (const s of sessions) if (!st.bySession.has(`${row.pc ?? ''}|${s}`)) st.bySession.set(`${row.pc ?? ''}|${s}`, made)
  return made
}

/** The added row of session `sid` on `pc`; a short id (an HSwarm job's 8-character prefix) finds the one row whose session it begins, never a guess between two. */
function addedOf(st: AddedRows, pc: string | null, sid: string): AddedRow | undefined {
  const exact = st.bySession.get(`${pc ?? ''}|${sid}`)
  if (exact || sid.length > 8) return exact
  const same = new Set([...st.bySession].filter(([k]) => k.startsWith(`${pc ?? ''}|${sid}`)).map(([, row]) => row))
  return same.size === 1 ? [...same][0] : undefined
}

/** The row of the chat with session `sid` on `pc`: titled and placed as the window knows that chat, else as `first` (its first task or job) says. */
function chatRow(st: AddedRows, pc: string | null, sid: string, first: { title: string; cwd: string | null; folder: string | null; at: number }): AddedRow {
  const had = addedOf(st, pc, sid)
  if (had) return had
  const k = st.known.get(sid)
  return addRow(
    st,
    { id: `${ADDED}${pc ?? ''}:chat:${sid}`, title: k?.title || first.title, pc, cwd: k?.cwd || first.cwd, folder: first.folder, at: Math.max(k?.at ?? 0, first.at), sessionId: sid.length > 8 ? sid : null, worker: null, job: null },
    [sid]
  )
}

/** The title of the row a task HSwarm sent goes under while no job says which chat it came from (routedRow). */
const ROUTED_TITLE = 'HSwarm tasks'

/**
 * The row a task HSwarm sent goes under when no job names its chat: its job's own row (a job nothing says which chat
 * called is a row itself, homeOf), else, its job not known, one row of such tasks per PC and folder, so a wave of them
 * folds into one badge rather than a row each (owner, 2026-10-09). Both are keyed by what they stand for, never by a
 * task, so a badge opened on one stays open as tasks come and go.
 */
function routedRow(st: AddedRows, r: CliMayteWorker, j: SwarmJob | null): AddedRow {
  const pc = r.pc ?? null
  const cwd = cwdOf(st, r)
  const id = j ? `${ADDED}${pc ?? ''}:job:${j.id}` : `${ADDED}${pc ?? ''}:hswarm:${cwd ? folderKey(cwd) : (r.folder ?? '').toLowerCase()}`
  const had = st.added.get(id)
  if (had) return had
  const at = j?.startedAt ?? activity(r)
  return addRow(st, { id, title: j ? j.title : ROUTED_TITLE, pc, cwd, folder: j?.folder ?? r.folder ?? null, at, sessionId: null, worker: null, job: j }, [])
}

function addRoots(ix: WorkerIndex, st: AddedRows, roots: CliMayteWorker[], seen: Set<string>, routed: ReadonlyMap<string, SwarmJob | null>): void {
  /** The first non-empty title of the chat each origin stands for, as its PC sent it. */
  const titles = new Map<string, string>()
  for (const r of roots) if (r.originSessionId && r.originTitle && !titles.has(`${r.pc ?? ''}|${r.originSessionId}`)) titles.set(`${r.pc ?? ''}|${r.originSessionId}`, r.originTitle)
  for (const r of roots.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    const pc = r.pc ?? null
    if (routed.has(keyOf(r))) {
      routedRow(st, r, routed.get(keyOf(r)) ?? null).nodes.push({ worker: r, depth: 1 }, ...walk(ix, sessionsOf(r), new Set([keyOf(r)]), 2, seen))
    } else if (r.originSessionId) {
      // The chat that started it, titled as the window knows it, else as its PC titles it, else after its first
      // task (owner, 2026-10-05), with its tasks one step in as under a drawn row.
      const row = chatRow(st, pc, r.originSessionId, { title: titles.get(`${pc ?? ''}|${r.originSessionId}`) || r.title, cwd: cwdOf(st, r), folder: r.folder ?? null, at: activity(r) })
      // A row its first task left without a folder takes the first of its other tasks that has one.
      if (!row.cwd) row.cwd = cwdOf(st, r)
      if (!row.folder) row.folder = r.folder ?? null
      row.nodes.push({ worker: r, depth: 1 }, ...walk(ix, sessionsOf(r), new Set([keyOf(r)]), 2, seen))
    } else {
      // A Hydra Desk chat run as a worker, or a task nothing says which chat started (its dispatcher is gone, or
      // its PC's AgentHydra is too old to say): the row is the worker itself, never a "No chat" heading.
      const row = addRow(st, { id: `${ADDED}${pc ?? ''}:task:${r.id}`, title: r.title, pc, cwd: cwdOf(st, r), folder: r.folder ?? null, at: activity(r), sessionId: r.sessionId, worker: r, job: null }, sessionsOf(r))
      row.nodes.push(...walk(ix, sessionsOf(r), new Set([keyOf(r)]), 1, seen))
    }
  }
}

/** The drawn row whose session a job's caller id names: an 8-character prefix two rows share finds none. */
function rowFinder(rows: readonly NestRow[]): (id: string | null | undefined) => string | undefined {
  const rowOfSession = new Map<string, string>()
  for (const r of rows) for (const s of r.sessionIds) if (!rowOfSession.has(s)) rowOfSession.set(s, r.key)
  const rowsByPrefix = new Map<string, Set<string>>()
  for (const [s, key] of rowOfSession) rowsByPrefix.set(s.slice(0, 8), (rowsByPrefix.get(s.slice(0, 8)) ?? new Set()).add(key))
  return (id) => {
    if (!id) return undefined
    const exact = rowOfSession.get(id)
    if (exact || id.length > 8) return exact
    const same = rowsByPrefix.get(id)
    return same?.size === 1 ? [...same][0] : undefined
  }
}

/** Where a job goes: a drawn row's key, an added row, or nowhere; `make` makes its added row when it has none. */
function homeOf(st: AddedRows, rowFor: (id: string | null | undefined) => string | undefined, j: SwarmJob, make: boolean): string | AddedRow | undefined {
  const row = rowFor(j.callerSessionId) ?? rowFor(j.callerHostSessionId)
  if (row) return row
  const pc = j.pc ?? null
  const sid = j.callerSessionId ?? j.callerHostSessionId
  if (sid) return addedOf(st, pc, sid) ?? (make ? chatRow(st, pc, sid, { title: j.callerTitle || j.title, cwd: null, folder: j.folder ?? null, at: j.startedAt ?? 0 }) : undefined)
  const id = `${ADDED}${pc ?? ''}:job:${j.id}`
  return st.added.get(id) ?? (make ? addRow(st, { id, title: j.title, pc, cwd: null, folder: j.folder ?? null, at: j.startedAt ?? 0, sessionId: null, worker: null, job: j }, []) : undefined)
}

// HSwarm jobs: under the one row that has the caller's session (a job's id may be the 8-character prefix the jobs
// list stamps: a prefix two rows share places nothing, never a guessed row), else under the added row of its
// caller on the job's PC (a CliMayte task of that chat, or that chat run as a worker, may have made it). A running
// job whose caller has none makes it, and one nothing says which chat called is a row itself; a finished one only
// joins a row that is there, as a finished task does.
function placeJobs(st: AddedRows, rows: readonly NestRow[], jobs: readonly SwarmJob[]): Map<string, SwarmJob[]> {
  const jobsByRow = new Map<string, SwarmJob[]>()
  const rowFor = rowFinder(rows)
  const newestJobs = [...jobs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  // The running ones first, so a finished job of the same chat finds the row they made.
  for (const j of newestJobs) if (j.active) homeOf(st, rowFor, j, true)
  for (const j of newestJobs) {
    const home = homeOf(st, rowFor, j, false)
    if (typeof home === 'string') jobsByRow.set(home, [...(jobsByRow.get(home) ?? []), j])
    else if (home && home.job !== j) home.jobs.push(j)
  }
  return jobsByRow
}

function settleAdded(st: AddedRows): void {
  for (const row of st.added.values()) {
    for (const n of row.nodes) row.at = Math.max(row.at, activity(n.worker))
    for (const j of row.jobs) row.at = Math.max(row.at, j.endedAt ?? j.startedAt ?? 0)
    // One that nothing gave a folder takes the first folder name its tasks, then its jobs, have.
    if (!row.cwd && !row.folder) row.folder = row.nodes.find((n) => n.worker.folder)?.worker.folder ?? row.jobs.find((j) => j.folder)?.folder ?? null
  }
}

/** What an added row's dot shows: its worker's or its job's state; a chat's own is not known here, so it is idle. */
export function addedStatus(r: Pick<AddedRow, 'worker' | 'job'>): ExternalSession['status'] {
  const w = r.worker
  if (w?.active) return w.status === 'waiting' ? 'needs_you' : w.status === 'queued' ? 'idle' : 'working'
  return r.job?.active ? 'working' : 'idle'
}

/**
 * How an added row's other-PC cloud pulses (owner, 2026-10-05: gray for remote work, blue for HSwarm's alone): blue
 * for a row that is itself a running HSwarm job, gray while any work it stands for or lists runs or waits in the
 * queue (its worker, its task nodes, a job), null (still, muted) when none does.
 */
export function addedPulse(r: Pick<AddedRow, 'worker' | 'job' | 'nodes' | 'jobs'>): 'gray' | 'blue' | null {
  if (r.job?.active && !r.worker) return 'blue'
  return r.worker?.active || r.job?.active || r.nodes.some((n) => n.worker.active) || r.jobs.some((j) => j.active) ? 'gray' : null
}

/** An added row as the desk list draws it: a row of a session run outside Desk (ExternalRow), with none of Hydra Desk's marks. */
export function addedEntry(r: AddedRow): SidebarEntry {
  const session: ExternalSession = {
    id: r.id,
    title: r.title,
    cwd: r.cwd,
    source: r.worker ? 'climayte' : r.job ? 'other' : 'cli',
    instance: r.worker?.account ?? null,
    status: addedStatus(r),
    activity: r.worker?.lastActivity ?? null,
    lastActivityAt: r.at,
    model: r.worker?.model ?? null,
    accountId: null,
    canResume: false,
    fromPc: r.pc,
    pinned: false,
    archived: false,
    unread: false,
    group: null
  }
  return { kind: 'external', id: r.id, at: r.at, session }
}

/** An added row as the cloud list draws it: one of its rows, another PC's leading with a cloud (CloudList.vue). */
export function addedCloudRow(r: AddedRow): CloudSession {
  const num = r.worker?.account?.match(/^#(\d+)$/)
  return {
    id: r.id,
    title: r.title,
    cwd: r.cwd,
    lastCwd: null,
    source: r.job ? 'zswarm' : 'claude',
    instance: null,
    lastActivityAt: r.at,
    createdAt: r.worker?.startedAt ?? r.job?.startedAt ?? null,
    messageCount: 0,
    dispatched: false,
    archived: false,
    fromPc: r.pc,
    model: r.worker?.model ?? null,
    effort: r.worker?.effort ?? null,
    instanceNum: num ? Number(num[1]) : null
  }
}

/** How a list places the rows added to it: the order both lists keep (order.ts) and the groups Hide left out (hidden.ts). */
export interface AddedPlacing {
  order: SidebarOrder
  hidden: ReadonlySet<string>
  showHidden: boolean
}

/** The key of a group made for another PC's folder known only by its last name (AddedRow.folder). */
const NAME_KEY = 'name:'

/**
 * A list's groups with added rows among their own rows (owner, 2026-10-05: "inline identical"): each in the
 * group of its folder, matched by folder key as the cloud list matches a chat synced from the other PC (paths
 * differ between PCs, so another PC's folder often has no group here). A row known only by its folder's last
 * name (another PC's, AddedRow.folder) goes in the one group whose folder has that name, whatever the path
 * before it; when none has it, or two do (a guess), it goes in a group of that name. Each is put where the list puts its own
 * rows (`sort`, given them newest first). A folder no group has gets one; the groups are listed A-Z (sortFolders),
 * the added ones too; a folder the owner hid keeps them out unless hidden groups are shown, as it does its own rows.
 */
function placeAdded<G extends { label: string }, R>(
  groups: readonly G[],
  rows: readonly R[],
  p: AddedPlacing & {
    /** The folder key a group is the group of ('' for No folder); null for one that is no folder's (Pinned, Archived, a moved-to group). */
    folderOf: (g: G) => string | null
    rowsOf: (g: G) => readonly R[]
    cwdOf: (r: R) => string | null
    /** The last name of the folder of a row `cwdOf` gives none (AddedRow.folder). */
    nameOf: (r: R) => string | null
    at: (r: R) => number
    sort: (rows: R[]) => R[]
    withRows: (g: G, rows: R[]) => G
    make: (folder: string, cwd: string | null, label: string, rows: R[], hidden: boolean) => G
  }
): G[] {
  const newest = (a: R, b: R) => p.at(b) - p.at(a)
  // Each folder key here by its last name (keys are lower case, '/' between parts): the list's groups and the
  // folders this PC's rows bring. A name two folders share maps to null: no guess between them.
  const byName = new Map<string, string | null>()
  const noteName = (key: string) => {
    const name = key.slice(key.lastIndexOf('/') + 1)
    if (name) byName.set(name, byName.has(name) && byName.get(name) !== key ? null : key)
  }
  for (const g of groups) {
    const folder = p.folderOf(g)
    if (folder) noteName(folder)
  }
  for (const r of rows) {
    const cwd = p.cwdOf(r)
    if (cwd) noteName(folderKey(cwd))
  }
  /** A name-only group's label: the name as the other PC spelled it first. */
  const labels = new Map<string, string>()
  const byFolder = new Map<string, R[]>()
  for (const r of rows) {
    const cwd = p.cwdOf(r)
    const name = cwd ? null : p.nameOf(r)
    let folder = cwd ? folderKey(cwd) : ''
    if (name) {
      folder = byName.get(name.toLowerCase()) ?? `${NAME_KEY}${name.toLowerCase()}`
      if (!labels.has(folder)) labels.set(folder, name)
    }
    if (p.hidden.has(folder) && !p.showHidden) continue
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), r])
  }
  const out = groups.map((g) => {
    const folder = p.folderOf(g)
    if (folder === null) return g
    const mine = byFolder.get(folder)
    if (!mine) return g
    byFolder.delete(folder)
    return p.withRows(g, p.sort([...p.rowsOf(g), ...mine].sort(newest)))
  })
  const fresh = [...byFolder].map(([folder, list]) => ({ folder, list: list.sort(newest) })).sort((a, b) => newest(a.list[0]!, b.list[0]!))
  for (const { folder, list } of fresh) {
    // A path group's first row may be a name-only one that joined it: the path is the first row's that has one.
    const cwd = list.map(p.cwdOf).find(Boolean) ?? null
    out.push(p.make(folder, cwd, cwd ? folderLabel(cwd) : (labels.get(folder) ?? NO_FOLDER), p.sort(list), p.hidden.has(folder)))
  }
  return sortFolders(out)
}

/** The desk list's folder groups (logic.ts groupChats) with this PC's added rows, each drawn as an outside session's row (addedEntry) and ordered as a new row of the list. */
export function addToDeskGroups(groups: readonly ChatGroup[], rows: readonly AddedRow[], o: AddedPlacing): ChatGroup[] {
  const names = new Map(rows.map((r) => [r.id, r.folder]))
  return placeAdded<ChatGroup, SidebarEntry>(groups, rows.map(addedEntry), {
    order: o.order,
    hidden: o.hidden,
    showHidden: o.showHidden,
    folderOf: (g) => (g.cwd ? folderKey(g.cwd) : g.key === '' ? '' : null),
    rowsOf: (g) => g.entries,
    cwdOf: (e) => (e.kind === 'chat' ? e.chat.cwd : e.session.cwd) || null,
    nameOf: (e) => names.get(e.id) ?? null,
    at: (e) => e.at,
    sort: (list) => stableOrder(list, (e) => e.id, o.order.rows),
    withRows: (g, entries) => ({ ...g, entries }),
    make: (folder, cwd, label, entries, hidden) => ({ key: cwd ?? folder, label, cwd, entries, ...(hidden ? { hidden } : {}) })
  })
}

/**
 * The cloud list's groups (cloud/logic.ts groupCloud) with the added rows of every PC, each drawn as one of its
 * rows (addedCloudRow) and ordered as the rows only it has: after the desk list's in their group. The groups are
 * listed A-Z (sortFolders). `orderKey` and `onDesk` are the cloud store's.
 */
export function addToCloudGroups(
  groups: readonly CloudGroup[],
  rows: readonly AddedRow[],
  o: AddedPlacing & { orderKey: (id: string) => string; onDesk: (id: string) => boolean }
): CloudGroup[] {
  const names = new Map(rows.map((r) => [r.id, r.folder]))
  return placeAdded<CloudGroup, CloudSession>(groups, rows.map(addedCloudRow), {
    order: o.order,
    hidden: o.hidden,
    showHidden: o.showHidden,
    folderOf: (g) => (g.cwd ? folderKey(g.cwd) : g.orderKey === '' ? '' : null),
    rowsOf: (g) => g.rows,
    cwdOf: (r) => r.cwd,
    nameOf: (r) => names.get(r.id) ?? null,
    at: (r) => r.lastActivityAt,
    sort: (list) => stableOrder(list, (r) => o.orderKey(r.id), o.order.rows, (r) => !o.onDesk(r.id)),
    withRows: (g, list) => ({ ...g, rows: list }),
    make: (folder, cwd, label, list, hidden) => ({ key: `cloud:${folder}`, label, cwd, orderKey: folder, rows: list, ...(hidden ? { hidden } : {}) })
  })
}

/** How many of these lists' CliMayte tasks run: a folded group's heading shows it (RunningBadge.vue), as it does the jobs'. */
export function runningTasksIn(lists: readonly (readonly TaskNode[] | null | undefined)[]): number {
  return lists.reduce((n, l) => n + (l?.filter((t) => t.worker.active).length ?? 0), 0)
}

/** How many of these lists' HSwarm jobs run. */
export function runningJobsIn(lists: readonly (readonly SwarmJob[] | null | undefined)[]): number {
  return lists.reduce((n, l) => n + (l?.filter((j) => j.active).length ?? 0), 0)
}
