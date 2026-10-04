// CliMayte's state and the reading of it, under every other CliMayte module: the store (workers,
// per-account counters, walls) with its load and save, the journal, the paths, an attempt's log
// read into its worker, the token and spend backfills, and where a session's transcript is.
// Split out of climayte.ts so each file can be read whole. It imports none of climayte.ts,
// climayte-launch.ts, climayte-schedule.ts or climayte-totals.ts: they import it.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
  appendJournal,
  type CliMayteJournalEntry,
  type CliMayteJournalEvent,
} from './climayte-journal'
import {
  type AttemptSpend,
  addTokens,
  attemptSpend,
  type CliMayteAccount,
  type CliMayteLiveUsage,
  type CliMayteWalls,
  type CliMayteWorker,
  freshestPct,
  isOrgDisabled,
  isWalledNow,
  liveUsage,
  noTokens,
  ORG_DISABLED_WALL,
  overageStart,
  pastOnArrival,
  READING_STALE_MS,
  summarizeEvent,
} from './climayte-lib'
import { type MachineMemory, readMachineMemory } from './climayte-memory'
import {
  type CostEstimate,
  expectedCost,
  type FinishedCost,
  modelFamily,
  planFactor,
  type RunningLoad,
} from './climayte-placement'
import { newestLive } from './climayte-remote'
import { attemptUnits, ladderModel, rereadUnits, UNITS_PER_PRO_PERCENT } from './climayte-scorecard'
import { resolveClaudeExe } from './config'
import { getCliInstance, listCliInstances } from './core/cli-instances'
import { handsOnAgoMs } from './core/hands-on'
import { type JsonStoreSpec, readJsonStore, writeJsonStoreAtomic } from './core/json-store'
import { POINTER_DIR } from './instance'
import type { KitStore } from './kit/store'
import { liveSessionIds } from './live-registry'
import { getProviderSettings } from './provider-settings'
import type { CliInstance, UsageSnapshot } from './types'
import { resetTimeIso } from './usage'
import { allCachedUsage } from './usage-cache'

// POINTER_DIR is CONFIG_DIR for the primary install and a side-run's own data dir otherwise, so
// two daemons never tick and overwrite the same workers.json.
export const ROOT = join(POINTER_DIR, 'corch')

export const LOGS = join(ROOT, 'logs')

export const PROMPTS = join(ROOT, 'prompts')

export const HOOKS = join(ROOT, 'hooks')

export const SIGNALS = join(ROOT, 'signals')

/** Forward slashes: the path goes into a bash command (the hook) and into the model's prompt. */
export const slashed = (p: string): string => p.replace(/\\/g, '/')

export const signalPath = (workerId: string): string => join(SIGNALS, `${workerId}.json`)

const WALLS_PATH = join(ROOT, 'walls.json')

export const LIVE_PATH = join(ROOT, 'live.json')

export const JOURNAL_PATH = join(ROOT, 'journal.jsonl')

/** `#84`, or the account's name when it has no number: the journal's short account label. */
export const acctLabel = (a: { num: number | null; name: string }): string =>
  a.num === null ? a.name : `#${a.num}`

/** One line in the orchestration journal (climayte-journal.ts) for a state change of `w`. */
export function journal(
  w: CliMayteWorker,
  event: CliMayteJournalEvent,
  details: Omit<Partial<CliMayteJournalEntry>, 'ts' | 'id' | 'group' | 'title' | 'event'> = {},
): void {
  appendJournal(JOURNAL_PATH, {
    ts: new Date().toISOString(),
    id: w.id,
    group: w.group,
    title: w.title,
    event,
    ...details,
  })
}

interface Store {
  workers: CliMayteWorker[]
  perAccount: Record<string, number>
  /** Groups whose per_account is a hard cap (climayte_run per_account_strict); absent before
   *  2026-10-03. */
  perAccountStrict?: Record<string, boolean>
}

const STORE_SPEC: JsonStoreSpec<Store> = {
  path: join(ROOT, 'workers.json'),
  decode: (p) => {
    const w = (p as { workers?: unknown })?.workers
    if (!Array.isArray(w)) return null
    return {
      workers: w as CliMayteWorker[],
      perAccount: (p as Store).perAccount ?? {},
      perAccountStrict: (p as Store).perAccountStrict ?? {},
    }
  },
  empty: () => ({ workers: [], perAccount: {}, perAccountStrict: {} }),
}

/** Finished work, one file per worker. workers.json was rewritten whole on every change: 2.8 MB
 *  about every 40 s, some 4.7 GB of disk writes a day, with 2.5 MB of it 222 finished workers that
 *  no longer change (measured 2026-10-02). Now workers.json holds the work still in flight (75 KB
 *  for 17 workers) and a finished worker's file is written when that worker changes. */
const DONE = join(ROOT, 'done')

const donePath = (id: string): string => join(DONE, `${id}.json`)

/** No tick touches it again until a message revives it (climayteSend). */
const isFinished = (w: CliMayteWorker): boolean =>
  w.status === 'done' || w.status === 'failed' || w.status === 'cancelled'

/** Finished workers that have a file under done/, and the workers changed since the last save. */
const filed = new Set<string>()
const dirty = new Set<string>()

export const workers = new Map<string, CliMayteWorker>()

export let perAccount: Record<string, number> = {}

/** Groups whose per_account never spills (climayte-schedule scheduleWorker): the cap before the
 *  owner's 2026-10-03 ruling that a group's per_account is a preference. */
export let perAccountStrict: Record<string, boolean> = {}

export let walls: CliMayteWalls = {}

let loaded = false

/** Whether the store was read: an unread one holds no workers, which is not the same as none. */
export const storeLoaded = (): boolean => loaded

/** Per attempt log: bytes read, an unfinished last line, the events kept, the summaries shown,
 *  and whether system/init was ever seen (kept apart: the events list drops old ones). */
export interface LogRead {
  offset: number
  partial: string
  events: unknown[]
  recent: string[]
  sawInit: boolean
  /** The model system/init reported. */
  model: string | null
  /** The CLI said the account ran out and paid extra usage took over (overageStart). */
  overage: { resetsAt: number | null } | null
  /** The newest usage reading the CLI streamed (liveUsage). */
  live: CliMayteLiveUsage | null
  /** The first one (pastOnArrival). */
  firstLive: CliMayteLiveUsage | null
  /** The newest `timestamp` an event carried (assistant and user events do, epoch ms): when a
   *  replayed reading was really taken (readInto). */
  lastAt: number | null
}

