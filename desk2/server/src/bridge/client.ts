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
  origin?: { kind: 'chat'; sessionId: string } | { kind: 'worker'; workerId: string }
}

/** GET /api/corch/workers/:id: the view plus its last 60 event lines (summarizeEvent). */
export type AhWorkerDetail = AhWorker & { events: string[] }

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

// --- the client ----------------------------------------------------------------------------------

export interface HydraClientOptions {
  url?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface WorkerListQuery {
  /** Keep every active worker and this many recently finished ones; undefined = every worker. */
  limit?: number
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
      const reason = (data as { error?: unknown })?.error
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
    workers: (q: WorkerListQuery = {}) =>
      get<AhWorker[]>(`/api/corch/workers${q.limit === undefined ? '' : `?limit=${q.limit}`}`),
    worker: (id: string) => get<AhWorkerDetail>(`/api/corch/workers/${enc(id)}`),
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
  }
}

export type HydraClient = ReturnType<typeof createClient>
