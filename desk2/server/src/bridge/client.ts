// A typed client of the AgentHydra daemon (SPEC.md "The bridge"). Read-only GETs plus the two CliMayte
// writes Hydra Desk needs (cancel, send, place a chat, report an account failure). The Ah* types mirror AgentHydra's own response shapes
// (../server/src/types.ts, climayte-lib.ts, live-registry.ts), trimmed to the fields the bridge reads;
// recorded samples live in server/test/fixtures/agenthydra-*.json.

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

export const DEFAULT_HYDRA_URL = 'http://127.0.0.1:7787'
export const REQUEST_TIMEOUT_MS = 4000
/** A message into a Claude Desktop chat: AgentHydra confirms it from the transcript within 45 s. */
const DELIVERY_TIMEOUT_MS = 50_000
/** Starting a chat's worker or sending it a message. A busy AgentHydra answered after 4 s and had done it
 *  (2026-10-13); each carries a requestId, so a call that still runs out is retried without doing it twice. */
const WORKER_WRITE_TIMEOUT_MS = 30_000
/** A transcript search may scan for up to 7 s before AgentHydra's index is built (session-search.ts budget). */
export const SEARCH_TIMEOUT_MS = 10_000

/** Why a call failed: `down` (nothing answered), `timeout`, `http` (an error status), `bad_json`, `aborted` (its caller gave up). */
export type BridgeErrorKind = 'down' | 'timeout' | 'http' | 'bad_json' | 'aborted'

export class BridgeError extends Error {
  constructor(
    readonly kind: BridgeErrorKind,
    message: string,
    readonly status: number | null = null,
    /** An HTTP refusal's own reason, without the wrapping message (the daemon's `error`, `detail` or `message`). */
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'BridgeError'
  }
  /** AgentHydra did not answer at all (not running, or hung). */
  get unreachable(): boolean {
    return this.kind === 'down' || this.kind === 'timeout'
  }
}

// --- AgentHydra's shapes ----------------------------------------------------------------------

/** GET /api/agent-status: one row per session, fed by Claude Code hooks (server/src/agent-status.ts). */
export interface AhAgentStatus {
  sessionId: string
  state: 'working' | 'blocked' | 'done'
  mainState: 'working' | 'done'
  subagents: number
  waiting: string | null
  source: string
  event: string
  cwd: string | null
  at: string // ISO
  restoredUnconfirmed: boolean
}

/** GET /api/sessions/live: the pid-checked live registry of ~/.claude (live-registry.ts). */
export interface AhLiveSession {
  pid: number
  sessionId: string
  cwd: string
  name: string
  startedAt: number
  transcriptPath: string | null
  version?: string
  /** The desktop chat (`local_...`) hosting this engine; absent on terminal CLI engines. */
  hostSessionId?: string
}

/** GET /api/chats: Claude Desktop chats across the desktop instances (chat-dossier.ts listChats). */
export interface AhChatRow {
  instance: string
  chatId: string
  sessionId: string
  title: string
  archived: boolean
  lastActivityAt: string | null // ISO
  unread: boolean // Claude Desktop's dot: a turn finished after the app last had the chat in focus
  cwd: string | null
  /** The model the chat's record names (claude-opus-5-5 and the like); null or absent when it names none. */
  model?: string | null
  effort?: string | null
  /** The parent chat's local id (`local_<id>`) when another chat started this one; null or absent otherwise. */
  spawnedFrom?: string | null
  live: boolean
  livePid?: number | null
}

/** GET /api/codex-chats: every Codex account's unarchived chats, as its Codex app lists them (codex-chat-list.ts). */
export interface AhCodexChatRow {
  instance: string
  instanceNum: number
  instanceId: string
  /** The session id the transcript index keys the chat on. */
  threadId: string
  title: string
  cwd: string | null
  lastActivityAt: string | null // ISO
}

/** GET /api/codex-instances: one Codex account, only what Desk reads (no identity: its sign-in stays AgentHydra's). */
export interface AhCodexInstance {
  id: string
  num?: number
  name?: string
  codexHome: string
  loggedIn?: boolean
  isDesktopRunning?: boolean
}

/** GET /api/codex-instances/:id/usage, AgentHydra's cached reading: each window's use in percent and its reset (ISO). */
export interface AhCodexUsage {
  snapshot?: {
    session?: { pct?: number; resetsAt?: string } | null
    weekAll?: { pct?: number; resetsAt?: string } | null
  } | null
}

