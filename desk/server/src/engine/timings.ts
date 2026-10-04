// Speed tracking (SPEC "Speed (timings)"): one JSON line per measured stage in <home>/timings.jsonl, rolled like
// the failure ledger. An SDK chat is timed from the SDK's own messages (hook_started / hook_response, system/init,
// stream_event, tool_use / tool_result, result) against the server's clock; a worker chat from what the poll
// sees. Nothing here may break a chat: every entry point swallows its own errors, and a timer never holds the
// process open.

import { randomUUID } from 'node:crypto'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatSummary } from '@shared/protocol'
import type { ColdKind, GroupStats, StageStats, TimingSpan, TimingsResponse, TimingStage, TurnRow } from '@shared/timings'
import { JsonlLog } from './diagnostics'

const DAY = 86_400_000
const SLOWEST_TURNS = 20
/** The MCP status of a starting process is read this often, each read given this long, for at most this long. */
const MCP_POLL_MS = 500
const MCP_READ_MS = 2000
const MCP_MAX_MS = 30_000
/** SessionStart hooks that ended and were followed by nothing for this long are one finished group. */
const HOOK_GROUP_SETTLE_MS = 1000
/** What the owner waits on: the stages "what is slow right now" ranks (a whole turn, the model's own time and the background polls are not waits). */
const WAIT_STAGES = new Set<TimingStage>(['click_to_server', 'click_to_bubble', 'open_to_paint', 'process_start', 'session_start_hooks', 'hook', 'mcp_connect', 'ready', 'queue_wait', 'first_token', 'tool', 'worker_accept', 'worker_queue', 'worker_first_item', 'account_move', 'chat_open', 'title'])
/** Stages listed one row per name. */
const NAMED = new Set<TimingStage>(['hook', 'tool', 'mcp_connect', 'session_start_hooks', 'account_move'])

/** Nearest rank: the smallest value with at least p of the values at or under it. 0 for none. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!
}

/** A `sync_poll` line stands for `n` polls of mean `ms`; every other line is one measurement. */
const weight = (s: TimingSpan): number => (s.stage === 'sync_poll' ? (s.n ?? 1) : 1)

function summarize(spans: TimingSpan[]): { count: number; p50: number; p90: number; max: number; totalMs: number } {
  const ms = spans.map((s) => s.ms)
  return {
    count: spans.reduce((n, s) => n + weight(s), 0),
    p50: percentile(ms, 0.5),
    p90: percentile(ms, 0.9),
    max: spans.reduce((m, s) => Math.max(m, s.max ?? s.ms), 0),
    totalMs: Math.round(spans.reduce((t, s) => t + s.ms * weight(s), 0)),
  }
}

/** One row per stage (or per stage and name with `byName`), the most total time first; ties by stage then name. */
export function stageStats(spans: TimingSpan[], byName = false): StageStats[] {
  const groups = new Map<string, TimingSpan[]>()
  for (const s of spans) {
    const key = byName && s.name ? `${s.stage}\n${s.name}` : s.stage
    const g = groups.get(key)
    if (g) g.push(s)
    else groups.set(key, [s])
  }
  const rows = [...groups.values()].map((g): StageStats => {
    const first = g[0]!
    return { stage: first.stage, ...(byName && first.name ? { name: first.name } : {}), ...summarize(g) }
  })
  return rows.sort((a, b) => b.totalMs - a.totalMs || a.stage.localeCompare(b.stage) || (a.name ?? '').localeCompare(b.name ?? ''))
}

/** Spans by `key`, the most total time first. */
export function groupStats(spans: TimingSpan[], key: (s: TimingSpan) => string): GroupStats[] {
  const groups = new Map<string, TimingSpan[]>()
  for (const s of spans) {
    const k = key(s)
    const g = groups.get(k)
    if (g) g.push(s)
    else groups.set(k, [s])
  }
  return [...groups.entries()]
    .map(([k, g]): GroupStats => {
      const { count, ...rest } = summarize(g)
      return { key: k, turns: count, ...rest }
    })
    .sort((a, b) => b.totalMs - a.totalMs || a.key.localeCompare(b.key))
}

