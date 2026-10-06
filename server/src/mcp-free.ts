// server/src/mcp-free.ts - the MCP tools for the Free accounts: the claude.ai and chatgpt.com free web
// logins in AgentHydra 2.0's Instances → Free (desk2/server/src/free-instances). A chat sends work into
// them the way climayte_run sends it into the CLI accounts (owner, 2026-10-06: "orchestrate threads into
// free accounts"). They live in Desk 2's server, not this daemon, so every tool calls Desk 2's
// /api/free (desk2/README.md, "Free instances"); this file keeps no account state of its own, only the
// batches it is sending. Each Free account runs one operation at a time, so a batch waits for an idle
// account rather than ever being refused for a busy one.
import { randomUUID } from 'node:crypto'
import { DESK2_URL } from './config'
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

/** Desk 2's server, read at each call (HYDRA_DESK_PORT, as config.ts's DESK2_URL), or null where this
 *  install has no Desk 2. */
function deskBase(): string | null {
  return DESK2_URL ? `http://127.0.0.1:${Number(process.env.HYDRA_DESK_PORT) || 7798}` : null
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

/** The 5-hour window used, as a sort key: ChatGPT's unlimited everyday text is all room; no reading
 *  (Claude reports usage only once an account has chatted) sorts in the middle. */
function fiveHourUsed(i: FreeInstance): number {
  if (i.usage?.unlimited_text) return 0
  return windowOf(i, 'five_hour') ?? 50
}

export function accountLabel(i: Pick<FreeInstance, 'num' | 'provider' | 'name'>): string {
  return `#${i.num} ${i.provider}${i.name ? ` (${i.name})` : ''}`
}

/** The accounts a new thread may go to: signed in, of the provider and number asked for, and, unless
 *  one was named, under 90% of its week. */
export function eligibleAccounts(
  instances: FreeInstance[],
  want: { account?: number; provider?: Provider },
): FreeInstance[] {
  return instances.filter(
    (i) =>
      i.loggedIn &&
      (!want.provider || i.provider === want.provider) &&
      (want.account == null ? (windowOf(i, 'seven_day') ?? 0) < 90 : i.num === want.account),
  )
}

/** The idle account with the most room in its 5-hour window, Claude before ChatGPT on a tie, then the
 *  lowest number; null while every eligible account is busy. */
export function pickFreeAccount(
  instances: FreeInstance[],
  busy: ReadonlySet<string>,
  want: { account?: number; provider?: Provider },
): FreeInstance | null {
  const free = eligibleAccounts(instances, want).filter((i) => !busy.has(i.id))
  free.sort(
    (a, b) =>
      fiveHourUsed(a) - fiveHourUsed(b) ||
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

/** Sends a batch: each queued task starts on an idle account (a continuation on its thread's own),
 *  each running one is read until done. Runs on after the tool call returns; free_results reads it. */
async function runBatch(b: Batch): Promise<void> {
  const until = Date.now() + QUEUE_LIMIT_MS
  let threads: FreeThread[] | null = null
  while (b.items.some((it) => it.s.state === 'queued' || it.s.state === 'running')) {
    let status: { instances: FreeInstance[]; jobs: FreeJob[] }
    try {
      status = await desk('GET', '/status')
    } catch (e) {
      // Desk 2 away: a running send may still land, so only the tasks not yet started are given up.
      if (Date.now() > until || (e as DeskError).status !== 0) {
        for (const it of b.items)
          if (it.s.state === 'queued')
            Object.assign(it.s, { state: 'failed', error: String((e as Error).message) })
      }
      await sleep(TICK_MS * 2)
      if (Date.now() > until) break
      continue
    }
    const byId = new Map(status.instances.map((i) => [i.id, i]))
    const busy = new Set(status.jobs.filter((j) => j.state === 'running').map((j) => j.instanceId))
    for (const it of b.items) if (it.s.state === 'running' && it.instanceId) busy.add(it.instanceId)

    for (const it of b.items.filter((x) => x.s.state === 'running')) {
      try {
        const job = await desk<FreeJob>('GET', `/jobs/${it.requestId}`)
        if (job.state === 'done') finish(it, job.result, byId.get(it.instanceId ?? ''))
      } catch (e) {
        if ((e as DeskError).status === 404)
          finish(
            it,
            {
              ok: false,
              error: {
                code: 'operation_lost',
                message:
                  'Desk 2 no longer holds this operation (it restarted, or 15 minutes passed).',
              },
            },
            undefined,
          )
      }
    }

    for (const it of b.items.filter((x) => x.s.state === 'queued')) {
      let account: FreeInstance | undefined
      if (it.task.chat_id) {
        threads ??= await desk<FreeThread[]>('GET', '/threads').catch(() => null)
        const thread = threads?.find((t) => t.chatId === it.task.chat_id)
        account = thread ? byId.get(thread.instanceId) : undefined
        if (!account) {
          Object.assign(it.s, {
            state: 'failed',
            error: `No Free thread has chat_id ${it.task.chat_id} (free_threads lists them).`,
          })
          continue
        }
        if (busy.has(account.id)) continue
      } else {
        if (!eligibleAccounts(status.instances, it.task).length) {
          const asked =
            it.task.account != null
              ? `account #${it.task.account}`
              : it.task.provider
                ? `a ${it.task.provider} account`
                : 'an account'
          Object.assign(it.s, {
            state: 'failed',
            error: `No signed-in Free ${asked} can take it${it.task.account == null ? ' (accounts at 90% of their week are skipped)' : ''}. free_status shows them.`,
          })
          continue
        }
        account = pickFreeAccount(status.instances, busy, it.task) ?? undefined
        if (!account) continue
      }
      const requestId = randomUUID()
      const body = {
        requestId,
        instanceId: account.id,
        provider: account.provider,
        command: it.task.chat_id ? 'resume' : 'chat',
        prompt: it.task.prompt,
        ...(it.task.chat_id
          ? { chatId: it.task.chat_id }
          : it.task.name
            ? { name: it.task.name }
            : {}),
        ...(it.task.web_search && account.provider === 'claude' ? { webSearch: true } : {}),
      }
      try {
        await desk('POST', '/jobs', body)
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
    if (Date.now() > until)
      for (const it of b.items)
        if (it.s.state === 'queued')
          Object.assign(it.s, {
            state: 'failed',
            error: 'No Free account was idle within 30 minutes.',
          })
    if (b.items.some((it) => it.s.state === 'queued' || it.s.state === 'running'))
      await sleep(TICK_MS)
  }
}

function snapshot(b: Batch) {
  const done = b.items.filter((it) => it.s.state === 'done' || it.s.state === 'failed').length
  const finished = done === b.items.length
  return {
    batch: b.id,
    finished,
    done: `${done} of ${b.items.length}`,
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
  }
}

async function freeStatus() {
  const [status, threads] = await Promise.all([
    desk<{ ready: boolean; instances: FreeInstance[]; jobs: FreeJob[] }>('GET', '/status'),
    desk<FreeThread[]>('GET', '/threads').catch(() => []),
  ])
  const busy = new Set(status.jobs.filter((j) => j.state === 'running').map((j) => j.instanceId))
  return {
    ready: status.ready,
    accounts: status.instances.map((i) => ({
      account: accountLabel(i),
      num: i.num,
      provider: i.provider,
      signedIn: i.loggedIn,
      busy: busy.has(i.id),
      usage: !i.usage?.available
        ? 'no reading yet (Claude reports usage once the account has chatted)'
        : i.usage.unlimited_text
          ? 'unlimited everyday text'
          : `5h ${windowOf(i, 'five_hour') ?? '?'}%, week ${windowOf(i, 'seven_day') ?? '?'}%`,
      threads: threads.filter((t) => t.instanceId === i.id).length,
    })),
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
      "MUTATES: send messages to the Free accounts (free_status), each a new private thread (Claude incognito, ChatGPT temporary chat) or, with `chat_id`, the next message in a thread you started before: the thread keeps everything said in it, so a later message can build on an earlier answer. Tasks run at once, one per account; more tasks than idle accounts wait their turn (a continuation waits for its own thread's account). Without `account` or `provider`, a task goes to the idle signed-in account with the most room in its 5-hour window, skipping accounts at 90% of their week. Waits up to 45 s, then answers with what is done and a `batch` to poll with free_results; the sending goes on. Each answer names the account, the `chat_id` to continue or read the thread, and the reply. A failed send that names a chat_id may still have reached the provider: free_read it before sending again.",
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
      'The Free threads AgentHydra knows, newest first: chat_id, account, name, status (running, done, failed) and when each was last used. Continue one with free_chat { tasks: [{ chat_id, prompt }] }; read one with free_read. The messages stay at the provider; a provider may expire a private thread.',
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
      return threads
        .filter((t) => a.account == null || byId.get(t.instanceId)?.num === Number(a.account))
        .sort((x, y) => y.updatedAt - x.updatedAt)
        .slice(0, limit)
        .map((t) => {
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
