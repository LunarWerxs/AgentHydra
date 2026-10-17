// Fakes for the manager's route tests: an SDK Query the test drives, and a bridge with fixed answers.

import type { McpServerStatus, ModelInfo, Options, Query, SDKMessage, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { AccountInfo, AccountRef, CliMayteWorker, ExternalSession, TranscriptItem } from '@shared/protocol'
import type { AhWorker, StartWorker } from '../../../src/bridge/client'
import type { QueryImpl } from '../../../src/engine/chat-runtime'
import type { ManagerBridge } from '../../../src/engine/chat-manager'

/** A Query whose messages the test pushes; records the prompts it reads and the control calls. */
export class FakeQuery {
  private buffer: SDKMessage[] = []
  private waiter: ((r: IteratorResult<SDKMessage, void>) => void) | null = null
  private done = false
  sent: SDKUserMessage[] = []
  calls = {
    interrupt: 0,
    close: 0,
    setPermissionMode: [] as string[],
    setModel: [] as (string | undefined)[],
    applyFlagSettings: [] as unknown[],
    toggleMcpServer: [] as [string, boolean][],
    stopTask: [] as string[],
    cancelled: [] as string[],
  }
  /** What the process answers to a cancel: false once the message is already in the turn. */
  cancelAnswer = true
  /** What the process does when asked to stop a task (a real one answers with its task_notification). */
  onStopTask: ((taskId: string) => void) | null = null
  mcp: McpServerStatus[] = []
  /** The MCP status read and toggle never answer (a session too busy to). */
  mcpHangs = false
  commands: SlashCommand[] = [{ name: 'compact', description: 'Compact the conversation', argumentHint: '<instructions>' }]
  // A Haiku 4.5 entry as an older CLI lists it: the model menu drops it and offers Haiku 5.5.
  models: ModelInfo[] = [
    { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '' },
    { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: '' },
  ]

  constructor(
    readonly prompt: string | AsyncIterable<SDKUserMessage>,
    readonly options: Options,
  ) {
    if (typeof prompt !== 'string') {
      void (async () => {
        for await (const m of prompt) this.sent.push(m)
      })()
    }
  }

  push(...msgs: SDKMessage[]) {
    for (const m of msgs) {
      if (this.waiter) {
        const w = this.waiter
        this.waiter = null
        w({ value: m, done: false })
      } else this.buffer.push(m)
    }
  }

  next(): Promise<IteratorResult<SDKMessage, void>> {
    const head = this.buffer.shift()
    if (head) return Promise.resolve({ value: head, done: false })
    if (this.done) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => {
      this.waiter = resolve
    })
  }
  return(): Promise<IteratorResult<SDKMessage, void>> {
    this.done = true
    return Promise.resolve({ value: undefined, done: true })
  }
  [Symbol.asyncIterator]() {
    return this
  }
  async interrupt() {
    this.calls.interrupt++
  }
  async setPermissionMode(mode: string) {
    this.calls.setPermissionMode.push(mode)
  }
  async setModel(model?: string) {
    this.calls.setModel.push(model)
  }
  async applyFlagSettings(s: unknown) {
    this.calls.applyFlagSettings.push(s)
  }
  async cancelAsyncMessage(uuid: string) {
    this.calls.cancelled.push(uuid)
    return this.cancelAnswer
  }
  async stopTask(taskId: string) {
    this.calls.stopTask.push(taskId)
    this.onStopTask?.(taskId)
  }
  async getContextUsage() {
    return { percentage: 10 }
  }
  async supportedCommands() {
    return this.commands
  }
  async supportedModels() {
    return this.models
  }
  async mcpServerStatus() {
    if (this.mcpHangs) await new Promise(() => {})
    return this.mcp
  }
  async toggleMcpServer(name: string, enabled: boolean) {
    this.calls.toggleMcpServer.push([name, enabled])
    if (this.mcpHangs) await new Promise(() => {})
  }
  close() {
    this.calls.close++
    this.done = true
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: undefined, done: true })
    }
  }
}

export function fakeQueries() {
  const all: FakeQuery[] = []
  const queryImpl: QueryImpl = ({ prompt, options }) => {
    const f = new FakeQuery(prompt, options ?? {})
    all.push(f)
    return f as unknown as Query
  }
  return { all, queryImpl, last: () => all[all.length - 1]! }
}

