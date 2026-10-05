// Hydra Desk protocol: the one contract between the server (server/) and the window (web/).
// Both sides import this file. Change it only together with SPEC.md, and update both sides in the
// same commit. Plain types only: no runtime code, no imports.

// Chats run by Hydra Desk itself (one Claude Agent SDK session each)

/** What a chat is doing right now. This is the whole point of the app: it must always be true. */
export type ChatStatus =
  | 'starting' // the runtime is spawning, before the SDK's system/init arrives
  | 'working' // a turn is running
  | 'needs_you' // waiting on a permission, a question or a plan approval
  | 'idle' // the last turn finished; ready for the next message
  | 'stopped' // the user interrupted the last turn
  | 'error' // the last turn failed; see ChatSummary.lastError
  | 'limited' // the account hit a usage limit; see ChatSummary.limitResetsAt
  | 'closed' // no live runtime (app restarted, or closed after idling); sending a message resumes it

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Which Claude login a chat runs under. configDir null = the machine's default ~/.claude login. */
export interface AccountRef {
  id: string // 'default' or the AgentHydra CLI instance id
  label: string // e.g. '#68 eek (Max 20x)'
  configDir: string | null
  number?: number // AgentHydra's permanent instance number
}

export interface ChatSummary {
  id: string // Hydra Desk chat id (uuid), stable for the chat's life
  sessionId: string | null // the Claude Code session id, known once system/init arrives
  title: string
  cwd: string
  account: AccountRef
  /** The account was placed by 'auto' (not named): a usage limit moves the chat to another account. */
  accountAuto: boolean
  model: string | null // null = the account's default model
  effort: Effort | null
  permissionMode: PermissionMode
  delegateToCliMayte: boolean // sub-agents go to CliMayte (Agent/Task tools disallowed)
  status: ChatStatus
  /** While working: what it is doing, short ("Thinking", "Writing", "Bash: bun test", "Edit: src/a.ts"). */
  activity: string | null
  turnStartedAt: number | null // epoch ms the running turn started; null when not working
  lastError: string | null
  limitResetsAt: number | null // epoch ms, when status is 'limited' and the reset is known
  unread: boolean // finished or needs you since the user last looked at it
  pinned: boolean
  archived: boolean
  group: string | null // the sidebar group it was moved to; null = its project folder's group
  forkedFrom: string | null // the session it was forked from: until it has its own, its next message resumes a fork of that one
  createdAt: number
  updatedAt: number // last activity of any kind
  costUsd: number // running total reported by the SDK's result messages
  contextPct: number | null // 0..100, share of the context window used after the last turn
  pendingCount: number // open permission / question / plan requests
  queuedCount: number // user messages sent while a turn was running, not yet taken up
  climayteActive: number // CliMayte workers this chat dispatched that are still queued/running/waiting
  /** The chat's own background tasks still running (commands, sub-agents, workflows), less the long-lived
   *  ones (dev servers, watchers: server/src/engine/long-lived.ts). Absent = none. */
  backgroundActive?: number
  /** Every CliMayte worker ever matched to this chat (running and finished), kept so finished ones stay listed under it. */
  workerIds?: string[]
  /** The CliMayte worker this chat runs as; absent = an SDK chat run in this process; null = not started yet. */
  workerId?: string | null
}

// Transcript items: the normalized form of the SDK's message stream (and of AgentHydra transcripts)

export interface ImageRef {
  mediaType: string // image/png, image/jpeg, image/gif, image/webp
  dataBase64?: string // present when the client sent it and for small images; omitted in history
  name?: string
  /** Where the window loads the picture from when dataBase64 is absent: a server route of this chat. */
  url?: string
  bytes?: number // file size, for the file card ("PNG, live.png, 67.2KB")
}

export interface ToolResult {
  text: string // the result as text (images described as "[image]"), cut to MAX_TOOL_RESULT_CHARS
  isError: boolean
  truncated?: boolean
  images?: ImageRef[] // pictures the tool returned (a Read of a PNG), shown under its row
}

export interface AskQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description?: string }[]
}

export type ElicitationValue = string | number | boolean | string[]