/** Each account's newest live usage reading from any of its workers' streams (poll copies it
 *  here). The usage snapshot is refreshed only every 15 minutes; this is seconds old. */
export const liveByAccount = new Map<string, CliMayteLiveUsage>()

function loadLive(): void {
  try {
    const raw = JSON.parse(readFileSync(LIVE_PATH, 'utf8')) as Record<string, CliMayteLiveUsage>
    for (const [id, live] of Object.entries(raw)) {
      const prev = liveByAccount.get(id)
      if (live && typeof live.at === 'number' && (!prev || prev.at < live.at))
        liveByAccount.set(id, live)
    }
  } catch {
    // none yet, or unreadable: the next reading writes it again
  }
}

/** The owner's rule is never to spend paid extra usage; the `allowExtraUsage` setting (default
 *  false) lifts it: overage is then neither stopped nor walled, and accounts at their caps stay
 *  in the pool behind every account below them. Unreadable counts as false. */
export function overageAllowed(): boolean {
  try {
    return getProviderSettings().allowExtraUsage === true
  } catch {
    return false
  }
}

export const listeners = new Set<(w: CliMayteWorker) => void>()

export let claudeCommand: () => string[] = () => [resolveClaudeExe()]

/** Claude sessions running in an account's folder that are not CliMayte's own: an interactive
 *  CLI session, another agent's, the chat orchestrating this one. Matched by session id, which
 *  CliMayte picks before it starts the CLI (--session-id), so its own new sessions never count. */
function otherSessionsIn(configDir: string, mine: Set<string>): number {
  return liveSessionIds(configDir).filter((id) => !mine.has(id)).length
}

/** The sessions CliMayte's own running workers hold, built once per pool. */
function ownSessions(): Set<string> {
  const mine = new Set<string>()
  for (const w of workers.values()) {
    if (w.status !== 'running') continue
    if (w.sessionId) mine.add(w.sessionId)
    for (const at of w.attempts) if (at.endedAt === null && at.sessionId) mine.add(at.sessionId)
  }
  return mine
}

/** The pool is read at most every POOL_MS. The tick asked every second while work ran, and each
 *  build read the instance store, every account's credentials and usage cache, and every live
 *  session folder: about 15 file reads a second for data that changes every few minutes (stress
 *  review, 2026-10-02). */
const POOL_MS = 3_000
let pool: { at: number; accounts: CliMayteAccount[] } | null = null
function signedInAccounts(): CliMayteAccount[] {
  const now = Date.now()
  if (pool && now - pool.at < POOL_MS) return pool.accounts
  pool = { at: now, accounts: buildPool(now) }
  return pool.accounts
}

/** When each account's usage was last read again for placement (refreshReading), and the reads
 *  still running (epoch ms they started). */
const refreshAsked = new Map<string, number>()
const refreshRunning = new Map<string, number>()

/** How long an account sits out placement while its usage is read again: the read is one API call
 *  (about 300 ms), or a `claude -p /usage` spawn (about 9 s) when the API refuses the token. */
const REFRESH_HOLD_MS = 30_000

/** A read older than this has hung (the CLI spawn's own timeout is 60 s): it no longer holds the
 *  one-at-a-time line, or one stuck read would stop every later refresh until a restart. */
const REFRESH_LOCK_MS = 120_000

/** The account a task waits to start on until its usage is read (climayte-schedule startOn): the
 *  next pool build reads it before any other. */
let wantedRead: string | null = null

export function wantReading(id: string): void {
  wantedRead = id
}

/** Read an account's usage again, at most once per READING_STALE_MS, while there is work to place
 *  and its reading is missing or older than that (buildPool). The background sweep reads every
 *  account only every 30 minutes, and an account can be used outside CliMayte in between:
 *  2026-10-02, #118 was placed at 82% and read 95%, #119 at 79% and read 100%. The read is the
 *  usage check (no quota); its result lands in the usage cache the next pool build reads. No task
 *  starts on the account until then (readingPending). */
function refreshReading(id: string, now: number): void {
  // One read at a time, like the background sweep: `/api/oauth/usage` rate-limits per user agent,
  // and a burst over every stale account at once could earn a 429 that silences all of them for
  // tens of minutes (usage.ts apiBackoffUntil). The next pool build, seconds later, asks the next.
  for (const [k, started] of refreshRunning)
    if (now - started > REFRESH_LOCK_MS) refreshRunning.delete(k)
  if (refreshRunning.size > 0 || now - (refreshAsked.get(id) ?? 0) < READING_STALE_MS) return
  refreshAsked.set(id, now)
  refreshRunning.set(id, now)
  // Loaded only when a reading is due, so a daemon (or a test) that never places loads none of it.
  void import('./usage-service')
    .then((m) => m.checkUsageForCliInstance(id))
    .catch((err) => console.error(`[climayte] could not read usage of ${id}:`, err))
    .finally(() => {
      refreshRunning.delete(id)
      pool = null
    })
}

/** Some task is waiting to be placed. */
const placing = (): boolean =>
  [...workers.values()].some((w) => w.status === 'queued' || w.status === 'waiting')

/** A CLI `/usage` reading keeps each reset as the CLI printed it ("Oct 4, 1am") and no `resetsAt`.
 *  Read as unknown, an old percentage outlived its window (livePct) and the pacing had no weekly
 *  reset for four of ten accounts (stress run, 2026-10-02). Parsed against when it was read, so an
 *  old reading's yearless date is not rolled into next year. */
function withResetTimes(u: UsageSnapshot): UsageSnapshot {
  const readAt = new Date(Date.parse(u.capturedAt) || Date.now())
  const fill = <L extends { resets?: string; resetsAt?: string | null } | null | undefined>(
    l: L,
  ): L => (l && !l.resetsAt && l.resets ? { ...l, resetsAt: resetTimeIso(l, readAt) } : l)
  return { ...u, session: fill(u.session), weekAll: fill(u.weekAll) }
}

/** One limit (session or week) of a live reading, shaped as freshestPct takes it; null when the
 *  live reading carries no percentage for it. */
