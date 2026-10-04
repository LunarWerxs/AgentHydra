// The server's side of a chat host (SPEC "Chat hosts"): a Query the runtime drives exactly as it drives the
// SDK's own, while the SDK query runs in the host process. A first start launches a host; after a server
// restart the runtime attaches to the host that kept the chat running and replays its journal
// (ChatRuntime.adopt). Permission and elicitation calls arrive from the host and go to the runtime's callbacks
// with the SDK's own requestId, so a request re-opened after a restart is the same card as before.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { query as sdkQuery, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AccountRef } from '@shared/protocol'
import { hostFilePath, hostsDir, killHostTree, launchHost, listHostFiles, pidAlive, readHostFile } from './launch'
import { HOST_PROTOCOL, type HostEnd, type HostFile, type HostMessage, type HostOptions, type HostRequest, type HostSpec, type JournalEntry, type ServerMessage } from './protocol'

type Hello = Extract<HostMessage, { type: 'hello' }>

/** What the runtime hands its query implementation (the SDK's query() reads prompt and options only). */
export interface HostedParams {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
  chatId?: string
  /** The account the process runs under. */
  account?: AccountRef | null
  /** A host that outlived the server: run on it instead of starting one. */
  attach?: HostConnection
  /** The runtime's state a new host keeps for the next server (SPEC "Chat hosts", carry). */
  carry?: unknown
}

/** An open connection to a host, past its hello: the journal it sent and the requests it still waits on. */
export class HostConnection {
  hello!: Hello
  readonly journal: JournalEntry[] = []
  onClose: (() => void) | null = null
  private handler: ((msg: HostMessage) => void) | null = null
  private early: HostMessage[] = []
  private closed = false
  /** Waits for the host to close the connection after a last word (sayLast). */
  private afterClose: (() => void) | null = null

  private constructor(
    readonly file: HostFile,
    private readonly ws: WebSocket,
  ) {}

  /** Connects and reads the hello and the journal; rejects when the host does not answer in time. */
  static open(file: HostFile, timeoutMs = 5000): Promise<HostConnection> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(`ws://127.0.0.1:${file.port}/?token=${encodeURIComponent(file.token)}`)
      } catch (err) {
        reject(err)
        return
      }
      const conn = new HostConnection(file, ws)
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        conn.closed = true
        try {
          ws.close()
        } catch {
          // never opened
        }
        reject(err)
      }
      const timer = setTimeout(() => fail(new Error(`the chat process on port ${file.port} did not answer`)), timeoutMs)
      ws.onmessage = (ev) => {
        let msg: HostMessage
        try {
          msg = JSON.parse(String(ev.data)) as HostMessage
        } catch {
          return
        }
        if (settled) {
          conn.dispatch(msg)
          return
        }
        if (msg.type === 'hello') {
          if (msg.chatId !== file.chatId) fail(new Error(`port ${file.port} answers for another chat`))
          else conn.hello = msg
        } else if (msg.type === 'replay') conn.journal.push(msg.entry)
        else if (msg.type === 'ready' && conn.hello) {
          settled = true
          clearTimeout(timer)
          resolve(conn)
        }
      }
      ws.onclose = () => {
        if (!settled) fail(new Error(`the chat process on port ${file.port} closed the connection`))
        else if (!conn.closed) {
          conn.closed = true
          conn.onClose?.()
        } else conn.afterClose?.()
      }
      ws.onerror = () => {
        if (!settled) fail(new Error(`no chat process answers on port ${file.port}`))
      }
    })
  }

  get isOpen(): boolean {
    return !this.closed
  }

  /** Live traffic from here on (what arrived since ready is handed over first). */
  setHandler(fn: (msg: HostMessage) => void): void {
    this.handler = fn
    for (const msg of this.early.splice(0)) fn(msg)
  }

  send(msg: ServerMessage): boolean {
    if (this.closed) return false
    try {
      this.ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  /** Ends this connection only; the host goes on. */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.ws.close()
    } catch {
      // already closing
    }
  }

  /** Asks the host to end the chat's process; done once the host closed the connection. */
  end(): Promise<void> {
    return this.sayLast({ type: 'close' })
  }

  /**
   * A last message, after which the host closes the connection. Closing it here instead could lose the message:
   * Bun drops a frame that arrives with the close behind it while the host is sending (a working chat always
   * is). Past `ms` with no close from the host, it is closed here.
   */
  sayLast(msg: ServerMessage, ms = LAST_WORD_MS): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.send(msg)
    this.closed = true
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.ws.close()
        } catch {
          // already closing
        }
        resolve()
      }, ms)
      this.afterClose = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  private dispatch(msg: HostMessage): void {
    if (this.handler) this.handler(msg)
    else this.early.push(msg)
  }
}

