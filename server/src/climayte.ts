// server/src/climayte.ts — the RUNTIME half of CliMayte (docs/CLIMAYTE.md): the store, the launch of each
// attempt, the tick that watches workers, and the API the routes and MCP tools call. The decisions
// themselves (how an attempt ended, which account is next, how a session moves) live in
// climayte-lib.ts, which is pure and pinned by tests.
//
// WHY (owner, 2026-09-30): "I want this fully delegated ... orchestrating them only to CLI, not
// desktop instances ... just use all of my CLI accounts." A chat keeps only the orchestration; each
// piece of work is a Claude Code CLI session on one of his signed-in CLI instances, and a session
// that hits an account's usage limit is copied to another account and resumed there by itself. A
// Pro account's five-hour window lasts about ten minutes of heavy work, and moving threads by hand
// was the cost this removes.
//
// VISIBLE, WITHOUT A WINDOW. Workers run with `windowsHide` (no console on his screen, the 2026-08-31
// ruling) and every one is readable live in the CliMayte view and through climayte_status, and its
// transcript is an ordinary session in that account's folder. headless-policy.ts names this as the
// one exemption. Nothing here starts on its own: with no worker queued each tick is a no-op.

import {
  closeSync,
  cpSync,
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
import { finish } from './climayte-finish'
import {
  appendJournal,
  type CliMayteJournalEntry,
  type CliMayteJournalEvent,
  firstLine,
  formatJournalLine,
  type JournalFilter,
  readJournal,
} from './climayte-journal'
import {
  type AttemptSpend,
  aboutToBill,
  addTokens,
  atCeiling,
  attemptSpend,
  type CliMayteAccount,
  type CliMayteLiveUsage,
  type CliMayteSizing,
  type CliMayteWalls,
  type CliMayteWorker,
  type CliMayteWorkerBrief,
  type CliMayteWorkerReport,
  type CliMayteWorkerView,
  ceilingNotice,
  climayteEffort,
  climayteModel,
  climaytePriority,
  dueOrder,
  freshestPct,
  isLoginWall,
  isOrgDisabled,
  liveUsage,
  noTokens,
  ORG_DISABLED_WALL,
  OVERAGE_NOTICE,
  overageStart,
  PRE_OVERAGE_NOTICE,
  recentWorkers,
  summarizeEvent,
  toBrief,
  toReport,
  toView,
  wallUntil,
  windDownAt,
  windDownMessage,
} from './climayte-lib'
import {
  type CostEstimate,
  expectedCost,
  FIT_PCT,
  modelFamily,
  planFactor,
  projectedPct,
  type RunningLoad,
  sizeTask,
} from './climayte-placement'
import { readRunnerExit, readRunnerPids } from './climayte-runner'
import { pollRunning, scheduleWorker, tickAccounts, tickState } from './climayte-schedule'
import {
  attemptUnits,
  bestRung,
  type CliMayteKind,
  type CliMayteVerdict,
  climayteKind,
  ladderIndex,
  ladderModel,
  nextRung,
  pickConfig,
  rereadUnits,
  scoreRows,
  UNITS_PER_PRO_PERCENT,
} from './climayte-scorecard'
import { resolveClaudeExe } from './config'
import { getCliInstance, listCliInstances, setCliLoginVeto } from './core/cli-instances'
import { cliAuthStatus } from './core/cli-quick-add'
import { type JsonStoreSpec, readJsonStore, writeJsonStoreAtomic } from './core/json-store'
import { isPidAlive, killProcessTree } from './core/process'
import { POINTER_DIR } from './instance'
import { getProviderSettings } from './provider-settings'
import type { UsageSnapshot } from './types'
import { parseResetTime } from './usage'
import { allCachedUsage } from './usage-cache'

export * from './climayte-journal'
export * from './climayte-lib'
export { climayteTotals } from './climayte-totals'

// POINTER_DIR is CONFIG_DIR for the primary install and a side-run's own data dir otherwise, so
// two daemons never tick and overwrite the same workers.json.
const ROOT = join(POINTER_DIR, 'corch')
export const LOGS = join(ROOT, 'logs')
export const PROMPTS = join(ROOT, 'prompts')
export const HOOKS = join(ROOT, 'hooks')
const SIGNALS = join(ROOT, 'signals')
const HANDOFFS = join(ROOT, 'handoffs')
/** Forward slashes: the path goes into a bash command (the hook) and into the model's prompt. */
export const slashed = (p: string): string => p.replace(/\\/g, '/')
export const signalPath = (workerId: string): string => join(SIGNALS, `${workerId}.json`)
const WALLS_PATH = join(ROOT, 'walls.json')
const LIVE_PATH = join(ROOT, 'live.json')
const JOURNAL_PATH = join(ROOT, 'journal.jsonl')

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

/** The journal in scope, oldest first (the newest `limit`, default 100). */
export function climayteJournal(filter: JournalFilter = {}): CliMayteJournalEntry[] {
  return readJournal(JOURNAL_PATH, filter)
}

/** The same entries as readable one-line strings (formatJournalLine), newest last. */
export function climayteJournalLines(filter: JournalFilter = {}): string[] {
  const now = new Date()
  return climayteJournal(filter).map((e) => formatJournalLine(e, now))
}

/** A journal line about an account rather than a worker: the keepalive's nudges (usage-refresh.ts),
 *  under id and group 'keepalive', so `climayte_log { group: 'keepalive' }` lists them and a run's
 *  log shows when an idle account's window was started beside the work placed on it. */
export function climayteJournalNudge(
  details: Omit<Partial<CliMayteJournalEntry>, 'ts' | 'id' | 'group' | 'title' | 'event'>,
): void {
  appendJournal(JOURNAL_PATH, {
    ts: new Date().toISOString(),
    id: 'keepalive',
    group: 'keepalive',
    title: 'Start the 5-hour window',
    event: 'nudged',
    ...details,
  })
}

interface Store {
  workers: CliMayteWorker[]
  perAccount: Record<string, number>
}
const STORE_SPEC: JsonStoreSpec<Store> = {
  path: join(ROOT, 'workers.json'),
  decode: (p) => {
    const w = (p as { workers?: unknown })?.workers
    if (!Array.isArray(w)) return null
    return { workers: w as CliMayteWorker[], perAccount: (p as Store).perAccount ?? {} }
  },
  empty: () => ({ workers: [], perAccount: {} }),
}

export const workers = new Map<string, CliMayteWorker>()
export let perAccount: Record<string, number> = {}
export let walls: CliMayteWalls = {}
let loaded = false
let started = false
let timer: ReturnType<typeof setTimeout> | null = null
let ticking = false
/** Per attempt log: bytes read, an unfinished last line, the events kept, the summaries shown,
 *  and whether system/init was ever seen (kept apart: the events list drops old ones). */
interface LogRead {
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
}
const reads = new Map<string, LogRead>()
/** Each account's newest live usage reading from any of its workers' streams (poll copies it
 *  here). The usage snapshot is refreshed only every 15 minutes; this is seconds old. */
const liveByAccount = new Map<string, CliMayteLiveUsage>()

/** The live readings are kept on disk too: an account whose workers stopped at its limit has no
 *  stream left to read, and a restart used to drop its last reading, so the tables and the routing
 *  fell back to a usage snapshot from before the limit (run 1: #88 showed 43% while walled until
 *  11:30pm; its last live reading was 97%). A reading whose window has reset is void anyway. */
let liveDirty = false
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
function saveLive(): void {
  if (!liveDirty) return
  liveDirty = false
  try {
    mkdirSync(ROOT, { recursive: true })
    const tmp = `${LIVE_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(liveByAccount)))
    renameSync(tmp, LIVE_PATH)
  } catch (err) {
    console.error('[climayte] could not save live readings:', err)
  }
}

/** A copy of each account's newest live reading, for the usage tables (usage-live.ts). */
export function climayteLiveReadings(): Map<string, CliMayteLiveUsage> {
  load()
  return new Map(liveByAccount)
}

/** Accounts CliMayte has walled at a usage limit, with when the wall ends and whether the limit is
 *  the weekly one: the tables show those as at their limit (usage-live.ts withLimitWall), not the
 *  percentage of a snapshot read before the limit hit (field note 19). */
export function climayteLimitWalls(): Map<string, { until: number; weekly: boolean }> {
  load()
  const now = Date.now()
  const out = new Map<string, { until: number; weekly: boolean }>()
  for (const [id, wall] of Object.entries(walls)) {
    if (isLoginWall(wall.reason) || wall.until <= now) continue
    out.set(id, { until: wall.until, weekly: /weekly/i.test(wall.reason) })
  }
  return out
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
const listeners = new Set<(w: CliMayteWorker) => void>()

export let claudeCommand: () => string[] = () => [resolveClaudeExe()]
/** The production pool: every CLI instance with a credential file, with its last usage reading
 *  (void once its window has reset), or a running worker's live one when that is newer. A hollow
 *  or revoked login still passes that file check; its first attempt fails `auth` and the account
 *  stays walled until it signs in again (recheckSignedOut), so a dead login costs one quick
 *  failure, once. */
function signedInAccounts(): CliMayteAccount[] {
  const now = Date.now()
  const cache = allCachedUsage()
  // A login vetoed by CliMayte's own signed-out wall stays in the pool, walled, so recheckSignedOut
  // can find out when it works again.
  return listCliInstances()
    .filter((i) => i.loggedIn || !!i.loginNote)
    .map((i) => {
      const u = latestUsage(i.id, i.lastUsageCheck, cache)
      const snapshotAt = u ? Date.parse(u.capturedAt) || 0 : 0
      const live = liveByAccount.get(i.id) ?? null
      const liveSession =
        live && live.sessionPct !== null
          ? { pct: live.sessionPct, resetsAt: live.sessionResetsAt, at: live.at }
          : null
      const sessionPct = freshestPct(u?.session, snapshotAt, liveSession, now)
      // The reset of whichever reading sessionPct came from.
      const resets =
        liveSession && liveSession.at > snapshotAt
          ? liveSession.resetsAt
          : u?.session?.resetsAt
            ? Date.parse(u.session.resetsAt) || null
            : null
      const liveWeek =
        live && live.weekPct !== null
          ? { pct: live.weekPct, resetsAt: live.weekResetsAt, at: live.at }
          : null
      const weekPct = freshestPct(u?.weekAll, snapshotAt, liveWeek, now)
      const weekResets =
        liveWeek && liveWeek.at > snapshotAt
          ? liveWeek.resetsAt
          : u?.weekAll?.resetsAt
            ? Date.parse(u.weekAll.resetsAt) || null
            : null
      return {
        id: i.id,
        num: i.num ?? null,
        name: i.name,
        configDir: i.configDir,
        planFactor: planFactor(i.planLabel),
        sessionPct,
        sessionResetsAt: sessionPct !== null && resets !== null && resets > now ? resets : null,
        weekPct,
        weekResetsAt:
          weekPct !== null && weekResets !== null && weekResets > now ? weekResets : null,
      }
    })
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

export const SIGNED_OUT_MS = 30 * 60_000
/** An organization's switch is not on a clock: its wall waits for a new login (recheckSignedOut). */
export const ORG_WALL_MS = 365 * 24 * 3_600_000
export const credStamp = (configDir: string): number | null => {
  try {
    return statSync(join(configDir, '.credentials.json')).mtimeMs
  } catch {
    return null
  }
}
const authChecks = new Set<string>()

/** Walls' write is atomic (saveWalls); a failed one keeps the in-memory change and must not stop
 *  the recheck that made it. */
export function trySaveWalls(): void {
  try {
    saveWalls()
  } catch (err) {
    console.error('[climayte] could not save walls:', err)
  }
}

/** `auth status` passes a login whose organization turned Claude Code off, so only a new login
 *  (the credential file changing) lifts that wall; the next attempt then tells. True when `a`'s
 *  wall is that wall and the signed-out recheck must skip it. */
function recheckOrgWall(a: CliMayteAccount, wall: CliMayteWalls[string] | undefined): boolean {
  if (wall?.reason !== ORG_DISABLED_WALL) return false
  // A wall from before walls kept the credential's stamp takes today's, so a new login can
  // still lift it.
  if (wall.cred === undefined) {
    wall.cred = credStamp(a.configDir)
    trySaveWalls()
  } else if (wall.cred !== credStamp(a.configDir)) {
    delete walls[a.id]
    trySaveWalls()
  }
  return true
}

/** Ask the CLI whether `a`'s login works again; a yes lifts its wall. Any answer saves the wall
 *  (its new `until`, or its removal) and schedules the next tick at once. */
function checkAuth(a: CliMayteAccount): void {
  void cliAuthStatus(a.configDir)
    .then((s) => {
      if (s.loggedIn) delete walls[a.id]
    })
    .catch(() => {})
    .finally(() => {
      authChecks.delete(a.id)
      trySaveWalls()
      schedule(0)
    })
}

/** A signed-out wall is never lifted by the clock alone. When it runs out, or the account's
 *  credential file changes (a new sign-in), the CLI's own `auth status` decides: about a quarter
 *  of a second, no quota. A dead login stays walled, so it never costs another worker a failed
 *  attempt (before this, an expired account took one attempt from some worker every 30 minutes);
 *  a login that works again rejoins the pool at once. */
function recheckSignedOut(accounts: CliMayteAccount[], now: number): void {
  for (const a of accounts) {
    const wall = walls[a.id]
    if (recheckOrgWall(a, wall)) continue
    if (wall?.reason !== 'signed out' || authChecks.has(a.id)) continue
    const cred = credStamp(a.configDir)
    if (wall.until > now && (wall.cred === undefined || wall.cred === cred)) continue
    wall.until = now + SIGNED_OUT_MS
    wall.cred = cred
    authChecks.add(a.id)
    checkAuth(a)
  }
}
/** Why an account whose credential file exists is nevertheless signed out, or null. Field note 3
 *  (2026-09-30): the CLI instance list said `loggedIn: true` for two accounts whose login was dead,
 *  because it only checks that the file exists. CliMayte's signed-out wall is the verified answer: set
 *  when an attempt failed to authenticate, and lifted only when `claude auth status` says the login
 *  works (recheckSignedOut, every 30 minutes and whenever the credential file changes). A file
 *  rewritten since the wall (a new sign-in not yet rechecked) is given the benefit of the doubt.
 *  Costs one map lookup and one stat, so the listing stays as fast as it was. */
export function climayteSignedOutReason(id: string, configDir: string): string | null {
  load()
  const wall = walls[id]
  if (!isLoginWall(wall?.reason)) return null
  if (wall!.cred !== undefined && wall!.cred !== credStamp(configDir)) return null
  if (wall!.reason === ORG_DISABLED_WALL)
    return 'Claude Code is turned off for this account\'s organization ("Your organization has disabled Claude subscription access for Claude Code"), so CliMayte does not use it. Sign it in with a different login to use it again.'
  return 'Signed out: its credential file is there, but the login failed when CliMayte used it and has not worked since (checked again every 30 minutes, and as soon as the account signs in again). Sign in again: Quick add, or Log in.'
}

setCliLoginVeto(climayteSignedOutReason)

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

export function onCliMayteChange(cb: (w: CliMayteWorker) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function load(): void {
  if (loaded) return
  loaded = true
  const read = readJsonStore(STORE_SPEC)
  if (read.status === 'ok') {
    for (const w of read.value.workers) workers.set(w.id, w)
    perAccount = read.value.perAccount
    if (backfillTokens()) save()
  } else if (read.status !== 'missing') {
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

function save(): void {
  if (!loaded) return
  mkdirSync(ROOT, { recursive: true })
  writeJsonStoreAtomic(STORE_SPEC.path, { workers: [...workers.values()], perAccount })
}

function saveWalls(): void {
  mkdirSync(ROOT, { recursive: true })
  writeJsonStoreAtomic(WALLS_PATH, walls)
}

export function changed(w: CliMayteWorker): void {
  w.updatedAt = Date.now()
  save()
  for (const cb of listeners) {
    try {
      cb(w)
    } catch {
      // a listener's failure is its own
    }
  }
}

const isActive = (w: CliMayteWorker): boolean =>
  w.status === 'queued' ||
  w.status === 'running' ||
  w.status === 'waiting' ||
  w.status === 'checking'

/** The task's proof, run by CliMayte itself (owner, 2026-09-30: "whatever is best for the AI"): an
 *  orchestrator that has to remember to judge every result forgets some, and a worker's own "the
 *  tests pass" is a claim. A task with a `check` command is judged by its exit code the moment the
 *  worker reports done; a fail goes back to the same session one rung up the ladder with the end of
 *  the command's output, so nobody has to read it first. It runs under the daemon, so a restart
 *  ends it and the next daemon runs it again (tick). */
const checks = new Map<string, { kill: () => void }>()
/** A check that still fails after this many rounds stops the task for the orchestrator. */
const MAX_CHECK_FAILS = 3
const CHECK_TIMEOUT_MS = 20 * 60_000

/** Git's bash on Windows, never the WSL `bash.exe` in System32 that PATH may find first. */
function checkShell(): string {
  if (process.platform !== 'win32') return 'bash'
  for (const root of [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ]) {
    if (!root) continue
    for (const sub of [
      ['Git', 'bin', 'bash.exe'],
      ['Programs', 'Git', 'bin', 'bash.exe'],
    ]) {
      const exe = join(root, ...sub)
      if (existsSync(exe)) return exe
    }
  }
  return 'bash'
}

export function startCheck(w: CliMayteWorker): void {
  if (!w.check || checks.has(w.id)) return
  w.status = 'checking'
  w.checkRuns = (w.checkRuns ?? 0) + 1
  mkdirSync(LOGS, { recursive: true })
  const out = join(LOGS, `${w.id}-check-${w.checkRuns}.log`)
  const fd = openSync(out, 'w')
  journal(w, 'check', { notice: firstLine(w.check) })
  let timedOut = false
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([checkShell(), '-c', w.check], {
      cwd: w.cwd,
      stdin: 'ignore',
      stdout: fd,
      stderr: fd,
      windowsHide: true,
    })
  } catch (err) {
    closeSync(fd)
    judgeCheck(w, null, `could not start: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const timer = setTimeout(() => {
    timedOut = true
    killProcessTree(proc.pid)
  }, CHECK_TIMEOUT_MS)
  checks.set(w.id, { kill: () => killProcessTree(proc.pid) })
  changed(w)
  void proc.exited.then((code) => {
    clearTimeout(timer)
    try {
      closeSync(fd)
    } catch {
      // already closed
    }
    if (!checks.delete(w.id) || w.status !== 'checking') return // cancelled meanwhile
    judgeCheck(
      w,
      timedOut ? null : code,
      timedOut ? 'timed out after 20 minutes' : tailText(out, 1500),
    )
  })
}

function judgeCheck(w: CliMayteWorker, code: number | null, output: string): void {
  w.status = 'done'
  const cmd = firstLine(w.check, 200)
  if (code === 0) {
    climayteVerdict(w.id, { verdict: 'pass', note: `The check passed: ${cmd}`, by: 'check' })
    return
  }
  const fails =
    (w.verdicts ?? []).filter((v) => v.by === 'check' && v.verdict === 'fail').length + 1
  const retry = fails < MAX_CHECK_FAILS
  const note = `The check \`${cmd}\` failed (${code === null ? output : `exit ${code}`}). The end of its output:
${code === null ? '' : output.trim()}`
  climayteVerdict(w.id, { verdict: 'fail', note, retry, by: 'check' })
  if (!retry) {
    w.status = 'failed'
    w.error = `The check still failed after ${MAX_CHECK_FAILS} rounds; it needs the orchestrator. Last: ${firstLine(output)}`
    journal(w, 'failed', { error: firstLine(w.error) })
    changed(w)
  }
}

const isInit = (ev: unknown): boolean =>
  (ev as { type?: string; subtype?: string })?.type === 'system' &&
  (ev as { subtype?: string }).subtype === 'init'

/** Workers whose CLI a daemon restart would kill: only attempts the daemon spawned itself (before
 *  runners, 2026-09-30), which sit in its kill-on-close job on Windows. A worker under a runner
 *  (climayte-runner.ts) lives outside the daemon and is picked up again after the restart, so it does
 *  not hold a restart or an auto-update back. */
export function climayteRunningCount(): number {
  load()
  let n = 0
  for (const w of workers.values())
    if (w.status === 'running' && !w.attempts[w.attempts.length - 1]?.runner) n++
  return n
}

/** The pids of the CLI processes CliMayte's workers run in now. The extra-usage guard leaves these
 *  to CliMayte, which stops its own workers at the same line and moves the task on: a kill from
 *  outside would read as 'interrupted' and resume the task on the very account that can bill. */
export function climayteWorkerPids(): Set<number> {
  const pids = new Set<number>()
  for (const w of workers.values()) {
    const at = w.attempts[w.attempts.length - 1]
    if (w.status !== 'running' || !at?.runner) continue
    if (at.pid) pids.add(at.pid)
    if (at.runner.pid) pids.add(at.runner.pid)
  }
  return pids
}

/** Runner pids this daemon has confirmed are really that attempt's runner (its command line names
 *  the attempt's spec), so a pid Windows reused for a stranger after a crash is never taken for it,
 *  and never killed. Checked once per runner per daemon. */
const confirmedRunners = new Set<number>()

/** Where a runner attempt's spec goes (climayte-runner.ts deletes it once read; its path stays in the
 *  runner's command line, which is how isOurRunner recognises it). */
export const runnerSpecPath = (log: string): string => `${log}.spec.json`

function isOurRunner(pid: number, log: string): boolean {
  if (!isPidAlive(pid)) return false
  if (confirmedRunners.has(pid) || process.platform !== 'win32') return true
  const r = Bun.spawnSync(
    [
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
    ],
    { stdout: 'pipe', stderr: 'ignore', windowsHide: true },
  )
  const ok = r.success && r.stdout.toString().includes(runnerSpecPath(log))
  if (ok) confirmedRunners.add(pid)
  return ok
}

/** Whether the attempt's CLI has ended. A runner attempt is read from its files, so the answer
 *  survives a daemon restart: an exit file means it ended; a runner gone without one died (finish
 *  then reads it as interrupted); one that wrote no pids within a minute never started. An attempt
 *  the daemon spawned itself is read from its handle, or, with none (the daemon restarted), it
 *  died with that daemon's kill-on-close job on Windows. */
function attemptExited(w: CliMayteWorker, at: CliMayteWorker['attempts'][number]): boolean {
  const runner = at.runner
  if (!runner)
    return (
      (process.platform === 'win32' && at.daemonPid !== process.pid) ||
      !(at.pid && isPidAlive(at.pid))
    )
  if (readRunnerExit(runner.exitFile)) return true
  if (runner.pid === null) {
    const pids = readRunnerPids(runner.pidFile)
    if (!pids) return Date.now() - runner.launchedAt > 60_000
    runner.pid = pids.runner
    at.pid = pids.child
    confirmedRunners.add(pids.runner)
    changed(w)
  }
  return !isOurRunner(runner.pid as number, at.log)
}

/** Kill the attempt's CLI through its runner (the whole tree), if the runner is still this
 *  worker's. Never a bare pid nobody can vouch for. */
function killAttempt(at: CliMayteWorker['attempts'][number]): void {
  const pid = at.runner?.pid
  if (!pid || !isOurRunner(pid, at.log)) return
  try {
    killProcessTree(pid)
  } catch {
    // already gone
  }
}

export function schedule(delay?: number): void {
  if (timer) clearTimeout(timer)
  // poll() runs every tick, so the overage stop is only as fast as the tick, and each second of
  // overage bills the owner: 1 s while a worker runs, 3 s while one is queued or waiting.
  const all = [...workers.values()]
  const next =
    delay ?? (all.some((w) => w.status === 'running') ? 1_000 : all.some(isActive) ? 3_000 : 15_000)
  timer = setTimeout(
    () => void tick().catch((err) => console.error('[climayte] tick failed:', err)),
    next,
  )
  timer.unref?.()
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
  const finished = [...workers.values()]
    .filter((w) => w.status === 'done' && w.tokens)
    .map((w) => ({
      kind: w.kind ?? null,
      model: ladderModel(w.model ?? w.attempts.at(-1)?.model),
      effort: w.effort,
      // The work only: a move's re-read is what the move cost, not what the task costs.
      pct:
        w.attempts.reduce(
          (s, a) =>
            s + attemptUnits(a.tokens, a.model ?? w.model, a.cacheTtl) - rereadUnits(a, w.model),
          0,
        ) / UNITS_PER_PRO_PERCENT,
    }))
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

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    load()
    const now = Date.now()
    const accounts = tickAccounts()
    pollRunning()
    saveLive()
    // A check a restart ended (it ran under the old daemon) runs again.
    for (const w of workers.values())
      if (w.status === 'checking' && !checks.has(w.id)) startCheck(w)
    recheckSignedOut(accounts, now)
    const state = tickState(accounts, now)
    const due = [...workers.values()]
      .filter((w) => (w.status === 'queued' || w.status === 'waiting') && (w.notBefore ?? 0) <= now)
      .sort(dueOrder)
    for (const w of due) {
      try {
        scheduleWorker(state, w)
      } catch (err) {
        console.error(`[climayte] could not schedule ${w.id}:`, err)
      }
    }
  } finally {
    ticking = false
    schedule()
  }
}

const freshRead = (): LogRead => ({
  offset: 0,
  partial: '',
  events: [],
  recent: [],
  sawInit: false,
  model: null,
  overage: null,
  live: null,
})

function readLog(path: string): LogRead {
  let r = reads.get(path)
  if (!r) {
    r = freshRead()
    reads.set(path, r)
  }
  return readInto(path, r)
}

/** A finished attempt's log, parsed once without keeping it in `reads`. */
export function peekLog(path: string): LogRead {
  return readInto(path, freshRead())
}

/** The summary lines of finished attempts, for climayteGet: the CliMayte view asks for the selected
 *  worker every 3 s while any worker runs, and re-parsing a long session's log (megabytes of tool
 *  output) each time would burn the box. Bounded; the oldest entry goes first. */
const finishedRecent = new Map<string, string[]>()
function rememberFinished(path: string, recent: string[]): void {
  finishedRecent.delete(path)
  finishedRecent.set(path, recent)
  if (finishedRecent.size > 50) finishedRecent.delete(finishedRecent.keys().next().value as string)
}
function finishedLines(path: string): string[] {
  const kept = finishedRecent.get(path)
  if (kept) return kept
  const recent = peekLog(path).recent
  rememberFinished(path, recent)
  return recent
}
export function forgetRead(path: string): void {
  const r = reads.get(path)
  if (r) rememberFinished(path, r.recent)
  reads.delete(path)
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
 *  events and recent-summaries lists. */
function applyLogEvent(ev: unknown, r: LogRead): void {
  if (isInit(ev)) {
    r.sawInit = true
    const model = (ev as { model?: unknown }).model
    if (typeof model === 'string' && model) r.model = model
  }
  r.overage ??= overageStart(ev)
  r.live = liveUsage(ev, Date.now()) ?? r.live
  r.events.push(ev)
  if (r.events.length > 400) r.events.splice(0, r.events.length - 400)
  const s = summarizeEvent(ev)
  if (s) {
    r.recent.push(s)
    if (r.recent.length > 60) r.recent.splice(0, r.recent.length - 60)
  }
}

function readInto(path: string, r: LogRead): LogRead {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return r
  }
  if (size > r.offset) {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(size - r.offset)
      readSync(fd, buf, 0, buf.length, r.offset)
      r.offset = size
      const lines = (r.partial + buf.toString('utf8')).split(/\r?\n/)
      r.partial = lines.pop() ?? ''
      for (const line of lines) {
        const parsed = parseLogLine(line)
        if (parsed === null) continue
        applyLogEvent(parsed.ev, r)
      }
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

/** Ask a running session to wrap up and write a handoff (windDownMessage). The PostToolUse hook its
 *  launch installed prints this signal after the session's next tool call, so it winds down mid-
 *  turn without being killed (proven live 2026-09-30: the CLI showed the hook's additionalContext
 *  and the model acted on it). */
function signalWindDown(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  pct: number | null,
): void {
  const path = slashed(join(HANDOFFS, `${w.id}-${w.attempts.length - 1}.md`))
  mkdirSync(HANDOFFS, { recursive: true })
  mkdirSync(SIGNALS, { recursive: true })
  writeFileSync(
    signalPath(w.id),
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: windDownMessage(pct, path),
      },
    }),
  )
  at.windDown = { at: Date.now(), pct, path }
  journal(w, 'handoff-requested', { account: acctLabel(at.account), pct, path })
  changed(w)
}

