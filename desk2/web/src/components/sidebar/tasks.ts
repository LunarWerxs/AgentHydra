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
import { folderKey, folderLabel, NO_FOLDER, stableOrder, type ChatGroup, type SidebarEntry, type SidebarOrder } from './logic'

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
}

const ADDED = 'added:'
/** Whether a row is one the sidebar added (AddedRow), by its id. */
export const isAddedRow = (id: string): boolean => id.startsWith(ADDED)

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
 * goes in `added` under the topmost of its dispatchers no row lists either, so every running task is shown
 * once: under the row of the chat that dispatcher came from, titled and placed as `known` (what the window
 * knows of each session) has that chat, else as its PC titles it, else after its first task; or, when
 * nothing says which chat, under the dispatcher's own row (a Desk chat run as a worker is one).
 */
export function nestTasks(
  rows: readonly NestRow[],
  workers: readonly CliMayteWorker[],
  jobs: readonly SwarmJob[] = [],
  known: ReadonlyMap<string, KnownChat> = new Map()
): NestedTasks {
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
  const added = new Map<string, AddedRow>()
  /** Each added row by the sessions it stands for, on its PC (`<pc>|<session>`): a job of one of them joins it. */
  const addedBySession = new Map<string, AddedRow>()
  const activity = (w: CliMayteWorker) => w.lastActivityAt ?? w.startedAt ?? 0
  /** The folder a task runs in: its own, else the one the window knows one of its sessions by (another PC shares no folder for its tasks, but the chat sync may bring their sessions here with theirs). */
  const cwdOf = (w: CliMayteWorker) => w.cwd || [...sessionsOf(w)].map((s) => known.get(s)?.cwd).find(Boolean) || null
  const addRow = (row: Omit<AddedRow, 'nodes' | 'jobs'>, sessions: Iterable<string>): AddedRow => {
    const made: AddedRow = { ...row, nodes: [], jobs: [] }
    added.set(made.id, made)
    for (const s of sessions) if (!addedBySession.has(`${row.pc ?? ''}|${s}`)) addedBySession.set(`${row.pc ?? ''}|${s}`, made)
    return made
  }
  /** The added row of session `sid` on `pc`; a short id (an HSwarm job's 8-character prefix) finds the one row whose session it begins, never a guess between two. */
  const addedOf = (pc: string | null, sid: string): AddedRow | undefined => {
    const exact = addedBySession.get(`${pc ?? ''}|${sid}`)
    if (exact || sid.length > 8) return exact
    const same = new Set([...addedBySession].filter(([k]) => k.startsWith(`${pc ?? ''}|${sid}`)).map(([, row]) => row))
    return same.size === 1 ? [...same][0] : undefined
  }
  /** The row of the chat with session `sid` on `pc`: titled and placed as the window knows that chat, else as `first` (its first task or job) says. */
  const chatRow = (pc: string | null, sid: string, first: { title: string; cwd: string | null; folder: string | null; at: number }): AddedRow => {
    const had = addedOf(pc, sid)
    if (had) return had
    const k = known.get(sid)
    return addRow(
      { id: `${ADDED}${pc ?? ''}:chat:${sid}`, title: k?.title || first.title, pc, cwd: k?.cwd || first.cwd, folder: first.folder, at: Math.max(k?.at ?? 0, first.at), sessionId: sid.length > 8 ? sid : null, worker: null, job: null },
      [sid]
    )
  }
  /** The first non-empty title of the chat each origin stands for, as its PC sent it. */
  const titles = new Map<string, string>()
  for (const r of roots) if (r.originSessionId && r.originTitle && !titles.has(`${r.pc ?? ''}|${r.originSessionId}`)) titles.set(`${r.pc ?? ''}|${r.originSessionId}`, r.originTitle)
  for (const r of roots.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    const pc = r.pc ?? null
    if (r.originSessionId) {
      // The chat that started it, titled as the window knows it, else as its PC titles it, else after its first
      // task (owner, 2026-10-05), with its tasks one step in as under a drawn row.
      const row = chatRow(pc, r.originSessionId, { title: titles.get(`${pc ?? ''}|${r.originSessionId}`) || r.title, cwd: cwdOf(r), folder: r.folder ?? null, at: activity(r) })
      // A row its first task left without a folder takes the first of its other tasks that has one.
      if (!row.cwd) row.cwd = cwdOf(r)
      if (!row.folder) row.folder = r.folder ?? null
      row.nodes.push({ worker: r, depth: 1 }, ...walk(sessionsOf(r), new Set([keyOf(r)]), 2, seen))
    } else {
      // A Hydra Desk chat run as a worker, or a task nothing says which chat started (its dispatcher is gone, or
      // its PC's AgentHydra is too old to say): the row is the worker itself, never a "No chat" heading.
      const row = addRow({ id: `${ADDED}${pc ?? ''}:task:${r.id}`, title: r.title, pc, cwd: cwdOf(r), folder: r.folder ?? null, at: activity(r), sessionId: r.sessionId, worker: r, job: null }, sessionsOf(r))
      row.nodes.push(...walk(sessionsOf(r), new Set([keyOf(r)]), 1, seen))
    }
  }
  // HSwarm jobs: under the one row that has the caller's session (a job's id may be the 8-character prefix the jobs
  // list stamps: a prefix two rows share places nothing, never a guessed row), else under the added row of its
  // caller on the job's PC (a CliMayte task of that chat, or that chat run as a worker, may have made it). A running
  // job whose caller has none makes it, and one nothing says which chat called is a row itself; a finished one only
  // joins a row that is there, as a finished task does.
  const jobsByRow = new Map<string, SwarmJob[]>()
  const rowOfSession = new Map<string, string>()
  for (const r of rows) for (const s of r.sessionIds) if (!rowOfSession.has(s)) rowOfSession.set(s, r.key)
  const rowsByPrefix = new Map<string, Set<string>>()
  for (const [s, key] of rowOfSession) rowsByPrefix.set(s.slice(0, 8), (rowsByPrefix.get(s.slice(0, 8)) ?? new Set()).add(key))
  const rowFor = (id: string | null | undefined): string | undefined => {
    if (!id) return undefined
    const exact = rowOfSession.get(id)
    if (exact || id.length > 8) return exact
    const same = rowsByPrefix.get(id)
    return same?.size === 1 ? [...same][0] : undefined
  }
  /** Where a job goes: a drawn row's key, an added row, or nowhere; `make` makes its added row when it has none. */
  const homeOf = (j: SwarmJob, make: boolean): string | AddedRow | undefined => {
    const row = rowFor(j.callerSessionId) ?? rowFor(j.callerHostSessionId)
    if (row) return row
    const pc = j.pc ?? null
    const sid = j.callerSessionId ?? j.callerHostSessionId
    if (sid) return addedOf(pc, sid) ?? (make ? chatRow(pc, sid, { title: j.callerTitle || j.title, cwd: null, folder: j.folder ?? null, at: j.startedAt ?? 0 }) : undefined)
    const id = `${ADDED}${pc ?? ''}:job:${j.id}`
    return added.get(id) ?? (make ? addRow({ id, title: j.title, pc, cwd: null, folder: j.folder ?? null, at: j.startedAt ?? 0, sessionId: null, worker: null, job: j }, []) : undefined)
  }
  const newestJobs = [...jobs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  // The running ones first, so a finished job of the same chat finds the row they made.
  for (const j of newestJobs) if (j.active) homeOf(j, true)
  for (const j of newestJobs) {
    const home = homeOf(j, false)
    if (typeof home === 'string') jobsByRow.set(home, [...(jobsByRow.get(home) ?? []), j])
    else if (home && home.job !== j) home.jobs.push(j)
  }
  for (const row of added.values()) {
    for (const n of row.nodes) row.at = Math.max(row.at, activity(n.worker))
    for (const j of row.jobs) row.at = Math.max(row.at, j.endedAt ?? j.startedAt ?? 0)
    // One that nothing gave a folder takes the first folder name its tasks, then its jobs, have.
    if (!row.cwd && !row.folder) row.folder = row.nodes.find((n) => n.worker.folder)?.worker.folder ?? row.jobs.find((j) => j.folder)?.folder ?? null
  }
  return { byRow: lists, jobsByRow, added: [...added.values()] }
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
 * rows (`sort`, given them newest first). A folder no group has gets one after the list's groups, newest
 * first, as the cloud list puts the groups only it has; a folder the owner hid keeps them out unless hidden
 * groups are shown, as it does its own rows.
 */
function placeAdded<G, R>(
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
  return out
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
 * rows (addedCloudRow) and ordered as the rows only it has: after the desk list's, unless the saved order places
 * them. `orderKey` and `onDesk` are the cloud store's.
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
