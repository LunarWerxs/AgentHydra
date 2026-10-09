// The bridge to AgentHydra (SPEC.md "The bridge"): accounts, outside sessions, CliMayte workers. The
// engine uses the lazy singleton: `bridge().startWorker()` (a new chat is a CliMayte worker, SPEC
// "Chats are CliMayte workers"), `bridge().activeWorkersFor(sessionId)`, and registers its own chats'
// session ids with `bridge().setExcludeSessionIds(fn)` so they are not listed as "Elsewhere". Which
// account anything runs on is CliMayte's to decide; Hydra Desk keeps no placement of its own.
//
// The worker list the window gets also carries the other PCs' workers (`pc` set, GET /api/corch/remote),
// so the sidebar can show every running task; everything that counts or acts on workers here (accounts in
// use, a chat's workers, activeWorkersFor, lastWorkers) reads this PC's alone.
//
// AgentHydra down never throws out of a list: accounts fall back to the default login, sessions and
// workers to []. Writes (cancel, send) and a single transcript read do throw a BridgeError.

import type { AccountInfo, AccountRef, CliMayteWorker, ExternalSession, SearchHit, SwarmJob, TranscriptItem } from '@shared/protocol'
import { DEFAULT_ACCOUNT, DEFAULT_ACCOUNT_INFO, mapAccounts } from './accounts'
import { CHATS_FRESH_MS, type ChatIndex, JOBS_ASKED, mapRemoteJobs, mapSwarmJobs, SWARM_FRESH_MS } from './swarm'
import { activeFor, byRecency, mapRemote, mapWorkers, missingAncestors, RECENT_FINISHED, reuseWorkers } from './climayte'
import {
  BridgeError,
  createClient,
  type AhCliInstance,
  type AhSearchResult,
  type AhSessionRow,
  type AhWorker,
  type HydraClient,
  type HydraClientOptions,
  type StartWorker,
} from './client'
import { type ExternalInputs, mapExternal, tailToItems, workerDetailToItems } from './external'
import { mapSearch, searchResults } from './search'
import { claudeProjectRoots, findSessionJsonl, sessionJsonlItems, workerJsonlItems } from './session-jsonl'
import { createHomeStats } from './stats'
import { createWorkerTokens } from './worker-tokens'
import { resumeAccount, type ResumeData } from './resume'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

export { BridgeError } from './client'
export { DEFAULT_ACCOUNT } from './accounts'

type Ids = Iterable<string> | Promise<Iterable<string>>

export interface BridgeOptions extends HydraClientOptions {
  /** Session ids of Hydra Desk's own chats, left out of externalSessions(). */
  excludeSessionIds?: () => Ids
  now?: () => number
  /** The home folder holding the default ~/.claude and the Desktop instances (default: the user's). */
  home?: string
  /** Where outside sessions' .jsonl files are looked for (default: claudeProjectRoots with AgentHydra's CLI instances). */
  projectRoots?: () => string[] | Promise<string[]>
}

/** How long activeWorkersFor() reuses the last worker list (the poller refreshes it every 3 s). */
const WORKERS_FRESH_MS = 3000
/** How long one read of AgentHydra's CLI instances serves the account list, the resume matching and the transcript folders. */
const INSTANCES_FRESH_MS = 30_000
/** How long the list of projects folders is reused. */
const ROOTS_FRESH_MS = 10_000
/** How long a search hit's session row (its title, folder, activity time) is reused before it is read again. */
const SEARCH_ROW_FRESH_MS = 60_000
/** How long the 24-hour transcript index and desktop chat list are reused. */
const SESSIONS_FRESH_MS = 10_000
/** How long the other PCs' queues (remote workers) are reused. */
const REMOTES_FRESH_MS = 30_000
/** At most this many search rows are kept; the oldest go first. */
const SEARCH_ROWS_MAX = 300
/** A worker id no worker has, asked to learn whether AgentHydra has deliver-now (canDeliverNow). */
const DELIVER_NOW_PROBE_ID = 'desk-probe-no-such-worker'

const unreachable = (err: unknown): boolean => err instanceof BridgeError && err.unreachable

