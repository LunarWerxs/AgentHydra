// One chat's SDK query, run in a host process outside the Hydra Desk server (SPEC "Chat hosts"). This is the
// host's logic without its socket, so tests drive it directly. It hands the query's messages and its
// permission and elicitation calls to the connected server, keeps the journal a restarted server replays,
// and ends the host when the chat is done with it or no server came back for it.

import { randomUUID } from 'node:crypto'
import type { CanUseTool, ElicitationResult, OnElicitation, Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { HOST_PROTOCOL, NOT_CALLABLE, type HostEnd, type HostMessage, type HostRequest, type HostSpec, type JournalEntry, type ServerMessage, type ToolRequestOptions } from './protocol'

export type HostQueryImpl = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query

/** The server's end of a connection, as the host sees it. */
export interface ServerLink {
  send(msg: HostMessage): void
  close(): void
}

export interface HostCoreDeps {
  spec: HostSpec
  queryImpl: HostQueryImpl
  /** Ends the process. */
  exit(code: number): void
  now?: () => number
  pid?: number
  /** Journal size that starts a trim (default 50,000): stream deltas and tool progress before the newest whole entry go. */
  maxJournal?: number
  /** A line for the host's own log. */
  log?(line: string): void
}

const STDERR_TAIL_CHARS = 4000
/** After the query ended and the server was told, the host waits this long for the frame to leave. */
const EXIT_AFTER_END_MS = 1000

/** The input the SDK reads for the chat's whole life: what the server sends, in order. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null
  private closed = false

  push(msg: SDKUserMessage): void {
    if (this.closed) return
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: msg, done: false })
    } else this.items.push(msg)
  }

  close(): void {
    this.closed = true
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const head = this.items.shift()
        if (head) return Promise.resolve({ value: head, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiter = resolve
        })
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

type Recordable = { kind: 'sdk'; msg: SDKMessage } | { kind: 'input'; msg: SDKUserMessage } | { kind: 'interrupt' }

export class HostCore {
  readonly startedAt: number
  private readonly spec: HostSpec
  private readonly queryImpl: HostQueryImpl
  private readonly exitProcess: (code: number) => void
  private readonly now: () => number
  private readonly pid: number
  private readonly maxJournal: number
  private readonly log: (line: string) => void

  private query: Query | null = null
  private readonly input = new MessageQueue()
  private link: ServerLink | null = null
  private seq = 0
  private journal: JournalEntry[] = []
  /** The journal length that starts the next trim: doubles past what a trim could not drop, so trims stay rare. */
  private trimAt: number
  /** The seq the server's last ack named, and the state it left with it (SPEC "Chat hosts"). */
  private acked = 0
  private carry: unknown
  /** The newest SDK entry a server was sent: after it, what the query did reached no one. */
  private delivered = 0
  /** Open requests by callId; `shown`: a server was sent it. */
  private readonly open = new Map<string, { request: HostRequest; resolve(result: unknown): void; shown: boolean }>()
  private end: HostEnd | null = null
  /** The CLI's session state. 'running' from the moment a message goes in, until the CLI says otherwise. */
  private state: 'idle' | 'running' | 'requires_action' = 'idle'
  /** The CLI reports its state (newer CLIs do): else a result is the turn's end. */
  private sawState = false
  private stderrTail = ''
  private orphanTimer: ReturnType<typeof setTimeout> | null = null
  private exiting = false

  constructor(deps: HostCoreDeps) {
    this.spec = deps.spec
    this.queryImpl = deps.queryImpl
    this.exitProcess = deps.exit
    this.now = deps.now ?? Date.now
    this.pid = deps.pid ?? process.pid
    this.maxJournal = deps.maxJournal ?? 50_000
    this.trimAt = this.maxJournal
    this.log = deps.log ?? (() => {})
    this.carry = deps.spec.carry ?? null
    this.startedAt = this.now()
  }

  /** Starts the query. Until a server connects the host counts as unattended (the starting server connects within seconds). */
  start(): void {
    const options: Options = {
      ...(this.spec.options as Options),
      canUseTool: this.canUseTool,
      onElicitation: this.onElicitation,
      stderr: (data: string) => this.onStderr(data),
    }
    this.query = this.queryImpl({ prompt: this.input, options })
    void this.consume(this.query)
    this.armOrphan()
  }

  /** A server connected (a newer one replaces an older): it gets what it must replay, then the live traffic. */
  attach(link: ServerLink): void {
    if (this.exiting) {
      link.close()
      return
    }
    const old = this.link
    this.link = link
    if (old && old !== link) old.close()
    this.disarmOrphan()
    this.log(`server attached (${this.journal.length} journal entries, ${this.open.size} open requests${this.end ? ', query ended' : ''})`)
    link.send({
      type: 'hello',
      protocol: HOST_PROTOCOL,
      chatId: this.spec.chatId,
      pid: this.pid,
      startedAt: this.startedAt,
      account: this.spec.account,
      requests: [...this.open.values()].map((o) => o.request),
      end: this.end,
      acked: this.acked,
      carry: this.carry,
      delivered: this.delivered,
      unshown: [...this.open.values()].flatMap((o) => (o.shown ? [] : [o.request.callId])),
    })
    for (const entry of this.journal) link.send({ type: 'replay', entry })
    link.send({ type: 'ready' })
    // This server has it all now.
    this.delivered = this.seq
    for (const o of this.open.values()) o.shown = true
    if (this.end) this.exitSoon()
  }

  /** The connection went (the server stopped or restarts): the chat keeps going. */
  detach(link: ServerLink): void {
    if (this.link !== link) return
    this.link = null
    this.log('server detached')
    this.armOrphan()
  }

  receive(msg: ServerMessage, from: ServerLink): void {
    if (from !== this.link) return // a replaced connection's last words
    switch (msg.type) {
      case 'input':
        if (!this.query) return // the query ended; the server knows from 'end'
        this.record({ kind: 'input', msg: msg.msg })
        this.setState('running')
        this.input.push(msg.msg)
        return
      case 'answer': {
        const o = this.open.get(msg.callId)
        if (!o) return
        this.open.delete(msg.callId)
        // A No that stops the turn is part of the turn's story, as a Stop is.
        if ((msg.result as { interrupt?: unknown } | null)?.interrupt === true) this.record({ kind: 'interrupt' })
        o.resolve(msg.result)
        return
      }
      case 'call': {
        const args = [...msg.args]
        for (const i of msg.undefinedAt ?? []) args[i] = undefined
        void this.call(msg.rpcId, msg.method, args)
        return
      }
      case 'ack': {
        const keep = new Set(msg.keepInputs)
        this.acked = Math.max(this.acked, msg.upTo)
        this.carry = msg.carry ?? null
        this.journal = this.journal.filter((e) => e.seq > msg.upTo || (e.kind === 'input' && keep.has(e.msg.uuid ?? '')))
        this.trimAt = Math.max(this.maxJournal, this.journal.length * 2)
        return
      }
      case 'detach': {
        // What was sent on but not handled reached no one: the next server tells it.
        this.log(`server lets go, having seen up to ${msg.seen} of ${this.seq}`)
        this.delivered = msg.seen
        const shown = new Set(msg.shown)
        for (const [callId, o] of this.open) o.shown = shown.has(callId)
        this.detach(from)
        // The server waits for this close: it is how it knows the host has its last word.
        from.close()
        return
      }
      case 'close':
        this.log('closed by the server')
        this.shutdown(0)
        return
    }
  }

  /** Ends the query and the process. */
  shutdown(code: number): void {
    if (this.exiting) return
    this.exiting = true
    this.disarmOrphan()
    this.input.close()
    const q = this.query
    this.query = null
    try {
      q?.close()
    } catch {
      // already gone
    }
    this.link?.close()
    this.link = null
    this.exitProcess(code)
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.record({ kind: 'sdk', msg })
      this.finish(null)
    } catch (err) {
      this.finish(err instanceof Error ? err.message : String(err))
    }
  }

  private record(e: Recordable): void {
    const entry = { seq: ++this.seq, at: this.now(), ...e } as JournalEntry
    this.journal.push(entry)
    if (entry.kind === 'sdk') {
      this.noteState(entry.msg)
      if (this.link) {
        this.link.send({ type: 'entry', entry })
        this.delivered = entry.seq
      }
    }
    if (this.journal.length > this.trimAt) this.trim()
  }

  /**
   * A long turn's journal sheds what a replay does without: text deltas (the finished assistant message carries
   * the whole text; message and block starts stay, so the ids line up) and tool progress (the next one replaces
   * it). Only before the newest entry of another kind: what streams right now replays whole.
   */
  private trim(): void {
    let lastWhole = -1
    for (let i = this.journal.length - 1; i >= 0; i--) {
      if (!isSheddable(this.journal[i]!)) {
        lastWhole = i
        break
      }
    }
    this.journal = this.journal.filter((e, i) => i >= lastWhole || !isSheddable(e))
    this.trimAt = Math.max(this.maxJournal, this.journal.length * 2)
  }

  private noteState(msg: SDKMessage): void {
    const m = msg as { type: string; subtype?: string; state?: string }
    if (m.type === 'system' && m.subtype === 'session_state_changed') {
      if (m.state === 'idle' || m.state === 'running' || m.state === 'requires_action') {
        this.sawState = true
        this.setState(m.state)
      }
    } else if (m.type === 'result' && !this.sawState) this.setState('idle')
  }

  private setState(state: 'idle' | 'running' | 'requires_action'): void {
    this.state = state
    if (state === 'running') this.disarmOrphan()
    else this.armOrphan()
  }

  private async call(rpcId: number, method: string, args: unknown[]): Promise<void> {
    const q = this.query as unknown as Record<string, unknown> | null
    const fn = q?.[method]
    if (!q || NOT_CALLABLE.has(method) || typeof fn !== 'function') {
      this.link?.send({ type: 'reply', rpcId, ok: false, error: q ? `no such call: ${method}` : 'the chat process has ended' })
      return
    }
    // A Stop is part of the turn's story: a restarted server replays it with the turn.
    if (method === 'interrupt') this.record({ kind: 'interrupt' })
    try {
      const value = await (fn as (...a: unknown[]) => unknown).apply(q, args)
      this.link?.send({ type: 'reply', rpcId, ok: true, value: value ?? null })
    } catch (err) {
      this.link?.send({ type: 'reply', rpcId, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private readonly canUseTool: CanUseTool = (toolName, input, opts) =>
    new Promise<PermissionResult>((resolve) => {
      const { signal, ...options } = opts
      const request: HostRequest = { callId: opts.requestId || randomUUID(), kind: 'tool', toolName, input, options: options as ToolRequestOptions }
      this.ask(request, signal, (r) => resolve(r as PermissionResult), { behavior: 'deny', message: 'The request expired.', interrupt: true })
    })

  private readonly onElicitation: OnElicitation = (request, opts) =>
    new Promise<ElicitationResult | null>((resolve) => {
      const r: HostRequest = { callId: opts.requestId || randomUUID(), kind: 'elicitation', request }
      this.ask(r, opts.signal, (v) => resolve(v as ElicitationResult), { action: 'cancel' })
    })

  /** A request waits for the server's answer; one aborted by the SDK ends unanswered. Open requests outlive a restart. */
  private ask(request: HostRequest, signal: AbortSignal, resolve: (result: unknown) => void, whenAborted: unknown): void {
    this.open.set(request.callId, { request, resolve, shown: this.link !== null })
    signal.addEventListener(
      'abort',
      () => {
        if (!this.open.delete(request.callId)) return
        this.link?.send({ type: 'abort', callId: request.callId })
        resolve(whenAborted)
      },
      { once: true },
    )
    this.link?.send({ type: 'request', request })
  }

  private onStderr(data: string): void {
    this.stderrTail = (this.stderrTail + data).slice(-STDERR_TAIL_CHARS)
    this.link?.send({ type: 'stderr', data })
  }

  /** The query ended: the server learns now, or from hello when one comes back for it. */
  private finish(error: string | null): void {
    if (this.end || this.exiting) return
    this.end = { error, stderrTail: this.stderrTail }
    this.query = null
    this.input.close()
    this.open.clear()
    this.log(error ? `query ended: ${error}` : 'query ended')
    if (this.link) {
      this.link.send({ type: 'end', end: this.end })
      this.exitSoon()
    } else this.armOrphan()
  }

  private exitSoon(): void {
    setTimeout(() => this.shutdown(0), EXIT_AFTER_END_MS)
  }

  /** With no server, a chat that is not working waits orphanMinutes for one, then ends. A working one goes on. */
  private armOrphan(): void {
    if (this.link || this.exiting) return
    if (this.state === 'running' && !this.end) {
      this.disarmOrphan()
      return
    }
    if (this.orphanTimer) return
    this.orphanTimer = setTimeout(() => {
      this.orphanTimer = null
      this.log(`no server for ${this.spec.orphanMinutes} min: ending`)
      this.shutdown(0)
    }, this.spec.orphanMinutes * 60_000)
  }

  private disarmOrphan(): void {
    if (this.orphanTimer) clearTimeout(this.orphanTimer)
    this.orphanTimer = null
  }
}

function isSheddable(e: JournalEntry): boolean {
  if (e.kind !== 'sdk') return false
  const m = e.msg as { type: string; event?: { type?: string } }
  return (m.type === 'stream_event' && m.event?.type === 'content_block_delta') || m.type === 'tool_progress'
}