type LiveLimit = { pct: number; resetsAt: number | null; at: number } | null

function liveLimits(live: CliMayteLiveUsage | null): { session: LiveLimit; week: LiveLimit } {
  if (!live) return { session: null, week: null }
  return {
    session:
      live.sessionPct !== null
        ? { pct: live.sessionPct, resetsAt: live.sessionResetsAt, at: live.at }
        : null,
    week:
      live.weekPct !== null
        ? { pct: live.weekPct, resetsAt: live.weekResetsAt, at: live.at }
        : null,
  }
}

/** The reset of whichever reading a percentage came from: the live one when it is newer than the
 *  snapshot, else the snapshot's. */
function limitReset(
  live: LiveLimit,
  snapshotAt: number,
  limit: { resetsAt?: string | null } | null | undefined,
): number | null {
  if (live && live.at > snapshotAt) return live.resetsAt
  return limit?.resetsAt ? Date.parse(limit.resetsAt) || null : null
}

/** A reset still ahead, for a limit that has a percentage. */
function upcomingReset(pct: number | null, resets: number | null, now: number): number | null {
  return pct !== null && resets !== null && resets > now ? resets : null
}

/** When the session percentage was read: the live reading's time when it is the newer one. */
function sessionReadAt(pct: number | null, live: LiveLimit, snapshotAt: number): number | null {
  if (pct === null) return null
  return live && live.at > snapshotAt ? live.at : snapshotAt || null
}

/** What every account in one pool build shares. */
interface PoolBuild {
  now: number
  mine: Set<string>
  cache: Record<string, UsageSnapshot>
  toPlace: boolean
  /** Accounts whose reading is due to be read again and has not been tried since it fell due. */
  due: string[]
}

/** One CLI instance as a pool account (buildPool). */
function poolAccount(i: CliInstance, b: PoolBuild): CliMayteAccount {
  const { now } = b
  const read = latestUsage(i.id, i.lastUsageCheck, b.cache)
  const u = read && withResetTimes(read)
  const snapshotAt = u ? Date.parse(u.capturedAt) || 0 : 0
  // The other PC's reading counts when it is newer than this PC's own (climayte-remote).
  const live = liveLimits(newestLive(i.id, liveByAccount.get(i.id) ?? null, now))
  const sessionPct = freshestPct(u?.session, snapshotAt, live.session, now)
  const weekPct = freshestPct(u?.weekAll, snapshotAt, live.week, now)
  const readAt = sessionReadAt(sessionPct, live.session, snapshotAt)
  // A walled account takes no work until its wall ends, so its reading waits too.
  const due = readAt === null || now - readAt > READING_STALE_MS
  const asked = refreshAsked.get(i.id)
  const untried = asked === undefined || now - asked >= READING_STALE_MS
  if (b.toPlace && due && untried && !isWalledNow(walls[i.id], now)) b.due.push(i.id)
  const refreshStarted = refreshRunning.get(i.id)
  return {
    id: i.id,
    num: i.num ?? null,
    name: i.name,
    configDir: i.configDir,
    planFactor: planFactor(i.planLabel),
    sessionPct,
    sessionResetsAt: upcomingReset(
      sessionPct,
      limitReset(live.session, snapshotAt, u?.session),
      now,
    ),
    weekPct,
    weekResetsAt: upcomingReset(weekPct, limitReset(live.week, snapshotAt, u?.weekAll), now),
    readAt,
    refreshing: refreshStarted !== undefined && now - refreshStarted < REFRESH_HOLD_MS,
    readTriedAt: asked ?? null,
    handsOnAgoMs: handsOnAgoMs(i.associatedDesktopDir, now),
    otherSessions: otherSessionsIn(i.configDir, b.mine),
  }
}

/** The production pool: every CLI instance with a credential file, with its last usage reading
 *  (void once its window has reset), or a running worker's live one when that is newer. A hollow
 *  or revoked login still passes that file check; its first attempt fails `auth` and the account
 *  stays walled until it signs in again (recheckSignedOut), so a dead login costs one quick
 *  failure, once. Each carries who else is on it now (accountInUse), so new work goes around a
 *  person at the keyboard and around sessions that are not CliMayte's. */
function buildPool(now: number): CliMayteAccount[] {
  const b: PoolBuild = {
    now,
    mine: ownSessions(),
    cache: allCachedUsage(),
    toPlace: placing(),
    due: [],
  }
  // A login vetoed by CliMayte's own signed-out wall stays in the pool, walled, so recheckSignedOut
  // can find out when it works again.
  const accounts = listCliInstances()
    .filter((i) => i.loggedIn || !!i.loginNote)
    .map((i) => poolAccount(i, b))
  // One read at a time (refreshReading): the account a task waits on first, else the first due.
  const next = wantedRead && b.due.includes(wantedRead) ? wantedRead : b.due[0]
  if (next) refreshReading(next, now)
  return accounts
}

/** The newer of the background refresh's cached reading and a person's manual check (only the
 *  latter lands in `lastUsageCheck`). */
export function latestUsage(
  id: string,
  manual: UsageSnapshot | null | undefined,
  cache: Record<string, UsageSnapshot> = allCachedUsage(),
): UsageSnapshot | null {
  // The key cliKey (usage-service.ts) builds, spelled out so climayte does not load that module and
  // its database for one string.
  const cached = cache[`cli:${id}`] ?? null
  const at = (s: UsageSnapshot | null | undefined): number =>
    s ? Date.parse(s.capturedAt) || 0 : -1
  return at(cached) > at(manual) ? cached : (manual ?? null)
}

/** An organization's switch is not on a clock: its wall waits for a new login (recheckSignedOut). */
export const ORG_WALL_MS = 365 * 24 * 3_600_000

export let accountsProvider: () => CliMayteAccount[] = signedInAccounts

/** Tests: run a fake CLI instead of `claude`. null restores the real one. */
export function setCliMayteClaudeCommand(argv: string[] | null): void {
  claudeCommand = argv ? () => argv : () => [resolveClaudeExe()]
}

/** Where the owner's global CLAUDE.md and skills live (`~/.claude`). Off under tests unless a test
 *  sets it, so a test run never links the real skills into a fixture. */