/** True when `file` is inside `dir` (Windows compares the two without case). */
const isUnder = (file: string, dir: string): boolean => {
  const rel = relative(dir, file)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function createBridge(opts: BridgeOptions = {}) {
  const client: HydraClient = createClient(opts)
  const now = opts.now ?? Date.now
  let excludeSessionIds: () => Ids = opts.excludeSessionIds ?? (() => [])
  let extraWorkerIds: () => string[] = () => []
  let sessionMeta: (list: ExternalSession[]) => ExternalSession[] = (list) => list
  let pinnedIds: () => string[] = () => []
  let lastWorkers: { at: number; workers: CliMayteWorker[] } | null = null
  let lastRawWorkers: { at: number; recent: Promise<AhWorker[]> | null; all: Promise<AhWorker[]> | null } | null = null
  /** Told when this side changed the worker list (a start, a follow-up, a cancel): the poller reads it at once. */
  const workerChange = new Set<() => void>()
  function workersChanged(): void {
    lastWorkers = null
    lastRawWorkers = null
    for (const f of workerChange) f()
  }
  const workerTokens = createWorkerTokens()
  const homeStats = createHomeStats(client, now)
  let configDirs: { at: number; byId: Map<string, string> } | null = null
  let instancesRead: { at: number; read: Promise<AhCliInstance[]> } | null = null
  /** One read shared by every caller for `freshMs`. A failure is never kept as an answer: its callers get the
   *  rejection, and the next caller reads again after a wait that doubles while the route keeps failing (one
   *  worker tick, then two, four, up to `freshMs`), so a route that hangs costs its timeout every few ticks. */
  function sharedRead<T>(freshMs: number, load: () => Promise<T>): () => Promise<T> {
    let slot: { at: number; ms: number; read: Promise<T> } | null = null
    let fails = 0
    return () => {
      if (slot && now() - slot.at < slot.ms) return slot.read
      const entry = { at: now(), ms: freshMs, read: load() }
      slot = entry
      entry.read.then(
        () => {
          fails = 0
        },
        () => {
          fails++
          entry.ms = Math.min(freshMs, WORKERS_FRESH_MS * 2 ** (fails - 1))
        },
      )
      return entry.read
    }
  }

  /* The CLI instances, read once per INSTANCES_FRESH_MS however many callers ask (a poll tick asks three ways). */
  /** The CLI instances' config folders from the last read, for the synchronous sessionRoots(). */
  let knownCliDirs: string[] = []
  function cliInstances(): Promise<AhCliInstance[]> {
    if (instancesRead && now() - instancesRead.at < INSTANCES_FRESH_MS) return instancesRead.read
    const read = client.cliInstances().then((list) => {
      knownCliDirs = list.map((i) => i.configDir)
      return list
    })
    const entry = { at: now(), read }
    instancesRead = entry
    read.catch(() => {
      if (instancesRead === entry) instancesRead = null
    })
    return read
  }
  const home = opts.home ?? homedir()
  let logins: { at: number; data: ResumeData } | null = null

  /** Who is signed in where (desktop instances, CLI instances), for resumeAccount. */
  async function resumeData(): Promise<ResumeData> {
    if (logins && now() - logins.at < INSTANCES_FRESH_MS) return logins.data
    const [desktops, numbers, clis] = await Promise.all([
      client.desktopInstances().catch(() => []),
      client.instanceNumbers().catch(() => []),
      cliInstances().catch(() => []),
    ])
    const key = (p: string) => resolve(p).toLowerCase()
    const emailOf = new Map(numbers.filter((n) => n.kind === 'desktop').map((n) => [key(n.handle), n.email]))
    const data: ResumeData = {
      desktops: desktops.map((d) => ({ num: d.num, name: d.name, label: d.label, dir: d.dir, uuid: d.loginUuid ?? null, email: emailOf.get(key(d.dir)) ?? null })),
      clis,
    }
    logins = { at: now(), data }
    return data
  }

  async function instanceDirs(): Promise<Map<string, string>> {
    if (configDirs && now() - configDirs.at < INSTANCES_FRESH_MS) return configDirs.byId
    const list = await cliInstances().catch(() => [])
    configDirs = { at: now(), byId: new Map(list.map((i) => [i.id, i.configDir])) }
    return configDirs.byId
  }

  async function ping(): Promise<boolean> {
    try {
      await client.health()
      return true
    } catch {
      return false
    }
  }

  async function listAccounts(): Promise<AccountInfo[]> {
    try {
      const [instances, running] = await Promise.all([
        cliInstances(),
        // limit=0: only the active workers (the running ones make their account in use)
        client.workers({ limit: 0 }).catch(() => [] as AhWorker[]),
      ])
      return mapAccounts(instances, running)
    } catch (err) {
      if (unreachable(err)) return [DEFAULT_ACCOUNT_INFO]
      throw err
    }
  }

  /** The account the window shows for 'auto' when it continues an outside session: the default login.
   *  Hydra Desk chooses no account; a new chat is a CliMayte worker and CliMayte places it. */
  async function pickAccount(): Promise<AccountRef> {
    return { ...DEFAULT_ACCOUNT }
  }

  /** Reads once per WORKERS_FRESH_MS; both recent and all share the same tick. */
  function rawWorkers(all = false): Promise<AhWorker[]> {
    if (!lastRawWorkers || now() - lastRawWorkers.at >= WORKERS_FRESH_MS) lastRawWorkers = { at: now(), recent: null, all: null }
    const entry = lastRawWorkers
    // Each list is read only when asked for: the poll needs the recent one, a transcript lookup the full one.
    if (all) return (entry.all ??= client.workers({}))
    return (entry.recent ??= client.workers({ limit: RECENT_FINISHED }))
  }

  /** Adds the finished workers a running one hangs from (its dispatcher, a wave's manager, a few links up)
   *  that AgentHydra's recent-finished window dropped: the sidebar places the running one through them. */
  async function addAncestors(raw: AhWorker[]): Promise<void> {
    for (let round = 0; round < 3; round++) {
      const { ids, waves } = missingAncestors(raw)
      if (!ids.length && !waves.length) return
      const found = await Promise.all([
        ids.length ? client.workersByIds(ids).catch(() => []) : [],
        ...waves.map((wave) => client.workers({ group: `mgr-${wave}` }).catch(() => [])),
      ])
      const have = new Set(raw.map((w) => w.id))
      const fresh = found.flat().filter((w) => !have.has(w.id))
      if (!fresh.length) return
      raw.push(...fresh)
    }
  }

  /** The other PCs' queues, read at most every REMOTES_FRESH_MS. Shared between remoteWorkers and swarmJobs.
   *  An AgentHydra without the route (404) is kept as none; any other failure is retried (sharedRead). */
  const cachedRemoteQueues = sharedRead(REMOTES_FRESH_MS, () =>
    client.remoteQueues().catch((err) => {
      if (err instanceof BridgeError && err.status === 404) return null
      throw err
    }),
  )

  /** The other PCs' workers. An AgentHydra without the route (404), one that fails, or sharing off is none:
   *  never a failure of this PC's list. Read at most every REMOTES_FRESH_MS. */
  function remoteWorkers(all = false): Promise<CliMayteWorker[]> {
    return cachedRemoteQueues().then((answer) => mapRemote(answer ?? undefined, { all })).catch(() => [])
  }

  /** Chat id -> session id and title, from AgentHydra's /api/chats, archived chats included (a finished job's chat is
   *  often archived by now): how a job a Desktop chat started (it has a chat id and no session id) finds its row and
   *  its title. Read at most once per CHATS_FRESH_MS; a failed read keeps the last map. */
  let chatIndex: { at: number; map: ChatIndex } | null = null
  async function chatsIndex(): Promise<ChatIndex> {
    if (chatIndex && now() - chatIndex.at < CHATS_FRESH_MS) return chatIndex.map
    try {
      const rows = await client.chats('include')
      chatIndex = { at: now(), map: new Map(rows.map((r) => [r.chatId, { sessionId: r.sessionId, title: r.title || null }])) }
    } catch {
      chatIndex = { at: now(), map: chatIndex?.map ?? new Map() }
    }
    return chatIndex.map
  }

  /** HSwarm's running jobs and its newest finished ones, then the other PCs' (`pc` set); HSwarm down, off or without
   *  the route is none. One read serves every caller for SWARM_FRESH_MS (the poller asks on its 3 s timer). */
  let lastJobs: { at: number; jobs: Promise<SwarmJob[]> } | null = null
  function swarmJobs(): Promise<SwarmJob[]> {
    if (lastJobs && now() - lastJobs.at < SWARM_FRESH_MS) return lastJobs.jobs
    const jobs = (async () => {
      const [answer, remote, chats] = await Promise.all([
        client.hswarmJobs(JOBS_ASKED).catch(() => null),
        cachedRemoteQueues().catch(() => null),
        chatsIndex(),
      ])
      return [...mapSwarmJobs(answer, chats), ...mapRemoteJobs(remote, chats)]
    })()
    lastJobs = { at: now(), jobs }
    return jobs
  }

  /** This PC's workers and the other PCs' (`pc` set), as the window lists them. */
  async function workers(o: { all?: boolean } = {}): Promise<CliMayteWorker[]> {
    const remote = remoteWorkers(o.all)
    try {
      // A copy: the read is shared by every caller of the tick, none may change it.
      const raw = [...(await rawWorkers(o.all))]
      // Workers matched to a chat that AgentHydra's recent-finished window dropped stay listed under it.
      const have = new Set(raw.map((w) => w.id))
      const missing = extraWorkerIds().filter((id) => !have.has(id))
      if (missing.length) raw.push(...(await client.workersByIds(missing).catch(() => [])))
      if (!o.all) await addAncestors(raw)
      const list = mapWorkers(raw)
      if (list.some((w) => w.active)) workerTokens.apply(list, raw, await instanceDirs())
      // This PC's alone: the engine matches chats to these and counts them, and their ids may repeat the other PCs'.
      const stable = reuseWorkers(lastWorkers?.workers, list)
      lastWorkers = { at: now(), workers: stable }
      const others = await remote
      return others.length ? [...stable, ...others].sort(byRecency) : stable
    } catch (err) {
      if (unreachable(err)) {
        lastWorkers = { at: now(), workers: [] }
        return []
      }
      throw err
    }
  }

  async function activeWorkersFor(originSessionId: string): Promise<CliMayteWorker[]> {
    if (!lastWorkers || now() - lastWorkers.at > WORKERS_FRESH_MS) await workers().catch(() => [])
    return activeFor(lastWorkers?.workers ?? [], originSessionId)
  }

  /** The 24-hour transcript index, read at most every SESSIONS_FRESH_MS. */
  const sessionsIndex = sharedRead(SESSIONS_FRESH_MS, () => client.sessions())

  /** The desktop chats, read at most every SESSIONS_FRESH_MS. */
  const chatsForExternal = sharedRead(SESSIONS_FRESH_MS, () => client.chats())

  /** AgentHydra's reads behind the outside sessions, or null when every one failed to reach it (it is down).
   *  With `strict`, the two reads that are never cached failing to reach it throws their unreachable BridgeError:
   *  the poller reads that as down in place of a ping. */
  async function externalInputs(strict = false): Promise<ExternalInputs | null> {
    const settle = <T>(p: Promise<T>, empty: T) => p.catch((err) => (unreachable(err) ? Promise.reject(err) : empty))
    const parts = await Promise.allSettled([
      settle(client.agentStatus(), []),
      settle(client.liveSessions(), []),
      settle(chatsForExternal(), []),
      settle(sessionsIndex(), []),
      settle(rawWorkers(), []),
    ])
    if (strict && parts[0].status === 'rejected' && parts[1].status === 'rejected') throw parts[0].reason
    if (parts.every((p) => p.status === 'rejected')) return null
    const val = <T>(p: PromiseSettledResult<T>, empty: T): T => (p.status === 'fulfilled' ? p.value : empty)
    return {
      agentStatus: val(parts[0], []),
      live: val(parts[1], []),
      chats: val(parts[2], []),
      sessions: val(parts[3], []),
      workers: val(parts[4], []),
    }
  }

  async function externalSessions(o: { strict?: boolean } = {}): Promise<ExternalSession[]> {
    const inp = await externalInputs(o.strict)
    if (!inp) return []
    const exclude = new Set(await excludeSessionIds())
    const who = await resumeData()
    // A pinned session stays listed however old: the index answer is only the last 24 h, so a pinned id
    // missing from it is read by id, as externalSession(id) does. One AgentHydra does not know is left out.
    const pinned = pinnedIds()
    const known = new Set(inp.sessions.map((s) => s.session_id))
    const extra = (await Promise.all(pinned.filter((id) => !known.has(id)).map((id) => client.session(id).catch(() => null)))).filter(
      (r): r is NonNullable<typeof r> => r !== null,
    )
    const withPinned: ExternalInputs = pinned.length ? { ...inp, sessions: [...inp.sessions, ...extra], wanted: new Set(pinned) } : inp
    return sessionMeta(mapExternal(withPinned, exclude, now(), (q) => resumeAccount(q, who)))
  }

  /**
   * One outside session by id, however old (a search hit from last week): the list's own mapping, with the
   * session's index row read on its own so its age does not leave it out. A 404 BridgeError when AgentHydra
   * does not know it. Hydra Desk's own chats are not left out here: the window asked for this id.
   */
  async function externalSession(id: string): Promise<ExternalSession> {
    const [inp, row] = await Promise.all([
      externalInputs(),
      client.session(id).catch((err) => {
        if (err instanceof BridgeError && err.kind === 'http' && err.status === 404) return null
        throw err
      }),
    ])
    const base: ExternalInputs = inp ?? { agentStatus: [], live: [], chats: [], sessions: [], workers: [] }
    const sessions = row ? [...base.sessions.filter((s) => s.session_id !== id), row] : base.sessions
    const who = await resumeData()
    const found = mapExternal({ ...base, sessions, wanted: new Set([id]) }, new Set(), now(), (q) => resumeAccount(q, who)).find(
      (s) => s.id === id,
    )
    if (!found) throw new BridgeError('http', `AgentHydra does not know session ${id}`, 404)
    return sessionMeta([found])[0] ?? found
  }

  let rootsRead: { at: number; roots: string[] } | null = null

  /** Claude-format projects folders: the default login, Desktop instances and AgentHydra's CLI instances.
   *  Remembered for ROOTS_FRESH_MS: the polls of an open chat would otherwise scan the folders each time. */
  async function projectRoots(): Promise<string[]> {
    if (opts.projectRoots) return opts.projectRoots()
    if (rootsRead && now() - rootsRead.at < ROOTS_FRESH_MS) return rootsRead.roots
    const instances = await cliInstances().catch(() => [])
    const roots = claudeProjectRoots(instances.map((i) => i.configDir))
    rootsRead = { at: now(), roots }
    return roots
  }

  /** Every projects folder a session's transcript can be in, as of the last instance read. */
  let sessionRootsRead: { at: number; dirs: string[]; roots: string[] } | null = null
  function sessionRoots(): string[] {
    if (sessionRootsRead && sessionRootsRead.dirs === knownCliDirs && now() - sessionRootsRead.at < ROOTS_FRESH_MS) return sessionRootsRead.roots
    const roots = claudeProjectRoots(knownCliDirs, home)
    sessionRootsRead = { at: now(), dirs: knownCliDirs, roots }
    return roots
  }

  async function externalItems(sessionId: string): Promise<TranscriptItem[]> {
    // A Claude Code session's own .jsonl keeps every newline, list and code fence; the tail flattens them.
    const known = foundAt.get(sessionId)
    const items = known ? readItems(known) : null
    if (items) return items
    const file = findSessionJsonl(sessionId, await projectRoots())
    if (file) {
      rememberFile(sessionId, file)
      return sessionJsonlItems(file)
    }
    const tail = await client.tail(sessionId)
    if (!tail.error) return tailToItems(tail)
    // Not in the transcript index: a CliMayte worker's session lives in its CLI instance's folder.
    const all = await rawWorkers(true)
    const w = all.find((x) => x.sessionId === sessionId || x.sessions?.includes(sessionId))
    if (!w) throw new BridgeError('http', `AgentHydra has no transcript for session ${sessionId}`, 404)
    return workerDetailToItems(await client.worker(w.id))
  }

  const searchRows = new Map<string, { at: number; row: AhSessionRow | null }>()

  function rememberRow(key: string, row: AhSessionRow | null): void {
    searchRows.delete(key)
    searchRows.set(key, { at: now(), row })
    while (searchRows.size > SEARCH_ROWS_MAX) searchRows.delete(searchRows.keys().next().value as string)
  }

  /** A hit's session row, reused for SEARCH_ROW_FRESH_MS: a search would otherwise read one per hit, every keystroke.
   *  null: the index has no row (remembered) or the read failed or timed out (tried again next time). */
  async function searchRow(r: AhSearchResult, signal?: AbortSignal): Promise<AhSessionRow | null> {
    const key = `${r.source}:${r.session_id}`
    const known = searchRows.get(key)
    if (known && now() - known.at < SEARCH_ROW_FRESH_MS) return known.row
    if (signal?.aborted) return null
    try {
      const row = await client.session(r.session_id, r.source, signal)
      rememberRow(key, row)
      return row
    } catch (err) {
      if (err instanceof BridgeError && err.kind === 'http' && err.status === 404) rememberRow(key, null)
      return null
    }
  }

  /** AgentHydra's transcript search, each hit joined with its session row for the title and activity time.
   *  `signal`: the window's request; once it aborts no more work starts and an `aborted` BridgeError is thrown. */
  async function search(q: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
    const dropped = () => new BridgeError('aborted', `the search for ${JSON.stringify(q)} was dropped by the window`)
    if (signal?.aborted) throw dropped()
    const answer = await client.search(q, limit, signal).catch((err) => {
      // A search that outlives its budget is slow, not down.
      if (err instanceof BridgeError && err.kind === 'timeout') throw new BridgeError('http', err.message, 504)
      throw err
    })
    const results = searchResults(answer)
    if (signal?.aborted) throw dropped()
    const rows = await Promise.all(results.map((r) => searchRow(r, signal)))
    if (signal?.aborted) throw dropped()
    return mapSearch(results, rows, q)
  }

  async function cancelWorker(id: string): Promise<void> {
    const r = await client.cancelWorker(id)
    if (!r.cancelled.includes(id))
      throw new BridgeError('http', `worker ${id} is not active, so there is nothing to cancel`, 409)
    workersChanged()
  }

  /** A new chat as a CliMayte worker; AgentHydra's view of it (its id and the session id it minted). */
  async function startWorker(task: StartWorker): Promise<AhWorker> {
    const r = await client.startWorker(task)
    const w = r.workers[0]
    if (!w) throw new BridgeError('http', 'AgentHydra started no worker for the chat', 502)
    workersChanged()
    return w
  }

  /** These workers by id, however old. */
  function workersByIds(ids: string[]): Promise<AhWorker[]> {
    return ids.length ? client.workersByIds(ids) : Promise.resolve([])
  }

  /** Where each session's JSONL was last found: checked first, so a read is a stat, not a scan of every account folder.
   *  The newest FOUND_KEPT, so a long-lived server does not keep every session it ever read. */
  const foundAt = new Map<string, string>()
  const FOUND_KEPT = 200

  function rememberFile(sessionId: string, file: string): void {
    foundAt.delete(sessionId)
    foundAt.set(sessionId, file)
    if (foundAt.size > FOUND_KEPT) foundAt.delete(foundAt.keys().next().value as string)
  }

  /** A file's items, or null when the file is gone (the stat of the read says so; no separate existence check). */
  function readItems(file: string, cwd?: string | null): TranscriptItem[] | null {
    try {
      return sessionJsonlItems(file, cwd)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** A session file as its part of a worker's list was read: the stat taken before the read, and the items made from it. */
  interface WorkerPart {
    file: string
    ino: number
    size: number
    mtimeMs: number
    items: TranscriptItem[]
  }
  /** Each worker's list as last answered, with the part each session was read as: while none changed, the same list goes back. The newest few. */
  const workerReads = new Map<string, { cwd: string | null; parts: Map<string, WorkerPart>; items: TranscriptItem[] }>()
  const WORKER_READS_KEPT = 16
  /** Searches that found no file, by what was searched: when, and how long to leave it before searching again (doubling, to SESSION_MISS_MAX_MS). */
  const notFound = new Map<string, { at: number; wait: number }>()
  const SESSION_MISS_MS = 5_000
  const SESSION_MISS_MAX_MS = 60_000
  /** Whether a search for `key` found nothing recently enough to skip it: looking in every project folder of an account costs a stat each. */
  const searchedLately = (key: string): boolean => {
    const miss = notFound.get(key)
    return miss !== undefined && now() - miss.at < miss.wait
  }
  const rememberMiss = (key: string): void => {
    notFound.set(key, { at: now(), wait: Math.min(SESSION_MISS_MAX_MS, (notFound.get(key)?.wait ?? SESSION_MISS_MS / 2) * 2) })
    if (notFound.size > 2048) notFound.delete(notFound.keys().next().value as string)
  }

  function statOf(file: string): Pick<WorkerPart, 'ino' | 'size' | 'mtimeMs'> | null {
    try {
      const st = statSync(file)
      return { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** A session's part as any worker list of this folder read it, while its file is unchanged: a stat, no parse. */
  function unchangedPart(sid: string, file: string, cwd: string | null): WorkerPart | null {
    const st = statOf(file)
    if (!st) return null
    for (const read of workerReads.values()) {
      const prev = read.cwd === cwd ? read.parts.get(sid) : undefined
      if (prev && prev.file === file && prev.ino === st.ino && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev
    }
    return null
  }

  /** The file read now, its stat taken first: a file that changes during the read is read again next poll. */
  async function readPart(file: string, cwd: string | null): Promise<WorkerPart | null> {
    const st = statOf(file)
    if (!st) return null
    try {
      return { file, ...st, items: await workerJsonlItems.readAsync(file, cwd) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /**
   * A worker's transcript from its own .jsonl files, in session order (`sessions` then `sessionId`). A move
   * to another account copies the session into that account's folder, so the newest copy of each is read
   * (findSessionJsonl): the transcript follows the worker across accounts. Items repeated in a later
   * session (a resume copies the history) keep their first place. While no file changed it answers the very
   * array it answered last time, so the caller can skip it whole.
   *
   * `writing`: the session the worker writes now and its account. That session is read from the account's
   * own folder whenever a copy is there. The copy a move makes keeps the old file's time, so the newest-copy
   * rule tied and could keep the old account's copy, and nothing looked again: a chat moved #109 to #124
   * on 2026-10-05 showed none of the four replies that followed ("I've sent like seven chats ... nothing happens").
   */
  async function workerItems(
    sessionIds: string[],
    cwd: string | null,
    o: { rescan?: boolean; writing?: { sessionId: string; accountId: string } } = {},
  ): Promise<TranscriptItem[]> {
    let roots: string[] | null = null
    const ownDir = o.writing ? (await instanceDirs()).get(o.writing.accountId) : undefined
    const ownRoot = ownDir ? join(ownDir, 'projects') : null
    const parts = new Map<string, WorkerPart>()
    for (const sid of new Set(sessionIds)) {
      // One session's parse at a time: the requests and timers run between two sessions, not after all of them.
      await new Promise((done) => setImmediate(done))
      let known = o.rescan ? null : foundAt.get(sid)
      if (ownRoot && sid === o.writing?.sessionId && !(known && isUnder(known, ownRoot))) {
        const ownKey = `${ownRoot}|${sid}`
        const own = !o.rescan && searchedLately(ownKey) ? null : findSessionJsonl(sid, [ownRoot], cwd)
        if (own) {
          notFound.delete(ownKey)
          rememberFile(sid, own)
          known = own
        } else if (!o.rescan) rememberMiss(ownKey)
      }
      let part = known ? (unchangedPart(sid, known, cwd) ?? (await readPart(known, cwd))) : null
      if (!part) {
        // A session with no file yet: every project folder of every account is looked in, so not on every poll.
        if (!o.rescan && searchedLately(sid)) continue
        roots ??= await projectRoots()
        const file = findSessionJsonl(sid, roots, cwd)
        if (file) {
          rememberFile(sid, file)
          part = await readPart(file, cwd)
        }
        if (!part) {
          rememberMiss(sid)
          continue
        }
        notFound.delete(sid)
      }
      parts.set(sid, part)
    }
    const key = `${sessionIds.join(',')}|${cwd ?? ''}`
    const last = workerReads.get(key)
    if (last && last.parts.size === parts.size && [...parts].every(([sid, part]) => last.parts.get(sid) === part)) return last.items
    const out = new Map<string, TranscriptItem>()
    for (const part of parts.values()) for (const item of part.items) out.set(item.id, item)
    const items = [...out.values()]
    workerReads.delete(key)
    workerReads.set(key, { cwd, parts, items })
    if (workerReads.size > WORKER_READS_KEPT) workerReads.delete(workerReads.keys().next().value as string)
    return items
  }

  async function sendToWorker(id: string, text: string, cwd?: string, urgent = false, desk?: StartWorker['desk']): Promise<boolean> {
    const r = await client.sendToWorker(id, text, cwd, urgent, desk)
    if (!r.ok) throw new BridgeError('http', r.message || `AgentHydra refused the message to ${id}`, /no such worker/i.test(r.message) ? 404 : 400)
    // A follow-up can wake a finished worker.
    workersChanged()
    return r.urgent === true
  }

  /** An AgentHydra from before deliver-now (v1.10.0 and older) answers its own 404 page. */
  const noDeliverNow = (err: unknown) => err instanceof BridgeError && err.kind === 'bad_json' && err.status === 404
  /** Whether the AgentHydra of that version has deliver-now: an update changes the version, and the answer with it. */
  let deliverNowIn: { version: string; ok: boolean } | null = null

  /** Whether Send now can name a message the worker already holds (deliver-now). Asked once per AgentHydra version,
   *  with a worker id no worker has: deliver-now answers "No such worker", an AgentHydra without it its 404 page. */
  async function canDeliverNow(): Promise<boolean> {
    const version = (await client.health().catch(() => null))?.version
    // Unreachable: the send that follows says so.
    if (version === undefined) return true
    if (deliverNowIn?.version === version) return deliverNowIn.ok
    try {
      await client.deliverNow(DELIVER_NOW_PROBE_ID)
    } catch (err) {
      if (!noDeliverNow(err)) return true
      deliverNowIn = { version, ok: false }
      return false
    }
    deliverNowIn = { version, ok: true }
    return true
  }

  /** Send now on a message the worker holds: `stopped` when its running turn was stopped for it, else AgentHydra's why. */
  async function sendToWorkerNow(id: string, text?: string): Promise<{ stopped: boolean; message: string }> {
    let r: Awaited<ReturnType<typeof client.deliverNow>>
    try {
      r = await client.deliverNow(id, text)
    } catch (err) {
      if (noDeliverNow(err)) {
        const version = (await client.health().catch(() => null))?.version
        if (version !== undefined) deliverNowIn = { version, ok: false }
        throw new BridgeError(
          'http',
          `this AgentHydra${version ? ` (version ${version})` : ''} has no Send now for a message it already holds; it goes when the current task ends. Update AgentHydra to send it now`,
          404,
        )
      }
      throw err
    }
    if (!r.ok) throw new BridgeError('http', r.message || `AgentHydra refused to send ${id}'s message now`, /no such worker/i.test(r.message) ? 404 : 400)
    workersChanged()
    return { stopped: r.stopped === true, message: r.message ?? '' }
  }

  return {
    url: client.url,
    client,
    ping,
    async status(): Promise<{ up: boolean; url: string }> {
      return { up: await ping(), url: client.url }
    },
    listAccounts,
    pickAccount,
    externalSessions,
    externalSession,
    externalItems,
    search,
    sessionRoots,
    workers,
    swarmJobs,
    activeWorkersFor,
    /** This PC's workers from the last read (by the poller or a route), without asking AgentHydra; never another PC's. */
    lastWorkers: (): CliMayteWorker[] => lastWorkers?.workers ?? [],
    /** Calls `f` whenever this side changed the worker list; returns the call that stops it. */
    onWorkersChanged(f: () => void): () => void {
      workerChange.add(f)
      return () => {
        workerChange.delete(f)
      }
    },
    cancelWorker,
    sendToWorker,
    canDeliverNow,
    sendToWorkerNow,
    startWorker,
    workersByIds,
    workerItems,
    /** The home screen's stats card, consolidated over every source AgentHydra counts (stats.ts). */
    homeStats,
    setExtraWorkerIds(fn: () => string[]): void {
      extraWorkerIds = fn
    },
    setExcludeSessionIds(fn: () => Ids): void {
      excludeSessionIds = fn
    },
    excludeIds: (): Ids => excludeSessionIds(),
    extraIds: (): string[] => extraWorkerIds(),
    /** Registers Hydra Desk's marks on outside sessions (the engine's session-meta store); externalSessions() applies them. */
    setSessionMeta(fn: (list: ExternalSession[]) => ExternalSession[], pinned: () => string[] = () => []): void {
      sessionMeta = fn
      pinnedIds = pinned
    },
    applySessionMeta: (list: ExternalSession[]): ExternalSession[] => sessionMeta(list),
    pinnedSessionIds: (): string[] => pinnedIds(),
  }
}

export type Bridge = ReturnType<typeof createBridge>

let instance: Bridge | null = null

/** The process's bridge (HYDRA_URL, default http://127.0.0.1:7787), made on first use. */
export function bridge(): Bridge {
  instance ??= createBridge()
  return instance
}

/** Replaces the singleton (the plugin does this when ctx.deps names another AgentHydra url). The
 *  exclude function registered on the old one carries over. */
export function configureBridge(opts: BridgeOptions): Bridge {
  const next = createBridge(opts)
  if (instance && !opts.excludeSessionIds) {
    const prev = instance
    next.setExcludeSessionIds(() => prev.excludeIds())
    next.setExtraWorkerIds(() => prev.extraIds())
    next.setSessionMeta((list) => prev.applySessionMeta(list), () => prev.pinnedSessionIds())
  }
  instance = next
  return next
}
