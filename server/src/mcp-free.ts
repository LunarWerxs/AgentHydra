// server/src/mcp-free.ts - the MCP tools for the Free accounts: the claude.ai and chatgpt.com free web
// logins in AgentHydra 2.0's Instances → Free (desk2/server/src/free-instances). A chat sends work into
// them the way climayte_run sends it into the CLI accounts (owner, 2026-10-06: "orchestrate threads into
// free accounts"). They live in Desk 2's server, not this daemon, so every tool calls Desk 2's
// /api/free (desk2/README.md, "Free instances"); this file keeps no account state of its own, only the
// batches it is sending. Each Free account runs one operation at a time, so a batch waits for an idle
// account rather than ever being refused for a busy one.
import { randomUUID } from 'node:crypto'
import { desk2Present, desk2Url } from './desk2'
import { MCP_WAIT_MAX_MS, S, str } from './mcp-client'
import type { McpEngineTool } from './mcp-stdio.mjs'

type Provider = 'claude' | 'chatgpt'
interface FreeWindow {
  id: string
  used_percent: number | null
  resets_at?: string | null
}
interface FreeUsage {
  available: boolean
  unlimited_text?: boolean
  windows: FreeWindow[]
}
export interface FreeInstance {
  id: string
  num: number
  provider: Provider
  name: string
  loggedIn: boolean
  usage: FreeUsage | null
  lastActiveAt?: number | null
}
interface FreeResult {
  ok: boolean
  model?: string
  chat_id?: string
  chat_name?: string | null
  response?: string
  messages?: { role: string; text: string }[]
  warnings?: unknown[]
  error?: { code: string; message: string; chat_id?: string }
}
interface FreeJob {
  id: string
  instanceId: string
  state: 'running' | 'done'
  result?: FreeResult
}
interface FreeThread {
  instanceId: string
  provider: Provider
  chatId: string
  title: string
  status: string
  createdAt: number
  updatedAt: number
  error: string | null
}

/** Desk 2's server, read at each call (HYDRA_DESK_PORT, see desk2.ts), or null where this install has
 *  no Desk 2. */
function deskBase(): string | null {
  return desk2Present() ? desk2Url() : null
}

class DeskError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function desk<T>(method: string, path: string, body?: unknown): Promise<T> {
  const base = deskBase()
  if (!base)
    throw new Error(
      'Free accounts live in AgentHydra 2.0 (desk2/), which this install does not have.',
    )
  let res: Response
  try {
    res = await fetch(`${base}/api/free${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new DeskError(
      0,
      `AgentHydra's window (Desk 2, ${base}) is not answering. Free accounts run there: open AgentHydra, then call again.`,
    )
  }
  const json = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) throw new DeskError(res.status, json?.error ?? `HTTP ${res.status}`)
  return json as T
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const windowOf = (i: FreeInstance, id: string) =>
  i.usage?.windows.find((w) => w.id === id)?.used_percent ?? null

/** Room in the 5-hour window, in bands so a few points never decide (a test chat, 2026-10-06: ChatGPT's
 *  unlimited text took every task while three idle Claude accounts at 2% got none). ChatGPT's
 *  unlimited everyday text and a window under half used are plenty (0); no reading (Claude reports
 *  usage only once an account has chatted) is 1; half used is 2, four fifths 3. */
function roomBand(i: FreeInstance): number {
  if (i.usage?.unlimited_text) return 0
  const used = windowOf(i, 'five_hour')
  return used == null ? 1 : used < 50 ? 0 : used < 80 ? 2 : 3
}

export function accountLabel(i: Pick<FreeInstance, 'num' | 'provider' | 'name'>): string {
  return `#${i.num} ${i.provider}${i.name ? ` (${i.name})` : ''}`
}

/** An account whose send failed for an account-wide reason rests before it is picked again, longer at each
 *  failure in a row (2026-10-07: three ChatGPT accounts refused ~3,700 sends in a row while three idle Claude
 *  accounts got almost none: a failure never moved lastActiveAt, so the failing one stayed "used longest ago"). */
