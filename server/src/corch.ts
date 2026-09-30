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
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR, resolveClaudeExe } from './config'
import {
  type CorchAccount,
  type CorchWalls,
  type CorchWorker,
  type CorchWorkerView,
  classifyAttempt,
  copySessionTranscript,
  HANDOFF_PROMPT,
  INTERRUPTED_PROMPT,
  livePct,
  pickAccount,
  scrubbedEnv,
  summarizeEvent,
  toView,
  WORKER_BRIEF,
} from './corch-lib'
import { getCliInstance, listCliInstances } from './core/cli-instances'
import { cliAuthStatus } from './core/cli-quick-add'
import { type JsonStoreSpec, readJsonStore, writeJsonStoreAtomic } from './core/json-store'
import { isPidAlive, killProcessTree } from './core/process'
import { parseResetTime } from './usage'

export * from './corch-lib'

const ROOT = join(CONFIG_DIR, 'corch')
const LOGS = join(ROOT, 'logs')
const PROMPTS = join(ROOT, 'prompts')
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
/** Per attempt log: bytes read, an unfinished last line, the events kept, the summaries shown. */
const reads = new Map<
  string,
  { offset: number; partial: string; events: unknown[]; recent: string[] }
>()
const listeners = new Set<(w: CorchWorker) => void>()

let claudeCommand: () => string[] = () => [resolveClaudeExe()]
/** The production pool: every CLI instance with a credential file, with its last usage reading
 *  (void once its window has reset). A hollow or revoked login still passes that file check; its
 *  first attempt fails `auth` and the account stays walled until it signs in again
 *  (recheckSignedOut), so a dead login costs one quick failure, once. */
function signedInAccounts(): CorchAccount[] {
  const now = Date.now()
  return listCliInstances()
    .filter((i) => i.loggedIn)
    .map((i) => ({
      id: i.id,
      num: i.num ?? null,
      name: i.name,
      configDir: i.configDir,
      sessionPct: livePct(i.lastUsageCheck?.session, now),
      weekPct: livePct(i.lastUsageCheck?.weekAll, now),
    }))
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
        saveWalls()
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
  const next = delay ?? ([...workers.values()].some(isActive) ? 3_000 : 15_000)
  timer = setTimeout(() => void tick(), next)
  timer.unref?.()
}

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    load()
    const now = Date.now()
    for (const w of workers.values()) if (w.status === 'running') poll(w)
    let accounts: CorchAccount[] = []
    try {
      accounts = accountsProvider()
    } catch (err) {
      console.error('[corch] could not list accounts:', err)
    }
    recheckSignedOut(accounts, now)
    const active = new Map<string, number>()
    for (const w of workers.values())
      if (w.status === 'running' && w.accountId)
        active.set(w.accountId, (active.get(w.accountId) ?? 0) + 1)
    const due = [...workers.values()]
      .filter((w) => (w.status === 'queued' || w.status === 'waiting') && (w.notBefore ?? 0) <= now)
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const w of due) {
      const cap = perAccount[w.group] ?? 2
      const acct = pickAccount(w, accounts, walls, active, cap, now)
      if (acct) {
        launch(w, acct, accounts)
        active.set(acct.id, (active.get(acct.id) ?? 0) + 1)
        continue
      }
      // Busy (every eligible account at its worker cap) stays queued; nothing eligible at all waits.
      if (pickAccount(w, accounts, walls, new Map(), Number.MAX_SAFE_INTEGER, now)) continue
      const soonest = Object.values(walls)
        .map((x) => x.until)
        .filter((u) => u > now)
        .sort((a, b) => a - b)[0]
      const allSignedOut =
        accounts.length > 0 &&
        accounts.every((a) => walls[a.id]?.reason === 'signed out' && walls[a.id]!.until > now)
      const why = !accounts.length
        ? 'No signed-in CLI account. Add one: CLI instances, Quick add.'
        : allSignedOut
          ? 'Every CLI account is signed out. Sign one in again: CLI instances, Quick add (type its email).'
          : `Every eligible account is at its usage limit or signed out${soonest ? `; the first frees up at ${new Date(soonest).toLocaleString()}` : ''}.`
      if (w.status !== 'waiting' || w.error !== why) {
        w.status = 'waiting'
        w.error = why
        changed(w)
      }
    }
  } finally {
    ticking = false
    schedule()
  }
}