export interface HostedDeps {
  home: string
  /** Minutes a host waits for a server once its chat is not working (Settings' idle-close minutes). */
  orphanMinutes?: () => number
  launch?: (spec: HostSpec) => Promise<HostFile>
  connect?: (file: HostFile) => Promise<HostConnection>
}

const hostedQueries = new WeakMap<object, HostedQuery>()

/** The hosted query behind a Query the runtime holds; null for an in-process one. */
export function hostedOf(q: unknown): HostedQuery | null {
  return q && typeof q === 'object' ? (hostedQueries.get(q) ?? null) : null
}

/** Query's control methods (SDK 0.3.288): each one is a call into the host. */
const CALLS = new Set([
  'interrupt',
  'setPermissionMode',
  'setMcpPermissionModeOverride',
  'setModel',
  'setMaxThinkingTokens',
  'applyFlagSettings',
  'updateSettings',
  'initializationResult',
  'reinitialize',
  'supportedCommands',
  'supportedModels',
  'supportedAgents',
  'mcpServerStatus',
  'getContextUsage',
  'readFile',
  'reloadPlugins',
  'reloadSkills',
  'reloadOutputStyles',
  'accountInfo',
  'rewindFiles',
  'seedReadState',
  'reconnectMcpServer',
  'toggleMcpServer',
  'readMcpResource',
  'setMcpServers',
  'stopTask',
  'backgroundTasks',
])

/** How long a last word (detach, close) waits for the host to close the connection before it is closed here. */
const LAST_WORD_MS = 3000

/** How often a dropped connection to a live host is tried again before the chat counts as gone. */
const RECONNECT_TRIES = 3
const RECONNECT_DELAY_MS = 300
/** How long a stopping server waits for a host still starting, so the send that started it reaches it. */
const DETACH_WAIT_MS = 10_000

/** The SDK options a host can take: everything but the callbacks, which stay here. */
export function hostOptions(options: Options): HostOptions {
  const { canUseTool: _c, onElicitation: _e, stderr: _s, abortController: _a, hooks: _h, spawnClaudeCodeProcess: _p, ...rest } = options
  return rest
}

export class HostedQuery {
  /** What the runtime holds: an SDK Query whose methods run in the host. */
  readonly query: Query
  /** What a server restart left to replay, taken once by the runtime (adopt). */
  private journal: JournalEntry[] = []
  /** Requests that wait for the replay: the host's open ones at attach, and any that came before adopt was done. */
  private reopen: HostRequest[] = []
  /** The query ended while no server was there: applied after the replay. */
  private pendingEnd: HostEnd | null = null
  /** Done once the host has the last word: closed after close(), let go after detach(). */
  private lastWord: Promise<void> = Promise.resolve()
  /** False until the runtime replayed the journal (a fresh launch has none). */
  private adopted: boolean
  private conn: HostConnection | null = null
  private readonly connected: Promise<HostConnection>
  private readonly outbox: ServerMessage[] = []
  private readonly messages: SDKMessage[] = []
  private waiter: { resolve(r: IteratorResult<SDKMessage, void>): void; reject(err: unknown): void } | null = null
  private failure: Error | null = null
  private done = false
  private closing = false
  private detached = false
  private readonly seqs = new WeakMap<object, number>()
  private lastSeq = 0
  /** The newest entry the runtime took (next() gave it, or the replay): what this server saw, said when it lets go. */
  private handledSeq = 0
  private nextRpc = 0
  private readonly rpcs = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>()
  private readonly aborts = new Map<string, AbortController>()