/** What poll noted from the read: the init mark and the model on the attempt, its 5-hour peak,
 *  and the newest reading in the account's live table (liveByAccount). */
function noteReading(at: CliMayteWorker['attempts'][number], r: LogRead, watching: boolean): void {
  at.started ||= r.sawInit
  if (r.model) at.model = r.model
  // Only from a process this daemon is watching now: after a restart an old log is read again from
  // the start, and its readings would be stamped as fresh.
  const reading = r.live?.sessionPct
  if (r.live && reading != null && (!at.peak || reading > at.peak.pct))
    at.peak = { pct: reading, resetsAt: r.live.sessionResetsAt }
  if (!r.live || !watching) return
  const prev = liveByAccount.get(at.account.id)
  if (prev && prev.at >= r.live.at) return
  liveByAccount.set(at.account.id, r.live)
  liveDirty = true
}

/** The ceiling stop, or the overage stops: the log's overage notice first, then aboutToBill
 *  before the first billed request (poll). */
function stopAtCeilingOrOverage(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  r: LogRead,
  accountLive: CliMayteLiveUsage | null,
  now: number,
  watching: boolean,
  running: boolean,
): void {
  // The ceiling (CEILING_PCT, 90 on either window): stopped there, whatever it is doing. Not when
  // the owner allowed paid extra usage: that setting says to go past the limit, and lifts the stop
  // line the same way (pickAccount's allowFull).
  // Both lines go by the account's newest reading from any of its workers (sessionReading).
  if (watching && !at.ceiling && !at.overage && !overageAllowed()) {
    const c = atCeiling(r.live, accountLive, now)
    if (c) stopAtCeiling(w, at, c, running)
  }
  if (at.overage || at.ceiling || overageAllowed()) return
  if (r.overage) {
    stopForOverage(w, at, r.overage, running)
    return
  }
  // Stop BEFORE the first billed request on an account that can bill (aboutToBill).
  const soon = watching ? aboutToBill(r.live) : null
  if (soon) stopForOverage(w, at, { ...soon, notice: PRE_OVERAGE_NOTICE }, running)
}