/** One input of an MCP elicitation form, flattened from the server's requested JSON schema. */
export interface ElicitationField {
  name: string
  label: string
  description?: string
  type: 'text' | 'number' | 'boolean' | 'choice' | 'multichoice'
  required: boolean
  options?: { value: string; label: string }[] // choice, multichoice
  /** choice: the schema's values are numbers, and the answer goes back as a number. */
  numeric?: boolean
  /** The schema's limits, which the answer must keep: number (integer, min, max) and text (minLength, maxLength). */
  integer?: boolean
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  default?: ElicitationValue
}

export interface TodoEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

interface ItemBase {
  id: string // stable: an upsert with the same id replaces the item
  ts: number // epoch ms
  /** Set when the item belongs to a sub-agent (the Agent/Task tool call it runs under). */
  parentToolUseId?: string | null
}

export type TranscriptItem =
  | (ItemBase & { kind: 'user'; text: string; images?: ImageRef[]; queued?: boolean })
  | (ItemBase & { kind: 'assistant_text'; text: string; streaming?: boolean })
  | (ItemBase & { kind: 'thinking'; text: string; streaming?: boolean })
  | (ItemBase & {
      kind: 'tool_use'
      /** The item id is the tool_use id. */
      name: string // Bash, Read, Edit, Write, Grep, Glob, WebFetch, TodoWrite, Agent, mcp__server__tool, ...
      input: Record<string, unknown>
      status: 'running' | 'done' | 'error' | 'denied'
      result?: ToolResult
      progress?: string // latest tool progress line, while running
      startedAt: number
      endedAt?: number
    })
  | (ItemBase & {
      kind: 'permission'
      /** The item id is the request id the server made for this canUseTool call. */
      toolName: string
      toolUseId?: string
      input: Record<string, unknown>
      blockedPath?: string
      canAlwaysAllow: boolean // the SDK offered permission suggestions (and did not forbid saving a rule)
      /** The sentence the SDK gives for the prompt ("Claude wants to run git push"); the card falls back to "Allow <tool>?". */
      title?: string
      description?: string
      /** Why it asks (a safety check, an `ask` rule, a hook), when the SDK says. */
      reason?: string
      /** The SDK starts this one on No: Enter must not allow it. */
      defaultToNo?: boolean
      /** What "Always allow" would save, one line each: the rule and where it is kept ("Bash(git status:*) in this project"). */
      alwaysRules?: string[]
      state: 'pending' | 'allowed' | 'session' | 'always' | 'denied' | 'expired'
    })
  | (ItemBase & {
      kind: 'elicitation' // an MCP server asks the user for something (a form, or a link to open)
      /** The item id is the request id the server made for this onElicitation call. */
      serverName: string
      message: string
      /** The header and subtitle an MCP server gives an elicitation-driven permission prompt, when it gives them. */
      title?: string
      description?: string
      mode: 'form' | 'url'
      url?: string // mode 'url': the page to open
      fields?: ElicitationField[] // mode 'form'
      state: 'pending' | 'accepted' | 'declined' | 'expired'
      values?: Record<string, ElicitationValue> // what was sent back
    })
  | (ItemBase & {
      kind: 'question' // the AskUserQuestion tool
      toolUseId?: string
      questions: AskQuestion[]
      state: 'pending' | 'answered' | 'skipped' | 'expired'
      answers?: Record<string, string> // question text -> answer (multi-select comma-separated)
    })
  | (ItemBase & {
      kind: 'plan' // the ExitPlanMode tool
      toolUseId?: string
      plan: string // markdown
      state: 'pending' | 'approved' | 'rejected' | 'expired'
    })
  | (ItemBase & { kind: 'todos'; todos: TodoEntry[] }) // id 'todos': one live checklist per chat
  | (ItemBase & {
      kind: 'task' // a background sub-agent / task the SDK reports (task_started/updated/notification)
      taskId: string
      description: string
      status: 'running' | 'completed' | 'failed' | 'stopped'
      summary?: string
      /** What the task is, for its row and card: a workflow, a background command, a sub-agent. */
      taskKind?: 'workflow' | 'bash' | 'agent' | 'other'
      toolUseId?: string
      command?: string // bash: the command it runs, so a long-lived one (a dev server) is told apart
      agents?: number // workflow: how many agents it ran
      tokens?: number
      durationMs?: number
      outputFile?: string
    })
  | (ItemBase & { kind: 'system'; level: 'info' | 'warn' | 'error'; text: string })
  | (ItemBase & {
      kind: 'result' // end of a turn
      ok: boolean
      durationMs: number
      costUsd: number
      turns: number
      error?: string
    })

