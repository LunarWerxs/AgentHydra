// server/src/corch.ts — the RUNTIME half of Corch (docs/CORCH.md): the store, the launch of each
// attempt, the tick that watches workers, and the API the routes and MCP tools call. The decisions
// themselves (how an attempt ended, which account is next, how a session moves) live in
// corch-lib.ts, which is pure and pinned by tests.
//
// WHY (owner, 2026-09-30): "I want this fully delegated ... orchestrating them only to CLI, not
// desktop instances ... just use all of my CLI accounts." A chat keeps only the orchestration; each
// piece of work is a Claude Code CLI session on one of his signed-in CLI instances, and a session
// that hits an account's usage limit is copied to another account and resumed there by itself. A
// Pro account's five-hour window lasts about ten minutes of heavy work, and moving threads by hand
// was the cost this removes.
//
// VISIBLE, WITHOUT A WINDOW. Workers run with `windowsHide` (no console on his screen, the 2026-08-31
// ruling) and every one is readable live in the Corch view and through corch_status, and its
// transcript is an ordinary session in that account's folder. headless-policy.ts names this as the
// one exemption. Nothing here starts on its own: with no worker queued each tick is a no-op.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { resolveClaudeExe } from './config'
import {
  aboutToBill,
  attemptSpend,
  type CorchAccount,
  type CorchLiveUsage,
  type CorchWalls,
  type CorchWorker,
  type CorchWorkerView,
  classifyAttempt,
  continuationPrompt,
  copySessionTranscript,
  freshestPct,
  HANDOFF_PROMPT,
  INTERRUPTED_PROMPT,
  liveUsage,
  OVERAGE_NOTICE,
  overageStart,
  PAUSED_PROMPT,
  PRE_OVERAGE_NOTICE,
  pickAccount,
  scrubbedEnv,
  summarizeEvent,
  TRANSIENT_PROMPT,
  toView,
  WIND_DOWN_SESSION_PCT,
  WIND_DOWN_WEEK_PCT,
  WORKER_BRIEF,
  wallUntil,
  windDownAt,
  windDownMessage,
} from './corch-lib'
import { getCliInstance, listCliInstances } from './core/cli-instances'
import { cliAuthStatus } from './core/cli-quick-add'
import { type JsonStoreSpec, readJsonStore, writeJsonStoreAtomic } from './core/json-store'
import { isPidAlive, killProcessTree } from './core/process'
import { POINTER_DIR } from './instance'
import { getProviderSettings } from './provider-settings'
import type { UsageSnapshot } from './types'
import { parseResetTime } from './usage'
import { allCachedUsage } from './usage-cache'

export * from './corch-lib'

// POINTER_DIR is CONFIG_DIR for the primary install and a side-run's own data dir otherwise, so
// two daemons never tick and overwrite the same workers.json.
const ROOT = join(POINTER_DIR, 'corch')
const LOGS = join(ROOT, 'logs')
const PROMPTS = join(ROOT, 'prompts')
const HOOKS = join(ROOT, 'hooks')
const SIGNALS = join(ROOT, 'signals')
const HANDOFFS = join(ROOT, 'handoffs')
/** Forward slashes: the path goes into a bash command (the hook) and into the model's prompt. */
const slashed = (p: string): string => p.replace(/\\/g, '/')
const signalPath = (workerId: string): string => join(SIGNALS, `${workerId}.json`)
const WALLS_PATH = join(ROOT, 'walls.json')

interface Store {
  workers: CorchWorker[]
  perAccount: Record<string, number>
}
const STORE_SPEC: JsonStoreSpec<Store> = {
  path: join(ROOT, 'workers.json'),
  decode: (p) => {
    const w = (p as { workers?: unknown })?.workers
    if (!Array.isArray(w)) return null
    return { workers: w as CorchWorker[], perAccount: (p as Store).perAccount ?? {} }
  },
  empty: () => ({ workers: [], perAccount: {} }),
}

const workers = new Map<string, CorchWorker>()
let perAccount: Record<string, number> = {}
let walls: CorchWalls = {}
let loaded = false
let started = false
let timer: ReturnType<typeof setTimeout> | null = null
let ticking = false
const procs = new Map<string, ReturnType<typeof Bun.spawn>>()
const hasExited = (p: ReturnType<typeof Bun.spawn>): boolean =>
  p.exitCode !== null || p.signalCode !== null
/** Per attempt log: bytes read, an unfinished last line, the events kept, the summaries shown,
 *  and whether system/init was ever seen (kept apart: the events list drops old ones). */
interface LogRead {
  offset: number
  partial: string
  events: unknown[]
  recent: string[]
  sawInit: boolean
  /** The CLI said the account ran out and paid extra usage took over (overageStart). */
  overage: { resetsAt: number | null } | null
  /** The newest usage reading the CLI streamed (liveUsage). */
  live: CorchLiveUsage | null
}
const reads = new Map<string, LogRead>()
/** Each account's newest live usage reading from any of its workers' streams (poll copies it
 *  here). The usage snapshot is refreshed only every 15 minutes; this is seconds old. */