/** GET /api/sessions: the transcript index (SessionSummary), trimmed. */
export interface AhSessionRow {
  session_id: string
  source: string // claude, codex, opencode, hermes, dsh, zswarm, foreign
  /** The foreign store's tool id when source is foreign (e.g. claude-cloud); absent otherwise. */
  tool?: string
  title: string
  cwd: string
  last_activity_at: number
  last_role: 'user' | 'assistant' | null
  instance: string | null
  instance_num: number | null
  /** The other PC's name on a Desktop chat the chat sync took from it; absent on this PC's rows. */
  from_pc?: string
  /** A usage limit's stop in the transcript (AgentHydra's SessionLimitStop): `pending` while nothing has followed it. */
  limit_stop?: { notice: string; pending: boolean; at: number | null; resets_at?: string | null } | null
}

export interface AhUsageLimit {
  pct: number
  resets: string
  resetsAt?: string | null
}

export interface AhUsageSnapshot {
  account: string | null
  session: AhUsageLimit | null
  weekAll: AhUsageLimit | null
  capturedAt: string
  signedOutAt?: string
}

/** GET /api/cli-instances (CliInstance plus the route's liveSessions). */
export interface AhCliInstance {
  num: number
  id: string
  name: string
  configDir: string
  loggedIn: boolean
  loginNote?: string
  planLabel?: string | null
  lastUsageCheck: AhUsageSnapshot | null
  liveSessions?: number
  movedAway?: unknown
  /** The owner's priority and caps for AgentHydra's work on this account (AgentHydra's AccountPlacement). */
  placement?: { priority: number; maxSessionPct: number | null; maxWeekPct: number | null } | null
  /** The Claude Desktop instance this login is linked to: its folder and its name. */
  associatedDesktopDir?: string | null
  associatedDesktopLabel?: string | null
  /** The name on the signed-in account (its profile name). */
  accountName?: string | null
}

/** GET /api/instances: one isolated Claude Desktop instance (`loginUuid`: the account signed in there). */
export interface AhDesktopInstance {
  num: number
  name: string
  label: string | null
  dir: string
  isRunning: boolean
  loginUuid?: string | null
}

/** GET /api/instance-numbers: the whole fleet under one numbering (`email` is known for desktops). */
export interface AhInstanceNumber {
  num: number
  kind: 'desktop' | 'cli' | 'codex'
  handle: string // a desktop's dir, a CLI instance's id
  name: string
  email: string | null
  loggedIn: boolean
}

export interface AhTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** GET /api/corch/workers (the full CliMayteWorkerView, not `brief`). */
export interface AhWorker {
  id: string
  group: string
  title: string
  cwd: string
  /** The folder a `climayte_send` with `cwd` set for its next launch; absent when none is pending. */
  pendingCwd?: string
  prompt: string
  status: string
  sessionId: string | null
  sessions?: string[]
  accountId: string | null
  account: string | null // '#68 name'
  model: string | null
  effort: string | null
  reportedModel?: string | null
  kind?: string | null
  /** Set on the worker a Desk chat runs as. */
  chat?: boolean
  result: string | null
  error: string | null
  lastActivity: string | null
  /** What it is doing now, and the epoch ms that began; null or absent when it is not running or waiting. */
  doing?: string | null
  doingSince?: number | null
  doingKind?: 'hold' | 'said' | 'step' | 'wait' | null
  lastStepAt?: number | null
  /** ISO time a `waiting` worker is expected to start (AgentHydra's waitUntil); absent otherwise. */
  waitUntil?: string | null
  /** Epoch ms a retrying or queued worker is held until; null or absent when it is not. */
  notBefore?: number | null
  createdAt: number
  updatedAt: number
  /** Summed over its ended attempts (AgentHydra charges an attempt when it ends); absent before 2026-09-30. */
  tokens?: AhTokens
  attempts?: { account: { id: string; num: number | null; name: string }; outcome: string; tokens?: AhTokens }[]
  used?: { pct: number }
  verdicts?: { verdict: 'pass' | 'fail' | null }[]
  /** Absent on a wave's tasks: AgentHydra dispatches them with no origin, only their `wave`. */
  origin?: { kind: 'chat'; sessionId: string } | { kind: 'worker'; workerId: string }
  /** The wave it belongs to: a task of it, or (kind 'manage') the wave's manager. */
  wave?: string | null
  /** A manager held while its wave runs. */
  hold?: 'wave' | null
  /** What it asked with climayte_ask and waits on. */
  question?: { text: string; options?: string[]; at: number }
  /** Its current message's own estimate (climayte-eta.ts); `tookS`/`doneAt` once that message ended done.
   *  Absent before 2026-10-05 and when it gave none. */
  eta?: { minutes: number; at: number; attempt: number; tookS?: number; doneAt?: number }
}