interface Rest {
  until: number
  code: string
  strikes: number
}
const rests = new Map<string, Rest>()
/** When each account was last given a task, answered or not: the "used longest ago" order reads it too. */
const lastPicked = new Map<string, number>()
const RATE_LIMIT_REST_MS = 30 * 60_000 // ChatGPT Free locks out for 25-28 min after ~75 messages
const FAILURE_REST_MS = 5 * 60_000
const MAX_REST_MS = 4 * 60 * 60_000
/** Failure codes that are about the account (its limit, its login, the site refusing it), not the task. */
const ACCOUNT_CODES = new Set([
  'rate_limited',
  'http_rejected',
  'http_verification_required',
  'network_error',
  'login_required',
  'login_expired',
  'invalid_session',
  'preparation_invalid',
  'harness_failed',
  'setup_failed',
])

/** Records how an account's send ended: a success ends its rest, an account-wide failure starts one. */
export function noteFreeOutcome(instanceId: string, code: string | null, now = Date.now()): void {
  if (code == null) {
    rests.delete(instanceId)
    return
  }
  if (!ACCOUNT_CODES.has(code)) return
  const strikes = (rests.get(instanceId)?.strikes ?? 0) + 1
  const base = code === 'rate_limited' ? RATE_LIMIT_REST_MS : FAILURE_REST_MS
  rests.set(instanceId, {
    until: now + Math.min(base * 2 ** (strikes - 1), MAX_REST_MS),
    code,
    strikes,
  })
}

export function restingFor(instanceId: string, now = Date.now()): Rest | null {
  const rest = rests.get(instanceId)
  return rest && rest.until > now ? rest : null
}

/** For tests: forget every rest and pick. */
export function resetFreeHealth(): void {
  rests.clear()
  lastPicked.clear()
}

const lastUse = (i: FreeInstance) => Math.max(i.lastActiveAt ?? 0, lastPicked.get(i.id) ?? 0)

/** The accounts a new thread may go to: signed in, of the provider and number asked for, and, unless
 *  one was named, under 90% of its week and not resting after a failure. */
export function eligibleAccounts(
  instances: FreeInstance[],
  want: { account?: number; provider?: Provider },
): FreeInstance[] {
  return instances.filter(
    (i) =>
      i.loggedIn &&
      (!want.provider || i.provider === want.provider) &&
      (want.account == null
        ? (windowOf(i, 'seven_day') ?? 0) < 90 && !restingFor(i.id)
        : i.num === want.account),
  )
}

/** The idle account with the most room (roomBand), the one used (or tried) longest ago first so work
 *  spreads over every account and both providers, then Claude before ChatGPT, then the lowest number;
 *  null while every eligible account is busy. */
export function pickFreeAccount(
  instances: FreeInstance[],
  busy: ReadonlySet<string>,
  want: { account?: number; provider?: Provider },
): FreeInstance | null {
  const free = eligibleAccounts(instances, want).filter((i) => !busy.has(i.id))
  free.sort(
    (a, b) =>
      roomBand(a) - roomBand(b) ||
      lastUse(a) - lastUse(b) ||
      (a.provider === b.provider ? 0 : a.provider === 'claude' ? -1 : 1) ||
      a.num - b.num,
  )
  return free[0] ?? null
}

export interface FreeTask {
  prompt: string
  chat_id?: string
  name?: string
  account?: number
  provider?: Provider
  web_search?: boolean
  model?: 'haiku' | 'sonnet'
}
interface TaskState {
  task: number
  state: 'queued' | 'running' | 'done' | 'failed'
  account?: string
  chat_id?: string
  thread?: string
  model?: string
  response?: string
  error?: string
  warnings?: unknown[]
  seconds?: number
  /** The failure on another account that sent this new thread to a second one. */
  retried?: string
}
interface Item {
  task: FreeTask
  s: TaskState
  instanceId?: string
  requestId?: string
  startedAt?: number
}
interface Batch {
  id: string
  items: Item[]
  createdAt: number
  done: Promise<void>
}

const batches = new Map<string, Batch>()
/** How long a queued task waits for an idle account before it is given up. */
const QUEUE_LIMIT_MS = 30 * 60_000
/** How often a running batch looks at Desk 2 again. */
const TICK_MS = 1500
const KEEP_BATCH_MS = 6 * 60 * 60_000

