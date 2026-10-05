// One live chat (SPEC "The engine"): runs the SDK query with streaming input, feeds every message
// through the normalizer and the status reducer, writes finished items to the store, emits
// ServerEvents, and owns the canUseTool round trips (permission, AskUserQuestion, ExitPlanMode) and the
// MCP elicitation ones (onElicitation).

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  query as sdkQuery,
  type CanUseTool,
  type ElicitationResult,
  type McpServerConfig,
  type OnElicitation,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AccountRef,
  AskQuestion,
  ChatStatus,
  ChatSummary,
  DeskSettings,
  Effort,
  ElicitationAnswer,
  ImageRef,
  PermissionDecision,
  PermissionMode,
  PlanDecision,
  QuestionAnswer,
  ServerEvent,
  TranscriptItem,
} from '@shared/protocol'
import { contextPct } from './describe'
import { deskAppend } from './desk-prompt'
import { mainMcpOption } from './mcp-servers'
import { InputQueue, type QueuedInput } from './input-queue'
import { createNormalizer, LIMIT_LABEL, type Emission, type Normalizer } from './normalize'
import { answersWithPictures, checkAnswer, elicitationItem, ruleLine, type ElicitationItem } from './requests'
import { nextStatus, SESSION_STATE_ENV, statusEventsFor, type StatusEvent, type StatusState } from './status'
import type { ChatStore } from './store'
import { hostedOf, type HostConnection, type HostedParams } from '../host/client'
import { mediaCache, toStoredImage } from '../media/cache'

/** query()'s own parameters, plus what a chat host needs (SPEC "Chat hosts"); the SDK's query() reads prompt and options. */
export type QueryImpl = (params: HostedParams) => Query

export interface ChatRuntimeDeps {
  chat: ChatSummary
  store: ChatStore
  emit(event: ServerEvent): void
  /** Defaults to the SDK's query(); tests feed recorded fixtures through a fake. */
  queryImpl?: QueryImpl
  /** The base environment (default process.env); CLAUDE_CONFIG_DIR is set from chat.account. */
  env?: Record<string, string | undefined>
  settings: DeskSettings | (() => DeskSettings)
  /**
   * `mcpServers.agenthydra` from ~/.claude.json. undefined = read it at start; null = none.
   * Passed to the SDK verbatim and never logged.
   */
  agentHydraMcp?: McpServerConfig | null
  /** Jacob's main .claude.json whose user-level and folder-local MCP servers every chat gets. undefined = ~/.claude.json, unless agentHydraMcp was injected (then none); null = none. */
  mainClaudeJson?: string | null
  now?: () => number
  /** Called once the runtime has closed (idle timer or close()). */
  onClosed?(): void
  /**
   * The turn hit a usage limit (`window`: '5-hour', 'weekly'... when the SDK named it). True when the
   * manager carries the turn to another account: the limit is then not notified as a stop. `signIn`:
   * the account's login failed (expired, revoked) rather than its usage running out.
   */
  onLimited?(window: string | null, signIn?: boolean): boolean
  /** A failure for the ledger: a turn's error result, a crash, a hook that failed. `durationMs` is the turn's age, when one was running. */
  onFailure?(f: { message: string; durationMs: number | null }): void
  /**
   * A fork's cut: the uuid of the source session's last entry when the fork was made. Its first start
   * resumes the source only up to there, not as the source stands at that start.
   */
  forkAt?(): string | null
  /** A turn ended and the chat is idle: the manager looks where the session's folder is now (a cd moves the chat). */
  onTurnEnd?(): void
  /** Every live SDK message, before it is handled (speed tracking); never one replayed from a host's journal. */
  onMessage?(msg: SDKMessage): void
}

type PermissionItem = Extract<TranscriptItem, { kind: 'permission' }>
type QuestionItem = Extract<TranscriptItem, { kind: 'question' }>
type PlanItem = Extract<TranscriptItem, { kind: 'plan' }>
type ToolRequestItem = PermissionItem | QuestionItem | PlanItem
type RequestItem = ToolRequestItem | ElicitationItem
type UserItem = Extract<TranscriptItem, { kind: 'user' }>
/** A send no finished turn has answered yet; `uuid` names it to a chat host, which keeps it while a later turn may need it. */
type Sent = QueuedInput & { uuid?: string }

/**
 * What a hosted chat's runtime leaves with its host at each ack (SPEC "Chat hosts"), for the server that
 * adopts the chat after a restart: the query's cost so far and turns run (its total is cumulative), and the
 * status the chat had (null before the first ack).
 */
interface Carry {
  v: 1
  baseCostUsd: number
  totalCostUsd: number
  turns: number
  status: ChatStatus | null
}

function readCarry(x: unknown): Carry | null {
  const c = x as Partial<Carry> | null
  if (!c || c.v !== 1 || typeof c.baseCostUsd !== 'number' || typeof c.totalCostUsd !== 'number' || typeof c.turns !== 'number') return null
  return { v: 1, baseCostUsd: c.baseCostUsd, totalCostUsd: c.totalCostUsd, turns: c.turns, status: typeof c.status === 'string' ? c.status : null }
}

/** A canUseTool call waiting for its answer. */
interface Pending {
  item: ToolRequestItem
  input: Record<string, unknown>
  /** What "Always allow" saves; absent when the card does not offer it. */
  suggestions?: PermissionUpdate[]
  resolve(result: PermissionResult): void
}

/** An MCP server's elicitation waiting for its answer: it resolves an ElicitationResult, not a PermissionResult. */
interface PendingElicitation {
  item: ElicitationItem
  resolve(result: ElicitationResult): void
}

const STDERR_TAIL_CHARS = 4000
/** Stderr chunks that arrive within this many ms of a write are gathered into the next one. */
const STDERR_FLUSH_MS = 200
const STDERR_TAIL_LINES = 20
/** Images larger than this (base64 chars) are kept out of the stored transcript. */
const MAX_STORED_IMAGE_CHARS = 200_000
/** A plan's usage limit as the CLI words it: the usage limit, "hit your limit", the 5-hour or weekly window, a reset time. */
const LIMIT_TEXT =
  /usage limit|hit your (\w+ )?limit|(session|weekly|monthly|opus|sonnet) limit|limit (will )?resets?\b|\bresets? (at |on |in )?(\d|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|tomorrow|midnight|noon)|out of (extra )?usage|(5|five)[- ]hour limit|weekly limit/i
/** What passes in minutes (a per-minute rate limit, an overload) or is no limit of the account at all (the context window). */
const NOT_A_USAGE_LIMIT = /per[- ]minute|requests per|tokens per|\d+ ?seconds?\b|overloaded|context (window|limit|length)/i

/**
 * True for an account's usage limit, the one that holds the account out until its reset and moves an
 * 'auto' chat. A transient 429 or an unrelated "limit reached" is a plain error: the turn can be sent again.
 */
export function isUsageLimitText(text: string): boolean {
  return LIMIT_TEXT.test(text) && !NOT_A_USAGE_LIMIT.test(text)
}