  constructor(
    private readonly params: HostedParams,
    private readonly deps: HostedDeps,
  ) {
    const attach = params.attach
    this.adopted = !attach
    if (attach) {
      this.journal = [...attach.journal]
      for (const e of this.journal) if (e.kind === 'sdk') this.seqs.set(e.msg, e.seq)
      this.lastSeq = this.journal.at(-1)?.seq ?? 0
      this.reopen = [...attach.hello.requests]
      this.pendingEnd = attach.hello.end
      this.connected = Promise.resolve(this.bind(attach, false))
    } else {
      this.connected = this.launch().then((c) => this.bind(c, false))
      this.connected.catch((err) => this.fail(err instanceof Error ? err : new Error(String(err))))
    }
    void this.pump()
    this.query = new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === Symbol.asyncIterator) return () => receiver
        if (prop === 'next') return () => target.next()
        if (prop === 'return' || prop === 'throw') return () => target.stop()
        if (prop === 'close') return () => target.close()
        if (typeof prop === 'string' && CALLS.has(prop)) return (...args: unknown[]) => target.call(prop, args)
        return undefined
      },
    }) as unknown as Query
    hostedQueries.set(this.query, this)
  }

  /** The journal a restart left, once: the runtime replays it before anything live. */
  takeJournal(): JournalEntry[] {
    const j = this.journal
    this.journal = []
    this.handledSeq = Math.max(this.handledSeq, j.at(-1)?.seq ?? 0)
    return j
  }

  /** After the replay: the requests the host still waits on come back (same ids), then an end that came meanwhile. */
  reopenRequests(): void {
    this.adopted = true
    for (const r of this.reopen.splice(0)) this.invoke(r)
    const end = this.pendingEnd
    this.pendingEnd = null
    if (end) this.applyEnd(end, true)
  }

  /**
   * The runtime is done with everything up to `msg` (it reached a quiet point after a turn): the host drops it,
   * but for the sends a later turn may still need, and keeps `carry` for the next server.
   */
  ack(msg: SDKMessage, keepInputs: string[], carry: unknown): void {
    const seq = this.seqs.get(msg)
    if (seq !== undefined) this.post({ type: 'ack', upTo: seq, keepInputs, carry })
  }

  /** Ends the chat's process (once started, if it still starts); whenClosed() says when the host has it. */
  close(): void {
    if (this.closing) return
    this.closing = true
    if (this.conn) this.lastWord = this.conn.end()
    this.finish()
  }

  /** The host took close() (or detach()) in: it closed the connection, or did not in time. */
  whenClosed(): Promise<void> {
    return this.lastWord
  }

  /**
   * The server is stopping: let go of the host, which keeps the chat running for the next server. A host still
   * starting is waited for (a little) so what was just sent reaches it: a send made right before a restart is
   * not lost.
   */
  async detach(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.detached = true
    this.finish()
    if (this.conn) {
      this.lastWord = this.letGo(this.conn)
      return this.lastWord
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.connected.then(
        () => {},
        () => {}, // floor-ok: a host that never started has nothing to let go of (fail() already told the runtime)
      ),
      new Promise<void>((r) => {
        timer = setTimeout(r, DETACH_WAIT_MS)
      }),
    ])
    clearTimeout(timer)
    await this.lastWord
  }

  next(): Promise<IteratorResult<SDKMessage, void>> {
    const head = this.messages.shift()
    if (head) {
      this.noteHandled(head)
      return Promise.resolve({ value: head, done: false })
    }
    if (this.failure) {
      const f = this.failure
      this.failure = null
      return Promise.reject(f)
    }
    if (this.done) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  /** The runtime stopped reading (it replaced or ended the query, which says what becomes of the host). */
  private stop(): Promise<IteratorResult<SDKMessage, void>> {
    this.done = true
    this.messages.length = 0
    return Promise.resolve({ value: undefined, done: true })
  }

  private call(method: string, args: unknown[]): Promise<unknown> {
    if (this.done) return Promise.reject(new Error('the chat process has ended'))
    return this.connected.then(
      () =>
        new Promise((resolve, reject) => {
          const rpcId = ++this.nextRpc
          const undefinedAt = args.flatMap((a, i) => (a === undefined ? [i] : []))
          this.rpcs.set(rpcId, { resolve, reject })
          if (!this.conn?.send({ type: 'call', rpcId, method, args, ...(undefinedAt.length ? { undefinedAt } : {}) })) {
            this.rpcs.delete(rpcId)
            reject(new Error('the chat process is not connected'))
          }
        }),
    )
  }

  private async launch(): Promise<HostConnection> {
    const { chatId, account, options } = this.params
    if (!chatId || !account) throw new Error('a hosted chat needs its id and account')
    const dir = hostsDir(this.deps.home)
    // One process per chat, ever: a host left from before (one no server could reach) ends first.
    await endHost(dir, chatId, this.deps.connect)
    const spec: HostSpec = {
      protocol: HOST_PROTOCOL,
      chatId,
      token: randomBytes(24).toString('hex'),
      dir,
      account,
      options: hostOptions(options ?? {}),
      orphanMinutes: this.deps.orphanMinutes?.() ?? 30,
      carry: this.params.carry ?? null,
    }
    const file = await (this.deps.launch ?? launchHost)(spec)
    return (this.deps.connect ?? ((f: HostFile) => HostConnection.open(f)))(file)
  }

  /** `replay`: a reconnect, whose journal and open requests bring what the drop missed. */
  private bind(c: HostConnection, replay: boolean): HostConnection {
    this.conn = c
    c.onClose = () => this.onDisconnect(c)
    if (this.closing) {
      this.lastWord = this.detached ? this.letGo(c) : c.end()
      return c
    }
    if (replay) {
      for (const e of c.journal) this.take(e)
      for (const r of c.hello.requests) this.invoke(r)
    }
    this.flushOutbox(c)
    c.setHandler((m) => this.onMessage(m))
    if (replay && c.hello.end) this.applyEnd(c.hello.end, true)
    return c
  }

  private flushOutbox(c: HostConnection): void {
    for (const m of this.outbox.splice(0)) c.send(m)
  }

  /** Detached: what was sent goes out, then the host learns what this server saw, so the next one tells the rest. */
  private letGo(c: HostConnection): Promise<void> {
    this.flushOutbox(c)
    return c.sayLast({ type: 'detach', seen: this.handledSeq, shown: [...this.aborts.keys()] })
  }

  private noteHandled(msg: SDKMessage): void {
    const seq = this.seqs.get(msg)
    if (seq !== undefined && seq > this.handledSeq) this.handledSeq = seq
  }

  /** The runtime's input stream, forwarded to the host as it comes. */
  private async pump(): Promise<void> {
    const prompt = this.params.prompt
    if (typeof prompt === 'string') {
      this.fail(new Error('a hosted chat takes streaming input'))
      return
    }
    try {
      for await (const msg of prompt) {
        if (this.closing) return
        this.post({ type: 'input', msg })
      }
    } catch {
      // the runtime closed its input
    }
  }

  /** Sends now, or once (re)connected. */
  private post(msg: ServerMessage): void {
    if (this.closing) return
    if (!this.conn?.send(msg)) this.outbox.push(msg)
  }

  private onMessage(m: HostMessage): void {
    switch (m.type) {
      case 'entry':
        this.take(m.entry)
        return
      case 'request':
        this.invoke(m.request)
        return
      case 'abort':
        this.reopen = this.reopen.filter((r) => r.callId !== m.callId)
        this.aborts.get(m.callId)?.abort()
        this.aborts.delete(m.callId)
        return
      case 'stderr':
        this.params.options?.stderr?.(m.data)
        return
      case 'end':
        this.applyEnd(m.end, false)
        return
      case 'reply': {
        const r = this.rpcs.get(m.rpcId)
        if (!r) return
        this.rpcs.delete(m.rpcId)
        if (m.ok) r.resolve(m.value)
        else r.reject(new Error(m.error ?? 'the call into the chat process failed'))
        return
      }
    }
  }

  /** A live SDK message (one a reconnect already delivered is skipped). */
  private take(entry: JournalEntry): void {
    if (entry.kind !== 'sdk' || entry.seq <= this.lastSeq) return
    this.lastSeq = entry.seq
    this.seqs.set(entry.msg, entry.seq)
    this.deliver(entry.msg)
  }

  /** A permission or elicitation call from the host, to the runtime's own callback, with the SDK's requestId. */
  private invoke(r: HostRequest): void {
    if (this.aborts.has(r.callId)) return
    if (!this.adopted) {
      // Before the replay the runtime does not know the turn it belongs to: it opens once adopt is done.
      if (!this.reopen.some((x) => x.callId === r.callId)) this.reopen.push(r)
      return
    }
    const ctrl = new AbortController()
    this.aborts.set(r.callId, ctrl)
    const answer = (result: unknown) => {
      this.aborts.delete(r.callId)
      // Detached: the host keeps the request for the next server. Aborted: the host already let it go.
      if (this.detached || ctrl.signal.aborted) return
      this.post({ type: 'answer', callId: r.callId, result })
    }
    const o = this.params.options
    if (r.kind === 'tool') {
      if (!o?.canUseTool) return answer({ behavior: 'deny', message: 'Nothing here answers permission requests.' })
      o.canUseTool(r.toolName, r.input, { ...r.options, signal: ctrl.signal, requestId: r.callId }).then(answer, (err) =>
        answer({ behavior: 'deny', message: err instanceof Error ? err.message : String(err) }),
      )
    } else {
      if (!o?.onElicitation) return answer({ action: 'decline' })
      o.onElicitation(r.request, { signal: ctrl.signal, requestId: r.callId }).then(
        (res) => answer(res ?? { action: 'cancel' }),
        () => answer({ action: 'cancel' }),
      )
    }
  }

  /** The query ended in the host. `missed`: the server was not there to see its stderr. */
  private applyEnd(end: HostEnd, missed: boolean): void {
    if (missed && end.stderrTail) this.params.options?.stderr?.(end.stderrTail)
    if (end.error) this.fail(new Error(end.error))
    else this.finish()
  }

  private onDisconnect(c: HostConnection): void {
    if (c !== this.conn) return
    this.conn = null
    if (this.closing || this.done) return
    this.dropCalls(new Error('the connection to the chat process dropped'))
    void this.reconnect()
  }

  /** The socket dropped under a live chat: the host is tried again a few times before the chat counts as gone. */
  private async reconnect(): Promise<void> {
    const dir = hostsDir(this.deps.home)
    for (let i = 0; i < RECONNECT_TRIES && !this.closing; i++) {
      await Bun.sleep(RECONNECT_DELAY_MS)
      const file = readHostFile(dir, this.params.chatId ?? '')
      if (!file || !pidAlive(file.pid)) break
      try {
        const c = await (this.deps.connect ?? ((f: HostFile) => HostConnection.open(f)))(file)
        if (this.closing) {
          this.lastWord = this.detached ? this.letGo(c) : c.end()
          return
        }
        this.bind(c, true)
        return
      } catch {
        // tried again below
      }
    }
    if (!this.closing) this.fail(new Error('the chat process went away'))
  }

  private deliver(msg: SDKMessage): void {
    if (this.done) return
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      this.noteHandled(msg)
      w.resolve({ value: msg, done: false })
    } else this.messages.push(msg)
  }

  private finish(): void {
    if (this.done) return
    this.done = true
    this.dropCalls(new Error('the chat process has ended'))
    if (this.waiter && this.messages.length === 0) {
      const w = this.waiter
      this.waiter = null
      w.resolve({ value: undefined, done: true })
    }
  }

  private fail(err: Error): void {
    if (this.done) return
    this.done = true
    this.dropCalls(err)
    if (this.waiter && this.messages.length === 0) {
      const w = this.waiter
      this.waiter = null
      w.reject(err)
    } else this.failure = err
  }

  private dropCalls(err: Error): void {
    for (const r of this.rpcs.values()) r.reject(err)
    this.rpcs.clear()
  }
}