export let ownerClaudeDir: string | null =
  process.env.NODE_ENV === 'test' ? null : join(homedir(), '.claude')

/** Tests: sync the owner's CLAUDE.md and skills from `dir` before each launch. null turns it off. */
export function setCliMayteOwnerDir(dir: string | null): void {
  ownerClaudeDir = dir
}

/** Tests: supply the accounts. null restores the signed-in CLI instances. */
export function setCliMayteAccountsProvider(fn: (() => CliMayteAccount[]) | null): void {
  accountsProvider = fn ?? signedInAccounts
}

/** This machine's free memory, which a start must leave room in (climayte-memory.ts). Off under
 *  tests unless a test sets it, so a suite run on a busy box never holds its fake workers. */
export let memoryReader: (() => MachineMemory | null) | null =
  process.env.NODE_ENV === 'test' ? null : readMachineMemory

/** Tests: read the machine's memory from `fn`. null turns the memory gate off. */
export function setCliMayteMemoryReader(fn: (() => MachineMemory | null) | null): void {
  memoryReader = fn
}

/** Every readable worker file under done/. One that cannot be read, or that names another worker
 *  than its file, is left as found and said: an unreadable record is not an absent one. */
function readDone(): CliMayteWorker[] {
  let names: string[] = []
  try {
    names = readdirSync(DONE)
  } catch {
    return []
  }
  const found: CliMayteWorker[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const w = JSON.parse(readFileSync(join(DONE, name), 'utf8')) as CliMayteWorker
      if (name !== `${w?.id}.json` || !Array.isArray(w.attempts)) throw new Error('not a worker')
      found.push(w)
    } catch (err) {
      console.error(`[climayte] ${join(DONE, name)} could not be read; left as it is:`, err)
    }
  }
  return found
}

/** Both halves of the store into `workers`, oldest first as the single file kept them. The copy in
 *  workers.json wins: climayteSend revives a finished worker, and a daemon that died between
 *  writing workers.json and removing the worker's file left both. A finished worker still in
 *  workers.json is marked to be filed: every one of them on the first start after the single-file
 *  layout, which load's save then carries over. */
function loadWorkers(hot: CliMayteWorker[]): void {
  const all = new Map<string, CliMayteWorker>()
  for (const w of readDone()) {
    all.set(w.id, w)
    filed.add(w.id)
  }
  for (const w of hot) {
    all.set(w.id, w)
    if (isFinished(w)) dirty.add(w.id)
  }
  for (const w of [...all.values()].sort((a, b) => a.createdAt - b.createdAt)) workers.set(w.id, w)
}

export function load(): void {
  if (loaded) return
  loaded = true
  const read = readJsonStore(STORE_SPEC)
  if (read.status === 'ok') {
    loadWorkers(read.value.workers)
    perAccount = read.value.perAccount
    perAccountStrict = read.value.perAccountStrict ?? {}
    if (backfillTokens() || dirty.size) save()
  } else if (read.status === 'missing') {
    // Finished work is still on record when only workers.json is gone.
    loadWorkers([])
  } else {
    console.error(
      `[climayte] ${STORE_SPEC.path} is ${read.status}; starting with no workers and not overwriting it.`,
    )
    loaded = false
    return
  }
  try {
    if (existsSync(WALLS_PATH)) walls = JSON.parse(readFileSync(WALLS_PATH, 'utf8'))
  } catch {
    walls = {}
  }
  try {
    if (orgWallsFromAttempts()) saveWalls()
  } catch (err) {
    // The conversion holds in memory either way; a failed write must not stop the store loading.
    console.error('[climayte] could not save walls:', err)
  }
  loadLive()
}

/** A signed-out wall whose account's newest refusal said its organization turned Claude Code off
 *  (set before that case had its own wall) becomes that wall, so the next recheck does not lift it
 *  and send every waiting task at the account again. */
function orgWallsFromAttempts(): boolean {
  const newest = new Map<string, { at: number; org: boolean }>()
  for (const w of workers.values())
    for (const at of w.attempts) {
      if (at.outcome !== 'auth') continue
      const prev = newest.get(at.account.id)
      if (!prev || prev.at < at.startedAt)
        newest.set(at.account.id, { at: at.startedAt, org: isOrgDisabled(at.notice) })
    }
  let any = false
  for (const [id, n] of newest) {
    const wall = walls[id]
    if (!n.org || wall?.reason !== 'signed out') continue
    walls[id] = { ...wall, reason: ORG_DISABLED_WALL, until: Date.now() + ORG_WALL_MS }
    any = true
  }
  return any
}

export function save(): void {
  if (!loaded) return
  mkdirSync(ROOT, { recursive: true })
  const hot: CliMayteWorker[] = []
  for (const w of workers.values()) {
    if (!isFinished(w)) hot.push(w)
    else if (dirty.has(w.id) || !filed.has(w.id)) {
      writeJsonStoreAtomic(donePath(w.id), w)
      filed.add(w.id)
    }
  }
  dirty.clear()
  writeJsonStoreAtomic(STORE_SPEC.path, { workers: hot, perAccount, perAccountStrict })
  // A revived worker's file (and a removed one's) goes only now that workers.json is written: a
  // finished worker is filed before it leaves workers.json and unfiled after it is back there, so
  // a crash at any point leaves it in at least one of them.
  for (const id of filed) {
    const w = workers.get(id)
    if (w && isFinished(w)) continue
    rmSync(donePath(id), { force: true })
    filed.delete(id)
  }
}

export function saveWalls(): void {
  mkdirSync(ROOT, { recursive: true })
  writeJsonStoreAtomic(WALLS_PATH, walls)
}

/** Tell the listeners `w` changed. Apart from the save, so a dispatch of many saves once. */
export function notify(w: CliMayteWorker): void {
  for (const cb of listeners) {
    try {
      cb(w)
    } catch {
      // a listener's failure is its own
    }
  }
}

export function changed(w: CliMayteWorker): void {
  w.updatedAt = Date.now()
  dirty.add(w.id)
  save()
  notify(w)
}

const isInit = (ev: unknown): boolean =>
  (ev as { type?: string; subtype?: string })?.type === 'system' &&
  (ev as { subtype?: string }).subtype === 'init'

/** Where a runner attempt's spec goes (climayte-runner.ts claims it by renaming it to `.taken` and
 *  deletes it once read; its path stays in the runner's command line, which is how isOurRunner
 *  recognises it). */