/** GET /api/corch/workers/:id: the view plus its last 60 event lines (summarizeEvent). */
export type AhWorkerDetail = AhWorker & { events: string[] }

/**
 * One worker of another PC's shared queue (climayte-queue-sync.ts reduce()). It deliberately carries no
 * prompt or path, only its folder's last name (`folder`, from 2026-10-06); `account.name` is often the
 * login's email and is never shown. Its session, origin
 * (the chat's session, or the worker and that worker's session) and wave are ids on its own PC, absent
 * from an AgentHydra older than 2026-10-04.
 */
export interface AhRemoteWorker {
  id: string
  title: string
  group: string | null
  status: string
  kind: string | null
  model: string | null
  effort: string | null
  account: { id: string; num: number | null; name: string } | null
  createdAt: number
  updatedAt: number
  activeS: number
  costUsd: number | null
  lastActivity: string | null
  error: string | null
  verdict: 'pass' | 'fail' | null
  sessionId?: string | null
  originSessionId?: string | null
  originWorkerId?: string | null
  wave?: string | null
  originTitle?: string | null
  sessions?: string[]
  folder?: string | null
  doing?: string | null
  doingSince?: number | null
  doingKind?: 'hold' | 'said' | 'step' | 'wait' | null
  lastStepAt?: number | null
}

/** GET /api/corch/remote: the other PCs' queues, as the last poll of the shared store found them. */
export interface AhRemoteQueues {
  /** Queue sharing is off on this PC: `pcs` is then empty. */
  enabled: boolean
  pcs: { pc: string; name: string; at: number; stale: boolean; workers: AhRemoteWorker[]; jobs?: AhRemoteJob[] }[]
}

/** One HSwarm job of another PC (server/src/climayte-remote.ts RemoteSwarmJob). */
export interface AhRemoteJob {
  id: string
  label: string
  state: string
  tasks: number
  counts: Record<string, number>
  created: string | null
  finished: string | null
  callerSessionId: string | null
  callerChatId: string | null
  /** The last name of the caller's folder, never the path; absent from an AgentHydra older than 2026-10-06. */
  folder?: string | null
}

export interface AhTailEvent {
  role: 'user' | 'assistant'
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text: string
  tool_name: string | null
  timestamp: string | null
  /** A Claude reply's transcript line, which a new session can branch from (AgentHydra's session-branch). */
  uuid?: string
}

/** GET /api/sessions/:id/tail (TailResult). `error` is set when the transcript was not found. */
export interface AhTail {
  session_id: string
  source: string
  title: string
  cwd: string
  events: AhTailEvent[]
  has_more?: boolean
  /** A Codex chat's: where this window begins in its whole history (bytes), 0 at its beginning; the page above is asked with it as `before`. */
  history_start?: number
  error?: string
}

/** One session whose transcript matched (SessionSearchResult, trimmed). No title, no activity time. */
export interface AhSearchResult {
  session_id: string
  source: string
  cwd: string
  project: string
  match_count: number
  truncated: boolean
  snippets: string[]
}

/** GET /api/sessions/search (SessionSearchResponse, trimmed): newest-active first, and how complete it is. */
export interface AhSearchAnswer {
  results: AhSearchResult[]
  searched: 'index' | 'scan'
  conversationOnly: boolean
  budgetExhausted: boolean
  limitReached: boolean
}

/** The home stats reads can take seconds while AgentHydra warms its store (the spend report reads every session). */
export const STATS_TIMEOUT_MS = 15_000

/** AgentHydra's four token figures (TokenBreakdown): `input` is uncached input on every provider. */
export interface AhTokenBreakdown {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  total: number
}

/** One row of a spend report (SpendBucket, trimmed); `tokens` is set per model, source and day. */
export interface AhSpendBucket {
  key: string
  costUsd: number | null
  sessions: number
  turns: number
  tokens?: AhTokenBreakdown
}