/** The report GET /api/diagnostics/timings answers, from the lines of the last 7 days. */
export function buildReport(all: TimingSpan[], now: number): TimingsResponse {
  const week = all.filter((s) => s.ts >= now - 7 * DAY && s.ts <= now + DAY)
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const today = week.filter((s) => s.ts >= midnight.getTime())
  const turns = week.filter((s) => s.stage === 'turn' || s.stage === 'worker_turn')
  const named = (list: TimingSpan[], keep: (s: TimingSpan) => boolean): StageStats[] => [...stageStats(list.filter((s) => keep(s) && NAMED.has(s.stage)), true), ...stageStats(list.filter((s) => keep(s) && !NAMED.has(s.stage)))].sort((a, b) => b.totalMs - a.totalMs)
  const isSessionStart = (s: TimingSpan): boolean => s.stage === 'hook' && (s.name ?? '').startsWith('SessionStart')
  return {
    today: stageStats(today),
    week: stageStats(week),
    slowestTurns: [...turns]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, SLOWEST_TURNS)
      .map(
        (s): TurnRow => ({
          ts: s.ts,
          chatId: s.chatId ?? '',
          turnId: s.turnId ?? '',
          ms: s.ms,
          kind: s.kind ?? (s.stage === 'worker_turn' ? 'worker' : 'sdk'),
          cold: s.cold ?? null,
          accountId: s.accountId ?? null,
          accountNumber: s.accountNumber ?? null,
          model: s.model ?? null,
          cwd: s.cwd ?? null,
          ok: s.ok !== false,
          stages: s.stages ?? {},
        }),
      ),
    coldStart: named(week, (s) => s.stage === 'process_start' || s.stage === 'session_start_hooks' || s.stage === 'mcp_connect' || isSessionStart(s)),
    ready: groupStats(week.filter((s) => s.stage === 'ready'), (s) => s.cold ?? 'running'),
    hooks: stageStats(week.filter((s) => s.stage === 'hook'), true),
    tools: stageStats(week.filter((s) => s.stage === 'tool'), true),
    workers: named(week, (s) => s.stage === 'worker_accept' || s.stage === 'worker_queue' || s.stage === 'worker_first_item' || s.stage === 'account_move'),
    slowNow: named(today, (s) => WAIT_STAGES.has(s.stage)),
    byAccount: groupStats(turns, (s) => (typeof s.accountNumber === 'number' ? `#${s.accountNumber}` : (s.accountId ?? 'unknown'))),
    byModel: groupStats(turns, (s) => s.model ?? 'default'),
    byFolder: groupStats(turns, (s) => s.cwd ?? 'unknown'),
    spans: week.length,
  }
}

interface Turn {
  id: string
  sentAt: number
  /** When its own turn began: the send, or the end of the turn it waited behind. */
  startedAt: number
  cold: ColdKind
  queued: boolean
  readyAt: number | null
  firstToken: boolean
  stages: Record<string, number>
}

interface SdkState {
  /** When the process was started; null before its first start. */
  startedAt: number | null
  sawMessage: boolean
  inited: boolean
  /** Started ahead of a message (the warm start), and no turn has used it yet. */
  warm: boolean
  hooks: Map<string, { name: string; at: number }>
  /** The SessionStart hooks of this start: the first one's start, the last one's end, how many still run. */
  group: { name: string; from: number; to: number; open: number; timer: ReturnType<typeof setTimeout> | null } | null
  tools: Map<string, { name: string; at: number }>
  turns: Turn[]
  mcpTimer: ReturnType<typeof setTimeout> | null
  mcpSeen: Set<string>
}

interface WorkerTurn {
  id: string
  sentAt: number
  acceptedAt: number
  running: boolean
  firstItem: boolean
  stages: Record<string, number>
}