/** One wind-down ask per attempt (poll): the stop line a watched attempt is at (windDownAt),
 *  going by the account's newest reading from any of its workers (sessionReading). */
function stopWindDown(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  r: LogRead,
  accountLive: CliMayteLiveUsage | null,
  now: number,
  watching: boolean,
): void {
  // At the stop line the session writes a handoff, room elsewhere or not (owner, 2026-10-01: "The
  // goal is to NOT hit 'limit' ... at 85/90%"). With room elsewhere the task goes on in a fresh,
  // small session there; without, it waits for the first account with room (waitUntil). Until then
  // a session with nowhere to go worked on into the wall: w-228dcdcc on #98, 85% to 100% in 15
  // requests, outcome quota.
  if (!watching || at.windDown || at.overage || at.ceiling) return
  const pct = windDownAt(r.live, accountLive, now)
  if (pct !== null) signalWindDown(w, at, pct)
}

/** What changed for the worker in this read: its newest summary line (lastActivity), or, an ended
 *  attempt, the finish of it (finish). */
function noteActivity(w: CliMayteWorker, r: LogRead, exited: boolean): void {
  const latest = r.recent[r.recent.length - 1] ?? null
  if (latest && latest !== w.lastActivity) {
    w.lastActivity = latest
    w.updatedAt = Date.now()
  }
  if (exited) finish(w, r.events)
}

