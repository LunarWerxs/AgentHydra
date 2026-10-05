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

import type { AccountInfo, AccountRef, CliMayteWorker, ExternalSession, SearchHit, TranscriptItem } from '@shared/protocol'
import { DEFAULT_ACCOUNT, DEFAULT_ACCOUNT_INFO, mapAccounts } from './accounts'
import { activeFor, byRecency, mapRemote, mapWorkers, missingAncestors, RECENT_FINISHED } from './climayte'
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
import { claudeProjectRoots, findSessionJsonl, sessionJsonlItems } from './session-jsonl'
import { createHomeStats } from './stats'
import { createWorkerTokens } from './worker-tokens'
import { resumeAccount, type ResumeData } from './resume'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

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
/** At most this many search rows are kept; the oldest go first. */
const SEARCH_ROWS_MAX = 300

const unreachable = (err: unknown): boolean => err instanceof BridgeError && err.unreachable

export function createBridge(opts: BridgeOptions = {}) {
  const client: HydraClient = createClient(opts)
  const now = opts.now ?? Date.now
  let excludeSessionIds: () => Ids = opts.excludeSessionIds ?? (() => [])
  let extraWorkerIds: () => string[] = () => []
  let sessionMeta: (list: ExternalSession[]) => ExternalSession[] = (list) => list
  let lastWorkers: { at: number; workers: CliMayteWorker[] } | null = null
  const workerTokens = createWorkerTokens()
  const homeStats = createHomeStats(client, now)
  let configDirs: { at: number; byId: Map<string, string> } | null = null
  let instancesRead: { at: number; read: Promise<AhCliInstance[]> } | null = null

  /** The CLI instances, read once per INSTANCES_FRESH_MS however many callers ask (a poll tick asks three ways). */
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

  async function rawWorkers(all = false): Promise<AhWorker[]> {
    return client.workers(all ? {} : { limit: RECENT_FINISHED })
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

  /** The other PCs' workers. An AgentHydra without the route (404), one that fails, or sharing off is none:
   *  never a failure of this PC's list. */
  function remoteWorkers(all = false): Promise<CliMayteWorker[]> {
    return client
      .remoteQueues()
      .then((answer) => mapRemote(answer, { all }))
      .catch(() => [])
  }

  /** This PC's workers and the other PCs' (`pc` set), as the window lists them. */
  async function workers(o: { all?: boolean } = {}): Promise<CliMayteWorker[]> {
    const remote = remoteWorkers(o.all)
    try {
      const raw = await rawWorkers(o.all)
      // Workers matched to a chat that AgentHydra's recent-finished window dropped stay listed under it.
      const have = new Set(raw.map((w) => w.id))
      const missing = extraWorkerIds().filter((id) => !have.has(id))
      if (missing.length) raw.push(...(await client.workersByIds(missing).catch(() => [])))
      if (!o.all) await addAncestors(raw)
      const list = mapWorkers(raw)
      if (list.some((w) => w.active)) workerTokens.apply(list, raw, await instanceDirs())
      // This PC's alone: the engine matches chats to these and counts them, and their ids may repeat the other PCs'.
      lastWorkers = { at: now(), workers: list }
      const others = await remote
      return others.length ? [...list, ...others].sort(byRecency) : list
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

  /** AgentHydra's reads behind the outside sessions, or null when every one failed to reach it (it is down). */
  async function externalInputs(): Promise<ExternalInputs | null> {
    const settle = <T>(p: Promise<T>, empty: T) => p.catch((err) => (unreachable(err) ? Promise.reject(err) : empty))
    const parts = await Promise.allSettled([
      settle(client.agentStatus(), []),
      settle(client.liveSessions(), []),
      settle(client.chats(), []),
      settle(client.sessions(), []),
      settle(rawWorkers(), []),
    ])
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

  async function externalSessions(): Promise<ExternalSession[]> {
    const inp = await externalInputs()
    if (!inp) return []
    const exclude = new Set(await excludeSessionIds())
    const who = await resumeData()
    return sessionMeta(mapExternal(inp, exclude, now(), (q) => resumeAccount(q, who)))
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
  function sessionRoots(): string[] {
    return claudeProjectRoots(knownCliDirs, home)
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
    lastWorkers = null
  }

  /** A new chat as a CliMayte worker; AgentHydra's view of it (its id and the session id it minted). */
  async function startWorker(task: StartWorker): Promise<AhWorker> {
    const r = await client.startWorker(task)
    const w = r.workers[0]
    if (!w) throw new BridgeError('http', 'AgentHydra started no worker for the chat', 502)
    lastWorkers = null
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

  /** Each worker's list as last answered, with the per-file lists it was made of (sessionJsonlItems answers the
   *  same array for a file that has not changed): while none changed, the same list goes back. The newest few. */
  const workerReads = new Map<string, { parts: TranscriptItem[][]; items: TranscriptItem[] }>()
  const WORKER_READS_KEPT = 16

  /**
   * A worker's transcript from its own .jsonl files, in session order (`sessions` then `sessionId`). A move
   * to another account copies the session into that account's folder, so the newest copy of each is read
   * (findSessionJsonl): the transcript follows the worker across accounts. Items repeated in a later
   * session (a resume copies the history) keep their first place. While no file changed it answers the very
   * array it answered last time, so the caller can skip it whole.
   */
  async function workerItems(sessionIds: string[], cwd: string | null, o: { rescan?: boolean } = {}): Promise<TranscriptItem[]> {
    let roots: string[] | null = null
    const parts: TranscriptItem[][] = []
    for (const sid of new Set(sessionIds)) {
      const known = o.rescan ? null : foundAt.get(sid)
      let part = known ? readItems(known, cwd) : null
      if (!part) {
        roots ??= await projectRoots()
        const file = findSessionJsonl(sid, roots, cwd)
        if (!file) continue
        rememberFile(sid, file)
        part = sessionJsonlItems(file, cwd)
      }
      parts.push(part)
    }
    const key = `${sessionIds.join(',')}|${cwd ?? ''}`
    const last = workerReads.get(key)
    if (last && last.parts.length === parts.length && last.parts.every((p, i) => p === parts[i])) return last.items
    const out = new Map<string, TranscriptItem>()
    for (const part of parts) for (const item of part) out.set(item.id, item)
    const items = [...out.values()]
    workerReads.delete(key)
    workerReads.set(key, { parts, items })
    if (workerReads.size > WORKER_READS_KEPT) workerReads.delete(workerReads.keys().next().value as string)
    return items
  }

  async function sendToWorker(id: string, text: string, cwd?: string): Promise<void> {
    const r = await client.sendToWorker(id, text, cwd)
    if (!r.ok) throw new BridgeError('http', r.message || `AgentHydra refused the message to ${id}`, /no such worker/i.test(r.message) ? 404 : 400)
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
    activeWorkersFor,
    /** This PC's workers from the last read (by the poller or a route), without asking AgentHydra; never another PC's. */
    lastWorkers: (): CliMayteWorker[] => lastWorkers?.workers ?? [],
    cancelWorker,
    sendToWorker,
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
    setSessionMeta(fn: (list: ExternalSession[]) => ExternalSession[]): void {
      sessionMeta = fn
    },
    applySessionMeta: (list: ExternalSession[]): ExternalSession[] => sessionMeta(list),
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
    next.setSessionMeta((list) => prev.applySessionMeta(list))
  }
  instance = next
  return next
}