/** GET /api/analytics/spend (SpendReport, trimmed). `byDay` keys are local days (YYYY-MM-DD), quiet days left out. */
export interface AhSpendReport {
  totalCostUsd: number | null
  tokens: AhTokenBreakdown
  sessions: number
  calls: number
  byModel: AhSpendBucket[]
  byDay: AhSpendBucket[]
  bySource: AhSpendBucket[]
  pricesAsOf: string
  coverage: { sessions: number; total: number; refreshing: boolean }
  /** The kit's oldest and newest call per source (epoch ms): where each source's record begins. */
  kitCoverage?: { sources?: Record<string, { events?: number; firstTs?: number; lastTs?: number }> }
}

/** GET /api/analytics/activity (ActivityReport, trimmed): `hours` is 168 slots, Sunday 00:00 first, the PC's local time. */
export interface AhActivityReport {
  hours: number[]
  agentMinutes: number
}

/** GET /api/corch/totals (climayte-totals.ts, trimmed): what CliMayte ran, since `since` when given. */
export interface AhCorchTotals {
  tasks: number
  sessions: number
  costUsd: number
  limitHits: number
}

/** GET /api/hswarm/api/stats (HSwarm's own stats through AgentHydra's proxy, trimmed). */
export interface AhHswarmStats {
  /** Lifetime, whatever `days` asked; saved_usd is null when no task was priced. */
  total: { tasks: number; saved_usd: number | null }
  /** Oldest first, back from today: as many as asked, 90 at most. */
  days?: Array<{ day: string; tasks?: number; saved_usd?: number | null }>
}

/** GET /api/hswarm/api/jobs (hswarm/console.py _jobs): job summaries, trimmed to what Desk reads. */
export interface AhHswarmJob {
  job_id: string
  label?: string | null
  state?: string
  tasks?: number
  counts?: Record<string, number>
  /** hswarm/caller.py key(): '<instance> / <8 chars of the session> / <folder>'; a whole stamp (an object) is read too. */
  caller?: string | { session_id?: string; chat_id?: string } | null
  /** The caller's full ids (an empty session_id for a Claude Desktop chat, which has a chat_id like 'local_...'). */
  caller_ids?: { session_id?: string | null; chat_id?: string | null; instance?: string | null } | null
  created?: string | null
  finished?: string | boolean | null
  /** The job's measured tokens and dollars (HSwarm's summary), and its folder, where its results.jsonl is. */
  tokens?: number | null
  cost_usd?: number | null
  dir?: string | null
}
export interface AhHswarmJobs {
  jobs?: AhHswarmJob[]
}

// --- the client ----------------------------------------------------------------------------------