export const MAX_TOOL_RESULT_CHARS = 20_000

// Things Hydra Desk watches through AgentHydra (the daemon on 127.0.0.1:7787)

/** A Claude Code session NOT run by Hydra Desk: a Claude Desktop chat, a terminal CLI, a CliMayte worker, Codex. */
export interface ExternalSession {
  id: string // the session id AgentHydra knows it by
  title: string
  cwd: string | null
  source: 'desktop' | 'cli' | 'climayte' | 'codex' | 'other'
  instance: string | null // which desktop/CLI instance (label or number) it runs under
  status: 'working' | 'needs_you' | 'idle' | 'stale' // stale = no activity for a long time
  activity: string | null
  lastActivityAt: number | null
  model: string | null
  /** The signed-in CLI instance whose folder already holds this session: it continues there in place. null: it continues as a copy under the account the window lands it on. */
  accountId: string | null
  /** Idle in someone else's window and a Claude Code session: the composer can carry it on. */
  canResume: boolean
  /** The other PC's name for a Desktop chat AgentHydra's chat sync took from it (AgentHydra's `from_pc`); null for this PC's. */
  fromPc: string | null
  // Hydra Desk's own marks (its session-meta overlay; the session's files are never touched). The title above is the overlay's when renamed.
  pinned: boolean
  archived: boolean
  unread: boolean
  group: string | null
}

/** POST /api/external/sessions/:id/message: text for a Claude Desktop chat that is working; AgentHydra queues it in the chat. Errors answer { error } with the daemon's reason. */
export interface DesktopMessageRequest {
  text: string
}
export interface DesktopMessageResult {
  ok: true
  /** How it got there ('peer': the chat's own input queue over the native peer channel). */
  route: string
  delivered: true
  detail: string
}

/** The overlay Hydra Desk keeps on an outside session (PATCH /api/external/sessions/:id/meta answers it). */
export interface SessionMeta {
  title: string | null // null = the session's own title
  pinned: boolean
  archived: boolean
  unread: boolean
  group: string | null
}

export type SessionMetaPatch = Partial<SessionMeta>

/** One session AgentHydra's transcript search found (GET /api/search). */
export interface SearchHit {
  sessionId: string
  title: string
  cwd: string | null
  /** The matching line, at most ~160 characters around the match; the window emphasises the query's words. */
  snippet: string
  source: ExternalSession['source']
  lastActivityAt: number | null
  /** How many times the transcript matched. */
  score?: number
}

// Hydra Desk 2: the cloud list (the chrome bar's cloud button). AgentHydra's whole session list, the
// way its Sessions tab shows it: every source and instance, both PCs' chats included. A Desktop chat
// the chat sync took from another PC carries that PC's name in `fromPc`; every other row is this PC's.

/** One row of the cloud list (GET /api/cloud/sessions), mapped from AgentHydra's GET /api/sessions. */
export interface CloudSession {
  id: string // the session id
  title: string
  /** The folder the session started in, where Claude Desktop and the desk list show it (server bridge/cloud.ts startFolder). */
  cwd: string | null
  /** The folder it last worked in when that is not `cwd` (it moved into a subfolder); null when it never left. */
  lastCwd: string | null
  source: string // AgentHydra's: claude, codex, opencode, hermes, dsh, zswarm, foreign
  instance: string | null // the desktop or CLI instance folder it ran under; null = the default login
  lastActivityAt: number
  createdAt: number | null
  messageCount: number
  dispatched: boolean // queued by AgentHydra rather than driven by hand
  archived: boolean
  fromPc: string | null
  model: string | null
  effort: string | null
  instanceNum: number | null // AgentHydra's instance number, the #37 its rows show
}

export interface CloudList {
  /** This PC's name, for the rows without `fromPc`. */
  thisPc: string
  sessions: CloudSession[]
}

/** A desktop instance the Instance filter offers (GET /api/cloud/instances). */
export interface CloudInstance {
  name: string // the folder name the session list filters by
  label: string
}