type Meta = Pick<TimingSpan, 'chatId' | 'kind' | 'accountId' | 'accountNumber' | 'model' | 'cwd'>

const logs = new Map<string, Timings>()

export class Timings {
  private readonly log: JsonlLog
  private readonly sdk = new Map<string, SdkState>()
  private readonly workers = new Map<string, WorkerTurn>()
  private polls: { minute: number; n: number; sum: number; max: number } | null = null

  constructor(
    readonly home: string,
    private readonly now: () => number = Date.now,
  ) {
    this.log = new JsonlLog(home, 'timings', now)
  }

  /** The one log of a data home: the manager and the routes write the same file. */
  static for(home: string, now?: () => number): Timings {
    let t = logs.get(home)
    if (!t) logs.set(home, (t = new Timings(home, now)))
    return t
  }

  get file(): string {
    return this.log.file
  }

  /** Appends one line; `ts` is now. A negative or unreadable duration is dropped. */
  span(s: Omit<TimingSpan, 'ts'>): void {
    if (!Number.isFinite(s.ms) || s.ms < 0) return
    this.log.append({ ts: this.now(), ...s, ms: Math.round(s.ms) })
  }

  read(): TimingSpan[] {
    return (this.log.read(true) as TimingSpan[]).filter((s) => s && typeof s.ts === 'number' && typeof s.ms === 'number' && typeof s.stage === 'string')
  }

  report(): TimingsResponse {
    this.flushPolls(true)
    return buildReport(this.read(), this.now())
  }

  // An SDK chat

  /** A message is about to be sent. `running`: the chat's process was up before it. */
  sdkSent(chat: ChatSummary, running: boolean): void {
    this.guard(() => {
      const st = this.stateOf(chat.id)
      const now = this.now()
      // A process that ended without closing (a crash) left turns no result will end.
      if (!running) st.turns.length = 0
      const queued = st.turns.length > 0
      let cold: ColdKind = null
      if (!running) cold = chat.sessionId || chat.forkedFrom ? 'resume' : 'new'
      else if (st.warm) cold = 'warm'
      st.warm = false
      const turn: Turn = { id: randomUUID(), sentAt: now, startedAt: now, cold, queued, readyAt: null, firstToken: false, stages: {} }
      st.turns.push(turn)
      // A process already up and through its start is ready now: the warm start's whole point.
      if (queued || !running || !st.inited) return
      if (cold) this.ready(chat, st, turn)
      else turn.readyAt = now
    })
  }

  /** The chat's process was started (`attach`: taken over from a chat host, already running). */
  sdkStarted(chat: ChatSummary, q: Query, o: { attach: boolean }): void {
    this.guard(() => {
      const st = this.stateOf(chat.id)
      this.stopTimers(st)
      st.startedAt = this.now()
      st.sawMessage = o.attach
      st.inited = o.attach
      st.warm = false
      st.hooks.clear()
      st.tools.clear()
      st.group = null
      st.mcpSeen.clear()
      if (!o.attach) this.pollMcp(chat, st, q, st.startedAt)
    })
  }

  /** The start just made was the warm one: no message asked for it. */
  sdkWarmed(chatId: string): void {
    const st = this.sdk.get(chatId)
    if (st) st.warm = true
  }

  sdkClosed(chatId: string): void {
    const st = this.sdk.get(chatId)
    if (!st) return
    this.stopTimers(st)
    this.sdk.delete(chatId)
  }