export interface HydraClientOptions {
  url?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface WorkerListQuery {
  /** Keep every active worker and this many recently finished ones; undefined = every worker. */
  limit?: number
  /** Only this dispatch group's workers (a wave's manager is alone in `mgr-<wave>`). */
  group?: string
  /** Only the workers these chat sessions dispatched, through the workers they dispatched; `limit` then counts their
   *  finished ones. An older AgentHydra ignores it and answers the whole list. */
  origin?: string[]
}

/**
 * POST /api/corch/workers for one task. A Desk chat is always `chat: true` (AgentHydra launches it like the
 * owner's own claude: Opus xhigh unless the task names more). `model` / `effort` / `modelWhy` are sent only
 * when the owner explicitly chose one; Desk forces none.
 */
export interface StartWorker {
  prompt: string
  cwd: string
  title: string
  group: string
  model?: string
  effort?: string
  modelWhy?: string
  /** The chat's system-prompt append and connector MCP servers (`chatAddOns`); AgentHydra keeps them for every launch. */
  desk?: { append: string; mcpServers: Record<string, McpServerConfig>; manager?: string; chatId?: string }
  /** This start's own id: the same start sent again answers the worker it made (an older AgentHydra ignores it). */
  requestId?: string
}

/** A model and effort as CliMayte's send takes them. */
export interface WorkerSendSetting {
  model: 'opus' | 'sonnet' | 'haiku'
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export function createClient(opts: HydraClientOptions = {}) {
  const url = (opts.url ?? process.env.HYDRA_URL ?? DEFAULT_HYDRA_URL).replace(/\/+$/, '')
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  const doFetch = opts.fetch ?? fetch

  /** `signal`: the caller's own; once it aborts the call stops and throws an `aborted` BridgeError. */
  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeout = timeoutMs, signal?: AbortSignal): Promise<T> {
    const dropped = () => new BridgeError('aborted', `${method} ${path} was dropped by its caller`)
    let res: Response
    try {
      res = await doFetch(`${url}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      })
    } catch (err) {
      if (signal?.aborted) throw dropped()
      const name = (err as Error)?.name
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new BridgeError('timeout', `AgentHydra did not answer ${method} ${path} within ${timeout} ms`)
      throw new BridgeError('down', `AgentHydra is not answering at ${url} (${(err as Error)?.message ?? err})`)
    }
    let data: unknown
    try {
      data = await res.json()
    } catch {
      if (signal?.aborted) throw dropped()
      throw new BridgeError('bad_json', `AgentHydra answered ${method} ${path} with ${res.status} and no JSON`, res.status)
    }
    if (!res.ok) {
      // A refused delivery answers `detail` (no `error`): its reason is there.
      // A refused CliMayte message answers `message` (climayteSend's own shape).
      const body = data as { error?: unknown; detail?: unknown; message?: unknown }
      const reason = typeof body?.error === 'string' ? body.error : typeof body?.detail === 'string' ? body.detail : body?.message
      throw new BridgeError(
        'http',
        `AgentHydra ${method} ${path} failed (${res.status}): ${typeof reason === 'string' ? reason : 'no reason given'}`,
        res.status,
        typeof reason === 'string' ? reason : undefined,
      )
    }
    return data as T
  }

  const get = <T>(path: string, timeout?: number, signal?: AbortSignal) => request<T>('GET', path, undefined, timeout, signal)
  const post = <T>(path: string, body: unknown) => request<T>('POST', path, body)
  const enc = encodeURIComponent

  return {
    url,
    get,
    post,
    health: () => get<{ ok: boolean; version?: string; pid?: number; runningCode?: { bootCommit?: string | null } }>('/api/health'),
    agentStatus: () => get<AhAgentStatus[]>('/api/agent-status'),
    liveSessions: async () => (await get<{ count: number; sessions: AhLiveSession[] }>('/api/sessions/live')).sessions,
    /** The unarchived chats; `include` adds the archived ones (newest 1000 in all), for a job whose chat was archived since. */
    chats: async (archived: 'hide' | 'include' = 'hide') =>
      (await get<{ rows: AhChatRow[] }>(`/api/chats?limit=1000${archived === 'include' ? '&archived=include' : ''}`)).rows,
    /** The transcript index of the last 24 hours (its default window), newest first. */
    codexChats: async () => (await get<{ rows: AhCodexChatRow[] }>('/api/codex-chats')).rows,
    /** A Desk chat's turn ended: AgentHydra tells the chats that wait on its ticket (`desk-chat:<id>`). */
    completionFinished: (ticket: string, outcome: 'done' | 'failed' | 'cancelled') =>
      post<{ ok: boolean }>('/api/completions/finished', { ticket, outcome }),
    /** Every Codex account (Pin service picks one for a pinned chat's thread). */
    codexInstances: () => get<AhCodexInstance[]>('/api/codex-instances'),
    /** Its cached usage: never a fresh read, which would refresh the login beside an app-server Desk holds. */
    codexUsage: (id: string) => get<AhCodexUsage>(`/api/codex-instances/${enc(id)}/usage`),
    sessions: () => get<AhSessionRow[]>('/api/sessions?limit=200&period=24h'),
    cliInstances: () => get<AhCliInstance[]>('/api/cli-instances'),
    desktopInstances: () => get<AhDesktopInstance[]>('/api/instances'),
    instanceNumbers: () => get<AhInstanceNumber[]>('/api/instance-numbers'),
    workers: (q: WorkerListQuery = {}) => {
      const query = new URLSearchParams()
      if (q.limit !== undefined) query.set('limit', String(q.limit))
      if (q.group) query.set('group', q.group)
      if (q.origin?.length) query.set('origin', q.origin.join(','))
      // `lean`: the rows without the long text no list reads (result, reports, whole attempts); an older AgentHydra ignores it.
      query.set('lean', '1')
      // The bridge contract only, without unused worker configuration/attempt detail. Old daemons ignore it.
      query.set('bridge', '1')
      return get<AhWorker[]>(`/api/corch/workers?${query}`)
    },
    worker: (id: string) => get<AhWorkerDetail>(`/api/corch/workers/${enc(id)}`),
    /** The other PCs' CliMayte queues (read-only: AgentHydra cancels and sends only to this PC's workers). */
    remoteQueues: () => get<AhRemoteQueues>('/api/corch/remote'),
    tail: (sessionId: string, limit = 120, before?: number) =>
      get<AhTail>(`/api/sessions/${enc(sessionId)}/tail?limit=${limit}&thinking=1${before === undefined ? '' : `&before=${before}`}`),
    /** The search behind its search_sessions MCP tool: every store, newest-active first (it has no folder filter). */
    search: (q: string, limit: number, signal?: AbortSignal) =>
      get<AhSearchAnswer>(`/api/sessions/search?q=${enc(q)}&limit=${limit}`, SEARCH_TIMEOUT_MS, signal),
    /** One session's index row, whatever its age (SessionSummary); without `source` AgentHydra picks the newest match. */
    session: (sessionId: string, source?: string, signal?: AbortSignal) =>
      get<AhSessionRow>(`/api/sessions/${enc(sessionId)}${source ? `?source=${enc(source)}` : ''}`, undefined, signal),
    cancelWorker: (id: string) =>
      post<{ cancelled: string[]; keptMessages: Record<string, number> }>('/api/corch/cancel', { id }),
    /** Open (or count a repeat of) an incident and ping the owner: a routine's failed or timed-out run. */
    recordIncident: (body: { scope: string; key: string; message: string }) =>
      post<{ id: string; notified: boolean }>('/api/incidents', body),
    /** Resolve every open incident for one (scope, key): a routine's next ok run. */
    resolveIncidents: (scope: string, key: string) =>
      post<{ resolved: number }>('/api/incidents/resolve-by-key', { scope, key }),
    /** These workers however old (a chat's worker that finished a week ago), in one read. */
    workersByIds: (ids: string[]) => get<AhWorker[]>(`/api/corch/workers?ids=${ids.map(enc).join(',')}&lean=1&bridge=1`),
    /** The workers that ran in these sessions (current or earlier), however old, without reading every worker. */
    workersBySession: (sessionIds: string[]) =>
      get<AhWorker[]>(`/api/corch/workers?session=${sessionIds.map(enc).join(',')}&lean=1&bridge=1`),
    /** Starts one CliMayte worker: CliMayte picks its account and moves it when that account fails. */
    startWorker: (task: StartWorker) =>
      request<{ group: string; workers: AhWorker[] }>('POST', '/api/corch/workers', {
        // A Desk chat run as a worker is the user's own chat: no chat dispatched it, so nothing is traced or pinged.
        origin: null,
        tasks: [{
          prompt: task.prompt,
          cwd: task.cwd,
          title: task.title,
          chat: true,
          ...(task.desk ? { desk: task.desk } : {}),
          ...(task.requestId ? { requestId: task.requestId } : {}),
        }],
        group: task.group,
        ...(task.model ? { model: task.model, modelWhy: task.modelWhy } : {}),
        ...(task.effort ? { effort: task.effort } : {}),
        copies: true,
      }, WORKER_WRITE_TIMEOUT_MS),
    /** `cwd`: the folder the chat moved to; the worker's next launch copies its session there and resumes there.
     *  `urgent`: a running worker is stopped and the same session continues at once with this message first
     *  (`urgent: true` in the answer when it stopped; every AgentHydra with CliMayte has it).
     *  `delivered: 'in-turn'` in the answer: a message to a running worker went into its turn, not held.
     *  `desk`: the chat's add-ons now (`chatAddOns`), which replace what AgentHydra keeps from the next launch on.
     *  `requestId`: this message's own id; sent again, AgentHydra queues it once (an older one ignores it).
     *  `setting`: the model and effort the worker runs on from the launch that takes this message. */
    sendToWorker: (id: string, text: string, cwd?: string, urgent?: boolean, desk?: StartWorker['desk'], requestId?: string, setting?: WorkerSendSetting) =>
      request<{ ok: boolean; message: string; urgent?: boolean; delivered?: 'in-turn' }>('POST', `/api/corch/workers/${enc(id)}/send`, {
        text,
        ...(setting ? { model: setting.model, effort: setting.effort } : {}),
        ...(cwd ? { cwd } : {}),
        ...(desk ? { desk } : {}),
        ...(urgent ? { urgent: true } : {}),
        ...(requestId ? { requestId } : {}),
      }, WORKER_WRITE_TIMEOUT_MS),
    /** Send now on a message the worker holds (`text` names it, else its oldest): its turn stops and the same session continues with it first. */
    deliverNow: (id: string, text?: string) =>
      post<{ ok: boolean; stopped?: boolean; message: string }>(`/api/corch/workers/${enc(id)}/deliver-now`, text ? { text } : {}),
    /** Takes back the held message `text` names (the worker never runs it); `removed` false when it is not held any more. */
    cancelHeld: (id: string, text: string) =>
      post<{ ok: boolean; removed?: boolean; message: string }>(`/api/corch/workers/${enc(id)}/cancel-held`, { text }),
    /** Queues `text` in a working Claude Desktop chat's own input queue (peer channel only: never typed into its window); it runs when the current turn ends. */
    // AgentHydra answers once the chat's transcript shows the message, which takes seconds and may take its 45 s
    // confirm window: the 4 s every other call gets gave up on deliveries that went through.
    // `holdSecs`: how long the note stays worth sending if its chat is busy. A caller that sends on a clock
    // passes its own cadence (Desk's orchestrator peeks each running chat every 10 min, foreman.ts PEEK_MS);
    // unset, a held note waits up to the 24 h expiry, as a person's note does.
    sendToDesktopChat: (sessionId: string, text: string, holdSecs?: number) =>
      request<{ ok: boolean; route?: string; delivered?: boolean; confirmed?: boolean; held?: boolean; detail?: string }>('POST', `/api/sessions/${enc(sessionId)}/message`, { text, peer_only: true, ...(holdSecs ? { hold_secs: holdSecs } : {}) }, DELIVERY_TIMEOUT_MS),
    /** Claude Desktop's own Stop for a working chat (the daemon's native stop); answers { ok, verified } or a BridgeError. */
    stopDesktopChat: (sessionId: string) =>
      request<{ ok: boolean; verified?: boolean; route?: string }>('POST', `/api/sessions/${enc(sessionId)}/stop`, {}, DELIVERY_TIMEOUT_MS),
    /** A working Claude Desktop chat's model and effort, set in the app as its pickers set them (the daemon's native
     *  setting); answers { ok, verified, model, effort } with what the app kept, or a BridgeError. */
    setDesktopChatSetting: (sessionId: string, setting: { model?: string; effort?: string }) =>
      request<{ ok: boolean; verified?: boolean; model?: string | null; effort?: string | null }>('POST', `/api/sessions/${enc(sessionId)}/setting`, setting, DELIVERY_TIMEOUT_MS),
    /** A new Claude Code session holding this one up to the reply `uuid`, titled "<title> (branch)"; the original is not touched. */
    branchSession: (sessionId: string, uuid: string, title: string) =>
      post<{ session_id: string; source: string }>(`/api/sessions/${enc(sessionId)}/branch`, { uuid, title }),
    /** AgentHydra's spend report over `period` (all, 30d, 7d): sessions, turns, tokens and dollars per source, model and day. */
    spend: (period: string) => get<AhSpendReport>(`/api/analytics/spend?period=${enc(period)}`, STATS_TIMEOUT_MS),
    activity: (period: string) => get<AhActivityReport>(`/api/analytics/activity?period=${enc(period)}`, STATS_TIMEOUT_MS),
    /** CliMayte's totals; `since` (epoch ms) scopes them to the tasks since then, else every task on record. */
    corchTotals: (since?: number) =>
      get<AhCorchTotals>(`/api/corch/totals${since === undefined ? '' : `?since=${enc(new Date(since).toISOString())}`}`, STATS_TIMEOUT_MS),
    /* HSwarm's own stats over the last `days` days; its proxy errors while HSwarm is down. */
    /** HSwarm's job list (verbose: each summary with `created`, `finished` and its caller key), newest first. */
    /** `callers` (session or chat ids): only the jobs they started, from HSwarm's newest few hundred; an older HSwarm
     *  ignores it and answers the newest jobs. */
    hswarmJobs: (limit: number, callers: string[] = []) =>
      get<AhHswarmJobs>(`/api/hswarm/api/jobs?limit=${limit}${callers.length ? `&session=${callers.map(enc).join(',')}` : ''}`, STATS_TIMEOUT_MS),
    hswarmStats: (days: number) => get<AhHswarmStats>(`/api/hswarm/api/stats?days=${days}`, STATS_TIMEOUT_MS),
  }
}

export type HydraClient = ReturnType<typeof createClient>