/** The account's login is broken (AgentHydra climayte-lib.ts AUTH_RE): no turn on it can work until it is signed in again. */
const SIGN_IN_TEXT =
  /please run \/login|not logged in|invalid api key|failed to authenticate|oauth (?:token|session) (?:has )?(?:expired|been revoked)|authentication_error|disabled claude subscription access|invalid authentication credentials|\b40[13]\b[^\n]{0,40}(unauthori[sz]ed|forbidden|authenticat)|oauth authentication is currently not allowed|(organization|org)[^\n]{0,40}(disabled|not allowed|mismatch)/i

/** True for a turn refused because the account cannot sign in: the chat moves to another account, as on a usage limit. */
export function isSignInFailureText(text: string): boolean {
  return SIGN_IN_TEXT.test(text)
}

/** What was read from each config file last, by its size and mtime: the file grows to megabytes, and every chat start and MCP list asks for the same entry. */
const agentHydraMcpMemo = new Map<string, { sig: string; mcp: McpServerConfig | null }>()

/** `mcpServers.agenthydra` from ~/.claude.json, or null. Never logs what it read. Read again only when the file changed. */
export function readAgentHydraMcp(file = join(homedir(), '.claude.json')): McpServerConfig | null {
  try {
    const st = statSync(file)
    const sig = `${st.size}:${st.mtimeMs}`
    const hit = agentHydraMcpMemo.get(file)
    if (hit && hit.sig === sig) return hit.mcp
    const json = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> }
    const mcp = json.mcpServers?.agenthydra ?? null
    agentHydraMcpMemo.set(file, { sig, mcp })
    return mcp
  } catch {
    agentHydraMcpMemo.delete(file)
    return null
  }
}

/** Whether two chat summaries differ (a shallow comparison: their object fields, account and workerIds, are replaced when they change, never edited in place). */
export function chatDiffers(a: ChatSummary, b: ChatSummary): boolean {
  const x = a as unknown as Record<string, unknown>
  const y = b as unknown as Record<string, unknown>
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (!Object.is(x[k], y[k])) return true
  return false
}

/** The main .claude.json to read: the one given, else ~/.claude.json unless a test injected agentHydraMcp (then none). */
export function mainConfigFile(given: string | null | undefined, agentHydraMcp: unknown): string | null {
  if (given !== undefined) return given
  return agentHydraMcp === undefined ? join(homedir(), '.claude.json') : null
}

/**
 * AgentHydra copies its worker-only 'Rules for a CliMayte worker' CLAUDE.md into every CLI instance dir, where an
 * interactive chat would load it as user memory. When the instance's CLAUDE.md is that copy, returns the flag
 * setting that skips it and Jacob's real ~/.claude/CLAUDE.md text to put in the system prompt instead.
 */
export function workerRulesSwap(configDir: string | null, mainFile: string | null): { excludes: string[]; real: string } | null {
  if (!configDir || !mainFile) return null
  const copy = join(configDir, 'CLAUDE.md')
  try {
    if (!readFileSync(copy, 'utf8').slice(0, 400).includes('Rules for a CliMayte worker')) return null
    const real = readFileSync(join(dirname(mainFile), '.claude', 'CLAUDE.md'), 'utf8').trim()
    return { excludes: [copy.replace(/\\/g, '/')], real }
  } catch {
    return null
  }
}

export class ChatRuntime {
  readonly chat: ChatSummary
  private readonly store: ChatStore
  private readonly emitEvent: (event: ServerEvent) => void
  private readonly queryImpl: QueryImpl
  private readonly baseEnv: Record<string, string | undefined>
  private readonly settingsOf: () => DeskSettings
  private readonly agentHydraMcp: McpServerConfig | null | undefined
  private readonly mainClaudeJson: string | null
  private readonly now: () => number
  private readonly onClosed?: () => void
  private readonly onLimited?: (window: string | null, signIn?: boolean) => boolean
  private readonly onFailure?: (f: { message: string; durationMs: number | null }) => void
  private readonly forkAt?: () => string | null
  private readonly onTurnEnd?: () => void
  private readonly onMessage?: (msg: SDKMessage) => void

  private q: Query | null = null
  /** The account the process was started under; kept after it ends (the account the chat last ran on). */
  private ranAs: AccountRef | null = null
  /** The folder the process was started in: a chat whose cwd changed ends it at the next quiet point, and the next start runs in the new folder. */
  private ranCwd: string | null = null
  /** A turn ended and the folder the session says it is in has not been looked at since. */
  private cwdCheckDue = false
  /** The chat's account changed under a running turn: the runtime ends once the turn is over. */
  private closeOnIdle = false
  /** What this runtime was sent that no finished turn has answered yet, oldest first (images with their bytes). */
  private unanswered: Sent[] = []
  private input: InputQueue | null = null
  private normalizer: Normalizer | null = null
  private loop: Promise<void> | null = null
  private closing = false
  /** A Stop was sent into a turn whose result has not come: that result's error is the stop, whatever the CLI said meanwhile. */
  private stopping = false
  private sawSessionState = false
  private limitAnnounced = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private stderrTail = ''
  private logBuffer = ''
  private logTimer: ReturnType<typeof setTimeout> | null = null
  /** The chat as last published, so a message that changed nothing in it publishes nothing. */
  private published: ChatSummary | null = null
  /** The mode the chat had when it went into plan mode: approving the plan goes back to it. */
  private beforePlan: PermissionMode | null = null
  private readonly pending = new Map<string, Pending | PendingElicitation>()
  /** User items sent while a turn ran, oldest first, not yet taken up by a turn. */
  private readonly queued = new Map<string, UserItem>()
  /** tool_use ids already written while running (a running tool is written once, then when it ends). */
  private readonly storedRunning = new Set<string>()
  /** The running query's cost and turns, kept with its host for the next server (Carry). */
  private baseCost = 0
  private totalCost = 0
  private turns = 0
  /** A turn ended since the host's last ack: the next quiet point acks it. */
  private resultSinceAck = false
  /** adopt() replays a host's journal: what the last server already did (notify, carry a limit, read the context) is not done again. */
  private replaying = false
  /** The entry replayed reached the last server (it told the person then); after it, nothing reached anyone. */
  private replaySeen = false
  /** What the replay found that no one was told: notified, and a limit carried, once adopt is done. */
  private missed: { reason: Extract<ServerEvent, { type: 'notify' }>['reason']; body: string }[] = []
  private missedLimit: { window: string | null; signIn: boolean } | null = null
  /** The time of the journal entry being replayed: the time of what it brings. */
  private replayAt: number | null = null
  /** Upserts held while replaying, by id: only what differs from the stored transcript is written. */
  private replayed: Map<string, TranscriptItem> | null = null
  /** Set while adopt() re-opens the host's open requests: their cards keep their time; `shown` ones were notified before. */
  private reopened: { stored: Map<string, TranscriptItem>; shown: Set<string> } | null = null