/** Ends a chat's host, if one runs: asked to close first, its process tree ended when it does not. */
export async function endHost(dir: string, chatId: string, connect?: (file: HostFile) => Promise<HostConnection>): Promise<void> {
  const file = readHostFile(dir, chatId)
  if (!file) return
  if (pidAlive(file.pid)) {
    try {
      const c = await (connect ?? ((f: HostFile) => HostConnection.open(f, 2000)))(file)
      await c.end()
    } catch {
      // not answering: ended below
    }
    const deadline = Date.now() + 3000
    while (pidAlive(file.pid) && Date.now() < deadline) await Bun.sleep(100)
    if (pidAlive(file.pid)) killHostTree(file.pid)
  }
  rmSync(hostFilePath(dir, chatId), { force: true })
}

const serverFile = (home: string) => join(hostsDir(home), 'server.json')

/** True when a Hydra Desk server answers on this port. */
async function serverAnswers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

/**
 * Takes the chat hosts of `home` for this server (`<home>/hosts/server.json`): refused while another server that
 * took them still runs and answers (a second server on the same folder, a dev run say, must not take the live
 * chats over). A server that stopped, or died, holds nothing.
 */
export async function claimHosts(home: string, port: number, answers: (port: number) => Promise<boolean> = serverAnswers): Promise<boolean> {
  const file = serverFile(home)
  try {
    const held = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown; port?: unknown }
    if (typeof held.pid === 'number' && held.pid !== process.pid && pidAlive(held.pid) && typeof held.port === 'number' && (await answers(held.port))) return false
  } catch {
    // none, or unreadable: nobody holds them
  }
  mkdirSync(hostsDir(home), { recursive: true })
  writeFileSync(file, JSON.stringify({ pid: process.pid, port }))
  return true
}