export function poll(w: CliMayteWorker): void {
  const at = w.attempts[w.attempts.length - 1]
  if (!at) return
  const exited = attemptExited(w, at)
  // A process this daemon is watching now: its own child, or a live runner (a restarted daemon
  // picks those up again). A dead attempt's log, read again after a restart, is not.
  const watching = !exited && !!at.runner
  const r = readLog(at.log)
  noteReading(at, r, watching)
  const accountLive = liveByAccount.get(at.account.id) ?? null
  const now = Date.now()
  stopAtCeilingOrOverage(w, at, r, accountLive, now, watching, !exited)
  stopWindDown(w, at, r, accountLive, now, watching)
  noteActivity(w, r, exited)
}

/** The account ran out and started billing paid extra usage. Unless the owner allowed it
 *  (overageAllowed), nobody asked for that spend (CliMayte exists to use FREE quota across accounts), so the account is walled until its window resets
 *  and the running turn is stopped now; finish() then treats it as a limit, and the session moves
 *  to an account with room, or waits for one, without spending another cent of overage. */
function stopForOverage(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  overage: { resetsAt: number | null; notice?: string },
  running: boolean,
): void {
  at.overage = overage
  walls[at.account.id] = {
    until: wallUntil(Date.now(), { resetsAt: overage.resetsAt, resets: null }, parseResetTime),
    reason: overage.notice ?? OVERAGE_NOTICE,
  }
  try {
    saveWalls()
  } catch (err) {
    console.error('[climayte] could not save walls:', err)
  }
  if (running) killAttempt(at)
  changed(w)
}