  constructor(deps: ChatRuntimeDeps) {
    this.chat = deps.chat
    this.store = deps.store
    this.emitEvent = deps.emit
    this.queryImpl = deps.queryImpl ?? (sdkQuery as QueryImpl)
    this.baseEnv = deps.env ?? process.env
    const s = deps.settings
    this.settingsOf = typeof s === 'function' ? s : () => s
    this.agentHydraMcp = deps.agentHydraMcp
    this.mainClaudeJson = mainConfigFile(deps.mainClaudeJson, deps.agentHydraMcp)
    this.now = deps.now ?? Date.now
    this.onClosed = deps.onClosed
    this.onLimited = deps.onLimited
    this.onFailure = deps.onFailure
    this.forkAt = deps.forkAt
    this.onTurnEnd = deps.onTurnEnd
    this.onMessage = deps.onMessage
  }

  get running(): boolean {
    return this.q !== null
  }

  /** This runtime still waits on the request: anything else stored 'pending' can no longer be answered. */
  isPending(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  /** The account the running (or last) process used, which chat.account no longer is after a switch; null before the first start. */
  get startedAs(): AccountRef | null {
    return this.ranAs
  }

  get logFile(): string {
    return join(this.store.home, 'logs', `${this.chat.id}.log`)
  }

  /** The options query() gets (SPEC "Start"). Public so tests can check them without a run. */
  buildOptions(): Options {
    const chat = this.chat
    const env: Record<string, string | undefined> = { ...this.baseEnv, ...SESSION_STATE_ENV }
    if (chat.account.configDir) env.CLAUDE_CONFIG_DIR = chat.account.configDir
    else delete env.CLAUDE_CONFIG_DIR
    const options: Options = {
      cwd: chat.cwd,
      env,
      permissionMode: chat.permissionMode,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: deskAppend(chat.delegateToCliMayte) },
      canUseTool: this.canUseTool,
      // Without it the SDK declines every MCP form, sign-in link or other request for input unseen.
      onElicitation: this.onElicitation,
      stderr: (data: string) => this.onStderr(data),
    }
    // A Bypass chat in plan mode goes back to Bypass when the plan is approved, and the CLI refuses Bypass
    // to a process not launched for it (a process restarted mid-plan included).
    if (chat.permissionMode === 'bypassPermissions' || this.beforePlan === 'bypassPermissions') options.allowDangerouslySkipPermissions = true
    if (chat.model) options.model = chat.model
    if (chat.effort) options.effort = chat.effort
    if (chat.delegateToCliMayte) options.disallowedTools = ['Agent', 'Task']
    if (chat.sessionId) options.resume = chat.sessionId
    else if (chat.forkedFrom) {
      // A fork's first start: the SDK copies the session under a new id (system/init brings it).
      options.resume = chat.forkedFrom
      options.forkSession = true
      // The SDK reads the source now; the cut keeps out the turns it ran after the fork was made.
      const at = this.forkAt?.()
      if (at) options.resumeSessionAt = at
    }
    const swap = workerRulesSwap(chat.account.configDir, this.mainClaudeJson)
    if (swap) {
      options.settings = { claudeMdExcludes: swap.excludes }
      options.systemPrompt = { type: 'preset', preset: 'claude_code', append: `${deskAppend(chat.delegateToCliMayte)}

# User instructions (~/.claude/CLAUDE.md)

${swap.real}` }
    }
    const mcp = this.agentHydraMcp === undefined ? readAgentHydraMcp() : this.agentHydraMcp
    // What plain `claude` gets in this folder under the main config, on whatever account the chat runs; Hydra Desk's own agenthydra wins.
    const servers = { ...(this.mainClaudeJson ? mainMcpOption(chat.cwd, this.mainClaudeJson) : {}), ...(mcp ? { agenthydra: mcp } : {}) }
    if (Object.keys(servers).length) options.mcpServers = servers
    return options
  }

  /**
   * Spawns the SDK query (resuming the chat's session when it has one). No-op when already running. `attach`: a
   * chat host that kept the chat running through a server restart, which this runtime takes over (adopt).
   */
  start(attach?: HostConnection): void {
    if (this.q) return
    this.closing = false
    this.closeOnIdle = false
    this.ranAs = attach ? { ...attach.hello.account } : { ...this.chat.account }
    this.ranCwd = this.chat.cwd
    this.sawSessionState = false
    this.stopping = false
    this.stderrTail = ''
    this.unanswered = []
    mkdirSync(join(this.store.home, 'logs'), { recursive: true })
    const carry = attach ? readCarry(attach.hello.carry) : null
    this.baseCost = carry?.baseCostUsd ?? this.chat.costUsd
    this.totalCost = carry?.totalCostUsd ?? 0
    this.turns = carry?.turns ?? 0
    this.resultSinceAck = false
    this.normalizer = createNormalizer({
      now: () => this.clock(),
      cwd: this.chat.cwd,
      baseCostUsd: this.baseCost,
      priorTotalCostUsd: this.totalCost,
      firstTurn: this.turns,
      title: () => this.chat.title,
      accountLabel: () => (this.ranAs ?? this.chat.account).label,
    })
    this.input = new InputQueue()
    this.dispatch({ type: 'runtimeStarting' })
    if (!attach) this.publishChat()
    const q = this.queryImpl({ prompt: this.input, options: this.buildOptions(), chatId: this.chat.id, account: this.ranAs, attach, carry: this.carry(null) })
    this.q = q
    if (attach) this.adopt(q, attach, carry)
    this.loop = this.consume(q)
  }

  /**
   * The warm start (SPEC "Speed (timings)"): the process is started ahead of the message, so its start, its
   * SessionStart hooks and its MCP servers run while the owner still types. The chat reads idle, so the send
   * that follows is a turn of a running chat, not one queued behind a start. True when it started one.
   */
  warm(): boolean {
    if (this.q) return false
    this.start()
    this.dispatch({ type: 'init', now: this.now() })
    this.publishChat()
    this.armIdleTimer()
    return true
  }