export interface CliMayteWorker {
  id: string
  title: string
  description?: string | null // the first line of its task, for the Background tasks card
  group: string | null
  status: string // AgentHydra's own: queued, running, waiting, checking, done, failed, cancelled, ...
  active: boolean // queued, running, waiting or checking
  account: string | null // '#68' style label
  model: string | null
  effort: string | null
  kind: string | null
  cwd: string | null
  sessionId: string | null // the worker's current Claude Code session, for its live transcript
  originSessionId: string | null // the session id of the chat that dispatched it, when known
  originWorkerId?: string | null // the worker that dispatched it, when a worker did
  sessions?: string[] // every session the worker has had (a handoff gives it a new sessionId and keeps the old ones here)
  startedAt: number | null
  endedAt: number | null // when it settled; null while active
  lastActivityAt: number | null
  lastActivity: string | null // its latest event line, short
  usedPct: number | null // % of a Pro 5-hour window it has used
  tokens: number | null // tokens it has spent, when AgentHydra or its transcript says
  verdict: string | null
  error: string | null
  /**
   * The other PC's name when the worker runs there (AgentHydra's shared queue, GET /api/corch/remote);
   * absent or null = this PC. Such a worker has no folder, and its session and origin are only ids that
   * PC shared (a snapshot from an older AgentHydra has neither); its id may equal one of this PC's, and
   * nothing here can cancel it or send to it: the window keeps it apart from this PC's workers.
   */
  pc?: string | null
}

export interface AccountInfo extends AccountRef {
  email: string | null
  plan: string | null // 'Pro', 'Max 5x', 'Max 20x', ...
  signedIn: boolean
  fiveHourPct: number | null
  weeklyPct: number | null
  fiveHourResetsAt: number | null
  weeklyResetsAt: number | null
  inUse: boolean // a person or another session is using it now (AgentHydra's reading)
}

// Git (the bar above the composer, and the diff pane)

export interface GitFileChange {
  path: string
  status: string // M, A, D, R, ?? (porcelain)
  added: number
  removed: number
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  added: number // total lines added in the working tree vs HEAD (untracked files counted)
  removed: number
  files: GitFileChange[]
}

// Settings

export interface DeskSettings {
  defaultModel: string | null
  defaultEffort: Effort | null
  defaultPermissionMode: PermissionMode
  defaultAccountId: string // 'auto' or an AccountRef id
  delegateToCliMayte: boolean
  idleCloseMinutes: number // close a live runtime after this long idle (its chat goes 'closed')
  notifications: boolean
}

// REST request bodies (see SPEC.md "REST API" for the routes)

export interface CreateChatRequest {
  cwd: string
  prompt?: string // sent as the first message when present
  images?: ImageRef[]
  title?: string
  accountId?: string // 'auto' (default) or an AccountRef id
  model?: string | null
  effort?: Effort | null
  permissionMode?: PermissionMode
  delegateToCliMayte?: boolean
}

export interface SendMessageRequest {
  text: string
  images?: ImageRef[]
}

export interface PermissionDecision {
  decision: 'allow' | 'session' | 'always' | 'deny' // session = allow, and stop asking for the rest of this session only
  message?: string // deny reason shown to the model
}

export interface ElicitationAnswer {
  action: 'accept' | 'decline'
  values?: Record<string, ElicitationValue> // action 'accept' on a form
}

export interface QuestionAnswer {
  answers?: Record<string, string>
  /** Pictures pasted into a question's "Other" box (dataBase64), by question text. The server saves each and adds `[Image: source: <path>]` to that answer. */
  images?: Record<string, ImageRef[]>
  skip?: boolean
}

export interface PlanDecision {
  approve: boolean
  feedback?: string // when rejecting: what to change
  mode?: PermissionMode // when approving: the mode to continue in (default: the mode the chat was in before it entered plan mode, else acceptEdits)
}

export interface ChatPatch {
  title?: string
  pinned?: boolean
  archived?: boolean
  unread?: boolean
  model?: string | null
  effort?: Effort | null
  permissionMode?: PermissionMode
  delegateToCliMayte?: boolean
  accountId?: string // takes effect at the next runtime start
  group?: string | null // 1-60 chars after trimming; null = back to its folder's group
  cwd?: string // put the chat in another folder (an existing local directory); its next turn resumes there
}

export interface ImportSessionRequest {
  sessionId: string
  cwd?: string
  configDir?: string | null
  title?: string
  fork?: boolean // a new chat that forks the session at its first message; the original stays listed
}

export interface SlashCommandInfo {
  name: string // without the leading slash
  description: string
  argumentHint?: string
}