export const runnerSpecPath = (log: string): string => `${log}.spec.json`

/** Void an attempt's spec before its runner claims it: true when this rename won, so the runner
 *  will find nothing and start nothing. False when the runner took it first (or it is gone): the
 *  CLI is starting or started. A cancel 87-209 ms after launch used to stop at "no pid file yet"
 *  while the runner went on to run the whole task, unbilled (measured 2026-10-02, three workers).
 *  The voided copy goes at once: it carries the CLI's environment. */
export function voidSpec(log: string): boolean {
  const spec = runnerSpecPath(log)
  const voided = `${spec}.void`
  try {
    renameSync(spec, voided)
  } catch {
    return false
  }
  rmSync(voided, { force: true })
  return true
}

/** Placement inputs (climayte-placement.ts): what a task is expected to cost, what is running on
 *  each account and what it is expected to cost, and what attempts that ended since an account's
 *  first running worker started spent there (part of the meter's rise that is not the running
 *  work's; projectedPct). */
export function placementState(): {
  costOf: (w: Pick<CliMayteWorker, 'kind' | 'model' | 'effort'>) => CostEstimate
  running: Map<string, RunningLoad[]>
  finishedSince: Map<string, number>
} {
  const finished: FinishedCost[] = []
  for (const w of workers.values()) {
    const model = ladderModel(w.model ?? w.attempts.at(-1)?.model)
    const work = (a: CliMayteWorker['attempts'][number]): number =>
      (attemptUnits(a.tokens, a.model ?? w.model, a.cacheTtl) - rereadUnits(a, w.model)) /
      UNITS_PER_PRO_PERCENT
    // A manager is priced per wake (an attempt), however long its wave keeps it open (piece 6).
    if (w.kind === 'manage') {
      for (const a of w.attempts)
        if (a.tokens) finished.push({ kind: 'manage', model, effort: w.effort, pct: work(a) })
    } else if (w.status === 'done' && w.tokens) {
      // The work only: a move's re-read is what the move cost, not what the task costs.
      finished.push({
        kind: w.kind ?? null,
        model,
        effort: w.effort,
        pct: w.attempts.reduce((s, a) => s + work(a), 0),
      })
    }
  }
  const costOf = (w: Pick<CliMayteWorker, 'kind' | 'model' | 'effort'>): CostEstimate =>
    expectedCost({ kind: w.kind, model: ladderModel(w.model), effort: w.effort }, finished)
  const running = new Map<string, RunningLoad[]>()
  const firstStart = new Map<string, number>()
  for (const w of workers.values())
    if (w.status === 'running' && w.accountId) {
      const at = w.attempts.at(-1)
      running.set(w.accountId, [
        ...(running.get(w.accountId) ?? []),
        { expected: costOf(w).pct, startPct: at?.startPct ?? null },
      ])
      if (at)
        firstStart.set(
          w.accountId,
          Math.min(firstStart.get(w.accountId) ?? at.startedAt, at.startedAt),
        )
    }
  const finishedSince = new Map<string, number>()
  for (const w of workers.values())
    for (const a of w.attempts) {
      const since = firstStart.get(a.account.id)
      if (since === undefined || a.endedAt === null || a.endedAt <= since) continue
      const share =
        (a.endedAt - Math.max(a.startedAt, since)) / Math.max(1, a.endedAt - a.startedAt)
      const pct =
        (attemptUnits(a.tokens, a.model ?? w.model, a.cacheTtl) / UNITS_PER_PRO_PERCENT) * share
      finishedSince.set(a.account.id, (finishedSince.get(a.account.id) ?? 0) + pct)
    }
  return { costOf, running, finishedSince }
}

export const freshRead = (): LogRead => ({
  offset: 0,
  partial: '',
  events: [],
  recent: [],
  sawInit: false,
  model: null,
  overage: null,
  live: null,
  firstLive: null,
  lastAt: null,
})

/** A finished attempt's log, parsed once without keeping it in `reads`. */
export function peekLog(path: string): LogRead {
  return readInto(path, freshRead())
}

/** Where a packed attempt log is (packLog): beside the plain one it replaces. */
export const packedPath = (log: string): string => `${log}.zst`

/** Pack a finished attempt's log to `<log>.zst` and remove the plain file: nothing packed them, and
 *  corch/logs grew 170 MiB a day (429 MiB in 813 files, 2026-10-02). Only a log last written
 *  before `olderThan`, and only when it did not grow while it was read: a CLI that still has it
 *  open would lose what it appends after the remove. The packed file has its own name, so nothing
 *  is renamed over a file a process holds open (Windows refuses that); a plain file that cannot be
 *  removed stays, and the readers take the plain one first. The bytes packed; 0 when none were. */
export function packLog(path: string, olderThan: number): number {
  const tmp = `${packedPath(path)}.tmp`
  try {
    if (statSync(path).mtimeMs >= olderThan) return 0
    const raw = readFileSync(path)
    writeFileSync(tmp, zstdCompressSync(raw))
    if (statSync(path).size !== raw.length) {
      rmSync(tmp, { force: true })
      return 0
    }
    renameSync(tmp, packedPath(path))
    rmSync(path)
    return raw.length
  } catch {
    // no such log (packed already, or archived), or one that could not be packed this time
    rmSync(tmp, { force: true })
    return 0
  }
}

/** A packed log's text, or null with none. */
function packedText(path: string): string | null {
  try {
    return zstdDecompressSync(readFileSync(packedPath(path))).toString('utf8')
  } catch {
    return null
  }
}

