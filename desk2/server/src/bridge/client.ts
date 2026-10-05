// A typed client of the AgentHydra daemon (SPEC.md "The bridge"). Read-only GETs plus the two CliMayte
// writes Hydra Desk needs (cancel, send, place a chat, report an account failure). The Ah* types mirror AgentHydra's own response shapes
// (../server/src/types.ts, climayte-lib.ts, live-registry.ts), trimmed to the fields the bridge reads;
// recorded samples live in server/test/fixtures/agenthydra-*.json.

export const DEFAULT_HYDRA_URL = 'http://127.0.0.1:7787'
export const REQUEST_TIMEOUT_MS = 4000
/** A transcript search may scan for up to 7 s before AgentHydra's index is built (session-search.ts budget). */
export const SEARCH_TIMEOUT_MS = 10_000

/** Why a call failed: `down` (nothing answered), `timeout`, `http` (an error status), `bad_json`, `aborted` (its caller gave up). */
export type BridgeErrorKind = 'down' | 'timeout' | 'http' | 'bad_json' | 'aborted'

export class BridgeError extends Error {
  constructor(
    readonly kind: BridgeErrorKind,
    message: string,
    readonly status: number | null = null,
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
  cwd: string | null
  effort?: string | null
  live: boolean
  livePid?: number | null
}

/** GET /api/sessions: the transcript index (SessionSummary), trimmed. */
export interface AhSessionRow {
  session_id: string
  source: string // claude, codex, opencode, hermes, dsh, zswarm, foreign
  title: string
  cwd: string
  last_activity_at: number
  last_role: 'user' | 'assistant' | null
  instance: string | null
  instance_num: number | null
  /** The other PC's name on a Desktop chat the chat sync took from it; absent on this PC's rows. */
  from_pc?: string
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
  result: string | null
  error: string | null
  lastActivity: string | null
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
  /** Its current message's own estimate (climayte-eta.ts); `tookS`/`doneAt` once that message ended done.
   *  Absent before 2026-10-05 and when it gave none. */
  eta?: { minutes: number; at: number; attempt: number; tookS?: number; doneAt?: number }
}

/** GET /api/corch/workers/:id: the view plus its last 60 event lines (summarizeEvent). */
export type AhWorkerDetail = AhWorker & { events: string[] }

/**
 * One worker of another PC's shared queue (climayte-queue-sync.ts reduce()). It deliberately carries no
 * prompt or folder; `account.name` is often the login's email and is never shown. Its session, origin
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
}

/** GET /api/corch/remote: the other PCs' queues, as the last poll of the shared store found them. */
export interface AhRemoteQueues {
  /** Queue sharing is off on this PC: `pcs` is then empty. */
  enabled: boolean
  pcs: { pc: string; name: string; at: number; stale: boolean; workers: AhRemoteWorker[] }[]
}

export interface AhTailEvent {
  role: 'user' | 'assistant'
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text: string
  tool_name: string | null
  timestamp: string | null
}

/** GET /api/sessions/:id/tail (TailResult). `error` is set when the transcript was not found. */
export interface AhTail {
  session_id: string
  source: string
  title: string
  cwd: string
  events: AhTailEvent[]
  has_more?: boolean
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
      const body = data as { error?: unknown; detail?: unknown }
      const reason = typeof body?.error === 'string' ? body.error : body?.detail
      throw new BridgeError(
        'http',
        `AgentHydra ${method} ${path} failed (${res.status}): ${typeof reason === 'string' ? reason : 'no reason given'}`,
        res.status,
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
    health: () => get<{ ok: boolean; version?: string }>('/api/health'),
    agentStatus: () => get<AhAgentStatus[]>('/api/agent-status'),
    liveSessions: async () => (await get<{ count: number; sessions: AhLiveSession[] }>('/api/sessions/live')).sessions,
    chats: async () => (await get<{ rows: AhChatRow[] }>('/api/chats?limit=1000')).rows,
    /** The transcript index of the last 24 hours (its default window), newest first. */
    sessions: () => get<AhSessionRow[]>('/api/sessions?limit=200&period=24h'),
    cliInstances: () => get<AhCliInstance[]>('/api/cli-instances'),
    desktopInstances: () => get<AhDesktopInstance[]>('/api/instances'),
    instanceNumbers: () => get<AhInstanceNumber[]>('/api/instance-numbers'),
    workers: (q: WorkerListQuery = {}) => {
      const query = new URLSearchParams()
      if (q.limit !== undefined) query.set('limit', String(q.limit))
      if (q.group) query.set('group', q.group)
      return get<AhWorker[]>(`/api/corch/workers${query.size ? `?${query}` : ''}`)
    },
    worker: (id: string) => get<AhWorkerDetail>(`/api/corch/workers/${enc(id)}`),
    /** The other PCs' CliMayte queues (read-only: AgentHydra cancels and sends only to this PC's workers). */
    remoteQueues: () => get<AhRemoteQueues>('/api/corch/remote'),
    tail: (sessionId: string, limit = 120) =>
      get<AhTail>(`/api/sessions/${enc(sessionId)}/tail?limit=${limit}&thinking=1`),
    /** The search behind its search_sessions MCP tool: every store, newest-active first (it has no folder filter). */
    search: (q: string, limit: number, signal?: AbortSignal) =>
      get<AhSearchAnswer>(`/api/sessions/search?q=${enc(q)}&limit=${limit}`, SEARCH_TIMEOUT_MS, signal),
    /** One session's index row, whatever its age (SessionSummary); without `source` AgentHydra picks the newest match. */
    session: (sessionId: string, source?: string, signal?: AbortSignal) =>
      get<AhSessionRow>(`/api/sessions/${enc(sessionId)}${source ? `?source=${enc(source)}` : ''}`, undefined, signal),
    cancelWorker: (id: string) =>
      post<{ cancelled: string[]; keptMessages: Record<string, number> }>('/api/corch/cancel', { id }),
    /** These workers however old (a chat's worker that finished a week ago), in one read. */
    workersByIds: (ids: string[]) => get<AhWorker[]>(`/api/corch/workers?ids=${ids.map(enc).join(',')}`),
    /** Starts one CliMayte worker: CliMayte picks its account and moves it when that account fails. */
    startWorker: (task: StartWorker) =>
      post<{ group: string; workers: AhWorker[] }>('/api/corch/workers', {
        tasks: [{ prompt: task.prompt, cwd: task.cwd, title: task.title, chat: true }],
        group: task.group,
        ...(task.model ? { model: task.model, modelWhy: task.modelWhy } : {}),
        ...(task.effort ? { effort: task.effort } : {}),
        copies: true,
      }),
    /** `cwd`: the folder the chat moved to; the worker's next launch copies its session there and resumes there. */
    sendToWorker: (id: string, text: string, cwd?: string) =>
      post<{ ok: boolean; message: string }>(`/api/corch/workers/${enc(id)}/send`, cwd ? { text, cwd } : { text }),
    /** Send now on a message the worker holds (`text` names it, else its oldest): its turn stops and the same session continues with it first. */
    deliverNow: (id: string, text?: string) =>
      post<{ ok: boolean; stopped?: boolean; message: string }>(`/api/corch/workers/${enc(id)}/deliver-now`, text ? { text } : {}),
    /** Queues `text` in a working Claude Desktop chat's own input queue (peer channel only: never typed into its window); it runs when the current turn ends. */
    sendToDesktopChat: (sessionId: string, text: string) =>
      post<{ ok: boolean; route?: string; delivered?: boolean; detail?: string }>(`/api/sessions/${enc(sessionId)}/message`, { text, peer_only: true }),
    /** AgentHydra's spend report over `period` (all, 30d, 7d): sessions, turns, tokens and dollars per source, model and day. */
    spend: (period: string) => get<AhSpendReport>(`/api/analytics/spend?period=${enc(period)}`, STATS_TIMEOUT_MS),
    activity: (period: string) => get<AhActivityReport>(`/api/analytics/activity?period=${enc(period)}`, STATS_TIMEOUT_MS),
    /** CliMayte's totals; `since` (epoch ms) scopes them to the tasks since then, else every task on record. */
    corchTotals: (since?: number) =>
      get<AhCorchTotals>(`/api/corch/totals${since === undefined ? '' : `?since=${enc(new Date(since).toISOString())}`}`, STATS_TIMEOUT_MS),
    /** HSwarm's own stats over the last `days` days; its proxy errors while HSwarm is down. */
    hswarmStats: (days: number) => get<AhHswarmStats>(`/api/hswarm/api/stats?days=${days}`, STATS_TIMEOUT_MS),
  }
}

export type HydraClient = ReturnType<typeof createClient>