/** The server stops: the hosts are free for the next one. */
export function releaseHosts(home: string): void {
  try {
    const held = JSON.parse(readFileSync(serverFile(home), 'utf8')) as { pid?: unknown }
    if (held.pid === process.pid) rmSync(serverFile(home), { force: true })
  } catch {
    // not ours, or gone
  }
}

/** The hosts that outlived the last server, connected. A file whose host is gone is removed. */
export async function openHosts(home: string, connect?: (file: HostFile) => Promise<HostConnection>): Promise<HostConnection[]> {
  const dir = hostsDir(home)
  const open = connect ?? ((f: HostFile) => HostConnection.open(f))
  const conns = await Promise.all(
    listHostFiles(dir).map(async (f) => {
      try {
        const c = await open(f)
        if (c.hello.protocol === HOST_PROTOCOL) return c
        // A protocol this server does not speak: nothing here could drive the chat.
        console.warn(`[desk] chat ${f.chatId}: its process speaks host protocol ${c.hello.protocol}, not ${HOST_PROTOCOL}; ending it`)
        void c.end()
        return null
      } catch {
        if (!pidAlive(f.pid)) rmSync(hostFilePath(dir, f.chatId), { force: true })
        return null
      }
    }),
  )
  return conns.filter((c): c is HostConnection => c !== null)
}

/** Chats run in hosts (SPEC "Chat hosts") unless HYDRA_DESK_HOSTS=0. */
export function hostsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.HYDRA_DESK_HOSTS !== '0'
}

/**
 * The query implementation the manager gets by default. A chat's own query (streaming input, its chat id) runs in
 * a host, or with hosts off in this process; anything else (a one-shot query, a title say) runs here. A host that
 * is already running is taken over either way: a second process on its session would be the worse outcome.
 */
export function chatQueryImpl(
  deps: HostedDeps,
  env: Record<string, string | undefined> = process.env,
  here: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query = sdkQuery,
): (params: HostedParams) => Query {
  const on = hostsEnabled(env)
  return (params) => {
    if (params.attach || (on && params.chatId && typeof params.prompt !== 'string')) return new HostedQuery(params, deps).query
    return here({ prompt: params.prompt, options: params.options })
  }
}