export const ACCOUNT_68: AccountInfo = {
  id: 'inst-68',
  label: '#68 eek (Max 20x)',
  configDir: 'C:/fake/instances/68',
  number: 68,
  email: null,
  plan: 'Max 20x',
  signedIn: true,
  fiveHourPct: 10,
  weeklyPct: 10,
  fiveHourResetsAt: null,
  weeklyResetsAt: null,
  inUse: false,
}

type FakeBridgeOptions = { picked?: AccountRef; external?: ExternalSession[]; older?: ExternalSession[]; items?: Record<string, TranscriptItem[]>; workers?: CliMayteWorker[]; roots?: string[] }

/** The record the fake keeps of what the manager asked, and the knobs a test turns. */
function fakeBridgeState(o: FakeBridgeOptions) {
  return {
    workers: o.workers ?? [],
    /** CliMayte: the workers started (their tasks), the messages sent, the cancels, and what workersByIds answers. */
    started: [] as StartWorker[],
    sentToWorker: [] as { id: string; text: string; cwd?: string; urgent?: true; setting?: { model: string; effort: string } }[],
    /** Send now on a worker's held message: what was asked, and whether the fake stops a turn for it (an urgent message's too). */
    sentNow: [] as { id: string; text?: string }[],
    nowStops: true,
    /** A message sent to a running worker goes into its turn (`delivered: 'in-turn'`) instead of being held. */
    deliversInTurn: false,
    /** Whether this AgentHydra has deliver-now (v1.10.0 has not). */
    deliverNow: true,
    cancelled: [] as string[],
    /** Take back a held message: whether this AgentHydra has the cancel route (before its update it has not), and what it took back. */
    cancelHeldRoute: true,
    cancelRemoves: true,
    heldCancels: [] as { id: string; text: string }[],
    rows: [] as AhWorker[],
    /** What workerItems answers, by session id. */
    workerItems: {} as Record<string, TranscriptItem[]>,
    /** How many times the manager asked the bridge to read the worker's JSONL files (the folder scan). */
    workerReads: 0,
    excluded: () => [] as Iterable<string> | Promise<Iterable<string>>,
    // Like the real bridge, the list answers with the marks the manager registered.
    meta: (list: ExternalSession[]) => list,
    /** What the next starts and sends meet, oldest first: a failure, `took` when AgentHydra did it anyway and only
     *  answered too late. Like AgentHydra, a start or send whose requestId it has seen is answered and done once. */
    failNext: [] as { err: Error; took?: boolean }[],
    /** Every requestId a start or a send carried, repeats included. */
    requestIds: [] as string[],
    finished: [] as { ticket: string; outcome: string }[],
    /** takesRequestIds' answer: null when AgentHydra did not answer, false for one from before request ids. */
    takesRequestIds: true as boolean | null,
  }
}

type FakeBridgeState = ReturnType<typeof fakeBridgeState>

async function startFakeWorker(s: FakeBridgeState, madeFor: Map<string, AhWorker>, task: StartWorker) {
  if (task.requestId) s.requestIds.push(task.requestId)
  const fail = s.failNext.shift()
  if (fail && !fail.took) throw fail.err
  const again = task.requestId ? madeFor.get(task.requestId) : undefined
  if (again) {
    if (fail) throw fail.err
    return again
  }
  s.started.push(task)
  const n = s.started.length
  const row = ahWorker({ id: `w${n}`, title: task.title, cwd: task.cwd, prompt: task.prompt, model: task.model ?? null, sessionId: `worker-session-${n}` })
  s.rows.push(row)
  if (task.requestId) madeFor.set(task.requestId, row)
  if (fail) throw fail.err
  return row
}

async function sendFakeToWorker(
  s: FakeBridgeState,
  sendIds: Set<string>,
  id: string,
  text: string,
  cwd: string | undefined,
  urgent: boolean | undefined,
  requestId: string | undefined,
  setting: { model: string; effort: string } | undefined,
) {
  if (requestId) s.requestIds.push(requestId)
  const fail = s.failNext.shift()
  if (fail && !fail.took) throw fail.err
  if (!requestId || !sendIds.has(requestId)) s.sentToWorker.push({ id, text, ...(cwd ? { cwd } : {}), ...(urgent ? { urgent } : {}), ...(setting ? { setting } : {}) })
  if (requestId) sendIds.add(requestId)
  if (fail) throw fail.err
  return { urgent: urgent === true && s.nowStops, delivered: urgent !== true && s.deliversInTurn }
}