  /**
   * A host kept this chat running through a server restart (SPEC "Chat hosts"): its journal goes through the
   * path live messages take, from the status the chat had at the last ack, so the transcript, the status and
   * the queue end where the chat is now, and only items that differ from the stored ones are written. What the
   * last server already told the person is not told again; what happened while no server was there is (a turn
   * that finished, a request that opened), and a usage limit hit then is carried now. Then the requests the
   * host still waits on open again, under the ids their cards already have.
   */
  private adopt(q: Query, attach: HostConnection, carry: Carry | null): void {
    const hosted = hostedOf(q)
    if (!hosted) return
    const hello = attach.hello
    const stored = new Map(this.store.loadItems(this.chat.id).map((i) => [i.id, i]))
    this.normalizer?.seed([...stored.values()])
    if (carry?.status && carry.status !== 'closed' && carry.status !== 'starting') this.chat.status = carry.status
    let last: SDKMessage | null = null
    this.replaying = true
    this.replayed = new Map()
    try {
      for (const e of hosted.takeJournal()) {
        this.replayAt = e.at
        this.replaySeen = e.seq <= hello.delivered
        if (e.kind === 'input') this.replayInput(e.msg, e.seq <= hello.acked, stored)
        else if (e.kind === 'interrupt') {
          this.stopping = this.midTurn
          this.normalizer?.noteInterrupt()
          this.dispatch({ type: 'interrupted' })
        } else {
          this.handle(e.msg)
          last = e.msg
        }
      }
    } finally {
      this.replaying = false
      this.replaySeen = false
      this.replayAt = null
    }
    const replayed = this.replayed
    this.replayed = null
    for (const item of replayed.values()) {
      const prev = stored.get(item.id)
      if (prev && sameItem(prev, item)) {
        if (item.kind === 'tool_use' && item.status === 'running') this.storedRunning.add(item.id)
      } else this.upsert(item)
    }
    const unshown = new Set(hello.unshown)
    this.reopened = { stored, shown: new Set(hello.requests.flatMap((r) => (unshown.has(r.callId) ? [] : [r.callId]))) }
    try {
      hosted.reopenRequests()
    } finally {
      this.reopened = null
    }
    // Nothing in the journal moved it on: idle, or working on a send whose turn has not said so yet.
    if (this.chat.status === 'starting') this.dispatch({ type: 'init', now: this.now() })
    if (last) this.ackHost(last)
    if (this.chat.status === 'working' || this.chat.status === 'needs_you') this.clearIdleTimer()
    else this.armIdleTimer()
    this.publishChat()
    void this.refreshContext()
    const missed = this.missed.splice(0)
    const limit = this.missedLimit
    this.missedLimit = null
    const carried = limit ? (this.onLimited?.(limit.window, limit.signIn) ?? false) : false
    for (const n of missed) if (!(carried && n.reason === 'limited')) this.notify(n.reason, n.body)
    // The chat was switched to another account during the restart's turn: it moves once that turn is over.
    if (this.switchedAway) void this.closeWhenIdle()
  }

  /** A send the host journaled. `beforeAck`: one a limited turn left (kept to be sent again), only remembered. */
  private replayInput(msg: SDKUserMessage, beforeAck: boolean, stored: Map<string, TranscriptItem>): void {
    this.unanswered.push(sentOf(msg))
    if (beforeAck) return
    const c = this.chat
    const busy = c.status === 'working' || c.status === 'needs_you' || (c.status === 'starting' && c.turnStartedAt !== null)
    this.limitAnnounced = false
    this.dispatch({ type: 'userSent', now: this.clock() })
    // The transcript has the send already (written when it was sent): only the queue is rebuilt.
    const item = msg.uuid ? stored.get(msg.uuid) : undefined
    if (busy && item?.kind === 'user') {
      this.queued.set(item.id, { ...item, queued: true })
      this.syncQueuedCount()
    }
  }

  /**
   * The server is stopping. A hosted chat is let go: it runs on in its host, open requests and all, and the next
   * server adopts it. An in-process one closes.
   */
  async shutdown(): Promise<void> {
    const hosted = hostedOf(this.q)
    if (!hosted) return this.close()
    this.clearIdleTimer()
    this.closing = true
    this.q = null
    const loop = this.loop
    this.loop = null
    await hosted.detach()
    await loop?.catch(() => {})
  }

  /** A hosted chat at a quiet point after a turn: its host drops its journal up to here and keeps the carry. */
  private ackHost(msg: SDKMessage): void {
    if (this.replaying || !this.resultSinceAck || this.midTurn || this.pending.size > 0) return
    const hosted = hostedOf(this.q)
    if (!hosted) return
    this.resultSinceAck = false
    hosted.ack(
      msg,
      this.unanswered.flatMap((s) => (s.uuid ? [s.uuid] : [])),
      this.carry(this.chat.status),
    )
  }

  private carry(status: ChatStatus | null): Carry {
    return { v: 1, baseCostUsd: this.baseCost, totalCostUsd: this.totalCost, turns: this.turns, status }
  }

  /** Now, or while replaying, the time of the entry replayed. */
  private clock(): number {
    return this.replayAt ?? this.now()
  }

  /**
   * Sends a message: starts the runtime when needed; queued behind a running turn. Returns whether it was queued.
   * `messageId` becomes the SDK message uuid and the user item's id (the send queue finds a delivered send by it).
   */
  send(text: string, images?: ImageRef[], messageId?: string): { queued: boolean } {
    this.clearIdleTimer()
    if (!this.q) this.start()
    const before = this.chat
    const busy = before.status === 'working' || before.status === 'needs_you' || (before.status === 'starting' && before.turnStartedAt !== null)
    this.limitAnnounced = false
    const msg = this.input!.push({ text, images }, messageId)
    this.unanswered.push({ text, images, uuid: msg.uuid })
    this.dispatch({ type: 'userSent', now: this.now() })
    const item: UserItem = { kind: 'user', id: msg.uuid ?? randomUUID(), ts: this.now(), text }
    // The SDK gets the bytes; the transcript (and so /ws and the history file) gets the cached url.
    if (images?.length) item.images = images.map((i) => toStoredImage(i))
    if (busy) {
      item.queued = true
      this.queued.set(item.id, item)
      this.syncQueuedCount()
    }
    this.upsert(item)
    this.publishChat()
    return { queued: busy }
  }

  /** The sends no finished turn has answered: what a turn cut short by a usage limit asked. */
  unansweredSends(): QueuedInput[] {
    return this.unanswered.map(({ uuid: _u, ...s }) => s)
  }

  /** Sends them again on a fresh start (the chat moved to another account); the transcript already has them. */
  replay(sends: QueuedInput[]): void {
    this.clearIdleTimer()
    if (!this.q) this.start()
    this.limitAnnounced = false
    for (const s of sends) {
      const msg = this.input!.push(s)
      this.unanswered.push({ ...s, uuid: msg.uuid })
      this.dispatch({ type: 'userSent', now: this.now() })
    }
    this.publishChat()
  }

  /** The manager could not carry a limit it took over: the next limit is announced again. */
  rearmLimit(): void {
    this.limitAnnounced = false
  }

  /**
   * The chat's account changed: the process keeps the login it started under, so it ends once its turn
   * is over (now when no turn runs) and the next send starts, resuming the session, under the new one.
   */
  closeWhenIdle(): Promise<void> {
    if (!this.q) return Promise.resolve()
    if (!this.midTurn) return this.close()
    this.closeOnIdle = true
    return Promise.resolve()
  }

  /** The chat is set to another account than the one this process runs under (switched back, it is not). */
  private get switchedAway(): boolean {
    return (this.ranAs !== null && this.ranAs.id !== this.chat.account.id) || (this.ranCwd !== null && this.ranCwd !== this.chat.cwd)
  }

  /** A turn runs or one queued send still waits for its turn; idle, stopped, error and limited do not count. */
  private get midTurn(): boolean {
    const c = this.chat
    return c.status === 'working' || c.status === 'needs_you' || (c.status === 'starting' && c.turnStartedAt !== null) || c.queuedCount > 0
  }