function finish(it: Item, result: FreeResult | undefined, account: FreeInstance | undefined) {
  it.s.seconds = it.startedAt ? Math.round((Date.now() - it.startedAt) / 1000) : undefined
  if (result?.ok) {
    Object.assign(it.s, {
      state: 'done',
      chat_id: result.chat_id ?? it.s.chat_id,
      thread: result.chat_name ?? it.s.thread,
      model: result.model,
      response: result.response ?? '',
    })
    if (result.warnings?.length) it.s.warnings = result.warnings
    return
  }
  it.s.state = 'failed'
  it.s.chat_id = result?.error?.chat_id ?? result?.chat_id ?? it.s.chat_id
  it.s.error = result?.error
    ? `${result.error.code}: ${result.error.message}`
    : 'The operation ended without a result.'
  if (account && it.s.chat_id) it.s.error += ` Read it with free_read before sending again.`
}

const pending = (b: Batch) =>
  b.items.some((it) => it.s.state === 'queued' || it.s.state === 'running')

function failQueued(b: Batch, error: string) {
  for (const it of b.items)
    if (it.s.state === 'queued') Object.assign(it.s, { state: 'failed', error })
}

/** One tick's view of Desk 2: its accounts and the ones busy with a running operation. */
interface Tick {
  instances: FreeInstance[]
  byId: Map<string, FreeInstance>
  busy: Set<string>
}

function readTick(b: Batch, status: { instances: FreeInstance[]; jobs: FreeJob[] }): Tick {
  const byId = new Map(status.instances.map((i) => [i.id, i]))
  const busy = new Set(status.jobs.filter((j) => j.state === 'running').map((j) => j.instanceId))
  for (const it of b.items) if (it.s.state === 'running' && it.instanceId) busy.add(it.instanceId)
  return { instances: status.instances, byId, busy }
}

/** A new thread whose account failed for an account-wide reason before any chat existed goes back to the
 *  queue once, for another account; nothing reached the provider, so nothing is sent twice. */
function retryElsewhere(it: Item, code: string | undefined): boolean {
  if (it.s.retried || it.task.chat_id || it.task.account != null || it.s.chat_id) return false
  if (!code || !ACCOUNT_CODES.has(code)) return false
  Object.assign(it.s, { state: 'queued', retried: `${it.s.account}: ${it.s.error}` })
  for (const k of ['account', 'error', 'seconds', 'thread', 'model'] as const) delete it.s[k]
  for (const k of ['instanceId', 'requestId', 'startedAt'] as const) delete it[k]
  return true
}

async function pollRunning(it: Item, tick: Tick) {
  try {
    const job = await desk<FreeJob>('GET', `/jobs/${it.requestId}`)
    if (job.state === 'done') {
      finish(it, job.result, tick.byId.get(it.instanceId ?? ''))
      const code = job.result?.ok ? null : (job.result?.error?.code ?? 'unknown')
      if (it.instanceId) noteFreeOutcome(it.instanceId, code)
      if (code) retryElsewhere(it, code)
    }
  } catch (e) {
    if ((e as DeskError).status === 404)
      finish(
        it,
        {
          ok: false,
          error: {
            code: 'operation_lost',
            message: 'Desk 2 no longer holds this operation (it restarted, or 15 minutes passed).',
          },
        },
        undefined,
      )
  }
}

function noAccountError(task: FreeTask): string {
  const asked =
    task.account != null
      ? `account #${task.account}`
      : task.provider
        ? `a ${task.provider} account`
        : 'an account'
  return `No signed-in Free ${asked} can take it${task.account == null ? ' (accounts at 90% of their week, or resting after a failed send, are skipped)' : ''}. free_status shows them.`
}

/** The account a queued task starts on this tick; undefined while that account is busy or after the
 *  task is failed for having none. `cache.threads` is read once per batch, when first needed. */
