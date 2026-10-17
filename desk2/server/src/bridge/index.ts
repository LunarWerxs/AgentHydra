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
// AgentHydra down never throws out of a list. A list it did not answer (a relaunch after an update, a
// stalled event loop, one read past its timeout) is answered with its last answer for KEEP_LAST_MS:
// treating a missed read as "none" emptied the sidebar and put ids in place of titles for one poll
// (owner, 2026-10-09: chats "mass disappear, then they mass reappear"). Past that, accounts fall back
// to the default login, sessions and workers to []. Writes (cancel, send) and a single transcript read
// do throw a BridgeError.

import { type SearchResult, searchResult } from '@shared/find'
import { SESSION_FINISHED, type AccountInfo, type AccountRef, type CliMayteWorker, type ExternalSession, type SearchHit, type SessionTasks, type SwarmJob, type TranscriptIndex, type TranscriptItem } from '@shared/protocol'
import { isThrowawayCwd } from '@shared/throwaway'
import { mapAccounts, pickHealthy } from './accounts'
import { CHATS_FRESH_MS, type ChatIndex, JOBS_ASKED, jobDirs, mapRemoteJobs, mapSwarmJobs, SWARM_FRESH_MS } from './swarm'
import { attachJobModels } from './swarm-models'
import { activeFor, byRecency, mapRemote, mapWorkers, missingAncestors, RECENT_FINISHED, reuseWorkers, workersOfChat } from './climayte'
import {
  BridgeError,
  createClient,
  type AhAgentStatus,
  type AhChatRow,
  type AhCliInstance,
  type AhCodexChatRow,
  type AhLiveSession,
  type AhSearchResult,
  type AhSessionRow,
  type AhTail,
  type AhWorker,
  type HydraClient,
  type HydraClientOptions,
  type StartWorker,
  type WorkerSendSetting,
} from './client'
import { type ExternalInputs, mapExternal, STALE_AFTER_MS, tailToItems, workerDetailToItems } from './external'
import { mapSearch, searchResults } from './search'
import { buildTranscriptIndex } from '@shared/transcript-index'
import { codexTurnCount, codexTurnOpen, findCodexRollout, lastCodexContext } from './codex-rollout'
import { createBackgroundTasks } from './background-tasks'
import { claudeProjectRoots, findSessionJsonlAsync, lastContextTokens, sessionJsonlItems, sessionJsonlOlder, sessionJsonlStart, workerJsonlItems } from './session-jsonl'
import { createHomeStats } from './stats'
import { createWorkerTokens } from './worker-tokens'
import { resumeAccount, withDesktopAccounts, type ResumeData } from './resume'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

export { BridgeError } from './client'

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
/** How long one read of a session's own workers and jobs (sessionTasks) serves every window showing it. */
const SESSION_TASKS_FRESH_MS = 5000
/** The sessions whose last read sessionTasks keeps (a window shows one at a time; a few windows, a few more). */
const SESSION_TASKS_KEPT = 20
/** At most this many pages of a Codex chat's tail (6 MB each) are read above its newest. */
const OLDER_PAGES = 32
/** At most this many search rows are kept; the oldest go first. */
const SEARCH_ROWS_MAX = 300
/** The Codex homes (accounts come and go rarely) are asked again after this long. */
const CODEX_HOMES_FRESH_MS = 5 * 60_000
/** A session with no rollout found is looked for again after this long (a Codex thread's file appears with its first turn). */
const ROLLOUT_MISS_MS = 60_000
/** A worker id no worker has, asked to learn whether AgentHydra has deliver-now (canDeliverNow). */
const DELIVER_NOW_PROBE_ID = 'desk-probe-no-such-worker'
/**
 * How long a list read that failed is answered with its last answer. Longer than the poller's DOWN_GRACE_MS, so
 * the lists hold until the poller says AgentHydra is down. Measured 2026-10-09: AgentHydra's minute sweep held its
 * event loop ~4 s (the read timeout) and its auto-update relaunched it 36 times that day.
 */
export const KEEP_LAST_MS = 2 * 60_000
/** At most this many sessions' titles are remembered (knownTitle); the oldest go first. */
const TITLES_KEPT = 2000

const unreachable = (err: unknown): boolean => err instanceof BridgeError && err.unreachable

/** One list's last answer: `ok` keeps an answer and returns it, `get` returns the kept one while it is KEEP_LAST_MS old at most. */
interface Kept<T> {
  ok(value: T): T
  get(): T | undefined
}