  async interrupt(): Promise<void> {
    if (!this.q) return
    this.stopTurn()
    try {
      await this.q.interrupt()
    } catch {
      // the process may already be gone; the status already says stopped
    }
  }

  /** The turn is being stopped (Stop, or a bare No to a permission): stopped, every open request expired. */
  private stopTurn(): void {
    this.stopping = this.midTurn
    this.normalizer?.noteInterrupt()
    this.dispatch({ type: 'interrupted' })
    this.expirePending(false)
    this.publishChat()
    this.armIdleTimer()
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const was = { mode: this.chat.permissionMode, beforePlan: this.beforePlan }
    this.notePlanEntry(mode)
    this.chat.permissionMode = mode
    this.touch()
    this.publishChat()
    const q = this.q
    if (!q) return
    try {
      await q.setPermissionMode(mode)
    } catch (err) {
      // A process that went away takes the mode at its next start. One that refused it (Bypass on a process
      // not launched for it) still runs in the old mode, so the chat says that one, and why.
      if (this.q !== q) return
      this.chat.permissionMode = was.mode
      this.beforePlan = was.beforePlan
      this.touch()
      this.publishChat()
      const now = this.now()
      const why = err instanceof Error ? err.message : String(err)
      this.upsert({ kind: 'system', id: `mode:${now}`, ts: now, level: 'warn', text: `The permission mode did not change: ${why}` })
    }
  }

  async setModel(model: string | null): Promise<void> {
    this.chat.model = model
    this.touch()
    this.publishChat()
    if (this.q) await this.q.setModel(model ?? undefined)
  }

  async setEffort(effort: Effort | null): Promise<void> {
    this.chat.effort = effort
    this.touch()
    this.publishChat()
    if (this.q) await this.q.applyFlagSettings({ effortLevel: effort })
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const p = this.takePending(requestId, 'permission')
    const item = p.item as PermissionItem
    if (decision.decision === 'deny') {
      if (item.toolUseId) this.apply(this.normalizer?.markDenied(item.toolUseId) ?? [])
      const reason = decision.message?.trim()
      // A bare No stops the turn, as Esc does in the terminal; with a reason Claude carries on and reads it.
      const result: PermissionResult = reason ? { behavior: 'deny', message: reason } : { behavior: 'deny', message: 'The user denied this.', interrupt: true }
      this.finishRequest({ ...item, state: 'denied' }, () => p.resolve(result))
      if (!reason) this.stopTurn()
      return
    }
    const suggestions = p.suggestions ?? []
    const result: PermissionResult = { behavior: 'allow', updatedInput: p.input }
    // 'session' saves the same rules as "Always allow", kept for this session only.
    if (decision.decision === 'always') result.updatedPermissions = suggestions
    else if (decision.decision === 'session') result.updatedPermissions = suggestions.map((s): PermissionUpdate => ({ ...s, destination: 'session' }))
    const state = decision.decision === 'allow' ? 'allowed' : decision.decision
    this.finishRequest({ ...item, state }, () => p.resolve(result))
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): void {
    // Pictures are saved before the request is taken: one that cannot be kept refuses the answer and leaves the question open.
    if (answer.answers && answer.images) answer = { answers: answersWithPictures(answer.answers, answer.images, mediaCache(this.store.home)) }
    const p = this.takePending(requestId, 'question')
    const item = p.item as QuestionItem
    if (answer.skip || !answer.answers) {
      this.finishRequest({ ...item, state: 'skipped' }, () => p.resolve({ behavior: 'deny', message: 'The user skipped the question.' }))
      return
    }
    // AskUserQuestionInput.answers: question text -> answer (multi-select comma-separated; a picture adds an [Image: source: path] line)
    const answers = answer.answers
    this.finishRequest({ ...item, state: 'answered', answers }, () => p.resolve({ behavior: 'allow', updatedInput: { ...p.input, answers } }))
  }