async function accountFor(
  it: Item,
  tick: Tick,
  cache: { threads: FreeThread[] | null },
): Promise<FreeInstance | undefined> {
  if (it.task.chat_id) {
    cache.threads ??= await desk<FreeThread[]>('GET', '/threads').catch(() => null)
    const thread = cache.threads?.find((t) => t.chatId === it.task.chat_id)
    const account = thread ? tick.byId.get(thread.instanceId) : undefined
    if (!account) {
      Object.assign(it.s, {
        state: 'failed',
        error: `No Free thread has chat_id ${it.task.chat_id} (free_threads lists them).`,
      })
      return undefined
    }
    return tick.busy.has(account.id) ? undefined : account
  }
  if (!eligibleAccounts(tick.instances, it.task).length) {
    Object.assign(it.s, { state: 'failed', error: noAccountError(it.task) })
    return undefined
  }
  return pickFreeAccount(tick.instances, tick.busy, it.task) ?? undefined
}

function jobBody(task: FreeTask, account: FreeInstance, requestId: string) {
  return {
    requestId,
    instanceId: account.id,
    provider: account.provider,
    command: task.chat_id ? 'resume' : 'chat',
    prompt: task.prompt,
    ...(task.chat_id ? { chatId: task.chat_id } : task.name ? { name: task.name } : {}),
    ...(task.web_search && account.provider === 'claude' ? { webSearch: true } : {}),
    // A continued thread keeps its model; the family only picks a new Claude chat's (owner, 2026-10-07).
    ...(task.model && !task.chat_id && account.provider === 'claude' ? { model: task.model } : {}),
  }
}

async function startTask(it: Item, account: FreeInstance, busy: Set<string>) {
  const requestId = randomUUID()
  const body = jobBody(it.task, account, requestId)
  try {
    try {
      await desk('POST', '/jobs', body)
    } catch (e) {
      // A Desk 2 still running an older build refuses an option it does not know (2026-10-07: `model` cost
      // 304 tasks over 5 hours): send without the optional ones rather than fail.
      if (
        !(e instanceof DeskError && e.status === 400 && /Unknown operation option/.test(e.message))
      )
        throw e
      const {
        model: _model,
        webSearch: _web,
        ...plain
      } = body as typeof body & {
        model?: unknown
        webSearch?: unknown
      }
      await desk('POST', '/jobs', plain)
    }
    lastPicked.set(account.id, Date.now())
    Object.assign(it, { instanceId: account.id, requestId, startedAt: Date.now() })
    Object.assign(it.s, {
      state: 'running',
      account: accountLabel(account),
      chat_id: it.task.chat_id,
      thread: it.task.name,
    })
    busy.add(account.id)
  } catch (e) {
    // Busy since the status was read (another chat, a keepalive nudge): the next tick tries again.
    if ((e as DeskError).status === 409) busy.add(account.id)
    else Object.assign(it.s, { state: 'failed', error: String((e as Error).message) })
  }
}

/** Sends a batch: each queued task starts on an idle account (a continuation on its thread's own),
 *  each running one is read until done. Runs on after the tool call returns; free_results reads it. */
async function runBatch(b: Batch): Promise<void> {
  const until = Date.now() + QUEUE_LIMIT_MS
  const cache: { threads: FreeThread[] | null } = { threads: null }
  while (pending(b)) {
    let status: { instances: FreeInstance[]; jobs: FreeJob[] }
    try {
      status = await desk('GET', '/status')
    } catch (e) {
      // Desk 2 away: a running send may still land, so only the tasks not yet started are given up.
      if (Date.now() > until || (e as DeskError).status !== 0)
        failQueued(b, String((e as Error).message))
      await sleep(TICK_MS * 2)
      if (Date.now() > until) break
      continue
    }
    const tick = readTick(b, status)
    for (const it of b.items.filter((x) => x.s.state === 'running')) await pollRunning(it, tick)
    for (const it of b.items.filter((x) => x.s.state === 'queued')) {
      const account = await accountFor(it, tick, cache)
      if (account) await startTask(it, account, tick.busy)
    }
    if (Date.now() > until) failQueued(b, 'No Free account was idle within 30 minutes.')
    if (pending(b)) await sleep(TICK_MS)
  }
}

