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
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  liveUsage,
  noTokens,
  ORG_DISABLED_WALL,
  overageStart,
  summarizeEvent,
} from './climayte-lib'
import {
  type CostEstimate,
  expectedCost,
  modelFamily,
  planFactor,
  type RunningLoad,
} from './climayte-placement'
import { attemptUnits, ladderModel, rereadUnits, UNITS_PER_PRO_PERCENT } from './climayte-scorecard'
import { resolveClaudeExe } from './config'
import { getCliInstance, listCliInstances } from './core/cli-instances'
import { type JsonStoreSpec, readJsonStore, writeJsonStoreAtomic } from './core/json-store'
import { POINTER_DIR } from './instance'
import { getProviderSettings } from './provider-settings'
import type { UsageSnapshot } from './types'
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

export function save(): void {
  if (!loaded) return
  mkdirSync(ROOT, { recursive: true })
  writeJsonStoreAtomic(STORE_SPEC.path, { workers: [...workers.values()], perAccount })
}

export function saveWalls(): void {
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

const isInit = (ev: unknown): boolean =>
  (ev as { type?: string; subtype?: string })?.type === 'system' &&
  (ev as { subtype?: string }).subtype === 'init'

/** Where a runner attempt's spec goes (climayte-runner.ts deletes it once read; its path stays in the
 *  runner's command line, which is how isOurRunner recognises it). */
export const runnerSpecPath = (log: string): string => `${log}.spec.json`

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

export const freshRead = (): LogRead => ({
  offset: 0,
  partial: '',
  events: [],
  recent: [],
  sawInit: false,
  model: null,
  overage: null,
  live: null,
})

/** A finished attempt's log, parsed once without keeping it in `reads`. */
export function peekLog(path: string): LogRead {
  return readInto(path, freshRead())
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

export function readInto(path: string, r: LogRead): LogRead {
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

/** An ended attempt's own spend and tokens, from its transcript on the account it ran on
 *  (attemptSpend). */
export function spentOf(w: CliMayteWorker, at: CliMayteWorker['attempts'][number]): AttemptSpend {
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

/** Weighted units as % of a Pro 5-hour window, to one decimal. */
export const pct1 = (units: number): number => Math.round((units / UNITS_PER_PRO_PERCENT) * 10) / 10