/** At the ceiling the turn is stopped where it is and the account walled until that window
 *  resets. finish() goes on from the handoff when the session wrote one after the stop line asked,
 *  else the session moves to an account with room or waits for one, like a limit, but journalled
 *  and counted as a ceiling stop, never a limit hit. */
function stopAtCeiling(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  c: { pct: number; week: boolean; resetsAt: number | null },
  running: boolean,
): void {
  at.ceiling = c
  walls[at.account.id] = {
    until: wallUntil(Date.now(), { resetsAt: c.resetsAt, resets: null }, parseResetTime),
    reason: ceilingNotice(c),
  }
  try {
    saveWalls()
  } catch (err) {
    console.error('[climayte] could not save walls:', err)
  }
  if (running) killAttempt(at)
  changed(w)
}

/** An ended attempt's own spend and tokens, from its transcript on the account it ran on
 *  (attemptSpend). */
function spentOf(w: CliMayteWorker, at: CliMayteWorker['attempts'][number]): AttemptSpend {
  const dir = at.account.configDir ?? getCliInstance(at.account.id)?.configDir
  // null: its log names no session, the CLI never started, so it spent nothing.
  const session = at.sessionId === undefined ? w.sessionId : at.sessionId
  if (!dir) return { costUsd: 0, tokens: noTokens(), turns: 0, first: null, found: false }
  if (!session) return { costUsd: 0, tokens: noTokens(), turns: 0, first: null, found: true }
  return attemptSpend(dir, session, at.startedAt, at.endedAt ?? Date.now())
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
function spendRecord(
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
  let fd: number | null = null
  try {
    fd = openSync(log, 'r')
    const buf = Buffer.alloc(256 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.includes('"init"')) continue
      try {
        const ev = JSON.parse(line)
        if (ev?.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string')
          return ev.session_id
      } catch {
        // a partial last line
      }
    }
  } catch {
    // no log
  } finally {
    if (fd !== null) closeSync(fd)
  }
  return null
}

/** Charge an ended attempt to its task: its own cost and tokens. Returns the cost. */
export function charge(w: CliMayteWorker, at: CliMayteWorker['attempts'][number]): number {
  const spent = spentOf(w, at)
  at.tokens = spent.tokens
  at.spend = spendRecord(w, at, spent)
  w.costUsd += spent.costUsd
  w.tokens = addTokens(w.tokens, spent.tokens)
  return spent.costUsd
}

/** The highest 5-hour usage a log's main-agent rate_limit_events reported, with that window's
 *  reset; null with none (or no log). */
function peakOfLog(log: string): { pct: number; resetsAt: number | null } | null {
  let text = ''
  try {
    text = readFileSync(log, 'utf8')
  } catch {
    return null
  }
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
    if (backfillAttemptTokens(w)) any = true
    if (backfillAttemptPeaks(w)) any = true
    if (backfillAttemptSpend(w)) any = true
    if (backfillVerdictRereads(w)) any = true
    if (backfillWorkerTokens(w)) any = true
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

const hex = (n: number): string => crypto.randomUUID().replace(/-/g, '').slice(0, n)

const isAutoSetting = (v: unknown): boolean =>
  typeof v === 'string' && v.trim().toLowerCase() === 'auto'

type RunTask = Parameters<typeof climayteRun>[0]['tasks'][number]

/** A run's defaults: what a task takes when it names none of its own. */
interface RunDefaults {
  /** The run's model is `auto`: the scorecard picks for every task that names no model. */
  auto: boolean
  model: string | null
  effort: string | null
  kind: CliMayteKind | null
  priority: number
}

/** One task's setting, and for an `auto` task why the scorecard picked it. */
interface RunSetting {
  model: string | null
  effort: string | null
  kind: CliMayteKind | null
  auto: boolean
  reason: string | undefined
  priority: number
}

/** How many `auto` tasks of each kind are on record: pickConfig's every-4th exploring pick counts
 *  from here. */
function autoPicksSoFar(): Map<CliMayteKind, number> {
  const autoSoFar = new Map<CliMayteKind, number>()
  for (const w of workers.values())
    if (w.auto && w.kind) {
      const k = w.kind as CliMayteKind
      autoSoFar.set(k, (autoSoFar.get(k) ?? 0) + 1)
    }
  return autoSoFar
}

/** Refuse a task that could not run: no prompt, no such folder, a check that is not one command. */
function assertRunnable(t: RunTask, i: number): void {
  if (typeof t?.prompt !== 'string' || !t.prompt.trim())
    throw new Error(`task ${i + 1}: prompt is empty`)
  if (typeof t.cwd !== 'string' || !existsSync(t.cwd) || !statSync(t.cwd).isDirectory())
    throw new Error(`task ${i + 1}: cwd '${t.cwd}' is not an existing folder`)
  if (
    t.check !== undefined &&
    t.check !== null &&
    (typeof t.check !== 'string' || t.check.length > 2000)
  )
    throw new Error(`task ${i + 1}: check must be one shell command (at most 2000 characters)`)
}

/** One task's model, effort, kind and priority: its own, else the run's; for an `auto` task the
 *  scorecard's pick for its kind (and `autoSoFar` counts it). Throws on a value that is not one. */
function runSetting(
  t: RunTask,
  defaults: RunDefaults,
  rows: ReturnType<typeof scoreRows>,
  autoSoFar: Map<CliMayteKind, number>,
): RunSetting {
  const kind = climayteKind(t.kind) ?? defaults.kind
  const priority = climaytePriority(t.priority) ?? defaults.priority
  const own = t.model === undefined || t.model === null || t.model === ''
  if (isAutoSetting(t.model) || (own && defaults.auto)) {
    const k = kind ?? 'code'
    const n = autoSoFar.get(k) ?? 0
    autoSoFar.set(k, n + 1)
    const pick = pickConfig(k, rows, n)
    return { ...pick.config, kind: k, auto: true, reason: pick.reason, priority }
  }
  return {
    model: climayteModel(t.model) ?? defaults.model,
    effort: (isAutoSetting(t.effort) ? null : climayteEffort(t.effort)) ?? defaults.effort,
    kind,
    auto: false,
    reason: undefined,
    priority,
  }
}

/** A queued worker for one task of a run. */
function newWorker(
  t: RunTask,
  setting: RunSetting | undefined,
  size: CliMayteSizing | undefined,
  group: string,
  accounts: string[] | undefined,
  now: number,
): CliMayteWorker {
  return {
    id: `w-${hex(8)}`,
    group,
    title: t.title?.trim() || t.prompt.replace(/\s+/g, ' ').trim().slice(0, 60),
    cwd: t.cwd,
    prompt: t.prompt,
    pending: [],
    model: setting?.model ?? null,
    effort: setting?.effort ?? null,
    kind: setting?.kind ?? null,
    ...(setting?.auto ? { auto: true } : {}),
    ...(t.check?.trim() ? { check: t.check.trim() } : {}),
    ...(size ? { size } : {}),
    priority: setting?.priority ?? 0,
    accounts: accounts?.length ? accounts : null,
    status: 'queued',
    sessionId: crypto.randomUUID(),
    accountId: null,
    attempts: [],
    result: null,
    results: [],
    error: null,
    lastActivity: null,
    costUsd: 0,
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: now,
    updatedAt: now,
  }
}

/** `model` / `effort` / `kind` at the top level are the group's default: a task that names its
 *  own wins. All are validated (climayteModel, climayteEffort, climayteKind) before anything is created.
 *  Model `auto` lets the scorecard choose model AND effort for the task's kind (default `code`):
 *  the cheapest setting that keeps passing, or one rung cheaper on every 4th pick (pickConfig). */
export function climayteRun(input: {
  tasks: Array<{
    prompt: string
    cwd: string
    title?: string
    model?: string
    effort?: string
    kind?: string
    check?: string
    priority?: number
    size?: string
  }>
  group?: string
  accounts?: string[]
  perAccount?: number
  model?: string
  effort?: string
  kind?: string
  priority?: number
  size?: string
}): { group: string; workers: CliMayteWorkerView[] } {
  load()
  if (!Array.isArray(input.tasks) || !input.tasks.length)
    throw new Error('tasks must be a non-empty array')
  const groupAuto = isAutoSetting(input.model)
  const defaults: RunDefaults = {
    auto: groupAuto,
    model: groupAuto ? null : climayteModel(input.model),
    effort: groupAuto || isAutoSetting(input.effort) ? null : climayteEffort(input.effort),
    kind: climayteKind(input.kind),
    priority: climaytePriority(input.priority) ?? 0,
  }
  const rows = scoreRows(workers.values())
  const autoSoFar = autoPicksSoFar()
  const settings = input.tasks.map((t, i) => {
    assertRunnable(t, i)
    try {
      return runSetting(t, defaults, rows, autoSoFar)
    } catch (err) {
      throw new Error(`task ${i + 1}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  const cap = input.perAccount ?? 2
  if (!Number.isInteger(cap) || cap < 1 || cap > 4) throw new Error('perAccount must be 1..4')
  const sized = sizeTasks(input, settings)
  const group = input.group?.trim() || `g-${hex(6)}`
  // Joining a group keeps its cap unless the caller names a new one.
  if (input.perAccount !== undefined || !(group in perAccount)) perAccount[group] = cap
  const now = Date.now()
  const made = input.tasks.map((t, i) =>
    newWorker(t, settings[i], sized[i], group, input.accounts, now),
  )
  for (const [i, w] of made.entries()) {
    workers.set(w.id, w)
    journal(w, 'dispatched', {
      cwd: w.cwd,
      accounts: w.accounts?.length,
      model: w.model,
      effort: w.effort,
      kind: w.kind ?? undefined,
      reason: settings[i]?.reason,
      priority: w.priority,
    })
    changed(w)
  }
  startCliMayte()
  schedule(0)
  return { group, workers: made.map((w) => toView(w, now)) }
}

/** What an expected cost is based on, in words: 'sweep on other models, scaled to Sonnet, 3 finished'. */
export function basisText(
  cost: CostEstimate,
  s: { kind?: string | null; model: string | null; effort: string | null },
): string {
  if (!cost.samples) return 'nothing on record yet (the default)'
  const fam = modelFamily(ladderModel(s.model)) === 'sonnet' ? 'Sonnet' : 'Opus'
  const on = {
    setting: `${s.kind} on ${ladderModel(s.model) ?? 'the CLI default'} ${s.effort ?? 'default effort'}`,
    'kind-model': `${s.kind} on ${fam} at other efforts`,
    kind: `${s.kind} on other models, scaled to ${fam}`,
    model: `${fam} tasks of any kind`,
    default: '',
  }[cost.basis]
  return `${on}, ${cost.samples} finished`
}

/** A dispatch with a task too big for one window (sizeTask): nothing was started. */
export class CliMayteSplitNeeded extends Error {
  constructor(
    message: string,
    readonly tasks: Array<{
      task: number
      title: string
      expected: number
      window: number
      pieces: number
    }>,
  ) {
    super(message)
  }
}

/** Sizes every task of a dispatch against the accounts it may use (climayte-placement sizeTask), and
 *  refuses the whole dispatch, starting nothing, when a task is over SPLIT_SHARE of the biggest
 *  window unless it (or the dispatch) says `size: 'whole'`. */
function sizeTasks(
  input: Parameters<typeof climayteRun>[0],
  settings: Array<{ model: string | null; effort: string | null; kind: string | null }>,
): CliMayteSizing[] {
  const sizeOf = (v: unknown, where: string): 'auto' | 'whole' => {
    if (v === undefined || v === null || v === '') return 'auto'
    const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
    if (s === 'auto' || s === 'whole') return s
    throw new Error(`${where}size must be auto or whole`)
  }
  const groupSize = sizeOf(input.size, '')
  let pool: CliMayteAccount[] = []
  try {
    pool = accountsProvider()
  } catch {
    // Sized against one Pro window.
  }
  const now = Date.now()
  const allowed = pool.filter((a) => !input.accounts?.length || input.accounts.includes(a.id))
  const open = allowed.filter((a) => !((walls[a.id]?.until ?? 0) > now))
  const { costOf, running, finishedSince } = placementState()
  const best = open
    .map((a) => ({
      a,
      room: Math.max(
        0,
        (FIT_PCT - projectedPct(a, running.get(a.id) ?? [], 0, finishedSince.get(a.id) ?? 0)) *
          (a.planFactor ?? 1),
      ),
    }))
    .sort((x, y) => y.room - x.room)[0]
  const tooBig: CliMayteSplitNeeded['tasks'] = []
  const sized = input.tasks.map((t, i): CliMayteSizing => {
    const s = settings[i] ?? { model: null, effort: null, kind: null }
    const cost = costOf(s)
    const fit = sizeTask(
      cost.pct,
      allowed.map((a) => a.planFactor ?? 1),
    )
    const whole = sizeOf(t.size, `task ${i + 1}: `) === 'whole' || groupSize === 'whole'
    const title = t.title?.trim() || firstLine(t.prompt, 60)
    if (fit.split && !whole)
      tooBig.push({
        task: i + 1,
        title,
        expected: Math.round(cost.pct),
        window: fit.window,
        pieces: fit.pieces,
      })
    return {
      expected: Math.round(cost.pct * 10) / 10,
      basis: basisText(cost, s),
      window: fit.window,
      room: best ? Math.round(best.room) : null,
      roomOn: best ? acctLabel(best.a) : null,
    }
  })
  if (tooBig.length) {
    const each = tooBig
      .map(
        (t) =>
          `task ${t.task} "${t.title}" is expected to use about ${t.expected}% of a Pro 5-hour window, and the biggest window it may use holds ${t.window}%: split it into about ${t.pieces} pieces`,
      )
      .join('; ')
    throw new CliMayteSplitNeeded(
      `Nothing started: split needed. ${each}. A task over half a window often runs out partway and moves accounts, re-writing its whole conversation into a cold cache. Send each piece as its own self-contained task with its own proof of done (keep pieces that touch the same files in order, one after another), or send it again with size: 'whole' to run it as it is.`,
      tooBig,
    )
  }
  return sized
}

function matches(
  w: CliMayteWorker,
  f: { group?: string; id?: string; ids?: string[]; active?: boolean },
): boolean {
  return (
    (!f.id || w.id === f.id) &&
    (!f.ids || f.ids.includes(w.id)) &&
    (!f.group || w.group === f.group) &&
    (!f.active || isActive(w))
  )
}

/** `limit`: keep every active worker and only the `limit` most recently finished ones
 *  (recentWorkers); `brief`: rows without the prompt and with the last 3 attempts (toBrief);
 *  `ids`: only these workers. */
export interface CliMayteListFilter {
  group?: string
  id?: string
  ids?: string[]
  active?: boolean
  limit?: number
  brief?: boolean
}

export function climayteList(filter: CliMayteListFilter & { brief: true }): CliMayteWorkerBrief[]
export function climayteList(filter?: CliMayteListFilter): CliMayteWorkerView[]
export function climayteList(
  filter: CliMayteListFilter = {},
): CliMayteWorkerView[] | CliMayteWorkerBrief[] {
  load()
  const now = Date.now()
  const views = recentWorkers(
    [...workers.values()].filter((w) => matches(w, filter)),
    filter.limit,
  ).map((w) => toView(w, now))
  return filter.brief ? views.map(toBrief) : views
}

/** The report view of the same list (toReport): one compact row per worker, `chars` of its report. */
export function climayteReports(
  filter: CliMayteListFilter = {},
  chars?: number,
): CliMayteWorkerReport[] {
  return climayteList({ ...filter, brief: false }).map((v) => toReport(v, chars))
}

/** One verdict for several finished workers (the same `verdict`, `note` and `kind` for each), in
 *  one call: a batch wake hands an orchestrator several results it checked together. */
export function climayteVerdicts(
  ids: string[],
  input: Parameters<typeof climayteVerdict>[1],
): Array<{ id: string } & ReturnType<typeof climayteVerdict>> {
  return ids.map((id) => ({ id, ...climayteVerdict(id, input) }))
}

export function climayteGet(id: string): (CliMayteWorkerView & { events: string[] }) | null {
  load()
  const w = workers.get(id)
  if (!w) return null
  // Every attempt's summary lines, oldest first, each under one separator line, so the work before
  // a move or a restart stays visible. A finished attempt keeps only its summary lines
  // (finishedLines), never its parsed events; attempts older than the newest 60 lines are not read.
  const events: string[] = []
  for (let i = w.attempts.length - 1; i >= 0 && events.length < 60; i--) {
    const a = w.attempts[i]!
    const who = a.account.num === null ? a.account.name : `#${a.account.num} ${a.account.name}`
    const lines = a.outcome === 'running' ? readLog(a.log).recent : finishedLines(a.log)
    events.unshift(`— attempt ${i + 1} on ${who}: ${a.outcome} —`, ...lines)
  }
  return { ...toView(w, Date.now()), events: events.slice(-60) }
}

export function climayteWait(
  filter: CliMayteListFilter,
  timeoutMs: number,
): Promise<CliMayteWorkerView[] | CliMayteWorkerBrief[]> {
  load()
  if (![...workers.values()].some((w) => matches(w, filter) && isActive(w)))
    return Promise.resolve(climayteList(filter))
  return new Promise((resolve) => {
    const off = onCliMayteChange((w) => {
      if (!matches(w, filter)) return
      done()
    })
    const t = setTimeout(() => done(), Math.max(0, timeoutMs))
    let settled = false
    function done(): void {
      if (settled) return
      settled = true
      clearTimeout(t)
      off()
      resolve(climayteList(filter))
    }
  })
}

/** Hand a running task to a fresh session now, the same way a worker near its limit does: it
 *  finishes the step it is on, writes a handoff, and the task goes on from that handoff in a new
 *  session (on the account with the most room). For freeing an account, or giving a task whose
 *  conversation has grown huge a clean start without losing where it was. */
export function climayteHandoff(id: string): { ok: boolean; message: string } {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  const at = w.attempts[w.attempts.length - 1]
  if (w.status !== 'running' || !at || attemptExited(w, at))
    return { ok: false, message: 'Only a running worker can hand off; this one is not running.' }
  if (at.windDown) return { ok: true, message: 'It is already winding down.' }
  signalWindDown(w, at, null)
  return {
    ok: true,
    message:
      'Asked to wrap up after its current step and write a handoff; the task then continues in a fresh session.',
  }
}

/** Change a task's priority (field note 20): queued and waiting work starts highest first, then
 *  oldest first; a running attempt is not stopped for it. */
export function climayteSetPriority(
  id: string,
  value: unknown,
): { ok: boolean; message: string; priority?: number } {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  let priority: number | null
  try {
    priority = climaytePriority(value)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  if (priority === null) return { ok: false, message: 'priority is required.' }
  const was = w.priority ?? 0
  if (priority !== was) {
    w.priority = priority
    journal(w, 'priority', { priority, was })
    changed(w)
    schedule(0)
  }
  return {
    ok: true,
    priority,
    message: isActive(w)
      ? `Priority ${priority}: it starts ahead of queued and waiting work with a lower priority.`
      : `Priority ${priority}, kept for when it is continued.`,
  }
}

/** What a message to a running worker waits for: a `-p` session takes no input mid-run, so it is
 *  delivered only when the whole current task ends. Field note 10 (2026-09-30): only this answer
 *  said so, and a "fix the build first" message could not reach a worker that was breaking it. */
export const HELD_MESSAGE =
  'Held until this worker finishes its WHOLE current task: a running CLI session takes no input mid-run, so it gets this only after it ends (that can be many minutes). If it must act on it now, send it again with urgent: true, which stops the running work and continues the same session with your message first.'

/** Preface of an urgent message, so the session knows why its turn ended mid-step. */
const URGENT_PREFIX =
  'AgentHydra stopped your previous turn mid-step to deliver this message from the orchestrator. Act on it first; then continue the task only if it still applies, checking the state of anything you were in the middle of.'

/** `urgent`: a running worker is stopped cleanly (its attempt recorded with its cost, the transcript
 *  kept) and the same session continues at once with this message first; messages already queued
 *  follow it, in order. Without it, a running worker gets the message when its task ends. */
export function climayteSend(
  id: string,
  text: string,
  opts: { urgent?: boolean; model?: string; effort?: string } = {},
): {
  ok: boolean
  message: string
  urgent?: boolean
  model?: string | null
  effort?: string | null
} {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  if (!text.trim()) return { ok: false, message: 'The message is empty.' }
  // A new model or effort applies from the next launch on: the turn that delivers this message
  // (or one queued before it) and every later one, in the same session (`--resume` takes both).
  let model: string | null
  let effort: string | null
  try {
    model = climayteModel(opts.model)
    effort = climayteEffort(opts.effort)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  if (model) w.model = model
  if (effort) w.effort = effort
  if (w.status === 'running' && opts.urgent) {
    w.pending.unshift(`${URGENT_PREFIX}\n\n${text}`)
    journal(w, 'follow-up-queued', {
      pending: w.pending.length,
      urgent: true,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    })
    if (stopRunning(w, 'Stopped to deliver an urgent message from the orchestrator.')) {
      w.status = 'queued'
      w.retries = 0
      w.error = null
      w.notBefore = null
      w.revived = true
      changed(w)
      schedule(0)
      const more = w.pending.length - 1
      return {
        ok: true,
        urgent: true,
        model: w.model,
        effort: w.effort,
        message: `Stopped its running work; the same session continues now with this message first${more ? `, then the ${more} message(s) queued before it` : ''}.`,
      }
    }
    // It finished on its own a moment ago: the message leads its next turn like any other.
  } else {
    w.pending.push(text)
    journal(w, 'follow-up-queued', {
      pending: w.pending.length,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    })
  }
  if (w.status === 'running') {
    changed(w)
    return { ok: true, message: HELD_MESSAGE, model: w.model, effort: w.effort }
  }
  if (!isActive(w)) {
    w.status = 'queued'
    w.retries = 0
    w.error = null
    w.revived = true
  }
  changed(w)
  schedule(0)
  return {
    ok: true,
    message: 'Queued as the next turn of the same session.',
    model: w.model,
    effort: w.effort,
  }
}

const SENT_BACK = 'The orchestrator checked your result and it did not pass. What was wrong:'

const configLabel = (c: { model: string | null; effort: string | null }): string =>
  `${c.model?.includes('sonnet') ? 'Sonnet 5.5' : c.model?.includes('opus') ? 'Opus 5.5' : (c.model ?? 'the default model')} · ${c.effort ?? 'default effort'}`

/** Tag an untagged task's kind from the verdict. The reason it is not a kind, or null. */
function tagKind(w: CliMayteWorker, kind: unknown): string | null {
  try {
    const k = climayteKind(kind)
    if (k) w.kind = k
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** A verdict's record: the setting that produced the result, and what that work cost. */
function verdictRecord(
  w: CliMayteWorker,
  passed: 'pass' | 'fail',
  note: string | null,
  by: unknown,
): CliMayteVerdict {
  // The work this verdict judges: every attempt since the previous verdict.
  const since = w.verdicts?.at(-1)?.at ?? 0
  const ran = w.attempts.filter((a) => a.startedAt >= since)
  const reported = [...ran].reverse().find((a) => a.model)?.model ?? null
  return {
    at: Date.now(),
    verdict: passed,
    note,
    model: ladderModel(w.model ?? reported),
    effort: w.effort,
    units: ran.reduce((sum, a) => sum + attemptUnits(a.tokens, a.model ?? w.model, a.cacheTtl), 0),
    reread: ran.reduce((sum, a) => sum + rereadUnits(a, w.model), 0),
    by: by === 'check' || by === 'owner' ? by : 'orchestrator',
  }
}

/** Send a failed result back to its session one rung up the ladder. What it was sent back on
 *  (null when it was not: already on the top setting, or the send was refused) and what to say. */
function sendBack(
  id: string,
  verdict: CliMayteVerdict,
  note: string | null,
): { next: { model: string; effort: string } | null; message: string } {
  const next = nextRung(verdict)
  if (!next)
    return {
      next: null,
      message:
        'Recorded a fail. It already ran on the top setting (Opus 5.5 · max), so it was not sent back.',
    }
  const sent = climayteSend(
    id,
    `${SENT_BACK} ${note}\n\nFix it, prove the fix with a command and what it printed, and report again.`,
    next,
  )
  return sent.ok
    ? { next, message: `Recorded a fail. Sent back on ${configLabel(next)}.` }
    : { next: null, message: sent.message }
}

/** Judge a finished task's result (owner, 2026-09-30: "if it works, it gives it a thumbs up ... if
 *  it does not, it reports the failure, and what model it tries next"). The verdict is kept with the
 *  setting that produced the result and what that work cost, and the scorecard learns from it. A
 *  fail (with `note`, required: the worker gets it) sends the task back to the same session one
 *  rung up the ladder unless `retry` is false. `kind` tags a task dispatched without one. */
export function climayteVerdict(
  id: string,
  input: { verdict?: unknown; note?: unknown; retry?: unknown; kind?: unknown; by?: unknown },
): { ok: boolean; message: string; next?: { model: string; effort: string } | null } {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  if (input.verdict !== 'pass' && input.verdict !== 'fail')
    return { ok: false, message: "verdict must be 'pass' or 'fail'." }
  if (isActive(w))
    return { ok: false, message: 'It is still working: judge its result once it has finished.' }
  const note =
    typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 1000) : null
  if (input.verdict === 'fail' && !note)
    return { ok: false, message: 'Say what was wrong (note): the worker gets it with the retry.' }
  const badKind = tagKind(w, input.kind)
  if (badKind !== null) return { ok: false, message: badKind }
  const verdict = verdictRecord(w, input.verdict, note, input.by)
  w.verdicts = [...(w.verdicts ?? []), verdict]
  let next: { model: string; effort: string } | null = null
  let message = verdict.verdict === 'pass' ? 'Recorded a pass.' : 'Recorded a fail; not sent back.'
  if (verdict.verdict === 'fail' && input.retry !== false)
    ({ next, message } = sendBack(id, verdict, note))
  journal(w, 'verdict', {
    verdict: verdict.verdict,
    notice: note ? firstLine(note) : undefined,
    model: verdict.model,
    effort: verdict.effort,
    kind: w.kind ?? undefined,
    reason: next ? `sent back on ${configLabel(next)}` : undefined,
  })
  changed(w)
  return { ok: true, message, next }
}

/** What works, per kind of task: every verdict on record summed by setting, with what a task cost
 *  on average as a share of a Pro 5-hour window, and the setting an `auto` task of that kind gets
 *  next (`pick`; an exploring pick one rung cheaper is not marked). */
export function climayteScorecard(): {
  unitsPerPercent: number
  rows: Array<{
    kind: string
    model: string | null
    effort: string | null
    pass: number
    fail: number
    pctPerTask: number | null
    pick: boolean
  }>
} {
  load()
  const rows = scoreRows(workers.values())
  const picks = new Map<string, number>()
  for (const r of rows) {
    if (picks.has(r.kind)) continue
    try {
      const k = climayteKind(r.kind)
      if (k) picks.set(r.kind, bestRung(k, rows))
    } catch {
      // a kind no longer on the list: shown, never picked
    }
  }
  return {
    unitsPerPercent: UNITS_PER_PRO_PERCENT,
    rows: rows.map((r) => {
      const n = r.pass + r.fail
      const best = picks.get(r.kind)
      return {
        kind: r.kind,
        model: r.model,
        effort: r.effort,
        pass: r.pass,
        fail: r.fail,
        pctPerTask: n ? Math.round((r.units / n / UNITS_PER_PRO_PERCENT) * 10) / 10 : null,
        pick: best !== undefined && ladderIndex(r) === best,
      }
    }),
  }
}

/** End a running worker's attempt now: kill its CLI and record the attempt as stopped, with its
 *  spend. False when the CLI had already finished (that turn is recorded instead, by poll) and the
 *  worker is no longer active. */
function stopRunning(w: CliMayteWorker, notice: string | null): boolean {
  const at = w.attempts[w.attempts.length - 1]
  // Stopped just after the CLI finished: record that turn's result, cost and turns first.
  if (w.status === 'running' && at && attemptExited(w, at)) {
    try {
      poll(w)
    } catch (err) {
      // One worker's read error must not stop a group cancel; the kill path below still runs.
      console.error(`[climayte] could not read ${w.id}:`, err)
    }
    if (!isActive(w)) return false
  }
  if (w.status === 'running' && at) {
    killAttempt(at)
    at.outcome = 'cancelled'
    at.notice = notice
    at.endedAt = Date.now()
    charge(w, at)
    forgetRead(at.log)
    rmSync(signalPath(w.id), { force: true })
  }
  return true
}

/** Queued messages survive a cancel (field note 11, 2026-09-30: a cancel dropped three silently):
 *  they are delivered, in order, when the worker is continued, and the answer counts them. */
export function climayteCancel(filter: { id?: string; group?: string }): {
  cancelled: string[]
  keptMessages: Record<string, number>
} {
  load()
  const cancelled: string[] = []
  const keptMessages: Record<string, number> = {}
  if (!filter.id && !filter.group) return { cancelled, keptMessages }
  for (const w of workers.values()) {
    if (!matches(w, filter) || !isActive(w)) continue
    checks.get(w.id)?.kill()
    checks.delete(w.id)
    if (!stopRunning(w, null)) continue
    const at = w.attempts[w.attempts.length - 1]
    w.status = 'cancelled'
    w.error = null
    delete w.revived
    if (w.pending.length) keptMessages[w.id] = w.pending.length
    journal(w, 'cancelled', {
      ...(at ? { account: acctLabel(at.account) } : {}),
      ...(w.pending.length ? { pending: w.pending.length } : {}),
    })
    changed(w)
    cancelled.push(w.id)
  }
  return { cancelled, keptMessages }
}

/** Weighted units as % of a Pro 5-hour window, to one decimal. */
export const pct1 = (units: number): number => Math.round((units / UNITS_PER_PRO_PERCENT) * 10) / 10

/** Move a file or folder into the archive, keeping it (a rename, or a copy then remove across
 *  drives). A missing source is not an error. */
function archiveMove(from: string, to: string): void {
  if (!existsSync(from)) return
  mkdirSync(join(to, '..'), { recursive: true })
  try {
    renameSync(from, to)
  } catch {
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
}

/** Remove finished tasks from CliMayte's list (owner, 2026-09-30: clear out the test sessions). Their
 *  records go; their logs and CLI transcripts are MOVED to corch/archive/<stamp>/<task id>/, never
 *  deleted, so a removal can be undone by hand. A task still queued, running or waiting is skipped. */
export function climayteRemove(ids: string[]): {
  removed: string[]
  skipped: string[]
  archive: string
} {
  load()
  const archive = join(ROOT, 'archive', new Date().toISOString().replace(/[:.]/g, '-'))
  const removed: string[] = []
  const skipped: string[] = []
  for (const id of ids) {
    const w = workers.get(id)
    if (!w || isActive(w)) {
      skipped.push(id)
      continue
    }
    const dest = join(archive, w.id)
    for (const [i, at] of w.attempts.entries()) {
      archiveMove(at.log, join(dest, 'logs', `${i}-out.jsonl`))
      archiveMove(at.errLog, join(dest, 'logs', `${i}-err.log`))
    }
    const sessionIds = [
      ...new Set([...(w.sessions ?? []), w.sessionId].filter(Boolean)),
    ] as string[]
    const accounts = [...new Set(w.attempts.map((a) => a.account.id))]
    for (const accountId of accounts) {
      const dir = getCliInstance(accountId)?.configDir
      if (!dir) continue
      const projects = join(dir, 'projects')
      let keys: string[] = []
      try {
        keys = readdirSync(projects)
      } catch {
        continue
      }
      for (const key of keys)
        for (const sid of sessionIds) {
          const base = join(dest, 'transcripts', accountId, key)
          archiveMove(join(projects, key, `${sid}.jsonl`), join(base, `${sid}.jsonl`))
          archiveMove(join(projects, key, sid), join(base, sid))
        }
    }
    workers.delete(w.id)
    removed.push(w.id)
  }
  if (removed.length) save()
  return { removed, skipped, archive }
}

/** Idempotent: load the store and start watching. Called at daemon boot. */
export function startCliMayte(): void {
  load()
  if (started) return
  started = true
  schedule(0)
}