  /** Every message of a running chat, live ones only. */
  sdkMessage(chat: ChatSummary, msg: SDKMessage): void {
    this.guard(() => {
      const st = this.sdk.get(chat.id)
      if (!st || st.startedAt === null) return
      const now = this.now()
      const m = msg as { type: string; subtype?: string }
      if (!st.sawMessage) {
        st.sawMessage = true
        this.put(chat, st, { stage: 'process_start', ms: now - st.startedAt })
      }
      if (m.type === 'system' && m.subtype === 'hook_started') return this.hookStarted(st, msg, now)
      if (m.type === 'system' && m.subtype === 'hook_response') return this.hookEnded(chat, st, msg, now)
      if (m.type === 'system' && m.subtype === 'init') {
        this.flushGroup(chat, st)
        const first = !st.inited
        st.inited = true
        if (first && st.warm) this.put(chat, st, { stage: 'warm', ms: now - st.startedAt })
        const head = st.turns[0]
        if (head && head.readyAt === null) this.ready(chat, st, head)
        return
      }
      const head = st.turns[0]
      if (m.type === 'stream_event' && (msg as { event?: { type?: string } }).event?.type === 'content_block_delta') return this.firstToken(chat, st, head, now)
      if (m.type === 'assistant') {
        this.firstToken(chat, st, head, now)
        for (const b of blocks(msg)) if (b.type === 'tool_use' && typeof b.id === 'string') st.tools.set(b.id, { name: String(b.name ?? 'tool'), at: now })
        return
      }
      if (m.type === 'user') {
        for (const b of blocks(msg)) {
          const t = b.type === 'tool_result' && typeof b.tool_use_id === 'string' ? st.tools.get(b.tool_use_id) : undefined
          if (!t) continue
          st.tools.delete(b.tool_use_id as string)
          this.put(chat, st, { stage: 'tool', name: t.name, ms: now - t.at, ok: b.is_error !== true }, 'tools')
        }
        return
      }
      if (m.type === 'result') this.turnEnded(chat, st, msg, now)
    })
  }

  private ready(chat: ChatSummary, st: SdkState, turn: Turn): void {
    turn.readyAt = this.now()
    this.put(chat, st, { stage: 'ready', ms: turn.readyAt - turn.sentAt, cold: turn.cold }, 'ready', turn)
  }

  private firstToken(chat: ChatSummary, st: SdkState, head: Turn | undefined, now: number): void {
    if (!head || head.firstToken) return
    head.firstToken = true
    // From when the model could begin: the turn's start, or the process being ready when that came later.
    this.put(chat, st, { stage: 'first_token', ms: now - Math.max(head.startedAt, head.readyAt ?? 0) }, 'first_token', head)
  }

  private hookStarted(st: SdkState, msg: SDKMessage, now: number): void {
    const h = msg as { hook_id?: unknown; hook_name?: unknown; hook_event?: unknown }
    const name = String(h.hook_name ?? h.hook_event ?? 'hook')
    st.hooks.set(String(h.hook_id ?? name), { name, at: now })
    if (!name.startsWith('SessionStart')) return
    if (st.group?.timer) clearTimeout(st.group.timer)
    if (st.group) st.group = { ...st.group, open: st.group.open + 1, timer: null }
    else st.group = { name: name.split(':')[1] || 'startup', from: now, to: now, open: 1, timer: null }
  }

  private hookEnded(chat: ChatSummary, st: SdkState, msg: SDKMessage, now: number): void {
    const h = msg as { hook_id?: unknown; hook_name?: unknown; hook_event?: unknown; outcome?: unknown; stderr?: unknown; output?: unknown; stdout?: unknown }
    const id = String(h.hook_id ?? h.hook_name ?? h.hook_event ?? 'hook')
    const started = st.hooks.get(id)
    if (!started) return
    st.hooks.delete(id)
    // The SDK names the event ('SessionStart:startup'), not the script; a hook that says which file it is (a
    // timeout, an error) is listed under it.
    const script = /([\w.-]+\.(?:mjs|cjs|js|ts|py|sh|ps1|cmd|bat))\b/.exec(`${String(h.stderr ?? '')}\n${String(h.output ?? '')}\n${String(h.stdout ?? '')}`.slice(0, 4000))?.[1]
    const event = String(h.hook_event ?? started.name.split(':')[0])
    this.put(chat, st, { stage: 'hook', name: script ? `${event}:${script}` : started.name, ms: now - started.at, ok: h.outcome !== 'error' }, 'hooks')
    const g = st.group
    if (!g || !started.name.startsWith('SessionStart')) return
    g.to = now
    g.open = Math.max(0, g.open - 1)
    if (g.open > 0) return
    g.timer = setTimeout(() => this.guard(() => this.flushGroup(chat, st)), HOOK_GROUP_SETTLE_MS)
    ;(g.timer as { unref?: () => void }).unref?.()
  }