const liveByAccount = new Map<string, CorchLiveUsage>()

/** The owner's rule is never to spend paid extra usage; the `corchAllowOverage` setting (default
 *  false) lifts it: overage is then neither stopped nor walled, and accounts at their caps stay
 *  in the pool behind every account below them. Unreadable counts as false. */
function overageAllowed(): boolean {
  try {
    return getProviderSettings().corchAllowOverage === true
  } catch {
    return false
  }
}
const listeners = new Set<(w: CorchWorker) => void>()

let claudeCommand: () => string[] = () => [resolveClaudeExe()]
/** The production pool: every CLI instance with a credential file, with its last usage reading
 *  (void once its window has reset), or a running worker's live one when that is newer. A hollow
 *  or revoked login still passes that file check; its first attempt fails `auth` and the account
 *  stays walled until it signs in again (recheckSignedOut), so a dead login costs one quick
 *  failure, once. */
function signedInAccounts(): CorchAccount[] {
  const now = Date.now()
  const cache = allCachedUsage()
  return listCliInstances()
    .filter((i) => i.loggedIn)
    .map((i) => {
      const u = latestUsage(i.id, i.lastUsageCheck, cache)
      const snapshotAt = u ? Date.parse(u.capturedAt) || 0 : 0
      const live = liveByAccount.get(i.id) ?? null
      return {
        id: i.id,
        num: i.num ?? null,
        name: i.name,
        configDir: i.configDir,
        sessionPct: freshestPct(
          u?.session,
          snapshotAt,
          live && live.sessionPct !== null
            ? { pct: live.sessionPct, resetsAt: live.sessionResetsAt, at: live.at }
            : null,
          now,
        ),
        weekPct: freshestPct(
          u?.weekAll,
          snapshotAt,
          live && live.weekPct !== null
            ? { pct: live.weekPct, resetsAt: live.weekResetsAt, at: live.at }
            : null,
          now,
        ),
      }
    })
}

/** The newer of the background refresh's cached reading and a person's manual check (only the
 *  latter lands in `lastUsageCheck`). */
function latestUsage(
  id: string,
  manual: UsageSnapshot | null | undefined,
  cache: Record<string, UsageSnapshot> = allCachedUsage(),
): UsageSnapshot | null {
  // The key cliKey (usage-service.ts) builds, spelled out so corch does not load that module and
  // its database for one string.
  const cached = cache[`cli:${id}`] ?? null
  const at = (s: UsageSnapshot | null | undefined): number =>
    s ? Date.parse(s.capturedAt) || 0 : -1
  return at(cached) > at(manual) ? cached : (manual ?? null)
}

const SIGNED_OUT_MS = 30 * 60_000
const credStamp = (configDir: string): number | null => {
  try {
    return statSync(join(configDir, '.credentials.json')).mtimeMs
  } catch {
    return null
  }
}
const authChecks = new Set<string>()

/** A signed-out wall is never lifted by the clock alone. When it runs out, or the account's
 *  credential file changes (a new sign-in), the CLI's own `auth status` decides: about a quarter
 *  of a second, no quota. A dead login stays walled, so it never costs another worker a failed
 *  attempt (before this, an expired account took one attempt from some worker every 30 minutes);
 *  a login that works again rejoins the pool at once. */
function recheckSignedOut(accounts: CorchAccount[], now: number): void {
  for (const a of accounts) {
    const wall = walls[a.id]
    if (wall?.reason !== 'signed out' || authChecks.has(a.id)) continue
    const cred = credStamp(a.configDir)
    if (wall.until > now && (wall.cred === undefined || wall.cred === cred)) continue
    wall.until = now + SIGNED_OUT_MS
    wall.cred = cred
    authChecks.add(a.id)
    void cliAuthStatus(a.configDir)
      .then((s) => {
        if (s.loggedIn) delete walls[a.id]
      })
      .catch(() => {})
      .finally(() => {
        authChecks.delete(a.id)
        try {
          saveWalls()
        } catch (err) {
          console.error('[corch] could not save walls:', err)
        }
        schedule(0)
      })
  }
}
let accountsProvider: () => CorchAccount[] = signedInAccounts

/** Tests: run a fake CLI instead of `claude`. null restores the real one. */
export function setCorchClaudeCommand(argv: string[] | null): void {
  claudeCommand = argv ? () => argv : () => [resolveClaudeExe()]
}
/** Tests: supply the accounts. null restores the signed-in CLI instances. */
export function setCorchAccountsProvider(fn: (() => CorchAccount[]) | null): void {
  accountsProvider = fn ?? signedInAccounts
}