function snapshot(b: Batch) {
  const done = b.items.filter((it) => it.s.state === 'done' || it.s.state === 'failed').length
  const finished = done === b.items.length
  return {
    batch: b.id,
    finished,
    done: `${done} of ${b.items.length}`,
    elapsed_s: Math.round((Date.now() - b.createdAt) / 1000),
    tasks: b.items.map((it) => it.s),
    ...(finished
      ? {}
      : {
          poll: `free_results { batch: "${b.id}" }`,
          note: 'Still sending: the batch goes on after this call. Poll it; nothing is lost by waiting.',
        }),
  }
}

function waitMs(a: Record<string, unknown>): number {
  const s = Number(a.wait_s)
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, MCP_WAIT_MAX_MS) : MCP_WAIT_MAX_MS
}

function readTask(raw: unknown, index: number): FreeTask {
  const t = (raw ?? {}) as Record<string, unknown>
  const prompt = str(t.prompt)
  if (!prompt.trim()) throw new Error(`task ${index}: a prompt is required`)
  if (prompt.length > 100_000)
    throw new Error(`task ${index}: a prompt is at most 100,000 characters`)
  const provider = t.provider == null ? undefined : str(t.provider)
  if (provider !== undefined && provider !== 'claude' && provider !== 'chatgpt')
    throw new Error(`task ${index}: provider is claude or chatgpt`)
  return {
    prompt,
    ...(t.chat_id != null ? { chat_id: str(t.chat_id) } : {}),
    ...(t.name != null && t.chat_id == null ? { name: str(t.name).slice(0, 100) } : {}),
    ...(t.account != null ? { account: Number(t.account) } : {}),
    ...(provider ? { provider } : {}),
    ...(t.web_search === true ? { web_search: true } : {}),
    ...(t.model === 'haiku' || t.model === 'sonnet' ? { model: t.model } : {}),
  }
}

/** The thread list (1.4 MB at 3,250 threads) only gives free_status its counts, and HSwarm reads free_status
 *  before every task with a short timeout: one read a minute is enough. */
const THREADS_TTL_MS = 60_000
let threadsRead: { at: number; list: Promise<FreeThread[]> } | null = null
function recentThreads(): Promise<FreeThread[]> {
  if (!threadsRead || Date.now() - threadsRead.at > THREADS_TTL_MS)
    threadsRead = {
      at: Date.now(),
      list: desk<FreeThread[]>('GET', '/threads').catch(() => []),
    }
  return threadsRead.list
}

async function freeStatus() {
  const [status, threads] = await Promise.all([
    desk<{ ready: boolean; instances: FreeInstance[]; jobs: FreeJob[] }>('GET', '/status'),
    recentThreads(),
  ])
  const busy = new Set(status.jobs.filter((j) => j.state === 'running').map((j) => j.instanceId))
  return {
    ready: status.ready,
    accounts: status.instances.map((i) => {
      const rest = restingFor(i.id)
      return {
        account: accountLabel(i),
        num: i.num,
        provider: i.provider,
        signedIn: i.loggedIn,
        busy: busy.has(i.id),
        // HSwarm counts an account resting after a failed send as not idle (hswarm/free_route.py _idle).
        ...(rest
          ? {
              resting: `until ${new Date(rest.until).toISOString()} after ${rest.code} (x${rest.strikes})`,
            }
          : {}),
        usage: !i.usage?.available
          ? 'no reading yet (Claude reports usage once the account has chatted)'
          : i.usage.unlimited_text
            ? 'unlimited everyday text'
            : `5h ${windowOf(i, 'five_hour') ?? '?'}%, week ${windowOf(i, 'seven_day') ?? '?'}%`,
        threads: threads.filter((t) => t.instanceId === i.id).length,
      }
    }),
    running: status.jobs.filter((j) => j.state === 'running').length,
  }
}