  private flushGroup(chat: ChatSummary, st: SdkState): void {
    const g = st.group
    if (!g) return
    if (g.timer) clearTimeout(g.timer)
    st.group = null
    this.put(chat, st, { stage: 'session_start_hooks', name: g.name, ms: g.to - g.from })
  }

  private turnEnded(chat: ChatSummary, st: SdkState, msg: SDKMessage, now: number): void {
    const head = st.turns.shift()
    if (!head) return
    const r = msg as { duration_api_ms?: unknown; is_error?: unknown; queued_turn_count?: unknown }
    if (typeof r.duration_api_ms === 'number') this.put(chat, st, { stage: 'api', ms: r.duration_api_ms }, 'api', head)
    this.span({ ...meta(chat), stage: 'turn', turnId: head.id, ms: now - head.sentAt, cold: head.cold, ok: r.is_error !== true, stages: head.stages })
    // The CLI says nothing waits: sends made during the turn were folded into it.
    if (r.queued_turn_count === 0) st.turns.length = 0
    const next = st.turns[0]
    if (!next) return
    next.startedAt = now
    next.readyAt = now
    this.put(chat, st, { stage: 'queue_wait', ms: now - next.sentAt }, 'queue_wait', next)
  }

  /** One line for the chat; `sum` adds it to the breakdown of the turn it belongs to (the oldest open one). */
  private put(chat: ChatSummary, st: SdkState, s: Pick<TimingSpan, 'stage' | 'ms'> & Partial<TimingSpan>, sum?: string, turn: Turn | undefined = st.turns[0]): void {
    if (sum && turn && Number.isFinite(s.ms) && s.ms >= 0) turn.stages[sum] = (turn.stages[sum] ?? 0) + Math.round(s.ms)
    this.span({ ...meta(chat), ...(turn ? { turnId: turn.id } : {}), ...s })
  }