export function onCorchChange(cb: (w: CorchWorker) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function load(): void {
  if (loaded) return
  loaded = true
  const read = readJsonStore(STORE_SPEC)
  if (read.status === 'ok') {
    for (const w of read.value.workers) workers.set(w.id, w)
    perAccount = read.value.perAccount
  } else if (read.status !== 'missing') {
    console.error(
      `[corch] ${STORE_SPEC.path} is ${read.status}; starting with no workers and not overwriting it.`,
    )
    loaded = false
    return
  }
  try {
    if (existsSync(WALLS_PATH)) walls = JSON.parse(readFileSync(WALLS_PATH, 'utf8'))
  } catch {
    walls = {}
  }
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

function changed(w: CorchWorker): void {
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

const isActive = (w: CorchWorker): boolean =>
  w.status === 'queued' || w.status === 'running' || w.status === 'waiting'

const isInit = (ev: unknown): boolean =>
  (ev as { type?: string; subtype?: string })?.type === 'system' &&
  (ev as { subtype?: string }).subtype === 'init'

/** Workers with a CLI process running now. A daemon restart kills them (on Windows they live in
 *  the daemon's kill-on-close job), so the restart route and auto-update count them as runs in
 *  flight; each resumes by itself afterwards, but its current step starts over. */
export function corchRunningCount(): number {
  load()
  let n = 0
  for (const w of workers.values()) if (w.status === 'running') n++
  return n
}

function schedule(delay?: number): void {
  if (timer) clearTimeout(timer)
  // poll() runs every tick, so the overage stop is only as fast as the tick, and each second of
  // overage bills the owner: 1 s while a worker runs, 3 s while one is queued or waiting.
  const all = [...workers.values()]
  const next =
    delay ?? (all.some((w) => w.status === 'running') ? 1_000 : all.some(isActive) ? 3_000 : 15_000)
  timer = setTimeout(
    () => void tick().catch((err) => console.error('[corch] tick failed:', err)),
    next,
  )
  timer.unref?.()
}

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    load()
    const now = Date.now()
    let accounts: CorchAccount[] = []
    try {
      accounts = accountsProvider()
    } catch (err) {
      console.error('[corch] could not list accounts:', err)
    }
    for (const w of workers.values()) {
      if (w.status !== 'running') continue
      try {
        poll(w, accounts)
      } catch (err) {
        console.error(`[corch] could not read ${w.id}:`, err)
      }
    }
    recheckSignedOut(accounts, now)
    const allowFull = overageAllowed()
    const active = new Map<string, number>()
    // Each group's running workers per account: `perAccount` caps a group, not the fleet.
    const byGroup = new Map<string, Map<string, number>>()
    const groupMap = (g: string): Map<string, number> => {
      let m = byGroup.get(g)
      if (!m) {
        m = new Map()
        byGroup.set(g, m)
      }
      return m
    }
    const bump = (m: Map<string, number>, id: string): void => {
      m.set(id, (m.get(id) ?? 0) + 1)
    }
    for (const w of workers.values())
      if (w.status === 'running' && w.accountId) {
        bump(active, w.accountId)
        bump(groupMap(w.group), w.accountId)
      }
    const due = [...workers.values()]
      .filter((w) => (w.status === 'queued' || w.status === 'waiting') && (w.notBefore ?? 0) <= now)
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const w of due) {
      try {
        const cap = perAccount[w.group] ?? 2
        const groupActive = groupMap(w.group)
        const acct = pickAccount(w, accounts, walls, active, cap, now, groupActive, allowFull)
        if (acct) {
          try {
            launch(w, acct, accounts)
          } catch (err) {
            console.error(`[corch] could not launch ${w.id}:`, err)
            // A throw after the spawn leaves a live attempt. One before it (a file lock on the
            // transcript copy or the prompt file) is usually passing: retry it, three times per turn.
            if (w.status !== 'running' && w.status !== 'failed') {
              const msg = err instanceof Error ? err.message : String(err)
              if (w.retries < 3) {
                w.status = 'queued'
                w.notBefore = Date.now() + 10_000
                w.retries++
                w.error = `Could not start the next attempt (will retry): ${msg}`
              } else {
                w.status = 'failed'
                w.error = `Could not start the next attempt: ${msg}`
              }
              changed(w)
            }
          }
          if (w.status === 'running') {
            bump(active, acct.id)
            bump(groupActive, acct.id)
          }
          continue
        }
        // Busy (every eligible account at its worker cap) stays queued; nothing eligible at all
        // waits.
        const idle = new Map<string, number>()
        if (pickAccount(w, accounts, walls, idle, Number.MAX_SAFE_INTEGER, now, idle, allowFull)) {
          if (w.status === 'waiting') {
            w.status = 'queued'
            w.error = null
            changed(w)
          }
          continue
        }
        const allowed = accounts.filter((a) => !w.accounts || w.accounts.includes(a.id))
        // A signed-out wall's `until` is only its next recheck, not a time the account frees up.
        const soonest = allowed
          .map((a) => walls[a.id])
          .filter((x) => x !== undefined && x.reason !== 'signed out' && x.until > now)
          .map((x) => x!.until)
          .sort((a, b) => a - b)[0]
        const allSignedOut =
          allowed.length > 0 &&
          allowed.every((a) => walls[a.id]?.reason === 'signed out' && walls[a.id]!.until > now)
        const why = !accounts.length
          ? 'No signed-in CLI account. Add one: CLI instances, Quick add.'
          : w.accounts && !allowed.length
            ? 'None of the accounts this task may use is signed in. Sign one in: CLI instances, Quick add (type its email).'
            : allSignedOut
              ? 'Every CLI account is signed out. Sign one in again: CLI instances, Quick add (type its email).'
              : `Every eligible account is at its usage limit or signed out${soonest ? `; the first frees up at ${new Date(soonest).toLocaleString()}` : ''}.`
        if (w.status !== 'waiting' || w.error !== why) {
          w.status = 'waiting'
          w.error = why
          changed(w)
        }
      } catch (err) {
        console.error(`[corch] could not schedule ${w.id}:`, err)
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
function peekLog(path: string): LogRead {
  return readInto(path, freshRead())
}

/** The summary lines of finished attempts, for corchGet: the Corch view asks for the selected
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
function forgetRead(path: string): void {
  const r = reads.get(path)
  if (r) rememberFinished(path, r.recent)
  reads.delete(path)
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
        if (!line.trim()) continue
        let ev: unknown
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (isInit(ev)) r.sawInit = true
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
    } finally {
      closeSync(fd)
    }
  }
  return r
}

function tailText(path: string, max: number): string {
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
  w: CorchWorker,
  at: CorchWorker['attempts'][number],
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
  changed(w)
}

/** Some OTHER account this worker may use has room below the wind-down thresholds. Without one a
 *  handoff would only restart the task on the same nearly-full account, so the session keeps
 *  working until its real limit, where the move (transcript copy) takes over. */
function roomElsewhere(w: CorchWorker, from: string, accounts: CorchAccount[]): boolean {
  const now = Date.now()
  return accounts.some(
    (a) =>
      a.id !== from &&
      (!w.accounts || w.accounts.includes(a.id)) &&
      !((walls[a.id]?.until ?? 0) > now) &&
      (a.sessionPct ?? 0) < WIND_DOWN_SESSION_PCT &&
      (a.weekPct ?? 0) < WIND_DOWN_WEEK_PCT,
  )
}

function poll(w: CorchWorker, accounts?: CorchAccount[]): void {
  const at = w.attempts[w.attempts.length - 1]
  if (!at) return
  const proc = procs.get(w.id)
  // With no handle (the daemon restarted), a live PID proves nothing on Windows, which reuses
  // them: an attempt another daemon launched died with that daemon's kill-on-close job (measured
  // 2026-09-30), since workers are never detached.
  const exited = proc
    ? hasExited(proc)
    : (process.platform === 'win32' && at.daemonPid !== process.pid) ||
      !(at.pid && isPidAlive(at.pid))
  const r = readLog(at.log)
  at.started ||= r.sawInit
  // Only from a process this daemon is watching now: after a restart an old log is read again from
  // the start, and its readings would be stamped as fresh.
  if (r.live && proc) {
    const prev = liveByAccount.get(at.account.id)
    if (!prev || prev.at <= r.live.at) liveByAccount.set(at.account.id, r.live)
  }
  if (!at.overage && !overageAllowed()) {
    if (r.overage) stopForOverage(w, at, r.overage, !exited)
    else {
      // Stop BEFORE the first billed request on an account that can bill (aboutToBill).
      const soon = proc ? aboutToBill(r.live) : null
      if (soon) stopForOverage(w, at, { ...soon, notice: PRE_OVERAGE_NOTICE }, !exited)
    }
  }
  // Near its limit, with room elsewhere: the session writes a handoff and the task goes on in a
  // fresh, small session on another account instead of re-reading this whole conversation there.
  if (proc && !exited && accounts && !at.windDown && !at.overage) {
    const pct = windDownAt(r.live)
    if (pct !== null && roomElsewhere(w, at.account.id, accounts)) signalWindDown(w, at, pct)
  }
  const latest = r.recent[r.recent.length - 1] ?? null
  if (latest && latest !== w.lastActivity) {
    w.lastActivity = latest
    w.updatedAt = Date.now()
  }
  if (exited) finish(w, r.events)
}

/** The account ran out and started billing paid extra usage. Unless the owner allowed it
 *  (overageAllowed), nobody asked for that spend (Corch exists to use FREE quota across accounts), so the account is walled until its window resets
 *  and the running turn is stopped now; finish() then treats it as a limit, and the session moves
 *  to an account with room, or waits for one, without spending another cent of overage. */
function stopForOverage(
  w: CorchWorker,
  at: CorchWorker['attempts'][number],
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
    console.error('[corch] could not save walls:', err)
  }
  const proc = procs.get(w.id)
  if (running && proc && !hasExited(proc) && at.pid) {
    try {
      killProcessTree(at.pid)
    } catch {
      // already gone
    }
  }
  changed(w)
}

function finish(w: CorchWorker, events: unknown[]): void {
  const at = w.attempts[w.attempts.length - 1]
  if (at?.outcome !== 'running') return
  procs.delete(w.id)
  const stderr = tailText(at.errLog, 4_000)
  let v = classifyAttempt(events, stderr, at.started === true)
  // Stopped to spare paid extra usage: a limit, whatever the killed process left behind. A turn
  // that still finished cleanly keeps its result; its account is walled either way.
  if (at.overage && v.outcome !== 'done')
    v = {
      ...v,
      outcome: 'quota',
      notice: at.overage.notice ?? OVERAGE_NOTICE,
      resetsAt: at.overage.resetsAt,
      window: 'session',
      resets: null,
    }
  // Asked to wind down: a handoff written after the signal means the task goes on in a fresh
  // session elsewhere; none means the session reported the whole task complete instead.
  if (at.windDown && v.outcome === 'done' && handoffWritten(at.windDown))
    v = {
      ...v,
      outcome: 'handoff',
      notice:
        at.windDown.pct === null
          ? 'Handed off on request: wrote a handoff; the task continues in a fresh session.'
          : `Wound down at ${Math.round(at.windDown.pct)}% of its usage limit and wrote a handoff; the task continues in a fresh session on another account.`,
    }
  rmSync(signalPath(w.id), { force: true })
  forgetRead(at.log)
  const now = Date.now()
  at.outcome = v.outcome
  at.notice = v.notice
  at.endedAt = now
  w.costUsd += spentOf(w, at)
  w.turns += v.turns
  if (v.outcome === 'done' || v.outcome === 'handoff') w.result = v.result
  if (w.status === 'cancelled') {
    changed(w)
    return
  }
  switch (v.outcome) {
    case 'done':
      w.retries = 0
      w.error = null
      w.status = w.pending.length ? 'queued' : 'done'
      break
    case 'handoff':
      // launch() starts the next session from the handoff; the wound-down account is tried last.
      w.retries = 0
      w.error = null
      w.status = 'queued'
      break
    case 'quota': {
      // The CLI's own resetsAt when it streamed one, else the notice's text (wallUntil). A weekly
      // wall with neither falls back to the account's own weekly reset rather than an hour.
      let weekly: number | null = null
      if (v.resetsAt === null && (v.window === 'weekly' || /weekly/i.test(v.notice ?? ''))) {
        const reading = latestUsage(at.account.id, getCliInstance(at.account.id)?.lastUsageCheck)
        const week = Date.parse(reading?.weekAll?.resetsAt ?? '')
        if (Number.isFinite(week)) weekly = week
      }
      walls[at.account.id] = {
        until: wallUntil(now, v, parseResetTime, weekly),
        reason: v.notice ?? 'usage limit',
      }
      // The wall holds in memory either way; a throw here must not leave the worker 'running'.
      try {
        saveWalls()
      } catch (err) {
        console.error('[corch] could not save walls:', err)
      }
      w.retries = 0
      w.status = 'queued'
      break
    }
    case 'auth': {
      const dir = getCliInstance(at.account.id)?.configDir
      walls[at.account.id] = {
        until: now + SIGNED_OUT_MS,
        reason: 'signed out',
        cred: dir ? credStamp(dir) : null,
      }
      try {
        saveWalls()
      } catch (err) {
        console.error('[corch] could not save walls:', err)
      }
      w.status = 'queued'
      break
    }
    case 'transient':
      if (w.retries < 3) {
        w.notBefore = now + [5_000, 10_000, 20_000][w.retries]!
        w.retries++
        w.status = 'queued'
      } else {
        w.status = 'failed'
        w.error = `Anthropic stayed overloaded through 3 retries: ${v.notice ?? ''}`.trim()
      }
      break
    case 'interrupted':
      // Killed from outside with the transcript intact: resume the same session on the same
      // account. Three in one turn means something keeps killing it, and that needs a person. No
      // delay: with one, a resume took 3.1 s every time (6 real cases), all of it waiting.
      if (w.retries < 3) {
        w.notBefore = null
        w.retries++
        w.status = 'queued'
      } else {
        w.status = 'failed'
        w.error = `The CLI was stopped before it finished three times in a row in this turn.${stderr ? ` Its last error output: ${stderr.slice(-1_500)}` : ''}`
      }
      break
    default:
      w.status = 'failed'
      w.error = v.result || stderr.slice(-1_500) || 'The CLI exited without a result.'
  }
  // corchSend told the caller a queued message would be delivered; say that it was not.
  if (w.status === 'failed' && w.pending.length)
    w.error =
      `${w.error ?? ''} ${w.pending.length} queued message(s) were not delivered; send one again to retry.`.trim()
  changed(w)
  schedule(50)
}

/** An ended attempt's own spend, from its transcript on the account it ran on (attemptSpend). */
function spentOf(w: CorchWorker, at: CorchWorker['attempts'][number]): number {
  const dir = getCliInstance(at.account.id)?.configDir
  if (!dir || !w.sessionId) return 0
  return attemptSpend(dir, w.sessionId, at.startedAt, at.endedAt ?? Date.now())
}

/** The handoff file exists and was written after the wind-down was asked for (a stale one from an
 *  earlier run with the same name does not count). */
function handoffWritten(windDown: { at: number; path: string }): boolean {
  try {
    return statSync(windDown.path).mtimeMs >= windDown.at - 1_000
  } catch {
    return false
  }
}

/** A session's transcript file on an account, or null. */
function transcriptFile(configDir: string | null, sessionId: string): string | null {
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

function hasTranscript(configDir: string, sessionId: string): boolean {
  const root = join(configDir, 'projects')
  try {
    return readdirSync(root).some((d) => existsSync(join(root, d, `${sessionId}.jsonl`)))
  } catch {
    return false
  }
}

function configDirOf(id: string, accounts: CorchAccount[]): string | null {
  return accounts.find((a) => a.id === id)?.configDir ?? getCliInstance(id)?.configDir ?? null
}

function launch(w: CorchWorker, acct: CorchAccount, accounts: CorchAccount[]): void {
  const n = w.attempts.length
  const last = w.attempts[n - 1]
  // After a planned handoff the task goes on in a NEW session, started from the handoff file.
  const fresh = last?.outcome === 'handoff' && !!last.windDown
  const oldSession = w.sessionId
  const sessionId = fresh || !w.sessionId ? crypto.randomUUID() : w.sessionId
  if (!fresh) w.sessionId = sessionId
  // Moving accounts: carry the transcript over so `--resume` finds it there. A session that holds
  // work already must not start over empty on the new account.
  const fromId = w.accountId !== acct.id ? w.accountId : null
  if (fromId && !fresh) {
    const from = configDirOf(fromId, accounts)
    const copied = from ? copySessionTranscript(from, acct.configDir, sessionId) : false
    if (!copied && w.attempts.some((a) => a.started === true || a.outcome === 'done')) {
      const label = acct.num === null ? acct.name : `#${acct.num} ${acct.name}`
      w.status = 'failed'
      w.error = `This session's transcript was not found on the account it last ran on, so it cannot move to ${label} without losing its context. Start it again as a new task.`
      changed(w)
      return
    }
  }
  const resume = !fresh && hasTranscript(acct.configDir, sessionId)
  // Stopped after the CLI started (its init event is in the log): the message is already in the
  // session, so ask it to carry on. Stopped before that: the message never arrived, send it again.
  const inSession = !!last && (last.started ?? peekLog(last.log).sawInit)
  const prevPrompt = (): string =>
    tailText(join(PROMPTS, `${w.id}-${n - 1}.txt`), 1_000_000) || w.prompt
  // A follow-up is shifted out of `pending` only once the spawn succeeded, so a failed spawn
  // cannot lose it. Without a transcript here the task itself goes first.
  const next = w.pending[0] ?? ''
  const stopped = !!last && ['quota', 'auth', 'transient', 'interrupted'].includes(last.outcome)
  const delivers = !fresh && !!last && w.pending.length > 0 && (w.revived === true || !stopped)
  let text: string
  if (!last) text = w.prompt
  // The continuation of a planned handoff: the task, the handoff, where the old transcript is, and
  // any messages that arrived while the old session was winding down.
  else if (fresh && last.windDown) {
    let handoff = ''
    try {
      handoff = readFileSync(last.windDown.path, 'utf8')
    } catch {
      handoff = '(The handoff file could not be read; use the earlier transcript.)'
    }
    const old = oldSession
      ? transcriptFile(configDirOf(last.account.id, accounts), oldSession)
      : null
    text = continuationPrompt(
      w.prompt,
      handoff,
      last.windDown.path,
      old ? slashed(old) : null,
      w.pending,
    )
  }
  // A revived worker gets the message at once, not a continue prompt for the work it stopped. If
  // the stopped attempt never started, its own message never arrived either: send it first.
  else if (delivers)
    text =
      w.revived === true && !inSession
        ? `${prevPrompt()}\n\n${next}`
        : resume
          ? next
          : `${w.prompt}\n\n${next}`
  // Back on the same account once its wall lifted, the session did not move.
  else if (last.outcome === 'quota' || last.outcome === 'auth')
    text = resume && inSession ? (fromId ? HANDOFF_PROMPT : PAUSED_PROMPT) : prevPrompt()
  else if (last.outcome === 'transient' || last.outcome === 'interrupted')
    text =
      resume && inSession
        ? last.outcome === 'transient'
          ? TRANSIENT_PROMPT
          : INTERRUPTED_PROMPT
        : prevPrompt()
  else text = w.prompt

  mkdirSync(LOGS, { recursive: true })
  mkdirSync(PROMPTS, { recursive: true })
  const promptFile = join(PROMPTS, `${w.id}-${n}.txt`)
  writeFileSync(promptFile, text)
  const log = join(LOGS, `${w.id}-${n}.jsonl`)
  const errLog = join(LOGS, `${w.id}-${n}.err.log`)
  // The wind-down channel: after every tool call the CLI runs this hook, which prints the worker's
  // signal file when there is one (signalWindDown) and nothing otherwise, about 65 ms a call.
  mkdirSync(HOOKS, { recursive: true })
  const hookFile = join(HOOKS, `${w.id}.json`)
  writeFileSync(
    hookFile,
    JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: `cat '${slashed(signalPath(w.id))}' 2>/dev/null || true`,
              },
            ],
          },
        ],
      },
    }),
  )
  rmSync(signalPath(w.id), { force: true })
  const argv = [
    ...claudeCommand(),
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ...(w.model ? ['--model', w.model] : []),
    ...(w.effort ? ['--effort', w.effort] : []),
    '--settings',
    hookFile,
    '--append-system-prompt',
    WORKER_BRIEF,
  ]
  const outFd = openSync(log, 'a')
  let errFd: number
  try {
    errFd = openSync(errLog, 'a')
  } catch (err) {
    closeSync(outFd)
    throw err
  }
  let proc: ReturnType<typeof Bun.spawn>
  try {
    // Files, not pipes: a daemon restart must not kill the worker through a broken pipe. Never
    // `detached` (DETACHED_PROCESS would flash a console per child); windowsHide hides the tree.
    proc = Bun.spawn(argv, {
      cwd: w.cwd,
      // No claude.ai connectors (Gmail, Calendar, Drive, Notion, ...; several answer needs-auth).
      // Measured on #83 with the real CLI: with them it took 2.0-3.0 s to its init event and loaded
      // 158-202 tools (a different number run to run); without, 1.2-1.3 s and a steady 137 tools.
      // Local MCP servers still load. Here, not in scrubbedEnv: quick add uses that too.
      env: { ...scrubbedEnv(acct.configDir, w.id), ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
      stdin: Bun.file(promptFile),
      stdout: outFd,
      stderr: errFd,
      windowsHide: true,
    })
  } catch (err) {
    w.status = 'failed'
    w.error = `Could not start the CLI: ${err instanceof Error ? err.message : String(err)}`
    changed(w)
    return
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  procs.set(w.id, proc)
  void proc.exited.then(() => schedule(50))
  w.attempts.push({
    account: { id: acct.id, num: acct.num, name: acct.name },
    pid: proc.pid,
    log,
    errLog,
    startedAt: Date.now(),
    endedAt: null,
    outcome: 'running',
    notice: null,
    resumed: resume,
    daemonPid: process.pid,
  })
  if (fromId) w.moves++
  if (delivers) w.pending.shift()
  if (fresh) {
    if (oldSession) w.sessions = [...(w.sessions ?? []), oldSession]
    w.sessionId = sessionId
    w.pending = [] // they went into the continuation prompt
  }
  if (!last || delivers || fresh) w.result = null // a new turn: the previous answer is not this one's
  delete w.revived
  w.accountId = acct.id
  w.status = 'running'
  w.error = null
  w.notBefore = null
  changed(w)
}

const hex = (n: number): string => crypto.randomUUID().replace(/-/g, '').slice(0, n)

export function corchRun(input: {
  tasks: Array<{ prompt: string; cwd: string; title?: string; model?: string; effort?: string }>
  group?: string
  accounts?: string[]
  perAccount?: number
}): { group: string; workers: CorchWorkerView[] } {
  load()
  if (!Array.isArray(input.tasks) || !input.tasks.length)
    throw new Error('tasks must be a non-empty array')
  for (const [i, t] of input.tasks.entries()) {
    if (typeof t?.prompt !== 'string' || !t.prompt.trim())
      throw new Error(`task ${i + 1}: prompt is empty`)
    if (typeof t.cwd !== 'string' || !existsSync(t.cwd) || !statSync(t.cwd).isDirectory())
      throw new Error(`task ${i + 1}: cwd '${t.cwd}' is not an existing folder`)
  }
  const cap = input.perAccount ?? 2
  if (!Number.isInteger(cap) || cap < 1 || cap > 4) throw new Error('perAccount must be 1..4')
  const group = input.group?.trim() || `g-${hex(6)}`
  // Joining a group keeps its cap unless the caller names a new one.
  if (input.perAccount !== undefined || !(group in perAccount)) perAccount[group] = cap
  const now = Date.now()
  const made = input.tasks.map(
    (t): CorchWorker => ({
      id: `w-${hex(8)}`,
      group,
      title: t.title?.trim() || t.prompt.replace(/\s+/g, ' ').trim().slice(0, 60),
      cwd: t.cwd,
      prompt: t.prompt,
      pending: [],
      model: t.model || null,
      effort: t.effort || null,
      accounts: input.accounts?.length ? input.accounts : null,
      status: 'queued',
      sessionId: crypto.randomUUID(),
      accountId: null,
      attempts: [],
      result: null,
      error: null,
      lastActivity: null,
      costUsd: 0,
      turns: 0,
      moves: 0,
      retries: 0,
      notBefore: null,
      createdAt: now,
      updatedAt: now,
    }),
  )
  for (const w of made) {
    workers.set(w.id, w)
    changed(w)
  }
  startCorch()
  schedule(0)
  return { group, workers: made.map((w) => toView(w, now)) }
}

function matches(w: CorchWorker, f: { group?: string; id?: string; active?: boolean }): boolean {
  return (!f.id || w.id === f.id) && (!f.group || w.group === f.group) && (!f.active || isActive(w))
}

export function corchList(
  filter: { group?: string; id?: string; active?: boolean } = {},
): CorchWorkerView[] {
  load()
  const now = Date.now()
  return [...workers.values()]
    .filter((w) => matches(w, filter))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((w) => toView(w, now))
}

export function corchGet(id: string): (CorchWorkerView & { events: string[] }) | null {
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

export function corchWait(
  filter: { group?: string; id?: string },
  timeoutMs: number,
): Promise<CorchWorkerView[]> {
  load()
  if (![...workers.values()].some((w) => matches(w, filter) && isActive(w)))
    return Promise.resolve(corchList(filter))
  return new Promise((resolve) => {
    const off = onCorchChange((w) => {
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
      resolve(corchList(filter))
    }
  })
}

/** Hand a running task to a fresh session now, the same way a worker near its limit does: it
 *  finishes the step it is on, writes a handoff, and the task goes on from that handoff in a new
 *  session (on the account with the most room). For freeing an account, or giving a task whose
 *  conversation has grown huge a clean start without losing where it was. */
export function corchHandoff(id: string): { ok: boolean; message: string } {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  const at = w.attempts[w.attempts.length - 1]
  const proc = procs.get(w.id)
  if (w.status !== 'running' || !at || !proc || hasExited(proc))
    return { ok: false, message: 'Only a running worker can hand off; this one is not running.' }
  if (at.windDown) return { ok: true, message: 'It is already winding down.' }
  signalWindDown(w, at, null)
  return {
    ok: true,
    message:
      'Asked to wrap up after its current step and write a handoff; the task then continues in a fresh session.',
  }
}

export function corchSend(id: string, text: string): { ok: boolean; message: string } {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  if (!text.trim()) return { ok: false, message: 'The message is empty.' }
  w.pending.push(text)
  if (w.status === 'running') {
    changed(w)
    return { ok: true, message: 'Queued: it is delivered when the current turn ends.' }
  }
  if (!isActive(w)) {
    w.status = 'queued'
    w.retries = 0
    w.error = null
    w.revived = true
  }
  changed(w)
  schedule(0)
  return { ok: true, message: 'Queued as the next turn of the same session.' }
}

export function corchCancel(filter: { id?: string; group?: string }): { cancelled: string[] } {
  load()
  if (!filter.id && !filter.group) return { cancelled: [] }
  const cancelled: string[] = []
  for (const w of workers.values()) {
    if (!matches(w, filter) || !isActive(w)) continue
    const at = w.attempts[w.attempts.length - 1]
    const had = procs.get(w.id)
    // Stopped just after the CLI finished: record that turn's result, cost and turns first.
    if (w.status === 'running' && had && hasExited(had)) {
      try {
        poll(w)
      } catch (err) {
        // One worker's read error must not stop a group cancel; the kill path below still runs.
        console.error(`[corch] could not read ${w.id}:`, err)
      }
      if (!isActive(w)) continue
    }
    if (w.status === 'running' && at?.pid) {
      // Kill only a process known to be this worker's: a PID with no handle (the daemon
      // restarted) may have been reused by Windows for a stranger.
      const proc = procs.get(w.id)
      if (proc ? !hasExited(proc) : process.platform !== 'win32' && isPidAlive(at.pid)) {
        try {
          killProcessTree(at.pid)
        } catch {
          // already gone
        }
      }
      at.outcome = 'cancelled'
      at.endedAt = Date.now()
      w.costUsd += spentOf(w, at)
      procs.delete(w.id)
      forgetRead(at.log)
    }
    w.status = 'cancelled'
    w.pending = []
    w.error = null
    delete w.revived
    changed(w)
    cancelled.push(w.id)
  }
  return { cancelled }
}

/** Idempotent: load the store and start watching. Called at daemon boot. */
export function startCorch(): void {
  load()
  if (started) return
  started = true
  schedule(0)
}
