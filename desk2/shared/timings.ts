// Speed tracking (SPEC "Speed (timings)"): <home>/timings.jsonl, GET /api/diagnostics/timings,
// POST /api/diagnostics/timings/client. Types only; shared by server/ and web/.

/** Every stage a span can name. SPEC lists what each measures and from which clock. */
export const TIMING_STAGES = [
  // The window's own clock (POST /api/diagnostics/timings/client)
  'click_to_server',
  'click_to_bubble',
  'open_to_paint',
  // An SDK chat's process
  'process_start',
  'session_start_hooks',
  'hook',
  'mcp_connect',
  'ready',
  // An SDK chat's turn
  'queue_wait',
  'first_token',
  'tool',
  'api',
  'turn',
  // A CliMayte (worker) chat
  'worker_accept',
  'worker_queue',
  'worker_first_item',
  'worker_turn',
  'account_move',
  'sync_poll',
  // The server
  'chat_open',
  'title',
  'warm',
  // The event loop was blocked this long (engine/loop-stall.ts)
  'loop_stall',
  // A synchronous call held the thread (engine/sync-block.ts): its label in `name`
  'sync_block',
] as const

export type TimingStage = (typeof TIMING_STAGES)[number]

/** The stages the window may report. */
export const CLIENT_STAGES: readonly TimingStage[] = ['click_to_server', 'click_to_bubble', 'open_to_paint']

/** How the process stood when a turn was sent: started for it ('new', or 'resume' of a session), started ahead by the warm start, or already running (null). */
export type ColdKind = 'new' | 'resume' | 'warm' | null

/** One line of timings.jsonl. Never an email: accounts are an id and a number. */
export interface TimingSpan {
  /** When the stage ended, epoch ms. */
  ts: number
  stage: TimingStage
  ms: number
  chatId?: string
  /** The turn the stage belongs to (the `turn` line carries the same id). */
  turnId?: string
  /** What the stage is about: a hook ('SessionStart:branch-guard.mjs'), a tool, an MCP server, an account move ('#126>#61'). */
  name?: string
  kind?: 'sdk' | 'worker'
  accountId?: string
  accountNumber?: number | null
  model?: string | null
  cwd?: string
  cold?: ColdKind
  ok?: boolean
  /** A `sync_block` line: the call that held the thread, as `server/src/engine/queue.ts:662`. */
  caller?: string
  /** A `loop_stall` line: the process's CPU ms over the same interval (user + system, all threads). */
  cpu?: number
  /** A `turn` line: ms per stage inside it (hooks and tools summed). */
  stages?: Record<string, number>
  /** A `sync_poll` line: how many polls the minute held, and the slowest. A `chat_open` line: `n` is the items served. */
  n?: number
  max?: number
}

export interface StageStats {
  stage: TimingStage
  /** Set when the row is one name of a stage (one hook, one tool, one MCP server). */
  name?: string
  count: number
  p50: number
  p90: number
  max: number
  totalMs: number
}

export interface TurnRow {
  ts: number
  chatId: string
  turnId: string
  ms: number
  kind: 'sdk' | 'worker'
  cold: ColdKind
  accountId: string | null
  accountNumber: number | null
  model: string | null
  cwd: string | null
  ok: boolean
  stages: Record<string, number>
}

export interface GroupStats {
  key: string
  turns: number
  p50: number
  p90: number
  max: number
  totalMs: number
}

export interface TimingsResponse {
  /** Per stage, slowest total first. */
  today: StageStats[]
  week: StageStats[]
  /** The slowest turns of the 7 days, each with its stage breakdown. */
  slowestTurns: TurnRow[]
  /** What a cold start is made of, 7 days: process start, each SessionStart hook, each MCP server. */
  coldStart: StageStats[]
  /** Send -> ready (system/init) by how the process stood: 'new', 'resume', 'warm'. */
  ready: GroupStats[]
  /** Every hook and every tool by name, 7 days. */
  hooks: StageStats[]
  tools: StageStats[]
  /** The worker chats' waits, 7 days: accept, queue, first item, account moves. */
  workers: StageStats[]
  /** Today's waiting, ranked by total time lost. */
  slowNow: StageStats[]
  /** Turns of the 7 days by account ('#126' or id), model and folder. */
  byAccount: GroupStats[]
  byModel: GroupStats[]
  byFolder: GroupStats[]
  /** Lines read (7 days). */
  spans: number
}

/** POST /api/diagnostics/timings/client */
export interface ClientTimingReport {
  stage: TimingStage
  ms: number
  chatId?: string
}