function readLog(path: string): { events: unknown[]; recent: string[] } {
  let r = reads.get(path)
  if (!r) {
    r = { offset: 0, partial: '', events: [], recent: [] }
    reads.set(path, r)
  }
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

function poll(w: CorchWorker): void {
  const at = w.attempts[w.attempts.length - 1]
  if (!at) return
  const proc = procs.get(w.id)
  const exited = proc
    ? proc.exitCode !== null || proc.signalCode !== null
    : !(at.pid && isPidAlive(at.pid))
  const r = readLog(at.log)
  const latest = r.recent[r.recent.length - 1] ?? null
  if (latest && latest !== w.lastActivity) {
    w.lastActivity = latest
    w.updatedAt = Date.now()
  }
  if (exited) finish(w, r.events)
}

function finish(w: CorchWorker, events: unknown[]): void {
  const at = w.attempts[w.attempts.length - 1]
  if (at?.outcome !== 'running') return
  procs.delete(w.id)
  const stderr = tailText(at.errLog, 4_000)
  const v = classifyAttempt(events, stderr)
  const now = Date.now()
  at.outcome = v.outcome
  at.notice = v.notice
  at.endedAt = now
  w.costUsd += v.costUsd
  w.turns += v.turns
  if (v.result && v.outcome === 'done') w.result = v.result
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
    case 'quota': {
      const resets = v.notice?.match(/resets\s+(.+?)\s*$/i)?.[1]
      const iso = resets ? parseResetTime(resets) : null
      const until = iso ? Date.parse(iso) : Number.NaN
      walls[at.account.id] = {
        until: Number.isFinite(until) && until > now ? until : now + 60 * 60_000,
        reason: v.notice ?? 'usage limit',
      }
      saveWalls()
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
      saveWalls()
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
      // account. Three in one turn means something keeps killing it, and that needs a person.
      if (w.retries < 3) {
        w.notBefore = now + 2_000
        w.retries++
        w.status = 'queued'
      } else {
        w.status = 'failed'
        w.error = 'The CLI was stopped before it finished three times in a row in this turn.'
      }
      break
    default:
      w.status = 'failed'
      w.error = v.result || stderr.slice(-1_500) || 'The CLI exited without a result.'
  }
  changed(w)
  schedule(50)
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
  const sessionId = w.sessionId ?? crypto.randomUUID()
  w.sessionId = sessionId
  // Moving accounts: carry the transcript over so `--resume` finds it there.
  if (w.accountId && w.accountId !== acct.id) {
    const from = configDirOf(w.accountId, accounts)
    if (from) copySessionTranscript(from, acct.configDir, sessionId)
    w.moves++
  }
  const resume = hasTranscript(acct.configDir, sessionId)
  let text: string
  if (!last) text = w.prompt
  else if (last.outcome === 'quota' || last.outcome === 'auth')
    text = resume ? HANDOFF_PROMPT : w.prompt
  else if (last.outcome === 'transient')
    text = tailText(join(PROMPTS, `${w.id}-${n - 1}.txt`), 1_000_000) || w.prompt
  else if (last.outcome === 'interrupted')
    // Killed after the CLI started (its init event is in the log): the message is already in the
    // session, so ask it to carry on. Killed before that: the message never arrived, send it again.
    text =
      resume && readLog(last.log).events.some(isInit)
        ? INTERRUPTED_PROMPT
        : tailText(join(PROMPTS, `${w.id}-${n - 1}.txt`), 1_000_000) || w.prompt
  else if (w.pending.length) text = w.pending.shift() as string
  else text = w.prompt
  if (
    !resume &&
    text !== w.prompt &&
    last?.outcome !== 'transient' &&
    last?.outcome !== 'interrupted'
  )
    text = `${w.prompt}\n\n${text}`

  mkdirSync(LOGS, { recursive: true })
  mkdirSync(PROMPTS, { recursive: true })
  const promptFile = join(PROMPTS, `${w.id}-${n}.txt`)
  writeFileSync(promptFile, text)
  const log = join(LOGS, `${w.id}-${n}.jsonl`)
  const errLog = join(LOGS, `${w.id}-${n}.err.log`)
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
    '--append-system-prompt',
    WORKER_BRIEF,
  ]
  const outFd = openSync(log, 'a')
  const errFd = openSync(errLog, 'a')
  let proc: ReturnType<typeof Bun.spawn>
  try {
    // Files, not pipes: a daemon restart must not kill the worker through a broken pipe. Never
    // `detached` (DETACHED_PROCESS would flash a console per child); windowsHide hides the tree.
    proc = Bun.spawn(argv, {
      cwd: w.cwd,
      env: scrubbedEnv(acct.configDir, w.id),
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
  })
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
  perAccount[group] = cap
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
  const at = w.attempts[w.attempts.length - 1]
  return { ...toView(w, Date.now()), events: at ? readLog(at.log).recent.slice() : [] }
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
    if (w.status === 'running' && at?.pid) {
      try {
        killProcessTree(at.pid)
      } catch {
        // already gone
      }
      at.outcome = 'cancelled'
      at.endedAt = Date.now()
      procs.delete(w.id)
    }
    w.status = 'cancelled'
    w.pending = []
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