/** An event's own `timestamp` in epoch ms, or null (a rate_limit_event carries none). */
function eventTime(ev: unknown): number | null {
  const t = (ev as { timestamp?: unknown } | null)?.timestamp
  const ms = typeof t === 'string' ? Date.parse(t) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

/** One raw line as a parsed event, or null when it is blank or not JSON (both skipped by the loop).
 *  Wrapped, so a line that parses to `null` is still an event and not a skip. */
function parseLogLine(line: string): { ev: unknown } | null {
  if (!line.trim()) return null
  try {
    return { ev: JSON.parse(line) }
  } catch {
    return null
  }
}

/** Fold one parsed event into the read: init/model, the overage and live readings, and the bounded
 *  events and recent-summaries lists. `replayAt` is null for a log being tailed (a reading is from
 *  now); on a replay it is the file's last write, the time of a reading no stamped event came
 *  before. */
function applyLogEvent(ev: unknown, r: LogRead, replayAt: number | null): void {
  if (isInit(ev)) {
    r.sawInit = true
    const model = (ev as { model?: unknown }).model
    if (typeof model === 'string' && model) r.model = model
  }
  r.overage ??= overageStart(ev)
  r.lastAt = eventTime(ev) ?? r.lastAt
  r.live = liveUsage(ev, replayAt === null ? Date.now() : (r.lastAt ?? replayAt)) ?? r.live
  r.firstLive ??= r.live
  r.events.push(ev)
  if (r.events.length > 400) r.events.splice(0, r.events.length - 400)
  const s = summarizeEvent(ev)
  if (s) {
    r.recent.push(s)
    if (r.recent.length > 60) r.recent.splice(0, r.recent.length - 60)
  }
}

/** The next stretch of a log's text into the read: whole lines, the rest waits in `partial`. */
function feedLog(text: string, r: LogRead, replayAt: number | null): void {
  const lines = (r.partial + text).split(/\r?\n/)
  r.partial = lines.pop() ?? ''
  for (const line of lines) {
    const parsed = parseLogLine(line)
    if (parsed === null) continue
    applyLogEvent(parsed.ev, r, replayAt)
  }
}

/** `replay`: this read starts a log an earlier daemon was already tailing, so its usage readings
 *  keep their own time (the event before them, else the file's last write). Stamped 'now', a
 *  reading minutes old outranked newer ones from the account's other workers and the usage
 *  snapshot: 18 of 27 restarts with runner workers had two or more on one account (2026-10-02). */
export function readInto(path: string, r: LogRead, replay = false): LogRead {
  let size = 0
  let writtenAt = 0
  try {
    const stat = statSync(path)
    size = stat.size
    writtenAt = stat.mtimeMs
  } catch {
    // No plain file: a finished attempt's log may be packed (packLog), and is then read whole, once.
    const packed = r.offset === 0 ? packedText(path) : null
    if (packed) {
      r.offset = packed.length
      feedLog(packed, r, null)
    }
    return r
  }
  if (size > r.offset) {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(size - r.offset)
      readSync(fd, buf, 0, buf.length, r.offset)
      r.offset = size
      feedLog(buf.toString('utf8'), r, replay ? writtenAt : null)
    } finally {
      closeSync(fd)
    }
  }
  return r
}

