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
  }
  /** What the process does when asked to stop a task (a real one answers with its task_notification). */
  onStopTask: ((taskId: string) => void) | null = null
  mcp: McpServerStatus[] = []
  /** The MCP status read and toggle never answer (a session too busy to). */
  mcpHangs = false
  commands: SlashCommand[] = [{ name: 'compact', description: 'Compact the conversation', argumentHint: '<instructions>' }]
  models: ModelInfo[] = [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '' }]

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

/** `older`: sessions past the list's 24 hours, which only the single-session read finds. `picked`: one more account listed. */
export function fakeBridge(
  o: { picked?: AccountRef; external?: ExternalSession[]; older?: ExternalSession[]; items?: Record<string, TranscriptItem[]>; workers?: CliMayteWorker[]; roots?: string[] } = {},
) {
  const state = {
    workers: o.workers ?? [],
    /** CliMayte: the workers started (their tasks), the messages sent, the cancels, and what workersByIds answers. */
    started: [] as StartWorker[],
    sentToWorker: [] as { id: string; text: string; cwd?: string }[],
    /** Send now on a worker's held message: what was asked, and whether the fake stops a turn for it. */
    sentNow: [] as { id: string; text?: string }[],
    nowStops: true,
    cancelled: [] as string[],
    rows: [] as AhWorker[],
    /** What workerItems answers, by session id. */
    workerItems: {} as Record<string, TranscriptItem[]>,
    /** How many times the manager asked the bridge to read the worker's JSONL files (the folder scan). */
    workerReads: 0,
    excluded: () => [] as Iterable<string> | Promise<Iterable<string>>,
    // Like the real bridge, the list answers with the marks the manager registered.
    meta: (list: ExternalSession[]) => list,
  }
  const b: ManagerBridge = {
    startWorker: async (task) => {
      state.started.push(task)
      const n = state.started.length
      const row = ahWorker({ id: `w${n}`, title: task.title, cwd: task.cwd, prompt: task.prompt, model: task.model ?? null, sessionId: `worker-session-${n}` })
      state.rows.push(row)
      return row
    },
    sendToWorker: async (id, text, cwd) => {
      state.sentToWorker.push({ id, text, ...(cwd ? { cwd } : {}) })
    },
    sendToWorkerNow: async (id, text) => {
      state.sentNow.push({ id, ...(text ? { text } : {}) })
      return state.nowStops
    },
    cancelWorker: async (id) => {
      state.cancelled.push(id)
    },
    workersByIds: async (ids) => state.rows.filter((r) => ids.includes(r.id)),
    workerItems: async (sessionIds) => {
      state.workerReads += 1
      return sessionIds.flatMap((s) => state.workerItems[s] ?? [])
    },
    listAccounts: async () => (o.picked ? [ACCOUNT_68, { ...ACCOUNT_68, ...o.picked }] : [ACCOUNT_68]),
    externalSessions: async () => state.meta(o.external ?? []),
    externalSession: async (id: string) => {
      const found = [...(o.external ?? []), ...(o.older ?? [])].find((s) => s.id === id)
      if (!found) throw new Error(`AgentHydra does not know session ${id}`)
      return found
    },
    externalItems: async (sessionId: string) => {
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