  respondPlan(requestId: string, decision: PlanDecision): void {
    const p = this.takePending(requestId, 'plan')
    const item = p.item as PlanItem
    if (!decision.approve) {
      const message = decision.feedback?.trim() || 'The user wants to keep planning.'
      this.finishRequest({ ...item, state: 'rejected' }, () => p.resolve({ behavior: 'deny', message }))
      return
    }
    // Back to the mode the chat had before plan mode (a Bypass chat stays Bypass); acceptEdits when unknown.
    // The approval carries the mode, so the CLI leaves plan mode before it runs ExitPlanMode (which would
    // otherwise put back its own idea of the earlier mode) or any tool after it.
    const mode = decision.mode ?? this.beforePlan ?? 'acceptEdits'
    const updatedPermissions: PermissionUpdate[] = [{ type: 'setMode', mode, destination: 'session' }]
    this.finishRequest({ ...item, state: 'approved' }, () => p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions }))
    // The CLI ignores a setMode it cannot take without a word; the control call refuses out loud, and the chat then keeps the mode it runs in.
    void this.setPermissionMode(mode).catch(() => {}) // floor-ok: setPermissionMode reports a refusal itself; a process that went away takes the mode at its next start
  }

  /** The answer to an MCP elicitation. A form answer is checked first: a refused one leaves the request open. */
  answerElicitation(requestId: string, answer: ElicitationAnswer): void {
    const p = this.pending.get(requestId)
    if (!p || 'input' in p) throw new Error(`no pending elicitation request ${requestId}`)
    const item = p.item
    if (answer.action === 'decline') {
      this.pending.delete(requestId)
      this.finishRequest({ ...item, state: 'declined' }, () => p.resolve({ action: 'decline' }))
      return
    }
    const values = item.mode === 'form' ? checkAnswer(item.fields ?? [], answer.values) : null
    this.pending.delete(requestId)
    if (!values) {
      this.finishRequest({ ...item, state: 'accepted' }, () => p.resolve({ action: 'accept' }))
      return
    }
    this.finishRequest({ ...item, state: 'accepted', values }, () => p.resolve({ action: 'accept', content: values }))
  }

  /** The chat goes into plan mode (Jacob's switch, or Claude's own EnterPlanMode): remember the mode it leaves. Leaving plan mode forgets it. */
  private notePlanEntry(mode: PermissionMode): void {
    if (mode !== 'plan') this.beforePlan = null
    else if (this.chat.permissionMode !== 'plan') this.beforePlan = this.chat.permissionMode
  }

  /** Jacob looked at the chat. */
  markViewed(): void {
    this.dispatch({ type: 'viewed' })
    this.publishChat()
  }

  /** Ends the runtime: the chat goes 'closed' and the next send resumes it. */
  async close(): Promise<void> {
    this.clearIdleTimer()
    const q = this.q
    if (!q) return
    this.closing = true
    this.expirePending(false)
    this.input?.close()
    try {
      q.close()
    } catch {
      // already gone
    }
    this.q = null
    this.endLog()
    this.dispatch({ type: 'closed' })
    this.unqueueAll()
    this.publishChat()
    const loop = this.loop
    this.loop = null
    await loop?.catch(() => {})
    // A chat host ends its process once it has the close: a server stopping right after still ends it.
    await hostedOf(q)?.whenClosed()
    this.onClosed?.()
  }

  // canUseTool (SPEC): AskUserQuestion -> question, ExitPlanMode -> plan, anything else -> permission.
  // The SDK's requestId names the card: a chat host re-opens a request after a server restart under it.
  private readonly canUseTool: CanUseTool = (toolName, input, opts) =>
    new Promise<PermissionResult>((resolve) => {
      const id = opts.requestId || randomUUID()
      const ts = this.reopened?.stored.get(id)?.ts ?? this.now()
      const toolUseId = opts.toolUseID
      let item: ToolRequestItem
      let suggestions: PermissionUpdate[] | undefined
      if (toolName === 'AskUserQuestion') {
        item = { kind: 'question', id, ts, toolUseId, questions: questionsFrom(input), state: 'pending' }
      } else if (toolName === 'ExitPlanMode') {
        item = { kind: 'plan', id, ts, toolUseId, plan: typeof input.plan === 'string' ? input.plan : '', state: 'pending' }
      } else {
        // The SDK may forbid saving a rule (it would grant more than this one call): then no "always" and no "session".
        const offered = opts.suggestions?.length && !opts.suppressAlwaysAllowRule ? opts.suggestions : undefined
        const permission: PermissionItem = { kind: 'permission', id, ts, toolName, toolUseId, input, canAlwaysAllow: !!offered, state: 'pending' }
        if (opts.blockedPath) permission.blockedPath = opts.blockedPath
        if (opts.title) permission.title = opts.title
        if (opts.description) permission.description = opts.description
        if (opts.decisionReason) permission.reason = opts.decisionReason
        if (opts.defaultToNo) permission.defaultToNo = true
        if (offered) permission.alwaysRules = offered.map(ruleLine)
        item = permission
        suggestions = offered
      }
      this.pending.set(id, { item, input, suggestions, resolve })
      opts.signal.addEventListener('abort', () => this.expire(id, true), { once: true })
      this.openRequest(item)
    })

  // onElicitation (SPEC): an MCP server asks for a form or for a link to be opened -> elicitation.
  private readonly onElicitation: OnElicitation = (request, opts) =>
    new Promise<ElicitationResult>((resolve) => {
      const id = opts.requestId || randomUUID()
      const item = elicitationItem(id, this.reopened?.stored.get(id)?.ts ?? this.now(), request)
      this.pending.set(item.id, { item, resolve })
      opts.signal.addEventListener('abort', () => this.expire(item.id, true), { once: true })
      this.openRequest(item)
    })

  /**
   * A request is shown and counted; the first one waiting notifies (later ones join a chat already asking, and
   * one re-opened after a server restart was notified before it).
   */
  private openRequest(item: RequestItem): void {
    this.upsert(item)
    this.dispatch({ type: 'requestOpened' })
    this.publishChat()
    if (this.pending.size === 1 && !this.reopened?.shown.has(item.id)) this.notify('needs_you', describeRequest(item))
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        if (this.q !== q) return
        this.handle(msg)
      }
      if (this.q === q && !this.closing) this.crash(new Error('Claude Code exited unexpectedly'))
    } catch (err) {
      if (this.q === q && !this.closing) this.crash(err)
    }
  }

  /** One SDK message: status first, then the transcript, then the after-turn work. */
  handle(msg: SDKMessage): void {
    if (!this.replaying) this.onMessage?.(msg)
    const now = this.clock()
    const m = msg as { type: string; subtype?: string }
    if (m.type === 'system' && m.subtype === 'session_state_changed') this.sawSessionState = true
    this.takeUp(msg)

    const before = this.chat.status
    let limitFromResult = false
    let signIn = false
    let reportedQueued: number | undefined
    const turnStartedAt = this.chat.turnStartedAt
    if (m.type === 'system' && m.subtype === 'hook_response' && (msg as { outcome?: string }).outcome === 'error') {
      const h = msg as { hook_name?: unknown; hook_event?: unknown; exit_code?: unknown; stderr?: unknown; output?: unknown; stdout?: unknown }
      const why = String(h.stderr || h.output || h.stdout || '').split(/\r?\n/).find((l) => l.trim()) ?? ''
      this.failed(`Hook ${String(h.hook_name ?? '')} (${String(h.hook_event ?? '')}) failed${typeof h.exit_code === 'number' ? ` (exit ${h.exit_code})` : ''}${why ? `: ${why}` : ''}`, null)
    }
    for (let e of statusEventsFor(msg, now)) {
      if (e.type === 'turnError' && !this.replaying) this.failed(e.message, turnStartedAt)
      // An assistant 'rate_limit' error is a usage limit only when it says so; a 429 that passes in a
      // minute ends as a plain error (its result follows).
      if (e.type === 'usageLimit' && m.type === 'assistant' && !isUsageLimitText(assistantText(msg))) continue
      // A Stop sent while the process was still starting is taken by the CLI after it began the turn: its
      // 'running' put the chat back to working, and the aborted result is still the stop, not a failure.
      if (e.type === 'turnError' && this.stopping) e = { type: 'interrupted' }
      if (e.type === 'turnError' && isUsageLimitText(e.message) && this.chat.status !== 'stopped') {
        e = { type: 'usageLimit', resetsAt: null }
        limitFromResult = true
      }
      // A login that failed holds the account out like a limit, so the turn moves on (Jacob, 2026-10-04:
      // sending again into an account whose OAuth expired is the failure).
      if (e.type === 'turnError' && isSignInFailureText(e.message) && this.chat.status !== 'stopped') {
        e = { type: 'usageLimit', resetsAt: null }
        limitFromResult = true
        signIn = true
      }
      if (e.type === 'turnEnded') {
        reportedQueued = e.queued
        // Older CLIs leave queued_turn_count out: our own queued sends say whether a turn follows.
        if (e.queued === undefined) e = { ...e, queued: this.queued.size }
      }
      this.dispatch(e)
    }

    let emissions = this.normalizer?.handle(msg) ?? []
    if (limitFromResult) emissions = emissions.filter((x) => !(x.type === 'notify' && x.reason === 'error'))
    const limitedNow = this.chat.status === 'limited' && before !== 'limited' && !this.limitAnnounced
    const announced = emissions.some((x) => x.type === 'notify' && x.reason === 'limited')
    // A replayed limit was carried (or not) by the server that saw it; one no server saw is carried once adopt is done.
    if (limitedNow && this.replaying && !this.replaySeen) this.missedLimit = { window: limitWindow(msg), signIn }
    const carried = limitedNow && !this.replaying && (this.onLimited?.(limitWindow(msg), signIn) ?? false)
    if (carried) emissions = emissions.filter((x) => !(x.type === 'notify' && x.reason === 'limited'))
    this.apply(emissions)

    if (limitedNow) {
      if (!announced) {
        const on = (this.ranAs ?? this.chat.account).label
        const text = signIn ? `Sign-in failed on ${on}: its login needs renewing.` : `Usage limit reached on ${on}.`
        // Keyed by the message, so a replay after a server restart writes the same line, not a second one.
        this.upsert({ kind: 'system', id: `limit:${(msg as { uuid?: string }).uuid || now}`, ts: now, level: 'error', text })
        if (!carried) this.notify('limited', text)
      }
      this.limitAnnounced = true
    } else if (this.chat.status === 'limited') {
      this.limitAnnounced = true
    }

    if (m.type === 'result') {
      const total = (msg as { total_cost_usd?: unknown }).total_cost_usd
      if (typeof total === 'number') this.totalCost = total
      this.turns++
      this.stopping = false
      this.resultSinceAck = true
      if (!this.replaying) this.cwdCheckDue = true
      const stillQueued = this.queued.size
      // The CLI's count says how many sends still wait; without it the oldest one starts the next turn now.
      this.syncQueued(reportedQueued ?? Math.max(0, stillQueued - 1))
      // A limited turn answered nothing: its sends stay for the manager to carry to another account.
      if (this.chat.status !== 'limited') this.unanswered.splice(0, Math.max(0, this.unanswered.length - this.queued.size))
      // Without session_state_changed events (older CLIs, recordings) the result is the turn's end.
      if (!this.sawSessionState && stillQueued === 0) this.dispatch({ type: 'stateChanged', state: 'idle', now })
      if (!this.replaying) void this.refreshContext()
    }
    if (this.chat.status === 'idle' && this.queued.size > 0 && this.chat.queuedCount === 0) this.unqueueAll()

    if (this.closeOnIdle && this.switchedAway && !this.midTurn) {
      // close() publishes the chat 'closed'; this loop ends at the next message.
      void this.close()
      return
    }
    if (this.chat.status === 'working' || this.chat.status === 'needs_you') this.clearIdleTimer()
    else this.armIdleTimer()
    this.ackHost(msg)
    // Streamed text and tool progress change no field of the chat: only a changed summary goes out.
    if (!this.published || chatDiffers(this.published, this.chat)) this.publishChat()
    // At the quiet point after a turn the session's own transcript says where it is now.
    if (this.cwdCheckDue && !this.replaying && !this.midTurn && this.chat.status === 'idle') {
      this.cwdCheckDue = false
      this.onTurnEnd?.()
    }
  }

  private apply(emissions: Emission[]): void {
    for (const e of emissions) {
      switch (e.type) {
        case 'upsert':
          this.upsert(e.item)
          break
        case 'delta': {
          const held = this.replayed?.get(e.itemId)
          if (held && (held.kind === 'assistant_text' || held.kind === 'thinking')) {
            this.replayed!.set(e.itemId, { ...held, text: held.text + e.text })
            break
          }
          if (this.replayed) break
          this.emitEvent({ type: 'item.delta', chatId: this.chat.id, itemId: e.itemId, text: e.text })
          break
        }
        case 'chat': {
          const { activity, ...rest } = e.patch
          if ('activity' in e.patch) this.dispatch({ type: 'activity', activity: activity ?? null })
          if (rest.permissionMode) this.notePlanEntry(rest.permissionMode)
          Object.assign(this.chat, rest)
          this.touch()
          break
        }
        case 'notify':
          this.notify(e.reason, e.body)
          break
      }
    }
  }

  private dispatch(e: StatusEvent): void {
    const s: StatusState = nextStatus(this.chat, e)
    Object.assign(this.chat, s)
    this.touch()
  }

  private upsert(item: TranscriptItem): void {
    if (this.replayed) {
      this.replayed.set(item.id, item)
      return
    }
    this.emitEvent({ type: 'item.upsert', chatId: this.chat.id, item })
    if ((item.kind === 'assistant_text' || item.kind === 'thinking') && item.streaming) return
    if (item.kind === 'tool_use' && item.status === 'running') {
      if (this.storedRunning.has(item.id)) return
      this.storedRunning.add(item.id)
    }
    // A request re-opened after a restart is on disk as it was.
    const prev = this.reopened?.stored.get(item.id)
    if (prev && sameItem(prev, item)) return
    this.store.appendItem(this.chat.id, forStore(item))
  }

  private notify(reason: Extract<ServerEvent, { type: 'notify' }>['reason'], body: string): void {
    if (this.replaying) {
      if (!this.replaySeen) this.missed.push({ reason, body })
      return
    }
    this.emitEvent({ type: 'notify', chatId: this.chat.id, reason, title: this.chat.title, body })
  }

  private publishChat(): void {
    if (this.replaying) return
    this.published = { ...this.chat }
    this.emitEvent({ type: 'chat.upsert', chat: { ...this.chat } })
  }

  private touch(): void {
    this.chat.updatedAt = this.clock()
  }

  // Queued sends: taken up when a turn names their uuid, or when a result reports fewer queued.
  private takeUp(msg: SDKMessage): void {
    if (this.queued.size === 0) return
    const m = msg as { user_message_uuid?: string; user_message_uuids?: string[] }
    const ids = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : [])
    let changed = false
    for (const id of ids) changed = this.unqueue(id) || changed
    if (changed) this.syncQueuedCount()
  }

  /** After a result: keep only as many queued items as still wait (oldest taken up first). */
  private syncQueued(waiting: number): void {
    while (this.queued.size > waiting) {
      const oldest = this.queued.keys().next().value as string
      this.unqueue(oldest)
    }
    this.syncQueuedCount()
  }

  private syncQueuedCount(): void {
    this.chat.queuedCount = this.queued.size
  }

  private unqueue(id: string): boolean {
    const item = this.queued.get(id)
    if (!item) return false
    this.queued.delete(id)
    const { queued: _q, ...rest } = item
    this.upsert({ ...rest, ts: item.ts })
    return true
  }

  private unqueueAll(): void {
    for (const id of [...this.queued.keys()]) this.unqueue(id)
    this.chat.queuedCount = 0
  }

  private takePending(requestId: string, kind: ToolRequestItem['kind']): Pending {
    const p = this.pending.get(requestId)
    if (!p || !('input' in p) || p.item.kind !== kind) throw new Error(`no pending ${kind} request ${requestId}`)
    this.pending.delete(requestId)
    return p
  }

  /** Records the answered item and closes the request, then answers the SDK. */
  private finishRequest(item: RequestItem, answer: () => void): void {
    this.upsert(item)
    this.dispatch({ type: 'requestClosed' })
    this.publishChat()
    answer()
  }

  /** A pending request the SDK aborted, or every one at interrupt / close / crash. */
  private expire(id: string, closeRequest: boolean): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    this.upsert({ ...p.item, state: 'expired' } as RequestItem)
    if (closeRequest) {
      this.dispatch({ type: 'requestClosed' })
      this.publishChat()
    }
    if ('input' in p) p.resolve({ behavior: 'deny', message: 'The request expired.', interrupt: true })
    else p.resolve({ action: 'cancel' })
  }

  private expirePending(closeRequest: boolean): void {
    for (const id of [...this.pending.keys()]) this.expire(id, closeRequest)
  }

  private async refreshContext(): Promise<void> {
    const q = this.q
    if (!q) return
    try {
      const pct = contextPct(await q.getContextUsage({ detail: 'summary' }))
      if (pct === null || this.q !== q) return
      this.chat.contextPct = pct
      this.publishChat()
    } catch {
      // older CLIs, or the process went away: keep the last reading
    }
  }

  private onStderr(data: string): void {
    this.stderrTail = (this.stderrTail + data).slice(-STDERR_TAIL_CHARS)
    // The first chunk after a quiet spell is written at once; chunks that follow within the window go out as one write.
    if (this.logTimer) {
      this.logBuffer += data
      return
    }
    this.appendLog(data)
    this.logTimer = setTimeout(() => this.flushLog(), STDERR_FLUSH_MS)
    ;(this.logTimer as { unref?: () => void }).unref?.()
  }

  /** Writes what the window gathered; a window that gathered nothing ends. */
  private flushLog(): void {
    const data = this.logBuffer
    this.logBuffer = ''
    if (!data) {
      this.logTimer = null
      return
    }
    this.appendLog(data)
    this.logTimer = setTimeout(() => this.flushLog(), STDERR_FLUSH_MS)
    ;(this.logTimer as { unref?: () => void }).unref?.()
  }

  private appendLog(data: string): void {
    try {
      appendFileSync(this.logFile, data)
    } catch {
      // the log is best effort
    }
  }

  /** Writes the gathered stderr now and ends the window (the process ended). */
  private endLog(): void {
    if (this.logTimer) clearTimeout(this.logTimer)
    this.logTimer = null
    const data = this.logBuffer
    this.logBuffer = ''
    if (data) this.appendLog(data)
  }

  private failed(message: string, startedAt: number | null): void {
    if (!this.onFailure || this.replaying) return
    try {
      this.onFailure({ message, durationMs: startedAt === null ? null : Math.max(0, this.now() - startedAt) })
    } catch {
      // the ledger never breaks a chat
    }
  }

  /** The SDK process died: status error with the real message, the stderr tail as a system item. */
  private crash(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    const now = this.now()
    this.failed(message, this.chat.turnStartedAt)
    this.q = null
    this.endLog()
    this.input?.close()
    this.expirePending(false)
    this.unqueueAll()
    Object.assign(this.chat, {
      status: 'error',
      activity: null,
      turnStartedAt: null,
      pendingCount: 0,
      queuedCount: 0,
      lastError: message,
      unread: true,
    } satisfies Partial<ChatSummary>)
    this.touch()
    const tail = this.stderrTail.trim().split(/\r?\n/).slice(-STDERR_TAIL_LINES).join('\n')
    this.upsert({ kind: 'system', id: `crash:${now}`, ts: now, level: 'error', text: tail ? `${message}\n${tail}` : message })
    this.notify('error', message)
    this.publishChat()
    this.armIdleTimer()
  }

  private armIdleTimer(): void {
    this.clearIdleTimer()
    if (!this.q && this.chat.status !== 'error') return
    const minutes = this.settingsOf().idleCloseMinutes
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.q) void this.close()
      else if (this.chat.status !== 'closed') {
        this.dispatch({ type: 'closed' })
        this.publishChat()
        this.onClosed?.()
      }
    }, minutes * 60_000)
    ;(this.idleTimer as { unref?: () => void }).unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