async function sendFakeNow(s: FakeBridgeState, id: string, text?: string) {
  s.sentNow.push({ id, ...(text ? { text } : {}) })
  const running = s.rows.find((r) => r.id === id)?.status === 'running'
  if (!running) return { stopped: false, message: 'Not running: what it holds goes as its next turn.' }
  return s.nowStops
    ? { stopped: true, message: 'Stopped its running work; the same session continues now with this message.' }
    : { stopped: false, message: 'That message is not held any more: it was delivered, or its turn has begun.' }
}

/** `older`: sessions past the list's 24 hours, which only the single-session read finds. `picked`: one more account listed. */
export function fakeBridge(o: FakeBridgeOptions = {}) {
  const state = fakeBridgeState(o)
  const madeFor = new Map<string, AhWorker>()
  const sendIds = new Set<string>()
  const b: ManagerBridge = {
    completionFinished: async (ticket, outcome) => {
      state.finished.push({ ticket, outcome })
      return { ok: true }
    },
    startWorker: (task) => startFakeWorker(state, madeFor, task),
    sendToWorker: (id, text, cwd, urgent, _desk, requestId, setting) => sendFakeToWorker(state, sendIds, id, text, cwd, urgent, requestId, setting),
    takesRequestIds: async () => state.takesRequestIds,
    canDeliverNow: async () => state.deliverNow,
    sendToWorkerNow: (id, text) => sendFakeNow(state, id, text),
    cancelWorkerHeld: async (id, text) => {
      if (!state.cancelHeldRoute) throw new Error('This AgentHydra cannot take back a held message yet: it needs its update')
      state.heldCancels.push({ id, text })
      return state.cancelRemoves
        ? { removed: true, message: 'Taken back: the worker will not run it.' }
        : { removed: false, message: 'That message is not held any more: it was delivered, or its turn has begun.' }
    },
    cancelWorker: async (id) => {
      state.cancelled.push(id)
    },
    workersByIds: async (ids) => state.rows.filter((r) => ids.includes(r.id)),
    workerItems: async (sessionIds) => {
      state.workerReads += 1
      return sessionIds.flatMap((s) => state.workerItems[s] ?? [])
    },
    workerFileOf: () => null,
    listAccounts: async () => (o.picked ? [ACCOUNT_68, { ...ACCOUNT_68, ...o.picked }] : [ACCOUNT_68]),
    externalSessions: async () => state.meta(o.external ?? []),
    externalSession: async (id: string) => {
      const found = [...(o.external ?? []), ...(o.older ?? [])].find((s) => s.id === id)
      if (!found) throw new Error(`AgentHydra does not know session ${id}`)
      return found
    },
    externalHistory: async (sessionId: string) => {
      const items = o.items?.[sessionId]
      if (!items) throw new Error(`AgentHydra has no transcript for session ${sessionId}`)
      return items
    },
    sessionRoots: () => o.roots ?? [],
    lastWorkers: () => state.workers,
    setExtraWorkerIds: () => {},
    setExcludeSessionIds: (fn) => {
      state.excluded = fn
    },
    setSessionMeta: (fn) => {
      state.meta = fn
    },
  }
  return { bridge: b, state }
}

/** A worker as AgentHydra's /api/corch/workers answers it, queued and not yet on an account. */
export function ahWorker(over: Partial<AhWorker>): AhWorker {
  return {
    id: 'w1',
    group: 'hydra-desk',
    title: 'a worker',
    cwd: '/',
    prompt: '',
    status: 'queued',
    sessionId: null,
    accountId: null,
    account: null,
    model: null,
    effort: null,
    result: null,
    error: null,
    lastActivity: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

export function worker(over: Partial<CliMayteWorker>): CliMayteWorker {
  return {
    id: 'w1',
    title: 'a worker',
    group: null,
    status: 'running',
    active: true,
    account: '#68',
    model: null,
    effort: null,
    kind: null,
    cwd: null,
    sessionId: 'worker-session',
    originSessionId: null,
    startedAt: 1,
    endedAt: null,
    lastActivityAt: 1,
    lastActivity: null,
    usedPct: null,
    tokens: null,
    verdict: null,
    error: null,
    ...over,
  }
}