export interface ModelChoice {
  value: string // what is passed to the SDK, e.g. 'claude-opus-5-5' or an alias
  label: string // 'Opus 5.5'
}

/** An MCP server a chat in `cwd` loads (GET /api/mcp-servers): name, scope and transport only, never its config. */
export interface McpServerInfo {
  name: string
  scope: 'user' | 'project' | 'local' | 'hydra-desk' // local = added with `claude mcp add` for this folder (the account's .claude.json)
  transport: 'stdio' | 'http' | 'sse'
}

/** A live chat's MCP servers as its SDK session reports them (GET /api/chats/:id/mcp). */
export interface McpStatus {
  live: boolean
  servers: { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' }[]
}

// The managed send queue (SPEC "Send queue"): messages and new chats the server holds until they can go out.
// Not the SDK's own queue (a message pushed while a turn runs cannot be edited); these are held server-side.

/** waiting = will go out by itself; held = the owner must release it (see reason); sending = being handed over now; failed = see reason. */
export type QueueItemState = 'waiting' | 'held' | 'sending' | 'failed'

interface QueueItemBase {
  id: string
  /** Bumped by every change; an edit or reorder that names an older one is refused (two windows). */
  rev: number
  createdAt: number
  updatedAt: number
  state: QueueItemState
  /** What a waiting item waits for, or why a held or failed one is not going out: one short sentence. */
  reason: string | null
  text: string
  images?: ImageRef[] // url form only: the server keeps the pictures in its media cache
}

export type QueueItem =
  | (QueueItemBase & { kind: 'message'; chatId: string })
  | (QueueItemBase & {
      kind: 'chat' // a new chat, started once an account has room
      cwd: string
      title?: string
      accountId?: string
      model?: string | null
      effort?: Effort | null
      permissionMode?: PermissionMode
      delegateToCliMayte?: boolean
      /** Set once the chat exists (a failed first send leaves the item 'failed' with the chat to open). */
      startedChatId: string | null
    })

export type QueueSendMode = 'immediate' | 'queue'

export interface QueueState {
  items: QueueItem[] // in send order
  paused: boolean // nothing goes out while paused
  /** What a plain Enter does while a chat is working and on the new-session screen: 'immediate' hands the message to the running turn (a new chat starts at once), 'queue' holds it here (a new chat waits for an account with room). Ctrl+Enter queues while a turn runs, and always on the new-session screen. */
  sendMode: QueueSendMode
  /** How many chats started from the queue may run at once; the next one waits for a free slot and an account with room. */
  maxNewChats: number
  /** Chats whose queued messages are held, and why: the owner stopped the turn, it failed, or the server restarted under it. */
  held: Record<string, 'stopped' | 'error' | 'restart'>
  rev: number
}

export type QueueAddRequest =
  | { kind: 'message'; chatId: string; text: string; images?: ImageRef[] }
  | ({ kind: 'chat' } & CreateChatRequest)

export interface QueuePatch {
  text?: string
  images?: ImageRef[]
  ifRev?: number
}

export interface QueueSettingsPatch {
  paused?: boolean
  sendMode?: QueueSendMode
  maxNewChats?: number
}

/** The whole desired order, every id once; ifRev (the queue's rev) guards a stale window. */
export interface QueueReorder {
  ids: string[]
  ifRev?: number
}

// WebSocket (/ws): the server pushes; the client only pings

export type ServerEvent =
  | { type: 'hello'; version: string; chats: ChatSummary[]; settings: DeskSettings; queue?: QueueState }
  | { type: 'queue.update'; queue: QueueState }
  | { type: 'chat.upsert'; chat: ChatSummary }
  | { type: 'chat.removed'; chatId: string }
  | { type: 'item.upsert'; chatId: string; item: TranscriptItem }
  | { type: 'item.delta'; chatId: string; itemId: string; text: string } // append to a streaming assistant_text/thinking
  | { type: 'item.removed'; chatId: string; itemId: string } // a stand-in item its real copy replaced (a CliMayte chat's sent message)
  | {
      type: 'notify'
      chatId: string
      reason: 'finished' | 'needs_you' | 'error' | 'limited'
      title: string
      body: string
    }
  | { type: 'bridge.status'; up: boolean; url: string }
  | { type: 'external.update'; sessions: ExternalSession[] }
  | { type: 'climayte.update'; workers: CliMayteWorker[] }
  | { type: 'accounts.update'; accounts: AccountInfo[] }
  | { type: 'settings.update'; settings: DeskSettings }

export type ClientEvent = { type: 'ping' }

// Failure ledger (SPEC "Failure ledger"): <home>/failures.jsonl, GET /api/failures

export type FailureCause =
  | 'auth_expired'
  | 'org_disabled'
  | 'usage_limit'
  | 'interrupted'
  | 'refused_send'
  | 'worker_failed'
  | 'hook_timeout'
  | 'hook_failed'
  | 'move_failed'
  | 'network'
  | 'unknown'

/** One failure event. Never an email: the account is its number or id. */
export interface FailureRow {
  id: string
  ts: number
  chatId: string
  title: string
  cwd: string
  kind: 'sdk' | 'worker'
  accountId: string
  accountNumber: number | null
  model: string | null
  cause: FailureCause
  /** The error text, cut to 500 characters, emails masked. */
  message: string
  /** ms from the turn's start, null when unknown. */
  durationMs: number | null
  sessionId: string | null
  /** Desk moved the chat to another account and sent again. */
  recovered: boolean
  movedToAccountId: string | null
}

export interface FailuresResponse {
  rows: FailureRow[]
  total: number
  byCause: Record<string, number>
  /** Keyed by account number ('#126') else id. */
  byAccount: Record<string, number>
  /** Keyed by local day, YYYY-MM-DD. */
  byDay: Record<string, number>
}

export type HomeStatsRange = 'all' | '30d' | '7d'

/** A part of the card that did not answer: the card shows a dash for it with `reason` as its tooltip. */
export interface HomeStatsMissing {
  part: 'activity' | 'climayte' | 'hswarm'
  reason: string
}

/** One of AgentHydra's sources (desktop, cli, climayte, hswarm, codex, opencode, dsh, hermes). */
export interface HomeStatsSource {
  key: string
  /** 'Claude desktop', 'CliMayte', ...; a source the server does not know keeps its key. */
  label: string
  sessions: number
  messages: number
  tokens: number
  costUsd: number | null
}

/**
 * One square of the stats card's activity grid: its local day (YYYY-MM-DD), that day's figure and its
 * shade 0-4 against the busiest day shown, so a hover can name the day and its number (owner, 2026-10-05:
 * "Each of the squares ... need to have a number I can read when I hover over them").
 */
export interface HeatCell {
  day: string
  count: number
  level: number
}

/**
 * GET /api/stats/home?range=: the home screen's stats card over every source AgentHydra counts (owner,
 * 2026-10-04: "the overview screen needs to display full consolidated stats from all sources"). From
 * AgentHydra's spend and activity reports, CliMayte's totals and HSwarm's stats; a part that failed is
 * null and named in `missing`, never 0.
 */
export interface HomeStats {
  range: HomeStatsRange
  sessions: number
  /** Model turns. */
  messages: number
  /** `input` is uncached input; total = input + cacheRead + cacheWrite + output. */
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; total: number }
  /** At API rates; null when AgentHydra could not price it. */
  costUsd: number | null
  /** The date the prices behind `costUsd` were last known good. */
  pricesAsOf: string | null
  activeDays: number
  /** The busiest hour of the day, '1 PM' (the PC's local time); null when the activity report is missing or quiet. */
  peakHour: string | null
  /** The raw model id with the most sessions ('claude-opus-5-5'). */
  favoriteModel: string | null
  /** Engaged agent time; null when the activity report is missing. */
  agentMinutes: number | null
  /** 27 weeks x 7 days, oldest first, ending today: the card's activity grid; `count` is model turns. */
  heat: HeatCell[]
  /** Most tokens first. */
  sources: HomeStatsSource[]
  /** Raw model ids, most sessions first. */
  models: { key: string; sessions: number }[]
  climayte: { tasks: number; sessions: number; costUsd: number; limitHits: number } | null
  /** For the range; savedUsd null when HSwarm priced none of its tasks. */
  hswarm: { tasks: number; savedUsd: number | null } | null
  /** How much of the store AgentHydra has read: while `refreshing` the figures still grow. */
  coverage: { sessions: number; total: number; refreshing: boolean }
  missing: HomeStatsMissing[]
}