function questionsFrom(input: Record<string, unknown>): AskQuestion[] {
  // AskUserQuestionInput.questions: { question, header, options: { label, description }[], multiSelect }[]
  if (!Array.isArray(input.questions)) return []
  return (input.questions as Record<string, unknown>[]).map((q) => ({
    question: typeof q.question === 'string' ? q.question : '',
    header: typeof q.header === 'string' ? q.header : '',
    multiSelect: q.multiSelect === true,
    options: Array.isArray(q.options)
      ? (q.options as Record<string, unknown>[]).map((o) => {
          const opt: AskQuestion['options'][number] = { label: typeof o.label === 'string' ? o.label : '' }
          if (typeof o.description === 'string') opt.description = o.description
          return opt
        })
      : [],
  }))
}

/** An assistant message's text blocks, joined. */
function assistantText(msg: SDKMessage): string {
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((b: { type?: string; text?: unknown }) => (b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n')
}

/** The window a rate_limit_event names ('5-hour', 'weekly'...), else null. */
function limitWindow(msg: SDKMessage): string | null {
  const type = (msg as { rate_limit_info?: { rateLimitType?: string } }).rate_limit_info?.rateLimitType
  return (type && LIMIT_LABEL[type]) || null
}

function describeRequest(item: RequestItem): string {
  if (item.kind === 'question') return item.questions[0]?.question || 'Claude has a question'
  if (item.kind === 'plan') return 'A plan is ready for your approval'
  if (item.kind === 'elicitation') return item.message || `${item.serverName} asks for your input`
  return item.title || `Allow ${item.toolName}?`
}

/** A send a chat host journaled, as the runtime keeps it: its text, its pictures with their bytes, its uuid. */
function sentOf(msg: SDKUserMessage): Sent {
  const content = msg.message.content
  type Block = { type: string; text?: unknown; source?: { type?: string; media_type?: string; data?: string } }
  const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : (content as Block[])
  const text = blocks.flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n\n')
  const images: ImageRef[] = blocks.flatMap((b) =>
    b.type === 'image' && b.source?.type === 'base64' && b.source.data ? [{ mediaType: b.source.media_type ?? 'image/png', dataBase64: b.source.data }] : [],
  )
  const sent: Sent = { text }
  if (images.length) sent.images = images
  if (msg.uuid) sent.uuid = msg.uuid
  return sent
}

/** The same item but for when it was made: a replay's clock is not the one the stored copy was written by. */
function sameItem(a: TranscriptItem, b: TranscriptItem): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false
  return JSON.stringify(timeless(a)) === JSON.stringify(timeless(b))
}

function timeless(item: TranscriptItem): Record<string, unknown> {
  const { ts: _ts, startedAt: _s, endedAt: _e, ...rest } = item as TranscriptItem & { startedAt?: number; endedAt?: number }
  return rest
}

/** Large pasted images stay out of the history file. */
function forStore(item: TranscriptItem): TranscriptItem {
  if (item.kind !== 'user' || !item.images?.some((i) => (i.dataBase64?.length ?? 0) > MAX_STORED_IMAGE_CHARS)) return item
  return {
    ...item,
    images: item.images.map((i) => {
      if ((i.dataBase64?.length ?? 0) <= MAX_STORED_IMAGE_CHARS) return i
      const { dataBase64: _d, ...rest } = i
      return rest
    }),
  }
}