/** True when `file` is inside `dir` (Windows compares the two without case). */
const isUnder = (file: string, dir: string): boolean => {
  const rel = relative(dir, file)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function createBridge(opts: BridgeOptions = {}) {
  const client: HydraClient = createClient(opts)
  const now = opts.now ?? Date.now
  function keepLast<T>(): Kept<T> {
    let last: { at: number; value: T } | null = null
    return {
      ok(value) {
        last = { at: now(), value }
        return value
      },
      get: () => (last && now() - last.at < KEEP_LAST_MS ? last.value : undefined),
    }
  }
  let excludeSessionIds: () => Ids = opts.excludeSessionIds ?? (() => [])
  /** More session ids to leave out, beside the engine's (the new core's chats, plugins/19-core.ts). */
  const moreExcluded: (() => Ids)[] = []
  const excludedIds = async (): Promise<Set<string>> => {
    const out = new Set(await excludeSessionIds())
    for (const more of moreExcluded) for (const id of await more()) out.add(id)
    return out
  }
  let extraWorkerIds: () => string[] = () => []
  let sessionMeta: (list: ExternalSession[], onAccount?: ReadonlySet<string>) => ExternalSession[] = (list) => list
  /** The sessions kept listed however old: pinned, or in the Unassigned holding area (session-meta.ts listedIds). */
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
      const dirs = list.map((i) => i.configDir)
      // A folder that appeared since the last read may hold a session a miss already looked for: look again.
      if (dirs.join('\n') !== knownCliDirs.join('\n')) notFound.clear()
      knownCliDirs = dirs
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
    // A failed read answers this call with what it has, but is not kept: a cached empty list would
    // leave every chat without its account for the next 30 s, though the next read may succeed. A 404
    // is an AgentHydra without the route, a lasting answer, and is kept.
    let failed = false
    const none = (err: unknown) => {
      if (!(err instanceof BridgeError && err.kind === 'http' && err.status === 404)) failed = true
      return []
    }
    const [desktops, numbers, clis] = await Promise.all([
      client.desktopInstances().catch(none),
      client.instanceNumbers().catch(none),
      cliInstances().catch(none),
    ])
    const key = (p: string) => resolve(p).toLowerCase()
    const emailOf = new Map(numbers.filter((n) => n.kind === 'desktop').map((n) => [key(n.handle), n.email]))
    const data: ResumeData = {
      desktops: desktops.map((d) => ({ num: d.num, name: d.name, label: d.label, dir: d.dir, uuid: d.loginUuid ?? null, email: emailOf.get(key(d.dir)) ?? null })),
      clis,
    }
    if (!failed) logins = { at: now(), data }
    return data
  }

  async function instanceDirs(): Promise<Map<string, string>> {
    if (configDirs && now() - configDirs.at < INSTANCES_FRESH_MS) return configDirs.byId
    let list: AhCliInstance[]
    try {
      list = await cliInstances()
    } catch {
      // Not kept: the last good map stands (or an empty one this once), and the next call reads again.
      return configDirs?.byId ?? new Map()
    }
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

  const keptAccounts = keepLast<AccountInfo[]>()
  async function listAccounts(): Promise<AccountInfo[]> {
    try {
      const [instances, running] = await Promise.all([
        cliInstances(),
        // limit=0: only the active workers (the running ones make their account in use)
        client.workers({ limit: 0 }).catch(() => [] as AhWorker[]),
      ])
      return keptAccounts.ok(mapAccounts(instances, running))
    } catch (err) {
      if (unreachable(err)) return keptAccounts.get() ?? []
      throw err
    }
  }

  /** The account 'auto' would place a chat on now: one with room, the least used first; null when none has room. */
  async function pickAccount(): Promise<AccountRef | null> {
    return pickHealthy(await listAccounts(), new Set())
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

  /** The other PCs' workers. An AgentHydra without the route (404) or sharing off is none, one that fails its last
   *  answer (KEEP_LAST_MS) or none: never a failure of this PC's list. Read at most every REMOTES_FRESH_MS. */
  const keptRemote = { recent: keepLast<CliMayteWorker[]>(), all: keepLast<CliMayteWorker[]>() }
  function remoteWorkers(all = false): Promise<CliMayteWorker[]> {
    const kept = all ? keptRemote.all : keptRemote.recent
    return cachedRemoteQueues().then(
      (answer) => kept.ok(mapRemote(answer ?? undefined, { all })),
      () => kept.get() ?? [],
    )
  }

  /** Chat id -> session id and title, from AgentHydra's /api/chats, archived chats included (a finished job's chat is
   *  often archived by now): how a job a Desktop chat started (it has a chat id and no session id) finds its row and
   *  its title. Read at most once per CHATS_FRESH_MS; a failed read keeps the last map. */
  let chatIndex: { at: number; map: ChatIndex; titles: Map<string, string> } | null = null
  async function chatsIndex(): Promise<ChatIndex> {
    if (chatIndex && now() - chatIndex.at < CHATS_FRESH_MS) return chatIndex.map
    try {
      const rows = await client.chats('include')
      // Every record's title by session: a chat moved to another account keeps its title on the archived copy
      // it left behind, while its new record can be untitled for a moment.
      const titles = new Map<string, string>()
      for (const r of rows) if (r.sessionId && r.title && !titles.has(r.sessionId)) titles.set(r.sessionId, r.title)
      chatIndex = { at: now(), map: new Map(rows.map((r) => [r.chatId, { sessionId: r.sessionId, title: r.title || null }])), titles }
    } catch {
      chatIndex = { at: now(), map: chatIndex?.map ?? new Map(), titles: chatIndex?.titles ?? new Map() }
    }
    return chatIndex.map
  }

  /** The title each outside session was last listed with: the list never trades a known title for the id. The newest TITLES_KEPT. */
  const shownTitles = new Map<string, string>()
  function rememberTitles(list: ExternalSession[]): void {
    for (const s of list) {
      if (!s.title || s.title === s.id.slice(0, 8) || shownTitles.get(s.id) === s.title) continue
      shownTitles.delete(s.id)
      shownTitles.set(s.id, s.title)
    }
    while (shownTitles.size > TITLES_KEPT) shownTitles.delete(shownTitles.keys().next().value as string)
  }
  /** A title for a session whose chat record and index row have none: the one it was last listed with, else any
   *  record's from the last read of every chat (archived included, read for the HSwarm jobs; never awaited here). */
  const knownTitle = (id: string): string | undefined => shownTitles.get(id) ?? chatIndex?.titles.get(id)

  /** HSwarm's running jobs and its newest finished ones, then the other PCs' (`pc` set); HSwarm off or without the
   *  route is none, AgentHydra out of reach or HSwarm not answering the last answer (KEEP_LAST_MS). One read serves
   *  every caller for SWARM_FRESH_MS (the poller asks on its 3 s timer). */
  let lastJobs: { at: number; jobs: Promise<SwarmJob[]> } | null = null
  const keptJobs = keepLast<SwarmJob[]>()
  function swarmJobs(): Promise<SwarmJob[]> {
    if (lastJobs && now() - lastJobs.at < SWARM_FRESH_MS) return lastJobs.jobs
    const jobs = (async () => {
      let missed = false
      const miss = (err: unknown) => {
        if (unreachable(err)) missed = true
        return null
      }
      // An HSwarm that runs but answers nobody (AgentHydra's proxy says 502) still runs its jobs: the last list stands,
      // as when AgentHydra is out of reach, so job lines and the tasks placed by them do not drop out and come back
      // (owner, 2026-10-09: the sidebar "jackhammers"). One AgentHydra says is off (503) lists none.
      const swarmMiss = (err: unknown) => {
        if (err instanceof BridgeError && (err.status === 502 || err.status === 504)) missed = true
        return miss(err)
      }
      const [answer, remote, chats] = await Promise.all([client.hswarmJobs(JOBS_ASKED).catch(swarmMiss), cachedRemoteQueues().catch(miss), chatsIndex()])
      const kept = missed ? keptJobs.get() : undefined
      return kept ?? keptJobs.ok(await attachJobModels([...mapSwarmJobs(answer, chats), ...mapRemoteJobs(remote, chats)], jobDirs(answer)))
    })()
    lastJobs = { at: now(), jobs }
    return jobs
  }

  /** This PC's workers and the other PCs' (`pc` set), as the window lists them; AgentHydra out of reach, the last
   *  answer (KEEP_LAST_MS), so a chat's running tasks do not read as finished for one poll. */
  const keptWorkers = { recent: keepLast<CliMayteWorker[]>(), all: keepLast<CliMayteWorker[]>() }
  async function workers(o: { all?: boolean } = {}): Promise<CliMayteWorker[]> {
    const kept = o.all ? keptWorkers.all : keptWorkers.recent
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
      if (list.some((w) => w.active)) await workerTokens.apply(list, raw, await instanceDirs())
      // This PC's alone: the engine matches chats to these and counts them, and their ids may repeat the other PCs'.
      const stable = reuseWorkers(lastWorkers?.workers, list)
      lastWorkers = { at: now(), workers: stable }
      const others = await remote
      return kept.ok(others.length ? [...stable, ...others].sort(byRecency) : stable)
    } catch (err) {
      if (unreachable(err)) {
        const last = kept.get()
        // lastWorkers is this PC's alone (the window's list carries the other PCs' too).
        lastWorkers = { at: now(), workers: last?.filter((w) => !w.pc) ?? [] }
        return last ?? []
      }
      throw err
    }
  }

  /** One session's own workers and jobs (SessionTasks), read at most every SESSION_TASKS_FRESH_MS per session. Each
   *  answer is cut to the session's own here too: an older AgentHydra or HSwarm ignores the filter and answers its newest
   *  of the whole PC. A jobs read that fails (HSwarm off, deaf or out of reach) keeps the session's last jobs. */
  const sessionReads = new Map<string, { at: number; answer: Promise<SessionTasks>; kept: { jobs: SwarmJob[] } }>()
  function sessionTasks(sessionId: string): Promise<SessionTasks> {
    const hit = sessionReads.get(sessionId)
    if (hit && now() - hit.at < SESSION_TASKS_FRESH_MS) return hit.answer
    const kept = { jobs: hit?.kept.jobs ?? [] }
    const answer = (async (): Promise<SessionTasks> => {
      const chats = await chatsIndex()
      // A Claude Desktop chat's jobs name its chat id, not its session.
      const hosts = [...chats].filter(([, c]) => c.sessionId === sessionId).map(([id]) => id)
      const [raw, jobs] = await Promise.all([
        client.workers({ origin: [sessionId], limit: SESSION_FINISHED }),
        client.hswarmJobs(SESSION_FINISHED, [sessionId, ...hosts]).catch(() => null),
      ])
      // A chat that is itself a worker is not in the answer, yet the workers it dispatched name it: read it, so they
      // place under its session.
      const have = new Set(raw.map((w) => w.id))
      const up = [...new Set(raw.flatMap((w) => (w.origin?.kind === 'worker' && !have.has(w.origin.workerId) ? [w.origin.workerId] : [])))]
      const all = up.length ? [...raw, ...(await client.workersByIds(up).catch(() => []))] : raw
      if (jobs) {
        const mine = mapSwarmJobs(jobs, chats, SESSION_FINISHED).filter((j) => j.callerSessionId === sessionId || j.callerHostSessionId === sessionId)
        kept.jobs = await attachJobModels(mine, jobDirs(jobs))
      }
      return { sessionId, workers: workersOfChat(mapWorkers(all), { sessionId }), jobs: kept.jobs }
    })()
    const entry = { at: now(), answer, kept }
    sessionReads.delete(sessionId)
    sessionReads.set(sessionId, entry)
    while (sessionReads.size > SESSION_TASKS_KEPT) sessionReads.delete(sessionReads.keys().next().value as string)
    // A failed read is not kept: the next ask reads again.
    answer.catch(() => {
      if (sessionReads.get(sessionId) === entry) sessionReads.set(sessionId, { ...entry, at: 0 })
    })
    return answer
  }

  async function activeWorkersFor(originSessionId: string): Promise<CliMayteWorker[]> {
    if (!lastWorkers || now() - lastWorkers.at > WORKERS_FRESH_MS) await workers().catch(() => [])
    return activeFor(lastWorkers?.workers ?? [], originSessionId)
  }

  /** The 24-hour transcript index, read at most every SESSIONS_FRESH_MS. */
  const sessionsIndex = sharedRead(SESSIONS_FRESH_MS, () => client.sessions())

  /** The desktop chats, read at most every SESSIONS_FRESH_MS. */
  const chatsForExternal = sharedRead(SESSIONS_FRESH_MS, () => client.chats())

  /** Every Codex account's unarchived chats, read at most every SESSIONS_FRESH_MS. */
  const codexChatsForExternal = sharedRead(SESSIONS_FRESH_MS, () => client.codexChats())

  const keptInputs = {
    agentStatus: keepLast<AhAgentStatus[]>(),
    live: keepLast<AhLiveSession[]>(),
    chats: keepLast<AhChatRow[]>(),
    codexChats: keepLast<AhCodexChatRow[]>(),
    sessions: keepLast<AhSessionRow[]>(),
    workers: keepLast<AhWorker[]>(),
  }

  /**
   * AgentHydra's reads behind the outside sessions, or null when none answered and none was kept (it is down).
   * A read that failed, for any reason, is its last answer (KEEP_LAST_MS), else none: read as "no chats", one chat
   * list past its 4 s timeout took every Desktop chat out of the list, or left the live ones with their ids for
   * titles, until the next poll (2026-10-09, while AgentHydra's minute sweep held its event loop).
   * With `strict`, the two reads that are never cached both failing to reach it throws their unreachable
   * BridgeError: the poller reads that as down in place of a ping.
   */
  async function externalInputs(strict = false): Promise<ExternalInputs | null> {
    const [agentStatus, live, chats, codexChats, sessions, workers] = await Promise.allSettled([
      client.agentStatus(),
      client.liveSessions(),
      chatsForExternal(),
      codexChatsForExternal(),
      sessionsIndex(),
      rawWorkers(),
    ])
    if (strict && agentStatus.status === 'rejected' && live.status === 'rejected' && unreachable(agentStatus.reason) && unreachable(live.reason))
      throw agentStatus.reason
    const pick = <T>(p: PromiseSettledResult<T>, kept: Kept<T>): T | undefined => (p.status === 'fulfilled' ? kept.ok(p.value) : kept.get())
    const got = {
      agentStatus: pick(agentStatus, keptInputs.agentStatus),
      live: pick(live, keptInputs.live),
      chats: pick(chats, keptInputs.chats),
      codexChats: pick(codexChats, keptInputs.codexChats),
      sessions: pick(sessions, keptInputs.sessions),
      workers: pick(workers, keptInputs.workers),
    }
    if (Object.values(got).every((v) => v === undefined)) return null
    return {
      agentStatus: got.agentStatus ?? [],
      live: got.live ?? [],
      chats: got.chats ?? [],
      codexChats: got.codexChats ?? [],
      sessions: got.sessions ?? [],
      workers: got.workers ?? [],
      codexTurns: await codexTurns(got.codexChats ?? []),
      background: await backgroundTasks.read(got.live ?? []),
    }
  }

  /** Each live engine's open background tasks, read where its transcript grew (background-tasks.ts). */
  const backgroundTasks = createBackgroundTasks()

  /** Whether each Codex thread active in the last STALE_AFTER_MS has its last turn open (codex-rollout.ts codexTurnOpen),
   *  kept by the rollout's size and mtime, so a file that has not changed is not read again. */
  const turnKept = new Map<string, { key: string; open: boolean }>()
  async function codexTurns(chats: readonly AhCodexChatRow[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>()
    const recent = chats.filter((c) => {
      const at = c.lastActivityAt ? Date.parse(c.lastActivityAt) : Number.NaN
      return Number.isFinite(at) && now() - at <= STALE_AFTER_MS
    })
    const recentIds = new Set(recent.map((c) => c.threadId))
    for (const id of turnKept.keys()) if (!recentIds.has(id)) turnKept.delete(id)
    // One thread at a time: Bun starts an I/O thread for every fs call in flight and keeps it for the server's life.
    for (const c of recent) {
      const path = await codexRollout(c.threadId).catch(() => null)
      if (!path) continue
      try {
        const st = await stat(path)
        const key = `${path}|${st.size}|${st.mtimeMs}`
        const kept = turnKept.get(c.threadId)
        const open = kept?.key === key ? kept.open : codexTurnOpen(path)
        turnKept.set(c.threadId, { key, open })
        out.set(c.threadId, open)
      } catch {
        // floor-ok: a rollout that went away between the find and the read leaves the thread to go by how recently it wrote
      }
    }
    return out
  }

  /** `throwaway`: also the live probe's own sessions (shared/throwaway.ts), which every other caller, the window's
   *  list above all, never sees; only the probe asks for them, to find a thread it made. */
  async function externalSessions(o: { strict?: boolean; throwaway?: boolean } = {}): Promise<ExternalSession[]> {
    const inp = await externalInputs(o.strict)
    if (!inp) return []
    const exclude = await excludedIds()
    const who = await resumeData()
    // A pinned session stays listed however old: the index answer is only the last 24 h, so a pinned id
    // missing from it is read by id, as externalSession(id) does. One AgentHydra does not know is left out.
    // An Unassigned one too: its account's app archived it, so /api/chats no longer lists it.
    // A not-done claude-cloud status the 24 h answer missed (the cloud poll writes these) is read by id too, so its
    // row has its title. Local status rows are not: with the cloud source off there are none, and origin/main reads
    // none. A restored status is no evidence it still runs. `wanted` stays pinned-only.
    const pinned = pinnedIds()
    const statusIds = inp.agentStatus
      .filter((a) => a.source === 'claude-cloud' && a.state !== 'done' && !a.restoredUnconfirmed)
      .map((a) => a.sessionId)
    const readIds = new Set([...pinned, ...statusIds])
    for (const old of pinnedRows.keys()) if (!readIds.has(old)) pinnedRows.delete(old)
    const known = new Set(inp.sessions.map((s) => s.session_id))
    const extra = (await Promise.all([...readIds].filter((id) => !known.has(id)).map((id) => pinnedRow(id)))).filter(
      (r): r is NonNullable<typeof r> => r !== null,
    )
    const withPinned: ExternalInputs =
      pinned.length || extra.length
        ? { ...inp, sessions: [...inp.sessions, ...extra], wanted: pinned.length ? new Set(pinned) : inp.wanted }
        : inp
    const mapped = withDesktopAccounts(mapExternal({ ...withPinned, knownTitle }, exclude, now(), (q) => resumeAccount(q, who)), who)
    const list = o.throwaway ? mapped : mapped.filter((s) => !isThrowawayCwd(s.cwd))
    rememberTitles(list)
    return sessionMeta(list, onAccountIds(inp))
  }

  /** A pinned session's index row read by id; a read that failed is its last row (KEEP_LAST_MS), so a pinned row
   *  does not leave the list for one poll. A session AgentHydra answers it does not know is null. */
  const pinnedRows = new Map<string, Kept<AhSessionRow | null>>()
  function pinnedRow(id: string): Promise<AhSessionRow | null> {
    const kept = pinnedRows.get(id) ?? keepLast<AhSessionRow | null>()
    pinnedRows.set(id, kept)
    return client.session(id).then(
      (row) => kept.ok(row),
      (err) => (err instanceof BridgeError && err.kind === 'http' && err.status === 404 ? kept.ok(null) : (kept.get() ?? null)),
    )
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
    const found = withDesktopAccounts(
      mapExternal({ ...base, sessions, wanted: new Set([id]), knownTitle }, new Set(), now(), (q) => resumeAccount(q, who)),
      who,
    ).find((s) => s.id === id)
    if (!found) throw new BridgeError('http', `AgentHydra does not know session ${id}`, 404)
    return sessionMeta([found], onAccountIds(base))[0] ?? found
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

  /** Where an outside session's open spent its time: the find in the folders, the daemon's answer, the parse. `cold`: its file had to be searched for. */
  interface ExternalOpen {
    find: number
    daemon: number
    parse: number
    cold: boolean
    /** Where in the session's file the items begin: 0 for the whole file (or items not from a file); else what is before
     *  it is externalOlder's. */
    older?: number
  }

  /** An outside session's items: from the file it was last found in, else a search of the folders the last read knew, else
   *  the daemon's tail. The open never waits on the daemon for the folders (the refresh lands behind it), and a session with
   *  no file is not searched for again for a while, so its polls go straight to the tail. */
  async function externalItems(sessionId: string, cwd: string | null = null, open: ExternalOpen = { find: 0, daemon: 0, parse: 0, cold: false }): Promise<TranscriptItem[]> {
    // A Claude Code session's own .jsonl keeps every newline, list and code fence; the tail flattens them.
    const known = foundAt.get(sessionId)
    const items = known ? readItems(known) : null
    if (items) {
      open.older = sessionJsonlStart(known!)
      return items
    }
    void cliInstances().catch(() => {})
    const key = `ext|${sessionId}`
    if (!searchedLately(key)) {
      open.cold = true
      const t0 = now()
      const file = await findSessionJsonlAsync(sessionId, opts.projectRoots ? await projectRoots() : sessionRoots(), cwd)
      open.find = now() - t0
      if (file) {
        notFound.delete(key)
        rememberFile(sessionId, file)
        const t1 = now()
        const parsed = sessionJsonlItems(file)
        open.parse = now() - t1
        open.older = sessionJsonlStart(file)
        return parsed
      }
      rememberMiss(key)
    }
    const t2 = now()
    try {
      const tail = await client.tail(sessionId)
      if (!tail.error) {
        // A Codex chat's tail says where it begins in the chat's history: what is above it is externalOlder's.
        if (tail.history_start) open.older = tail.history_start
        return tailToItems(tail)
      }
      // Not in the transcript index: a CliMayte worker's session lives in its CLI instance's folder.
      const held = await client.workersBySession([sessionId])
      const w = held.find((x) => x.sessionId === sessionId || x.sessions?.includes(sessionId))
      if (!w) throw new BridgeError('http', `AgentHydra has no transcript for session ${sessionId}`, 404)
      return workerDetailToItems(await client.worker(w.id))
    } finally {
      open.daemon = now() - t2
    }
  }

  /** What an outside session's file holds before byte `before` (the start externalItems reported); [] when its file is not known. */
  async function externalOlder(sessionId: string, before: number, cwd: string | null = null): Promise<TranscriptItem[]> {
    if (!(before > 0)) return []
    let file = foundAt.get(sessionId) ?? null
    if (!file) {
      file = await findSessionJsonlAsync(sessionId, opts.projectRoots ? await projectRoots() : sessionRoots(), cwd)
      if (file) rememberFile(sessionId, file)
    }
    if (!file) return tailOlder(sessionId, before, cwd)
    try {
      return await sessionJsonlOlder(file, before)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  /** A chat with no .jsonl whose tail pages (a Codex chat's history_start): every page above `before`, oldest first. */
  async function tailOlder(sessionId: string, before: number, cwd: string | null): Promise<TranscriptItem[]> {
    const pages: AhTail[] = []
    let at = before
    for (let n = 0; at > 0 && n < OLDER_PAGES; n++) {
      const tail = await client.tail(sessionId, 200, at)
      if (tail.error) break
      pages.unshift(tail)
      const next = tail.history_start ?? 0
      if (!(next < at)) break
      at = next
    }
    if (!pages.length) return []
    return tailToItems({ ...pages[0]!, cwd: pages[0]!.cwd || cwd || '', events: pages.flatMap((p) => p.events) })
  }

  /** An outside session's whole history: its items, and what its file holds before them. */
  async function externalHistory(sessionId: string, cwd: string | null = null): Promise<TranscriptItem[]> {
    const open: ExternalOpen = { find: 0, daemon: 0, parse: 0, cold: false }
    const items = await externalItems(sessionId, cwd, open)
    const older = open.older ? await externalOlder(sessionId, open.older, cwd) : []
    return older.length ? [...older, ...items] : items
  }

  /** The newest `limit` items of what externalOlder answers that end before item `end` (default: the last), and how many are above them. */
  async function externalOlderPage(sessionId: string, before: number, cwd: string | null, limit: number, end?: number): Promise<{ items: TranscriptItem[]; above: number }> {
    const all = await externalOlder(sessionId, before, cwd)
    const to = Math.min(Math.max(end ?? all.length, 0), all.length)
    const from = Math.max(0, to - Math.max(1, limit))
    return { items: all.slice(from, to), above: from }
  }

  /** Where Codex keeps its threads: the default login's home and every Codex account AgentHydra lists. */
  const codexHomes = sharedRead(CODEX_HOMES_FRESH_MS, async () => {
    const homes = [join(home, '.codex'), ...(await client.codexInstances().catch(() => [])).map((i) => i.codexHome).filter(Boolean)]
    return [...new Map(homes.map((h) => [h.toLowerCase(), h])).values()]
  })
  /** A thread's rollout once found; a miss is asked again after ROLLOUT_MISS_MS (a session with neither file is looked for again). */
  const rollouts = new Map<string, { path: string | null; at: number }>()
  const ROLLOUTS_KEPT = 500
  async function codexRollout(threadId: string): Promise<string | null> {
    const kept = rollouts.get(threadId)
    if (kept && (kept.path || now() - kept.at < ROLLOUT_MISS_MS)) return kept.path
    const path = await findCodexRollout(threadId, await codexHomes())
    rollouts.set(threadId, { path, at: now() })
    if (rollouts.size > ROLLOUTS_KEPT) rollouts.delete(rollouts.keys().next().value as string)
    return path
  }

  /** A whole outside session's history, kept by file size and mtime (a file that grew is read again). */
  const wholeKept = new Map<string, { key: string; items: TranscriptItem[]; index: TranscriptIndex }>()
  const WHOLE_KEPT = 3
  /** Only the index and context numbers of the newest INDEX_KEPT sessions: the rail's reads and the poller's warm-up come
   *  from here, so opening a chat does not read its whole transcript again. */
  const indexKept = new Map<string, { key: string; index: TranscriptIndex }>()
  const INDEX_KEPT = 50
  const INDEX_WARM = 20
  /** The size|mtime key of the session's file: its Claude Code .jsonl, else its Codex rollout (a Codex chat's items come from
   *  the daemon's tail, which grows with the rollout); '' when neither is known or the file is gone. Before the rollout counted,
   *  a Codex chat had no key, so its index was never kept and the warm-up rebuilt the same one at every poll. */
  async function fileKey(sessionId: string): Promise<string> {
    const file = foundAt.get(sessionId) ?? (await codexRollout(sessionId).catch(() => null))
    if (!file) return ''
    try {
      const st = await stat(file)
      return `${st.size}|${st.mtimeMs}`
    } catch {
      return ''
    }
  }
  function keepIndex(sessionId: string, key: string, index: TranscriptIndex): void {
    indexKept.delete(sessionId)
    indexKept.set(sessionId, { key, index })
    while (indexKept.size > INDEX_KEPT) indexKept.delete(indexKept.keys().next().value!)
  }
  async function externalWhole(sessionId: string, cwd: string | null): Promise<{ items: TranscriptItem[]; index: TranscriptIndex }> {
    // The file's key is checked before the transcript is read: an unchanged file costs one stat.
    const before = await fileKey(sessionId)
    const hit = wholeKept.get(sessionId)
    if (before && hit && hit.key === before) return hit
    const items = await externalHistory(sessionId, cwd)
    const file = foundAt.get(sessionId)
    const key = await fileKey(sessionId)
    const kept = wholeKept.get(sessionId)
    if (key && kept && kept.key === key) return kept
    // Its context comes from the file's usage lines, which no item carries: a Claude Code .jsonl's last reply (no window), or
    // for a chat with none, a Codex rollout's last token_count (with its window), and its turns over the whole thread.
    let context: { tokens: number; window: number | null; total?: number | null } | null = null
    let codexTurns: number | null = null
    try {
      if (key && file) {
        const tokens = lastContextTokens(file)
        context = tokens === null ? null : { tokens, window: null }
      } else {
        const rollout = await codexRollout(sessionId)
        context = rollout ? lastCodexContext(rollout) : null
        codexTurns = rollout ? await codexTurnCount(rollout) : null
      }
    } catch {
      // gone since it was found: no context, the rest of the index stands
    }
    const built = { key, items, index: { ...buildTranscriptIndex(items), contextTokens: context?.tokens ?? null, contextWindow: context?.window ?? null, sessionTokens: context?.total ?? null, sessionTurns: codexTurns } }
    if (key) {
      wholeKept.delete(sessionId)
      wholeKept.set(sessionId, built)
      while (wholeKept.size > WHOLE_KEPT) wholeKept.delete(wholeKept.keys().next().value!)
      keepIndex(sessionId, key, built.index)
    }
    return built
  }

  async function externalIndex(sessionId: string, cwd: string | null = null): Promise<TranscriptIndex> {
    const key = await fileKey(sessionId)
    const hit = indexKept.get(sessionId)
    if (key && hit && hit.key === key) return hit.index
    return (await externalWhole(sessionId, cwd)).index
  }

  /** Builds the index of the one most recently active idle session (of the INDEX_WARM newest) whose file changed since it
   *  was last built, so opening it finds it ready. One build per call, none while a build runs; true when it built one. */
  let warming = false
  async function warmIndexes(sessions: readonly Pick<ExternalSession, 'id' | 'cwd' | 'status' | 'lastActivityAt'>[]): Promise<boolean> {
    if (warming) return false
    warming = true
    try {
      const newest = [...sessions].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, INDEX_WARM)
      for (const s of newest) {
        if (s.status === 'working') continue // its file changes every step: warmed when it rests
        const key = await fileKey(s.id)
        const hit = indexKept.get(s.id)
        if (key && hit && hit.key === key) continue
        await externalWhole(s.id, s.cwd)
        return true
      }
      return false
    } catch {
      return false // a session that cannot be read now is tried again at the next poll
    } finally {
      warming = false
    }
  }

  async function externalSearch(sessionId: string, query: string, cwd: string | null = null): Promise<SearchResult> {
    return searchResult((await externalWhole(sessionId, cwd)).items, query)
  }

  async function externalItem(sessionId: string, itemId: string, cwd: string | null = null): Promise<TranscriptItem | null> {
    return (await externalWhole(sessionId, cwd)).items.find((i) => i.id === itemId) ?? null
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
  /** Which of a worker's session files to read: the rescan asks for every file again; `writing` names the session it writes now. */
  interface WorkerScan {
    rescan?: boolean
    writing?: { sessionId: string; accountId: string }
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

  async function statOf(file: string): Promise<Pick<WorkerPart, 'ino' | 'size' | 'mtimeMs'> | null> {
    try {
      const st = await stat(file)
      return { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** A session's part as any worker list of this folder read it, while its file is unchanged: a stat, no parse. */
  async function unchangedPart(sid: string, file: string, cwd: string | null): Promise<WorkerPart | null> {
    const st = await statOf(file)
    if (!st) return null
    for (const read of workerReads.values()) {
      const prev = read.cwd === cwd ? read.parts.get(sid) : undefined
      if (prev && prev.file === file && prev.ino === st.ino && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev
    }
    return null
  }

  /** The file read now, its stat taken first: a file that changes during the read is read again next poll. */
  async function readPart(file: string, cwd: string | null): Promise<WorkerPart | null> {
    const st = await statOf(file)
    if (!st) return null
    try {
      return { file, ...st, items: await workerJsonlItems.readAsync(file, cwd) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** A worker session's part, read from the newest file that holds it; null when no file does yet (a miss is remembered). */
  async function partOf(sid: string, cwd: string | null, o: WorkerScan, ownRoot: string | null, allRoots: () => Promise<string[]>): Promise<WorkerPart | null> {
    let known = o.rescan ? null : foundAt.get(sid)
    // The turn in flight is looked for in its own folder on every look: a new session's file is not there yet at its
    // first poll, and a back-off here made the next look 5 s, then 10 s, later.
    if (ownRoot && sid === o.writing?.sessionId && !(known && isUnder(known, ownRoot))) {
      const own = await findSessionJsonlAsync(sid, [ownRoot], cwd)
      if (own) {
        rememberFile(sid, own)
        known = own
      }
    }
    const part = known ? ((await unchangedPart(sid, known, cwd)) ?? (await readPart(known, cwd))) : null
    if (part) return part
    // A session with no file yet: every project folder of every account is looked in, so not on every poll.
    if (!o.rescan && searchedLately(sid)) return null
    const file = await findSessionJsonlAsync(sid, await allRoots(), cwd)
    if (file) rememberFile(sid, file)
    const found = file ? await readPart(file, cwd) : null
    if (!found) {
      rememberMiss(sid)
      return null
    }
    notFound.delete(sid)
    return found
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
  async function workerItems(sessionIds: string[], cwd: string | null, o: WorkerScan = {}): Promise<TranscriptItem[]> {
    let rootsOnce: Promise<string[]> | null = null
    const allRoots = () => (rootsOnce ??= projectRoots())
    const ownDir = o.writing ? (await instanceDirs()).get(o.writing.accountId) : undefined
    const ownRoot = ownDir ? join(ownDir, 'projects') : null
    const parts = new Map<string, WorkerPart>()
    for (const sid of new Set(sessionIds)) {
      // One session's parse at a time: the requests and timers run between two sessions, not after all of them.
      await new Promise((done) => setImmediate(done))
      const part = await partOf(sid, cwd, o, ownRoot, allRoots)
      if (part) parts.set(sid, part)
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

  /** `requestId`: the message's own id, the same on every retry of it (AgentHydra queues it once). `setting`: the model and effort its turn runs on. */
  async function sendToWorker(id: string, text: string, cwd?: string, urgent = false, desk?: StartWorker['desk'], requestId?: string, setting?: WorkerSendSetting): Promise<{ urgent: boolean; delivered: boolean }> {
    const r = await client.sendToWorker(id, text, cwd, urgent, desk, requestId, setting)
    if (!r.ok) throw new BridgeError('http', r.message || `AgentHydra refused the message to ${id}`, /no such worker/i.test(r.message) ? 404 : 400)
    // A follow-up can wake a finished worker.
    workersChanged()
    return { urgent: r.urgent === true, delivered: r.delivered === 'in-turn' }
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

  /** Whether the AgentHydra running now (its version, process and boot commit) takes requestId. */
  let requestIdsIn: { key: string; ok: boolean } | null = null

  /** Whether AgentHydra takes a worker start or a message sent again once (their requestId), so Desk may send one it
   *  did not answer again. Asked once per AgentHydra process, with a task holding an empty requestId and nothing else:
   *  an AgentHydra that reads it refuses it for that, an older one for its empty prompt, and neither makes anything.
   *  Null: AgentHydra did not answer. */
  async function takesRequestIds(): Promise<boolean | null> {
    const h = await client.health().catch(() => null)
    if (!h) return null
    const key = `${h.version ?? ''}|${h.pid ?? ''}|${h.runningCode?.bootCommit ?? ''}`
    if (requestIdsIn?.key === key) return requestIdsIn.ok
    let ok = false
    try {
      await client.post('/api/corch/workers', { origin: null, tasks: [{ prompt: '', cwd: '', requestId: '' }] })
    } catch (err) {
      if (!(err instanceof BridgeError) || err.unreachable) return null
      ok = err.kind === 'http' && /requestId/.test(err.message)
    }
    requestIdsIn = { key, ok }
    return ok
  }

  /** Takes back a message the worker holds. An AgentHydra without the route (before its update) refuses it, as Send now does. */
  async function cancelWorkerHeld(id: string, text: string): Promise<{ removed: boolean; message: string }> {
    let r: Awaited<ReturnType<typeof client.cancelHeld>>
    try {
      r = await client.cancelHeld(id, text)
    } catch (err) {
      if (noDeliverNow(err)) throw new BridgeError('http', 'This AgentHydra cannot take back a held message yet: it needs its update', 404)
      throw err
    }
    if (!r.ok) throw new BridgeError('http', r.message || `AgentHydra refused to cancel ${id}'s message`, /no such worker/i.test(r.message) ? 404 : 400)
    workersChanged()
    return { removed: r.removed === true, message: r.message ?? '' }
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
    externalOlder,
    externalOlderPage,
    externalHistory,
    warmIndexes,
    externalIndex,
    externalSearch,
    externalItem,
    search,
    sessionRoots,
    workers,
    swarmJobs,
    sessionTasks,
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
    takesRequestIds,
    canDeliverNow,
    sendToWorkerNow,
    cancelWorkerHeld,
    completionFinished: (ticket: string, outcome: 'done' | 'failed' | 'cancelled') =>
      client.completionFinished(ticket, outcome),
    startWorker,
    workersByIds,
    workerItems,
    /** The session file a worker session was last found in: what a watch on a turn in flight follows. */
    workerFileOf: (sessionId: string): string | null => foundAt.get(sessionId) ?? null,
    /** The home screen's stats card, consolidated over every source AgentHydra counts (stats.ts). */
    homeStats,
    setExtraWorkerIds(fn: () => string[]): void {
      extraWorkerIds = fn
    },
    setExcludeSessionIds(fn: () => Ids): void {
      excludeSessionIds = fn
    },
    addExcludedSessionIds(fn: () => Ids): void {
      moreExcluded.push(fn)
    },
    excludeIds: async (): Promise<Iterable<string>> => excludedIds(),
    extraIds: (): string[] => extraWorkerIds(),
    /** Registers Hydra Desk's marks on outside sessions (the engine's session-meta store); externalSessions() applies them. */
    setSessionMeta(fn: (list: ExternalSession[], onAccount?: ReadonlySet<string>) => ExternalSession[], pinned: () => string[] = () => []): void {
      sessionMeta = fn
      pinnedIds = pinned
    },
    applySessionMeta: (list: ExternalSession[], onAccount?: ReadonlySet<string>): ExternalSession[] => sessionMeta(list, onAccount),
    pinnedSessionIds: (): string[] => pinnedIds(),
  }
}

/** The sessions an account's app lists now: this PC's unarchived Desktop chats and every Codex account's unarchived chats. */
function onAccountIds(inp: Pick<ExternalInputs, 'chats' | 'codexChats'>): Set<string> {
  return new Set([...inp.chats.filter((c) => c.sessionId && !c.archived).map((c) => c.sessionId), ...(inp.codexChats ?? []).map((c) => c.threadId)])
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
    next.setSessionMeta((list, onAccount) => prev.applySessionMeta(list, onAccount), () => prev.pinnedSessionIds())
  }
  instance = next
  return next
}