export function tailText(path: string, max: number): string {
  try {
    const size = statSync(path).size
    const fd = openSync(path, 'r')
    try {
      const n = Math.min(size, max)
      const buf = Buffer.alloc(n)
      readSync(fd, buf, 0, n, size - n)
      return buf.toString('utf8').trim()
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/** An ended attempt's own spend and tokens, from its transcript on the account it ran on
 *  (attemptSpend). */
export function spentOf(w: CliMayteWorker, at: CliMayteWorker['attempts'][number]): AttemptSpend {
  const dir = at.account.configDir ?? getCliInstance(at.account.id)?.configDir
  // null: its log names no session, the CLI never started, so it spent nothing.
  const session = at.sessionId === undefined ? w.sessionId : at.sessionId
  const none = { costUsd: 0, tokens: noTokens(), turns: 0, first: null, settled: true }
  if (!dir) return { ...none, found: false }
  if (!session) return { ...none, found: true }
  return readSpend(dir, `cli:${at.account.id}`, session, at.startedAt, at.endedAt ?? Date.now())
}

/** Test seam: a scratch kit store to read instead of the daemon's, and what runs before each read
 *  (a test has no sweep, so it ingests the fake transcripts there). null: the daemon's own. */
let spendKit: {
  store: KitStore
  refresh?: (configDir: string, instance: string, session: string) => void
} | null = null
export function setSpendKit(k: typeof spendKit): void {
  spendKit = k
}

function readSpend(
  dir: string,
  instance: string,
  session: string,
  startedAt: number,
  endedAt: number,
): AttemptSpend {
  spendKit?.refresh?.(dir, instance, session)
  return attemptSpend(dir, instance, session, startedAt, endedAt, spendKit?.store)
}

/** Safety cap: how long after an attempt ended the kit may stay behind before its figures are taken as
 *  they are (flagged `spendCapped`). A sweep is every 60 s, but a sweep after a schema migration or on
 *  a fresh store can run for 20+ minutes with nothing ingested, so only a file the kit never covers
 *  reaches this. */
export const SPEND_SETTLE_CAP_MS = 24 * 3_600_000

/** An open attempt is read again at most this often: each read is a kit query, and the kit changes
 *  once per sweep. */
export const SPEND_REREAD_MS = 60_000

/** Charge an ended attempt's spend, and remember when the kit was still behind: `spendOpen` holds
 *  the cost charged so far (the task's tokens and cost already include it). */
export function chargeAttempt(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  spent: AttemptSpend,
): void {
  at.tokens = spent.tokens
  at.spend = spendRecord(w, at, spent)
  w.costUsd += spent.costUsd
  w.tokens = addTokens(w.tokens, spent.tokens)
  if (spent.found && !spent.settled) at.spendOpen = spent.costUsd
}

/** The kit reads transcripts on a 60 s sweep, so an attempt charged the moment it ended can be short
 *  of its last minute of calls. Rather than make that sync path wait on an ingest, it is charged
 *  from what the kit has and marked `spendOpen`; once the kit's ingest cursors cover the attempt's
 *  files (or SPEND_SETTLE_CAP_MS has passed) it is read again, at most once per SPEND_REREAD_MS, and the difference goes to the attempt and
 *  to its task, so the task's totals end equal to what the transcripts hold. Does nothing, and
 *  reads nothing, with no open attempt. True when any record changed. */
export function settleSpends(now: number = Date.now()): boolean {
  const open = [...workers.values()].flatMap((w) =>
    w.attempts.filter((a) => a.spendOpen !== undefined).map((a) => ({ w, a })),
  )
  if (!open.length) return false
  let any = false
  for (const { w, a } of open) {
    const dir = a.account.configDir ?? getCliInstance(a.account.id)?.configDir
    const session = a.sessionId === undefined ? w.sessionId : a.sessionId
    if (!dir || !session || a.endedAt === null) {
      a.spendOpen = undefined
      continue
    }
    if (a.spendReadAt !== undefined && now - a.spendReadAt < SPEND_REREAD_MS) continue
    a.spendReadAt = now
    const spent = readSpend(dir, `cli:${a.account.id}`, session, a.startedAt, a.endedAt)
    if (!spent.found) {
      a.spendOpen = undefined // the transcript is gone: what was charged stands
      a.spendReadAt = undefined
      continue
    }
    if (!spent.settled) {
      if (now - a.endedAt < SPEND_SETTLE_CAP_MS) continue
      a.spendCapped = true // the kit never covered its files: taken as it is, and said so
    }
    const was = a.tokens ?? noTokens()
    w.costUsd += spent.costUsd - (a.spendOpen ?? 0)
    w.tokens = addTokens(w.tokens, {
      input: spent.tokens.input - was.input,
      output: spent.tokens.output - was.output,
      cacheRead: spent.tokens.cacheRead - was.cacheRead,
      cacheWrite: spent.tokens.cacheWrite - was.cacheWrite,
    })
    a.tokens = spent.tokens
    a.spend = spendRecord(w, a, spent)
    a.spendOpen = undefined
    a.spendReadAt = undefined
    dirty.add(w.id)
    any = true
  }
  if (any) save()
  return any
}

/** The last attempt before `at` that made a model request (spent tokens), or undefined. One that
 *  started but was refused (signed out, Claude Code switched off) wrote no conversation to re-read:
 *  run 1 had three first attempts like that, and the run after each was fresh. */
export function lastThatRan(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
): CliMayteWorker['attempts'][number] | undefined {
  const i = w.attempts.indexOf(at)
  return w.attempts
    .slice(0, Math.max(0, i))
    .reverse()
    .find(
      (a) =>
        (a.tokens
          ? a.tokens.input + a.tokens.output + a.tokens.cacheRead + a.tokens.cacheWrite
          : 0) > 0,
    )
}

/** An attempt's `spend` from its transcript; its first request is a re-read only after a run that
 *  ran (lastThatRan). */
export function spendRecord(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  spent: AttemptSpend,
): CliMayteWorker['attempts'][number]['spend'] {
  if (!spent.found) return null
  const ranBefore = lastThatRan(w, at) !== undefined
  return {
    costUsd: Math.round(spent.costUsd * 10_000) / 10_000,
    turns: spent.turns,
    reread:
      ranBefore && spent.first
        ? { input: spent.first.input, output: 0, cacheRead: 0, cacheWrite: spent.first.cacheWrite }
        : null,
  }
}

/** The session id the CLI reported in an attempt's log (its system/init event), or null. */
function sessionOfLog(log: string): string | null {
  for (const line of logHead(log).split('\n')) {
    if (!line.includes('"init"')) continue
    try {
      const ev = JSON.parse(line)
      if (ev?.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string')
        return ev.session_id
    } catch {
      // a partial last line
    }
  }
  return null
}

/** The first 256 KB of an attempt's log (the packed one's when it is packed), '' with no log. */
function logHead(log: string): string {
  let fd: number | null = null
  try {
    fd = openSync(log, 'r')
    const buf = Buffer.alloc(256 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return packedText(log)?.slice(0, 256 * 1024) ?? ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** The highest 5-hour usage a log's main-agent rate_limit_events reported, with that window's
 *  reset; null with none (or no log). */
function peakOfLog(log: string): { pct: number; resetsAt: number | null } | null {
  let text: string | null = null
  try {
    text = readFileSync(log, 'utf8')
  } catch {
    text = packedText(log)
  }
  if (text === null) return null
  let peak: { pct: number; resetsAt: number | null } | null = null
  for (const line of text.split('\n')) {
    if (!line.includes('"rate_limit_event"')) continue
    let ev: unknown
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const live = liveUsage(ev, 0)
    if (live?.sessionPct != null && (!peak || live.sessionPct > peak.pct))
      peak = { pct: live.sessionPct, resetsAt: live.sessionResetsAt }
  }
  return peak
}

/** A task's attempts recorded before they kept their session: the session is the one their log
 *  names, and the tokens of any attempt that got none, from its transcript, added to the task's.
 *  The first backfill read every attempt against the task's CURRENT session, so the attempts
 *  before a planned handoff (a new session) got 0 tokens: 47M uncounted in run 1. Recounted
 *  once here; their cost was charged at the time, from the right session, and stays.
 *  True when any attempt's record changed. */
function backfillAttemptTokens(w: CliMayteWorker): boolean {
  let any = false
  for (const at of w.attempts) {
    if (at.endedAt === null || at.sessionId !== undefined) continue
    at.sessionId = sessionOfLog(at.log)
    any = true
    if (!w.tokens || !at.tokens || at.sessionId === null) continue
    const had = at.tokens
    if (had.input + had.output + had.cacheRead + had.cacheWrite > 0) continue
    at.tokens = spentOf(w, at).tokens
    w.tokens = addTokens(w.tokens, at.tokens)
  }
  return any
}

/** Each ended attempt's peak 5-hour usage, once, from its log's rate_limit_events.
 *  True when any attempt's record changed. */
function backfillAttemptPeaks(w: CliMayteWorker): boolean {
  let any = false
  for (const at of w.attempts) {
    if (at.endedAt === null || at.peak !== undefined) continue
    at.peak = peakOfLog(at.log)
    any = true
  }
  return any
}

/** Each ended ceiling stop's onArrival (pastOnArrival), once, from its log's first reading: stops
 *  recorded before it was kept would otherwise count as stop lines that came too late. True when
 *  any attempt's record changed. */
function backfillCeilingArrival(w: CliMayteWorker): boolean {
  let any = false
  for (const at of w.attempts) {
    if (at.endedAt === null || !at.ceiling || at.ceiling.onArrival !== undefined) continue
    at.ceiling.onArrival = pastOnArrival(peekLog(at.log).firstLive, at.ceiling)
    any = true
  }
  return any
}

/** Each ended attempt's cost, requests and re-read, once. Its tokens and the task's cost were
 *  recorded when it ended and stay as they are. True when any attempt's record changed. */
function backfillAttemptSpend(w: CliMayteWorker): boolean {
  let any = false
  for (const at of w.attempts) {
    if (at.endedAt === null) continue
    if (at.spend === undefined) {
      at.spend = spendRecord(w, at, spentOf(w, at))
      any = true
    } else if (at.spend?.reread && !lastThatRan(w, at)) {
      // Recorded by 29d4c56's first rule, which counted a refused first try as a run.
      at.spend.reread = null
      any = true
    }
  }
  return any
}

/** What each verdict's work spent re-reading: the attempts it judged, those started since the
 *  verdict before it. Worked out again on every load (no file is read), so it follows the
 *  attempts' records. True when any verdict's record changed. */
function backfillVerdictRereads(w: CliMayteWorker): boolean {
  let any = false
  for (const [i, v] of (w.verdicts ?? []).entries()) {
    const since = w.verdicts?.[i - 1]?.at ?? 0
    const reread = w.attempts
      .filter((a) => a.startedAt >= since && a.startedAt < v.at)
      .reduce((sum, a) => sum + rereadUnits(a, w.model), 0)
    if (v.reread === reread) continue
    v.reread = reread
    any = true
  }
  return any
}

/** The task's total tokens, once, summed from its ended attempts' transcripts; only a task that
 *  keeps none yet. True when the total was recorded. */
function backfillWorkerTokens(w: CliMayteWorker): boolean {
  if (w.tokens) return false
  let total = noTokens()
  for (const at of w.attempts) {
    if (at.endedAt === null) continue
    at.tokens ??= spentOf(w, at).tokens
    total = addTokens(total, at.tokens)
  }
  w.tokens = total
  return true
}

/** Tasks recorded before attempts kept their tokens get them once, from their transcripts, so the
 *  view's totals cover them too. Their cost was already charged and is left alone. */
function backfillTokens(): boolean {
  let any = false
  for (const w of workers.values()) {
    let mine = false
    if (backfillAttemptTokens(w)) mine = true
    if (backfillAttemptPeaks(w)) mine = true
    if (backfillCeilingArrival(w)) mine = true
    if (backfillAttemptSpend(w)) mine = true
    if (backfillVerdictRereads(w)) mine = true
    if (backfillWorkerTokens(w)) mine = true
    if (!mine) continue
    // A finished worker's own file is rewritten only when that worker is marked (save).
    dirty.add(w.id)
    any = true
  }
  return any
}

/** The handoff file exists and was written after the wind-down was asked for (a stale one from an
 *  earlier run with the same name does not count). */
export function handoffWritten(windDown: { at: number; path: string }): boolean {
  try {
    return statSync(windDown.path).mtimeMs >= windDown.at - 1_000
  } catch {
    return false
  }
}

/** A session's transcript file on an account, or null. */
export function transcriptFile(configDir: string | null, sessionId: string): string | null {
  if (!configDir) return null
  const root = join(configDir, 'projects')
  try {
    for (const d of readdirSync(root)) {
      const f = join(root, d, `${sessionId}.jsonl`)
      if (existsSync(f)) return f
    }
  } catch {
    // no projects folder
  }
  return null
}

export function hasTranscript(configDir: string, sessionId: string): boolean {
  const root = join(configDir, 'projects')
  try {
    return readdirSync(root).some((d) => existsSync(join(root, d, `${sessionId}.jsonl`)))
  } catch {
    return false
  }
}

export function configDirOf(id: string, accounts: CliMayteAccount[]): string | null {
  return accounts.find((a) => a.id === id)?.configDir ?? getCliInstance(id)?.configDir ?? null
}

/** Every account that may hold a copy of the task's transcript, for newestTranscript: the ones its
 *  attempts ran on, newest first (an attempt refused at sign-in wrote nothing, so those go last),
 *  then every other account CliMayte can use. */
export function transcriptCandidates(
  w: CliMayteWorker,
  accounts: CliMayteAccount[],
): Array<{ id: string; configDir: string }> {
  const ids: string[] = []
  const add = (id: string | null | undefined): void => {
    if (id && !ids.includes(id)) ids.push(id)
  }
  const tried = [...w.attempts].reverse()
  for (const a of tried) if (a.outcome !== 'auth') add(a.account.id)
  add(w.accountId)
  for (const a of tried) add(a.account.id)
  for (const a of accounts) add(a.id)
  return ids.flatMap((id) => {
    const configDir = configDirOf(id, accounts)
    return configDir ? [{ id, configDir }] : []
  })
}

/** The session ran somewhere (it holds work a fresh start would lose): an attempt of it got past
 *  sign-in. An attempt recorded before attempts kept their session counts when there was only one. */
export function sessionRan(w: CliMayteWorker, sessionId: string): boolean {
  return w.attempts.some(
    (a) =>
      (a.sessionId === sessionId || (a.sessionId === undefined && !w.sessions?.length)) &&
      a.outcome !== 'auth' &&
      (a.started === true || a.outcome === 'done'),
  )
}

/** The newest handoff note the task wrote, or null. */
export function lastHandoffNote(w: CliMayteWorker): string | null {
  for (let i = w.attempts.length - 1; i >= 0; i--) {
    const d = w.attempts[i]!.windDown
    if (d && handoffWritten(d)) return d.path
  }
  return null
}

/** What an expected cost is based on, in words: 'sweep on other models, scaled to Sonnet, 3 finished'. */
export function basisText(
  cost: CostEstimate,
  s: { kind?: string | null; model: string | null; effort: string | null },
): string {
  if (!cost.samples) return 'nothing on record yet (the default)'
  const fam = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }[modelFamily(ladderModel(s.model))]
  const on = {
    setting: `${s.kind} on ${ladderModel(s.model) ?? 'the CLI default'} ${s.effort ?? 'default effort'}`,
    'kind-model': `${s.kind} on ${fam} at other efforts`,
    kind: `${s.kind} on other models, scaled to ${fam}`,
    model: `${fam} tasks of any kind`,
    default: '',
  }[cost.basis]
  return `${on}, ${cost.samples} finished`
}

/** Weighted units as % of a Pro 5-hour window, to one decimal. */
export const pct1 = (units: number): number => Math.round((units / UNITS_PER_PRO_PERCENT) * 10) / 10