  /** Each MCP server's time from the process start to its first answer other than 'pending' (resolution MCP_POLL_MS). */
  private pollMcp(chat: ChatSummary, st: SdkState, q: Query, startedAt: number): void {
    const again = (): void => {
      if (st.startedAt !== startedAt || this.now() - startedAt > MCP_MAX_MS) return
      st.mcpTimer = setTimeout(() => void read(), MCP_POLL_MS)
      ;(st.mcpTimer as { unref?: () => void }).unref?.()
    }
    const read = async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const list = await Promise.race([
          q.mcpServerStatus(),
          new Promise<null>((r) => {
            timer = setTimeout(() => r(null), MCP_READ_MS)
            ;(timer as { unref?: () => void }).unref?.()
          }),
        ])
        if (st.startedAt !== startedAt) return
        if (!list) return again()
        let pending = false
        for (const s of list) {
          if (s.status === 'pending') pending = true
          else if (s.status !== 'disabled' && !st.mcpSeen.has(s.name)) {
            st.mcpSeen.add(s.name)
            this.put(chat, st, { stage: 'mcp_connect', name: s.name, ms: this.now() - startedAt, ok: s.status === 'connected' })
          }
        }
        if (pending) again()
      } catch {
        // an older CLI, or the process went away: no MCP timing for this start
      } finally {
        clearTimeout(timer)
      }
    }
    again()
  }

  private stateOf(chatId: string): SdkState {
    let st = this.sdk.get(chatId)
    if (!st) this.sdk.set(chatId, (st = { startedAt: null, sawMessage: false, inited: false, warm: false, hooks: new Map(), group: null, tools: new Map(), turns: [], mcpTimer: null, mcpSeen: new Set() }))
    return st
  }

  private stopTimers(st: SdkState): void {
    if (st.mcpTimer) clearTimeout(st.mcpTimer)
    if (st.group?.timer) clearTimeout(st.group.timer)
    st.mcpTimer = null
    st.startedAt = null
  }

  // A worker (CliMayte) chat

  /** CliMayte took the message, `acceptMs` after it was sent. A message sent into a running turn joins that turn. */
  workerSent(chat: ChatSummary, acceptMs: number): void {
    this.guard(() => {
      const now = this.now()
      let t = this.workers.get(chat.id)
      if (!t) this.workers.set(chat.id, (t = { id: randomUUID(), sentAt: now - acceptMs, acceptedAt: now, running: false, firstItem: false, stages: {} }))
      this.putWorker(chat, t, { stage: 'worker_accept', ms: acceptMs }, 'worker_accept')
    })
  }

  /** What one poll saw of the chat's worker: whether it runs, whether it is still at work, and whether a new assistant item came. */
  workerSeen(chat: ChatSummary, o: { running: boolean; active: boolean; newReply: boolean; ok: boolean }): void {
    this.guard(() => {
      const t = this.workers.get(chat.id)
      if (!t) return
      const now = this.now()
      if (!t.running && (o.running || o.newReply || !o.active)) {
        t.running = true
        this.putWorker(chat, t, { stage: 'worker_queue', ms: now - t.acceptedAt }, 'worker_queue')
      }
      if (!t.firstItem && o.newReply) {
        t.firstItem = true
        this.putWorker(chat, t, { stage: 'worker_first_item', ms: now - t.sentAt }, 'worker_first_item')
      }
      if (o.active) return
      this.workers.delete(chat.id)
      this.span({ ...meta(chat), stage: 'worker_turn', turnId: t.id, ms: now - t.sentAt, ok: o.ok, stages: t.stages })
    })
  }

  /** CliMayte moved the chat's worker to another account; the delay is the time since the message was sent. */
  workerMoved(chat: ChatSummary, name: string): void {
    this.guard(() => {
      const t = this.workers.get(chat.id)
      if (t) this.putWorker(chat, t, { stage: 'account_move', name, ms: this.now() - t.sentAt }, 'account_move')
    })
  }

  private putWorker(chat: ChatSummary, t: WorkerTurn, s: Pick<TimingSpan, 'stage' | 'ms'> & Partial<TimingSpan>, sum: string): void {
    if (Number.isFinite(s.ms) && s.ms >= 0) t.stages[sum] = Math.round(s.ms)
    this.span({ ...meta(chat), turnId: t.id, ...s })
  }

  /** One read of the workers' status and transcripts took `ms`: kept as one line per minute (mean, count, slowest). */
  poll(ms: number): void {
    this.guard(() => {
      this.flushPolls(false)
      const minute = Math.floor(this.now() / 60_000)
      this.polls ??= { minute, n: 0, sum: 0, max: 0 }
      this.polls.n++
      this.polls.sum += ms
      this.polls.max = Math.max(this.polls.max, ms)
    })
  }

  private flushPolls(force: boolean): void {
    const p = this.polls
    if (!p || (!force && p.minute === Math.floor(this.now() / 60_000))) return
    this.polls = null
    this.span({ stage: 'sync_poll', ms: p.sum / p.n, n: p.n, max: Math.round(p.max) })
  }

  private guard(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.warn(`[desk] a timing could not be taken: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function meta(chat: ChatSummary): Meta {
  return { chatId: chat.id, kind: chat.workerId !== undefined ? 'worker' : 'sdk', accountId: chat.account.id, accountNumber: chat.account.number ?? null, model: chat.model ?? null, cwd: chat.cwd }
}

type Block = { type?: string; id?: unknown; name?: unknown; tool_use_id?: unknown; is_error?: unknown }

function blocks(msg: SDKMessage): Block[] {
  const content = (msg as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? (content as Block[]) : []
}