export const FREE_TOOLS: McpEngineTool[] = [
  {
    name: 'free_status',
    description:
      "The Free accounts: the person's own claude.ai and chatgpt.com free web logins in AgentHydra's Instances → Free (they are not Claude Code, Codex or HSwarm accounts). Each with its number, provider, signed in, busy (one operation at a time per account), usage (Claude: 5-hour and weekly %; ChatGPT: unlimited everyday text) and how many threads it holds. Read this before free_chat when it matters which account or provider answers.",
    inputSchema: S({}),
    run: () => freeStatus(),
  },
  {
    name: 'free_chat',
    description:
      "MUTATES: send messages to the Free accounts (free_status), each a new private thread (Claude incognito, ChatGPT temporary chat) or, with `chat_id`, the next message in a thread you started before: the thread keeps everything said in it, so a later message can build on an earlier answer. Tasks run at once, one per account; more tasks than idle accounts wait their turn (a continuation waits for its own thread's account). Without `account` or `provider`, a task goes to an idle signed-in account with room (ChatGPT's unlimited text and a Claude 5-hour window under half used count alike), the one used longest ago first, so work spreads over every account and both providers; accounts at 90% of their week are skipped. Waits up to 45 s, then answers with what is done and a `batch` to poll with free_results; the sending goes on. Each answer names the account, the `chat_id` to continue or read the thread, the reply and `seconds` on its account (not counting the wait for one; `elapsed_s` is the batch's). A failed send that names a chat_id may still have reached the provider: free_read it before sending again. A task's `model` ('haiku') asks for the lightest Claude model on a new claude.ai thread. Free threads are private and never show in the account's history, so unlike probe chats they need no deleting.",
    inputSchema: S(
      {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: S(
            {
              prompt: { type: 'string', description: 'The message (at most 100,000 characters).' },
              chat_id: {
                type: 'string',
                description:
                  'Continue this thread (from an earlier answer or free_threads) instead of starting one.',
              },
              name: {
                type: 'string',
                description: "A new thread's name, shown in free_threads and AgentHydra.",
              },
              account: { type: 'number', description: 'Only this account number (free_status).' },
              provider: {
                type: 'string',
                enum: ['claude', 'chatgpt'],
                description: 'Only this provider.',
              },
              web_search: { type: 'boolean', description: 'Claude only: let it search the web.' },
              model: {
                type: 'string',
                enum: ['haiku', 'sonnet'],
                description:
                  "Preferred Claude family on a Free claude.ai account: 'haiku' takes the newest Haiku the account offers (Haiku 5.5 today), else the account's usual model. Ignored for chatgpt and for a continued thread.",
              },
            },
            ['prompt'],
          ),
        },
        wait_s: {
          type: 'number',
          description: 'How long to wait for answers, at most 45 (the default).',
        },
      },
      ['tasks'],
    ),
    run: async (a) => {
      if (!Array.isArray(a.tasks) || !a.tasks.length) throw new Error('pass `tasks`: [{ prompt }]')
      if (a.tasks.length > 32) throw new Error('at most 32 tasks per call')
      const items: Item[] = a.tasks.map((t, i) => ({
        task: readTask(t, i),
        s: { task: i, state: 'queued' },
      }))
      // Fail before anything is queued when Desk 2 cannot be reached at all.
      await desk('GET', '/status')
      for (const [id, b] of batches)
        if (Date.now() - b.createdAt > KEEP_BATCH_MS) batches.delete(id)
      const b: Batch = {
        id: randomUUID().slice(0, 8),
        items,
        createdAt: Date.now(),
        done: Promise.resolve(),
      }
      b.done = runBatch(b).catch((e) => {
        for (const it of b.items)
          if (it.s.state === 'queued' || it.s.state === 'running')
            Object.assign(it.s, { state: 'failed', error: String((e as Error).message) })
      })
      batches.set(b.id, b)
      await Promise.race([b.done, sleep(waitMs(a))])
      return snapshot(b)
    },
  },
  {
    name: 'free_results',
    description:
      "A free_chat batch: each task's state (queued, running, done, failed), account, chat_id and reply. Waits up to `wait_s` (at most 45, the default) for the batch to finish. Batches are kept 6 hours in this AgentHydra's memory; a restart loses them, never the threads (free_threads, free_read).",
    inputSchema: S(
      {
        batch: { type: 'string' },
        wait_s: {
          type: 'number',
          description: 'How long to wait for the batch to finish, at most 45 (the default).',
        },
      },
      ['batch'],
    ),
    run: async (a) => {
      const b = batches.get(str(a.batch))
      if (!b)
        throw new Error(
          `no batch ${str(a.batch)} here (kept 6 hours, lost on a restart): free_threads lists the threads, free_read reads one`,
        )
      await Promise.race([b.done, sleep(waitMs(a))])
      return snapshot(b)
    },
  },
  {
    name: 'free_threads',
    description:
      'The Free threads AgentHydra knows, most recently used first: `total`, and up to `limit` of them, each with chat_id, account, name, status (running, done, failed) and when it was last used; `more` says how many were left out. Continue one with free_chat { tasks: [{ chat_id, prompt }] }; read one with free_read. The messages stay at the provider; a provider may expire a private thread.',
    inputSchema: S({
      account: { type: 'number', description: 'Only this account number.' },
      limit: { type: 'number', description: 'At most this many (default 30).' },
    }),
    run: async (a) => {
      const [status, threads] = await Promise.all([
        desk<{ instances: FreeInstance[] }>('GET', '/status'),
        desk<FreeThread[]>('GET', '/threads'),
      ])
      const byId = new Map(status.instances.map((i) => [i.id, i]))
      const limit = Math.max(1, Math.min(Number(a.limit) || 30, 500))
      const mine = threads
        .filter((t) => a.account == null || byId.get(t.instanceId)?.num === Number(a.account))
        .sort((x, y) => y.updatedAt - x.updatedAt)
      const shown = mine.slice(0, limit).map((t) => {
        const i = byId.get(t.instanceId)
        return {
          chat_id: t.chatId,
          account: i ? accountLabel(i) : `${t.provider} (account removed)`,
          name: t.title,
          status: t.status,
          ...(t.error ? { error: t.error } : {}),
          updated: new Date(t.updatedAt).toISOString(),
        }
      })
      return {
        total: mine.length,
        threads: shown,
        ...(mine.length > shown.length
          ? {
              more: `${mine.length - shown.length} older: raise limit (at most 500) or pass account`,
            }
          : {}),
      }
    },
  },
  {
    name: 'free_read',
    description:
      "Read a Free thread back from its provider: every message, each with its role and text (code blocks and citations included in the text). `chat_id` from free_chat or free_threads. Waits for the thread's account if it is busy, up to 45 s.",
    inputSchema: S(
      {
        chat_id: { type: 'string' },
        last: { type: 'number', description: 'Only the last N messages.' },
      },
      ['chat_id'],
    ),
    run: async (a) => {
      const chatId = str(a.chat_id)
      const [status, threads] = await Promise.all([
        desk<{ instances: FreeInstance[] }>('GET', '/status'),
        desk<FreeThread[]>('GET', '/threads'),
      ])
      const thread = threads.find((t) => t.chatId === chatId)
      const account = thread && status.instances.find((i) => i.id === thread.instanceId)
      if (!thread || !account)
        throw new Error(`No Free thread has chat_id ${chatId} (free_threads lists them).`)
      const until = Date.now() + MCP_WAIT_MAX_MS
      const requestId = randomUUID()
      for (;;) {
        try {
          await desk('POST', '/jobs', {
            requestId,
            instanceId: account.id,
            provider: account.provider,
            command: 'read',
            chatId,
          })
          break
        } catch (e) {
          if ((e as DeskError).status !== 409 || Date.now() > until) throw e
          await sleep(TICK_MS)
        }
      }
      for (;;) {
        const job = await desk<FreeJob>('GET', `/jobs/${requestId}`)
        if (job.state === 'done') {
          const r = job.result
          if (!r?.ok)
            throw new Error(
              r?.error ? `${r.error.code}: ${r.error.message}` : 'The read ended without a result.',
            )
          const messages = (r.messages ?? []).map((m) => ({ role: m.role, text: m.text }))
          const last = Number(a.last)
          return {
            chat_id: chatId,
            account: accountLabel(account),
            name: thread.title,
            messages: Number.isFinite(last) && last > 0 ? messages.slice(-last) : messages,
          }
        }
        if (Date.now() > until)
          throw new Error('The read is still running after 45 s; call free_read again.')
        await sleep(1000)
      }
    },
  },
]
