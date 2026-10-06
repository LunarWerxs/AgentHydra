import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ElicitationRequest,
  ElicitationResult,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ChatSummary, DeskSettings, ServerEvent, TranscriptItem } from '@shared/protocol'
import { ChatRuntime, isUsageLimitText, type QueryImpl } from '../../../src/engine/chat-runtime'
import { DESK_APPEND, DESK_APPEND_NO_DELEGATE } from '../../../src/engine/desk-prompt'
import { ElicitationAnswerError } from '../../../src/engine/requests'
import { ChatStore } from '../../../src/engine/store'
import * as hand from '../../fixtures/hand-built'

const SID = 'fixture-session-0001'
const FIXTURE_CWD = 'C:\\Users\\test\\AppData\\Local\\Temp\\desk-fixture-qyIZy1'

const SETTINGS: DeskSettings = {
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: 'bypassPermissions',
  defaultAccountId: 'auto',
  delegateToCliMayte: true,
  idleCloseMinutes: 30,
  notifications: true,
}

/** A Query whose messages the test pushes; records every control call and every prompt it reads. */
class FakeQuery {
  private buffer: SDKMessage[] = []
  private waiter: ((r: IteratorResult<SDKMessage, void>) => void) | null = null
  private failWaiter: ((e: unknown) => void) | null = null
  private done = false
  private error: unknown = null
  sent: SDKUserMessage[] = []
  calls = { interrupt: 0, close: 0, setPermissionMode: [] as string[], setModel: [] as (string | undefined)[], applyFlagSettings: [] as unknown[] }
  contextUsage: { percentage?: number; totalTokens?: number; maxTokens?: number } = { percentage: 42 }
  /** A mode the CLI refuses, as it refuses Bypass to a process not launched for it. */
  refuseMode: string | null = null
  refuseModel = false

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
        this.failWaiter = null
        w({ value: m, done: false })
      } else this.buffer.push(m)
    }
  }

  fail(err: unknown) {
    this.error = err
    if (this.failWaiter) {
      const f = this.failWaiter
      this.waiter = null
      this.failWaiter = null
      f(err)
    }
  }

  next(): Promise<IteratorResult<SDKMessage, void>> {
    const head = this.buffer.shift()
    if (head) return Promise.resolve({ value: head, done: false })
    if (this.error) return Promise.reject(this.error)
    if (this.done) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => {
      this.waiter = resolve
      this.failWaiter = reject
    })
  }
  return(): Promise<IteratorResult<SDKMessage, void>> {
    this.done = true
    return Promise.resolve({ value: undefined, done: true })
  }
  throw(e: unknown): Promise<IteratorResult<SDKMessage, void>> {
    return Promise.reject(e)
  }
  [Symbol.asyncIterator]() {
    return this
  }
  async interrupt() {
    this.calls.interrupt++
    return undefined
  }
  async setPermissionMode(mode: string) {
    this.calls.setPermissionMode.push(mode)
    if (mode === this.refuseMode) throw new Error(`Cannot set permission mode to ${mode} because the session was not launched with --dangerously-skip-permissions`)
  }
  async setModel(model?: string) {
    this.calls.setModel.push(model)
    if (this.refuseModel) throw new Error('model not available')
  }
  async applyFlagSettings(s: unknown) {
    this.calls.applyFlagSettings.push(s)
  }
  async getContextUsage() {
    return this.contextUsage
  }
  close() {
    this.calls.close++
    this.done = true
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      this.failWaiter = null
      w({ value: undefined, done: true })
    }
  }
}

function loadJsonl(name: string): SDKMessage[] {
  return readFileSync(join(import.meta.dir, '..', '..', 'fixtures', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SDKMessage)
}

let uuidN = 0
function uuid() {
  uuidN++
  return `10000000-0000-4000-8000-${String(uuidN).padStart(12, '0')}`
}

function state(s: 'running' | 'idle' | 'requires_action'): SDKMessage {
  return { type: 'system', subtype: 'session_state_changed', state: s, uuid: uuid(), session_id: SID } as unknown as SDKMessage
}

function result(over: { queued?: number; errors?: string[]; text?: string; cost?: number } = {}): SDKMessage {
  const base: Record<string, unknown> = {
    type: 'result',
    subtype: over.errors ? 'error_during_execution' : 'success',
    is_error: !!over.errors,
    duration_ms: 1000,
    duration_api_ms: 900,
    num_turns: 1,
    total_cost_usd: over.cost ?? 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    uuid: uuid(),
    session_id: SID,
  }
  if (over.errors) base.errors = over.errors
  else base.result = over.text ?? 'Done.'
  if (over.queued !== undefined) base.queued_turn_count = over.queued
  return base as unknown as SDKMessage
}

function toolUse(id: string, name: string, input: Record<string, unknown>): SDKMessage {
  const message = { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name, input }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  return { type: 'assistant', message, parent_tool_use_id: null, uuid: uuid(), session_id: SID } as unknown as SDKMessage
}

function toolResult(id: string, text: string, isError = false): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: SID,
  } as unknown as SDKMessage
}

function messageStart(userUuid: string): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'message_start', message: { id: `msg_${uuid()}`, type: 'message', role: 'assistant', content: [] } },
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: SID,
    user_message_uuid: userUuid,
    user_message_uuids: [userUuid],
  } as unknown as SDKMessage
}

const tick = () => new Promise((r) => setTimeout(r, 0))
async function settle() {
  for (let i = 0; i < 5; i++) await tick()
}

let home: string
let store: ChatStore

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'desk-runtime-'))
  process.env.HYDRA_DESK_HOME = home
  store = new ChatStore(home, { debounceMs: 1 })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function makeChat(over: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: 'chat-1',
    sessionId: null,
    title: 'Test chat',
    cwd: FIXTURE_CWD,
    account: { id: 'default', label: 'Default', configDir: null },
    accountAuto: false,
    model: null,
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: true,
    status: 'closed',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: 1,
    updatedAt: 1,
    costUsd: 0,
    contextPct: null,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0,
    ...over,
  }
}

function setup(chatOver: Partial<ChatSummary> = {}, opts: { settings?: DeskSettings; env?: Record<string, string | undefined> } = {}) {
  const events: ServerEvent[] = []
  const fakes: FakeQuery[] = []
  const queryImpl: QueryImpl = ({ prompt, options }) => {
    const f = new FakeQuery(prompt, options ?? {})
    fakes.push(f)
    return f as unknown as Query
  }
  const rt = new ChatRuntime({
    chat: makeChat(chatOver),
    store,
    emit: (e) => events.push(e),
    queryImpl,
    env: opts.env ?? { PATH: '/bin' },
    settings: opts.settings ?? SETTINGS,
    agentHydraMcp: null,
  })
  const fake = () => fakes[fakes.length - 1]!
  const items = () => {
    const map = new Map<string, TranscriptItem>()
    for (const e of events) if (e.type === 'item.upsert') map.set(e.item.id, e.item)
    return [...map.values()]
  }
  const notifies = () => events.filter((e): e is Extract<ServerEvent, { type: 'notify' }> => e.type === 'notify')
  const statuses = () => events.flatMap((e) => (e.type === 'chat.upsert' ? [e.chat.status] : []))
  const activities = () => [...new Set(events.flatMap((e) => (e.type === 'chat.upsert' && e.chat.activity ? [e.chat.activity] : [])))]
  return { rt, events, fakes, fake, items, notifies, statuses, activities }
}

/** Opens a canUseTool request the way the SDK would. */
function ask(f: FakeQuery, toolName: string, input: Record<string, unknown>, extra: { suggestions?: PermissionUpdate[]; toolUseID?: string; blockedPath?: string } = {}) {
  const ac = new AbortController()
  const promise = f.options.canUseTool!(toolName, input, {
    signal: ac.signal,
    suggestions: extra.suggestions,
    blockedPath: extra.blockedPath,
    toolUseID: extra.toolUseID ?? `toolu_${uuid()}`,
    requestId: uuid(),
  }) as Promise<PermissionResult>
  return { promise, ac }
}

function lastItem<K extends TranscriptItem['kind']>(items: TranscriptItem[], kind: K) {
  return items.filter((i) => i.kind === kind).at(-1) as Extract<TranscriptItem, { kind: K }>
}

describe('ChatRuntime: a recorded turn', () => {
  test('working to idle with the right activity, cost, context and stored items', async () => {
    const t = setup()
    t.rt.send('What does notes.txt say?')
    expect(t.rt.chat.status).toBe('starting')
    t.fake().push(...loadJsonl('basic-turn.jsonl'))
    await settle()

    expect(t.statuses()).toContain('working')
    expect(t.rt.chat.status).toBe('idle')
    expect(t.rt.chat.activity).toBeNull()
    expect(t.rt.chat.turnStartedAt).toBeNull()
    expect(t.rt.chat.unread).toBe(true)
    expect(t.rt.chat.sessionId).toBe('bc02ba58-0cd0-4a7d-8e96-e0055fcccd74')
    expect(t.rt.chat.costUsd).toBeCloseTo(0.01077895, 8)
    expect(t.rt.chat.contextPct).toBe(42)

    const acts = t.activities()
    expect(acts).toContain('Thinking')
    expect(acts.some((a) => a.startsWith('PowerShell: Get-ChildItem'))).toBe(true)
    expect(acts).toContain('Read: notes.txt')
    expect(acts).toContain('Writing')

    expect(t.notifies().map((n) => n.reason)).toEqual(['finished'])
    expect(t.fake().sent).toHaveLength(1)

    const stored = store.loadItems('chat-1')
    expect(stored.find((i) => i.kind === 'user')).toMatchObject({ text: 'What does notes.txt say?' })
    const text = stored.find((i) => i.kind === 'assistant_text') as { text: string; streaming?: boolean }
    expect(text.text).toBe('The meeting is Thursday at 10am.')
    expect(text.streaming).toBe(false)
    expect(stored.filter((i) => i.kind === 'tool_use').every((i) => (i as { status: string }).status === 'done')).toBe(true)
    expect(t.events.some((e) => e.type === 'item.delta')).toBe(true)
  })
})

describe('ChatRuntime: start options', () => {
  test('default account, bypass, delegate on', () => {
    const t = setup({ permissionMode: 'bypassPermissions' }, { env: { PATH: '/bin', CLAUDE_CONFIG_DIR: 'C:/somewhere' } })
    t.rt.start()
    const o = t.fake().options
    expect(o.cwd).toBe(FIXTURE_CWD)
    expect(o.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect('CLAUDE_CONFIG_DIR' in (o.env ?? {})).toBe(false)
    expect(o.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1')
    expect(o.env?.PATH).toBe('/bin')
    expect(o.permissionMode).toBe('bypassPermissions')
    expect(o.allowDangerouslySkipPermissions).toBe(true)
    expect(o.includePartialMessages).toBe(true)
    expect(o.settingSources).toEqual(['user', 'project', 'local'])
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: DESK_APPEND })
    expect(o.disallowedTools).toEqual(['Agent', 'Task'])
    expect(o.resume).toBeUndefined()
    expect(o.model).toBeUndefined()
    expect(o.effort).toBeUndefined()
    expect(typeof o.canUseTool).toBe('function')
    expect(typeof o.stderr).toBe('function')
    expect(o.mcpServers).toBeUndefined()
  })

  test('another account, resume, model, effort, delegate off, agenthydra MCP', () => {
    const events: ServerEvent[] = []
    let opts: Options | undefined
    const rt = new ChatRuntime({
      chat: makeChat({
        sessionId: 'sess-abc',
        account: { id: 'inst-68', label: '#68', configDir: 'C:/acct68' },
        model: 'claude-opus-5-5',
        effort: 'high',
        permissionMode: 'acceptEdits',
        delegateToCliMayte: false,
      }),
      store,
      emit: (e) => events.push(e),
      queryImpl: ({ prompt, options }) => {
        opts = options
        return new FakeQuery(prompt, options ?? {}) as unknown as Query
      },
      env: {},
      settings: SETTINGS,
      agentHydraMcp: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
    })
    rt.start()
    expect(opts!.resume).toBe('sess-abc')
    expect(opts!.env?.CLAUDE_CONFIG_DIR).toBe('C:/acct68')
    expect(opts!.model).toBe('claude-opus-5-5')
    expect(opts!.effort).toBe('high')
    expect(opts!.permissionMode).toBe('acceptEdits')
    expect(opts!.allowDangerouslySkipPermissions).toBeUndefined()
    expect(opts!.disallowedTools).toBeUndefined()
    expect(opts!.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: DESK_APPEND_NO_DELEGATE })
    expect(DESK_APPEND_NO_DELEGATE.startsWith("You are running inside Hydra Desk, Jacob's own desktop for Claude Code. You have a real browser")).toBe(true)
    expect(DESK_APPEND_NO_DELEGATE).not.toContain('Sub-agents here are CliMayte workers')
    expect(DESK_APPEND).toContain('Sub-agents here are CliMayte workers')
    expect(opts!.mcpServers).toEqual({ agenthydra: { type: 'http', url: 'http://127.0.0.1:1/mcp' } })
  })

  test('a fork resumes its source cut where it was forked; without a cut, as the source stands', () => {
    const rt = new ChatRuntime({
      chat: makeChat({ forkedFrom: 'src-session' }),
      store,
      emit: () => {},
      queryImpl: ({ prompt, options }) => new FakeQuery(prompt, options ?? {}) as unknown as Query,
      env: {},
      settings: SETTINGS,
      agentHydraMcp: null,
      forkAt: () => 'entry-uuid-9',
    })
    expect(rt.buildOptions()).toMatchObject({ resume: 'src-session', forkSession: true, resumeSessionAt: 'entry-uuid-9' })
    expect(setup({ forkedFrom: 'src-session' }).rt.buildOptions().resumeSessionAt).toBeUndefined()
    // a fork with its own session resumes that, uncut
    expect(setup({ forkedFrom: 'src-session', sessionId: 'own' }).rt.buildOptions()).toMatchObject({ resume: 'own' })
  })

  test('stderr goes to the chat log file', () => {
    const t = setup()
    t.rt.start()
    t.fake().options.stderr!('hello stderr\n')
    expect(readFileSync(join(home, 'logs', 'chat-1.log'), 'utf8')).toBe('hello stderr\n')
  })
})

describe('ChatRuntime: permissions', () => {
  async function working() {
    const t = setup()
    t.rt.send('go')
    t.fake().push(hand.init(), state('running'))
    await settle()
    expect(t.rt.chat.status).toBe('working')
    return t
  }

  test('requires_action shows needs_you', async () => {
    const t = await working()
    t.fake().push(state('requires_action'))
    await settle()
    expect(t.rt.chat.status).toBe('needs_you')
  })

  test('allow', async () => {
    const t = await working()
    const { promise } = ask(t.fake(), 'Bash', { command: 'ls' }, { blockedPath: 'C:/x' })
    expect(t.rt.chat.status).toBe('needs_you')
    expect(t.rt.chat.pendingCount).toBe(1)
    const item = lastItem(t.items(), 'permission')
    expect(item).toMatchObject({ toolName: 'Bash', state: 'pending', canAlwaysAllow: false, blockedPath: 'C:/x' })
    expect(t.notifies().map((n) => n.reason)).toEqual(['needs_you'])
    t.rt.respondPermission(item.id, { decision: 'allow' })
    expect(await promise).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(lastItem(t.items(), 'permission').state).toBe('allowed')
    expect(t.rt.chat.status).toBe('working')
    expect(t.rt.chat.pendingCount).toBe(0)
  })

  test('always passes the suggestions back', async () => {
    const t = await working()
    const suggestions: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'session' }]
    const { promise } = ask(t.fake(), 'Bash', { command: 'ls' }, { suggestions })
    const item = lastItem(t.items(), 'permission')
    expect(item.canAlwaysAllow).toBe(true)
    t.rt.respondPermission(item.id, { decision: 'always' })
    expect(await promise).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: suggestions })
    expect(lastItem(t.items(), 'permission').state).toBe('always')
  })

  test('deny with a message, and the tool ends denied', async () => {
    const t = await working()
    t.fake().push(toolUse('toolu_rm', 'Bash', { command: 'rm -rf x' }))
    await settle()
    const { promise } = ask(t.fake(), 'Bash', { command: 'rm -rf x' }, { toolUseID: 'toolu_rm' })
    const item = lastItem(t.items(), 'permission')
    t.rt.respondPermission(item.id, { decision: 'deny', message: 'Not that folder' })
    expect(await promise).toEqual({ behavior: 'deny', message: 'Not that folder' })
    t.fake().push(toolResult('toolu_rm', 'Not that folder', true))
    await settle()
    expect(t.items().find((i) => i.id === 'toolu_rm')).toMatchObject({ kind: 'tool_use', status: 'denied' })
    expect(lastItem(t.items(), 'permission').state).toBe('denied')
  })

  test('deny without a message uses the default and stops the turn', async () => {
    const t = await working()
    const { promise } = ask(t.fake(), 'Write', { file_path: 'a' })
    const write = lastItem(t.items(), 'permission')
    const other = ask(t.fake(), 'Bash', { command: 'ls' })
    t.rt.respondPermission(write.id, { decision: 'deny' })
    expect(await promise).toEqual({ behavior: 'deny', message: 'The user denied this.', interrupt: true })
    expect(t.rt.chat.status).toBe('stopped')
    expect(t.rt.chat.pendingCount).toBe(0)
    // the other open request goes with the turn
    expect((await other.promise).behavior).toBe('deny')
    expect(t.items().filter((i) => i.kind === 'permission').map((i) => (i as { state: string }).state)).toEqual(['denied', 'expired'])
    // the CLI's aborted result does not turn the stop into an error
    t.fake().push(result({ errors: ['Request was aborted.'] }), state('idle'))
    await settle()
    expect(t.rt.chat.status).toBe('stopped')
  })

  test('an unknown request id throws', async () => {
    const t = await working()
    expect(() => t.rt.respondPermission('nope', { decision: 'allow' })).toThrow('no pending permission request nope')
  })

  test('the SDK aborting a request expires it', async () => {
    const t = await working()
    const { promise, ac } = ask(t.fake(), 'Bash', { command: 'ls' })
    ac.abort()
    expect((await promise).behavior).toBe('deny')
    expect(lastItem(t.items(), 'permission').state).toBe('expired')
    expect(t.rt.chat.pendingCount).toBe(0)
    expect(t.rt.chat.status).toBe('working')
  })
})

describe('ChatRuntime: AskUserQuestion and plans', () => {
  const questions = [
    { question: 'Which library?', header: 'Library', multiSelect: false, options: [{ label: 'dayjs', description: 'small' }, { label: 'luxon', description: 'big' }] },
  ]

  async function working() {
    const t = setup()
    t.rt.send('go')
    t.fake().push(hand.init(), state('running'))
    await settle()
    return t
  }

  test('answer', async () => {
    const t = await working()
    const { promise } = ask(t.fake(), 'AskUserQuestion', { questions })
    const item = lastItem(t.items(), 'question')
    expect(item.questions).toEqual(questions)
    expect(t.rt.chat.status).toBe('needs_you')
    t.rt.answerQuestion(item.id, { answers: { 'Which library?': 'dayjs' } })
    expect(await promise).toEqual({ behavior: 'allow', updatedInput: { questions, answers: { 'Which library?': 'dayjs' } } })
    expect(lastItem(t.items(), 'question')).toMatchObject({ state: 'answered', answers: { 'Which library?': 'dayjs' } })
    expect(t.rt.chat.status).toBe('working')
  })

  test('a picture in an answer is saved in the media folder and named in the answer text, never carried as bytes', async () => {
    const t = await working()
    const { promise } = ask(t.fake(), 'AskUserQuestion', { questions })
    const item = lastItem(t.items(), 'question')
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')])
    const dataBase64 = png.toString('base64')
    t.rt.answerQuestion(item.id, { answers: { 'Which library?': 'see this' }, images: { 'Which library?': [{ mediaType: 'image/png', dataBase64, name: 'shot.png' }] } })
    const result = await promise
    if (result.behavior !== 'allow') throw new Error('the answer was refused')
    const text = (result.updatedInput as { answers: Record<string, string> }).answers['Which library?']
    const m = /^see this\n\[Image: source: (.+)\]$/.exec(text)
    expect(m).not.toBeNull()
    expect(m![1].startsWith(join(home, 'media'))).toBe(true)
    expect(readFileSync(m![1]).equals(png)).toBe(true)
    expect(text).not.toContain(dataBase64)
  })

  test('skip', async () => {
    const t = await working()
    const { promise } = ask(t.fake(), 'AskUserQuestion', { questions })
    t.rt.answerQuestion(lastItem(t.items(), 'question').id, { skip: true })
    expect(await promise).toEqual({ behavior: 'deny', message: 'The user skipped the question.' })
    expect(lastItem(t.items(), 'question').state).toBe('skipped')
  })

  test('plan approve switches the mode', async () => {
    const t = await working()
    const { promise } = ask(t.fake(), 'ExitPlanMode', { plan: '# Plan\n1. do it' })
    const item = lastItem(t.items(), 'plan')
    expect(item.plan).toBe('# Plan\n1. do it')
    t.rt.respondPlan(item.id, { approve: true })
    // The approval carries the mode, so the CLI is out of plan mode before ExitPlanMode or the next tool runs.
    expect(await promise).toEqual({
      behavior: 'allow',
      updatedInput: { plan: '# Plan\n1. do it' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
    await settle()
    expect(t.fake().calls.setPermissionMode).toEqual(['acceptEdits'])
    expect(t.rt.chat.permissionMode).toBe('acceptEdits')
    expect(lastItem(t.items(), 'plan').state).toBe('approved')
  })

  test('plan approve with a chosen mode', async () => {
    const t = await working()
    ask(t.fake(), 'ExitPlanMode', { plan: 'p' })
    t.rt.respondPlan(lastItem(t.items(), 'plan').id, { approve: true, mode: 'bypassPermissions' })
    await settle()
    expect(t.fake().calls.setPermissionMode).toEqual(['bypassPermissions'])
  })

  test('plan reject sends the feedback', async () => {
    const t = await working()
    const { promise } = ask(t.fake(), 'ExitPlanMode', { plan: 'p' })
    t.rt.respondPlan(lastItem(t.items(), 'plan').id, { approve: false, feedback: 'Add tests first' })
    expect(await promise).toEqual({ behavior: 'deny', message: 'Add tests first' })
    expect(lastItem(t.items(), 'plan').state).toBe('rejected')
    expect(t.fake().calls.setPermissionMode).toEqual([])
  })
})

describe('ChatRuntime: interrupt', () => {
  test('stopped, pending requests expire, the error result does not overwrite it', async () => {
    const t = setup()
    t.rt.send('go')
    t.fake().push(hand.init(), state('running'))
    await settle()
    const { promise } = ask(t.fake(), 'Bash', { command: 'sleep 100' })
    await t.rt.interrupt()
    expect(t.fake().calls.interrupt).toBe(1)
    expect(t.rt.chat.status).toBe('stopped')
    expect(t.rt.chat.pendingCount).toBe(0)
    expect(lastItem(t.items(), 'permission').state).toBe('expired')
    expect((await promise).behavior).toBe('deny')

    t.fake().push(result({ errors: ['Request was aborted.'] }), state('idle'))
    await settle()
    expect(t.rt.chat.status).toBe('stopped')
    expect(lastItem(t.items(), 'result').error).toBe('Interrupted')
    expect(t.notifies().map((n) => n.reason)).toEqual(['needs_you'])
  })

  test('a Stop sent while the process still starts ends stopped, not in error, and the next message runs', async () => {
    const t = setup()
    t.rt.send('go')
    await t.rt.interrupt()
    expect(t.rt.chat.status).toBe('stopped')
    // The CLI comes up, begins the turn it was sent, then takes the interrupt.
    t.fake().push(hand.init(), state('running'), result({ errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'] }), state('idle'))
    await settle()
    expect(t.rt.chat.status).toBe('stopped')
    expect(t.rt.chat.lastError).toBeNull()
    expect(lastItem(t.items(), 'result').error).toBe('Interrupted')
    expect(t.notifies()).toEqual([])

    expect(t.rt.send('again')).toEqual({ queued: false })
    expect(t.rt.chat.status).toBe('working')
    // A later turn that really fails says so.
    t.fake().push(state('running'), result({ errors: ['API Error: 500'] }), state('idle'))
    await settle()
    expect(t.rt.chat.status).toBe('error')
  })
})

describe('ChatRuntime: messages while working', () => {
  test('queued, then taken up by the next turn (queued_turn_count and user_message_uuid)', async () => {
    const t = setup()
    t.rt.send('first')
    t.fake().push(hand.init(), state('running'))
    await settle()
    expect(t.rt.send('second')).toEqual({ queued: true })
    await settle()
    expect(t.fake().sent).toHaveLength(2)
    const secondId = t.fake().sent[1]!.uuid!
    expect(t.items().find((i) => i.id === secondId)).toMatchObject({ kind: 'user', text: 'second', queued: true })
    expect(t.rt.chat.queuedCount).toBe(1)

    t.fake().push(result({ queued: 1 }))
    await settle()
    expect(t.rt.chat.status).toBe('working')
    expect(t.rt.chat.queuedCount).toBe(1)

    t.fake().push(messageStart(secondId))
    await settle()
    const taken = t.items().find((i) => i.id === secondId) as { queued?: boolean }
    expect(taken.queued).toBeUndefined()
    expect(t.rt.chat.queuedCount).toBe(0)

    t.fake().push(result({ queued: 0 }), state('idle'))
    await settle()
    expect(t.rt.chat.status).toBe('idle')
    expect(store.loadItems('chat-1').find((i) => i.id === secondId)).not.toHaveProperty('queued')
  })

  test('without queued_turn_count or session state, the result takes up the oldest send', async () => {
    const t = setup()
    t.rt.send('first')
    t.fake().push(hand.init())
    await settle()
    expect(t.rt.chat.status).toBe('working')
    t.rt.send('second')
    await settle()
    const secondId = t.fake().sent[1]!.uuid!
    t.fake().push(result())
    await settle()
    expect(t.rt.chat.status).toBe('working')
    expect(t.rt.chat.queuedCount).toBe(0)
    expect((t.items().find((i) => i.id === secondId) as { queued?: boolean }).queued).toBeUndefined()
    t.fake().push(result())
    await settle()
    expect(t.rt.chat.status).toBe('idle')
  })

  test('a send to an idle chat is not queued and starts a turn', async () => {
    const t = setup()
    t.rt.send('first')
    t.fake().push(hand.init(), state('running'), result(), state('idle'))
    await settle()
    expect(t.rt.chat.status).toBe('idle')
    expect(t.rt.send('again')).toEqual({ queued: false })
    expect(t.rt.chat.status).toBe('working')
    expect(t.fakes).toHaveLength(1)
  })
})

describe('ChatRuntime: errors and limits', () => {
  test('a crash of the SDK process is an error with the stderr tail', async () => {
    const t = setup()
    t.rt.send('go')
    t.fake().push(hand.init(), state('running'))
    await settle()
    const { promise } = ask(t.fake(), 'Bash', { command: 'ls' })
    t.fake().options.stderr!('line one\nfatal: something broke\n')
    t.fake().fail(new Error('Claude Code process exited with code 1'))
    await settle()
    expect(t.rt.chat.status).toBe('error')
    expect(t.rt.chat.lastError).toBe('Claude Code process exited with code 1')
    expect(t.rt.running).toBe(false)
    const sys = lastItem(t.items(), 'system')
    expect(sys.level).toBe('error')
    expect(sys.text).toContain('Claude Code process exited with code 1')
    expect(sys.text).toContain('fatal: something broke')
    expect(lastItem(t.items(), 'permission').state).toBe('expired')
    expect((await promise).behavior).toBe('deny')
    expect(t.notifies().at(-1)).toMatchObject({ reason: 'error', body: 'Claude Code process exited with code 1' })

    // the next send restarts it, resuming the session
    t.rt.send('try again')
    expect(t.fakes).toHaveLength(2)
    expect(t.fake().options.resume).toBe(SID)
  })

  test('a failed turn result is an error', async () => {
    const t = setup()
    t.rt.send('go')
    t.fake().push(hand.init(), state('running'), result({ errors: ['API Error: 500 boom'] }), state('idle'))
    await settle()
    expect(t.rt.chat.status).toBe('error')
    expect(t.rt.chat.lastError).toBe('API Error: 500 boom')
    expect(t.notifies().map((n) => n.reason)).toEqual(['error'])
  })

  test('the rate limit fixture ends limited with the reset time and a system line', async () => {
    const t = setup({ account: { id: 'i68', label: '#68 eek (Max 20x)', configDir: 'C:/a' } })
    t.rt.send('go')
    t.fake().push(...hand.rateLimit())
    await settle()
    expect(t.rt.chat.status).toBe('limited')
    expect(t.rt.chat.limitResetsAt).toBe(1_791_086_400_000)
    const lines = t.items().filter((i) => i.kind === 'system').map((i) => (i as { text: string }).text)
    expect(lines.some((l) => l.startsWith('Usage limit reached (5-hour) on #68 eek (Max 20x).'))).toBe(true)
    expect(t.notifies().map((n) => n.reason)).toEqual(['limited'])
  })

  test('a turn failing on a usage limit without a rate_limit_event is limited too', async () => {
    const t = setup({ account: { id: 'i68', label: '#68', configDir: 'C:/a' } })
    t.rt.send('go')
    t.fake().push(hand.init(), state('running'), result({ errors: ['Claude AI usage limit reached|1791086400'] }), state('idle'))
    await settle()
    expect(t.rt.chat.status).toBe('limited')
    expect(t.notifies().map((n) => n.reason)).toEqual(['limited'])
    expect(t.items().some((i) => i.kind === 'system' && i.text === 'Usage limit reached on #68.')).toBe(true)
  })

  test('a per-minute 429 is an error that can be sent again, not a usage limit', async () => {
    const t = setup({ account: { id: 'i68', label: '#68', configDir: 'C:/a' } })
    t.rt.send('go')
    const text = 'API Error: 429 Rate limit reached for requests per minute'
    const message = { id: 'msg_429', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
    const rateLimited = { type: 'assistant', message, parent_tool_use_id: null, error: 'rate_limit', uuid: uuid(), session_id: SID } as unknown as SDKMessage
    t.fake().push(hand.init(), state('running'), rateLimited, result({ errors: [text] }), state('idle'))
    await settle()
    expect(t.rt.chat.status).toBe('error')
    expect(t.rt.chat.lastError).toBe(text)
    expect(t.notifies().map((n) => n.reason)).not.toContain('limited')
  })

  test('isUsageLimitText: the plan limit, not a per-minute rate limit, an overload or the context window', () => {
    for (const s of [
      'Claude AI usage limit reached|1791086400',
      "You've hit your limit · resets 3pm",
      'Usage limit reached (5-hour)',
      '5-hour limit reached ∙ resets Sun 12:00',
      'Your limit will reset at 3pm',
      "You're out of extra usage",
      // the Claude Code CLI's own words, as AgentHydra shows them on stopped sessions
      "You've hit your session limit · resets 10:50am (America/Chicago)",
      "You've hit your weekly limit · resets 10pm (America/Chicago)",
      "You've hit your session limit",
      'Opus weekly limit reached',
    ])
      expect(isUsageLimitText(s)).toBe(true)
    for (const s of [
      'Context limit reached',
      'API Error: 429 Rate limit reached for requests per minute',
      'This request would exceed the rate limit for your organization of 40,000 input tokens per minute',
      'Overloaded',
      'Output token limit reached',
      'Rate limit hit, resets in 30 seconds',
    ])
      expect(isUsageLimitText(s)).toBe(false)
  })
})

describe('ChatRuntime: live controls and lifecycle', () => {
  test('setPermissionMode, setModel and setEffort use the query control methods', async () => {
    const t = setup()
    t.rt.start()
    await t.rt.setPermissionMode('plan')
    await t.rt.setModel('claude-sonnet-5-5')
    await t.rt.setModel(null)
    await t.rt.setEffort('max')
    expect(t.fake().calls.setPermissionMode).toEqual(['plan'])
    expect(t.fake().calls.setModel).toEqual(['claude-sonnet-5-5', undefined])
    expect(t.fake().calls.applyFlagSettings).toEqual([{ effortLevel: 'max' }])
    expect(t.rt.chat).toMatchObject({ permissionMode: 'plan', model: null, effort: 'max' })
  })

  test('a model the process refuses goes back to the old one with a warning', async () => {
    const t = setup()
    t.rt.start()
    await t.rt.setModel('claude-sonnet-5-5')
    t.fake().refuseModel = true
    await t.rt.setModel('claude-haiku-4-5')
    expect(t.rt.chat.model).toBe('claude-sonnet-5-5')
  })

  test('close ends the query and the chat is closed', async () => {
    const t = setup()
    t.rt.send('go')
    t.fake().push(hand.init(), state('running'), result(), state('idle'))
    await settle()
    await t.rt.close()
    expect(t.fake().calls.close).toBe(1)
    expect(t.rt.chat.status).toBe('closed')
    expect(t.rt.running).toBe(false)
  })

  test('an account switched under a running turn: the runtime ends when the turn does, then starts under the new one', async () => {
    const t = setup()
    t.rt.send('go')
    t.fake().push(hand.init(), state('running'))
    await settle()
    t.rt.chat.account = { id: 'other', label: 'Other', configDir: 'C:/other' }
    await t.rt.closeWhenIdle()
    expect(t.fake().calls.close).toBe(0)
    expect(t.rt.startedAs?.id).toBe('default')

    t.fake().push(result(), state('idle'))
    await settle()
    expect(t.fake().calls.close).toBe(1)
    expect(t.rt.chat.status).toBe('closed')

    t.rt.send('again')
    expect(t.fakes).toHaveLength(2)
    expect(t.fake().options.env?.CLAUDE_CONFIG_DIR).toBe('C:/other')
    expect(t.rt.startedAs?.id).toBe('other')
  })

  test('the idle timer closes the runtime', async () => {
    const t = setup({}, { settings: { ...SETTINGS, idleCloseMinutes: 0.0005 } })
    t.rt.send('go')
    t.fake().push(hand.init(), state('running'), result(), state('idle'))
    await settle()
    expect(t.rt.chat.status).toBe('idle')
    await new Promise((r) => setTimeout(r, 80))
    expect(t.rt.chat.status).toBe('closed')
    expect(t.fake().calls.close).toBe(1)
  })
})

// Prompts (SPEC "Prompts"): what the card is told, the session choice, the first-request notice,
// plan mode's way back, and MCP elicitation.

type AskOptions = Parameters<NonNullable<Options['canUseTool']>>[2]

/** Opens a canUseTool request with any of the SDK's prompt fields. */
function askWith(f: FakeQuery, toolName: string, input: Record<string, unknown>, extra: Partial<AskOptions> = {}) {
  const ac = new AbortController()
  const promise = f.options.canUseTool!(toolName, input, { signal: ac.signal, toolUseID: `toolu_${uuid()}`, requestId: uuid(), ...extra }) as Promise<PermissionResult>
  return { promise, ac }
}

/** Opens an MCP elicitation the way the SDK would. */
function elicit(f: FakeQuery, request: ElicitationRequest) {
  const ac = new AbortController()
  const promise = f.options.onElicitation!(request, { signal: ac.signal, requestId: uuid() }) as Promise<ElicitationResult>
  return { promise, ac }
}

async function workingChat(chatOver: Partial<ChatSummary> = {}) {
  const t = setup(chatOver)
  t.rt.send('go')
  t.fake().push(hand.init(), state('running'))
  await settle()
  return t
}

const RULES: PermissionUpdate[] = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
]

describe('ChatRuntime: what a permission prompt says', () => {
  test('the SDK title, description, reason, defaultToNo and the rules "Always allow" saves', async () => {
    const t = await workingChat()
    askWith(t.fake(), 'Bash', { command: 'git status' }, {
      title: 'Claude wants to run git status',
      description: 'Reads the working tree',
      decisionReason: 'Matched the ask rule Bash(git:*)',
      defaultToNo: true,
      suggestions: RULES,
    })
    expect(lastItem(t.items(), 'permission')).toMatchObject({
      title: 'Claude wants to run git status',
      description: 'Reads the working tree',
      reason: 'Matched the ask rule Bash(git:*)',
      defaultToNo: true,
      canAlwaysAllow: true,
      alwaysRules: ['Bash(git status:*) in this project', 'Accept edits mode for this session'],
    })
    expect(t.notifies().map((n) => n.body)).toEqual(['Claude wants to run git status'])
  })

  test('suppressAlwaysAllowRule: no always or session choice, and an "always" answer saves nothing', async () => {
    const t = await workingChat()
    const { promise } = askWith(t.fake(), 'Bash', { command: 'rm -rf build' }, { suggestions: RULES, suppressAlwaysAllowRule: true })
    const item = lastItem(t.items(), 'permission')
    expect(item.canAlwaysAllow).toBe(false)
    expect(item.alwaysRules).toBeUndefined()
    t.rt.respondPermission(item.id, { decision: 'always' })
    expect(await promise).toEqual({ behavior: 'allow', updatedInput: { command: 'rm -rf build' }, updatedPermissions: [] })
  })

  test('session saves the same rules for this session only', async () => {
    const t = await workingChat()
    const { promise } = askWith(t.fake(), 'Bash', { command: 'git status' }, { suggestions: RULES })
    t.rt.respondPermission(lastItem(t.items(), 'permission').id, { decision: 'session' })
    const result = await promise
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: { command: 'git status' } })
    const saved = (result as { updatedPermissions?: PermissionUpdate[] }).updatedPermissions ?? []
    expect(saved.map((s) => s.destination)).toEqual(['session', 'session'])
    expect(saved[0]).toMatchObject({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }] })
    expect(lastItem(t.items(), 'permission').state).toBe('session')
    expect(t.rt.chat.status).toBe('working')
  })
})

describe('ChatRuntime: the needs_you notice', () => {
  test('the first open request notifies even when requires_action came first; later ones while it waits do not', async () => {
    const t = await workingChat()
    t.fake().push(state('requires_action'))
    await settle()
    expect(t.rt.chat.status).toBe('needs_you')
    askWith(t.fake(), 'Bash', { command: 'ls' })
    const first = lastItem(t.items(), 'permission')
    askWith(t.fake(), 'Write', { file_path: 'a' })
    const second = lastItem(t.items(), 'permission')
    expect(t.notifies().map((n) => n.reason)).toEqual(['needs_you'])
    t.rt.respondPermission(first.id, { decision: 'allow' })
    t.rt.respondPermission(second.id, { decision: 'allow' })
    askWith(t.fake(), 'Edit', { file_path: 'b' })
    expect(t.notifies().map((n) => n.reason)).toEqual(['needs_you', 'needs_you'])
  })
})

describe('ChatRuntime: plan approval returns to the mode before plan mode', () => {
  test('a Bypass chat switched to Plan is Bypass again once the plan is approved', async () => {
    const t = await workingChat({ permissionMode: 'bypassPermissions' })
    await t.rt.setPermissionMode('plan')
    askWith(t.fake(), 'ExitPlanMode', { plan: 'p' })
    t.rt.respondPlan(lastItem(t.items(), 'plan').id, { approve: true })
    await settle()
    expect(t.fake().calls.setPermissionMode).toEqual(['plan', 'bypassPermissions'])
    expect(t.rt.chat.permissionMode).toBe('bypassPermissions')
  })

  test("Claude's own switch to plan mode is remembered too", async () => {
    const t = await workingChat({ permissionMode: 'bypassPermissions' })
    t.fake().push({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan', uuid: uuid(), session_id: SID } as unknown as SDKMessage)
    await settle()
    expect(t.rt.chat.permissionMode).toBe('plan')
    askWith(t.fake(), 'ExitPlanMode', { plan: 'p' })
    t.rt.respondPlan(lastItem(t.items(), 'plan').id, { approve: true })
    await settle()
    expect(t.fake().calls.setPermissionMode).toEqual(['bypassPermissions'])
  })

  test('a mode sent with the approval wins over the remembered one', async () => {
    const t = await workingChat({ permissionMode: 'bypassPermissions' })
    await t.rt.setPermissionMode('plan')
    askWith(t.fake(), 'ExitPlanMode', { plan: 'p' })
    t.rt.respondPlan(lastItem(t.items(), 'plan').id, { approve: true, mode: 'default' })
    await settle()
    expect(t.fake().calls.setPermissionMode).toEqual(['plan', 'default'])
  })

  test('a process restarted in plan mode is launched so that it can go back to Bypass', async () => {
    const t = await workingChat({ permissionMode: 'bypassPermissions' })
    await t.rt.setPermissionMode('plan')
    await t.rt.close()
    t.rt.send('keep planning')
    expect(t.fakes).toHaveLength(2)
    expect(t.fake().options).toMatchObject({ permissionMode: 'plan', allowDangerouslySkipPermissions: true })
    const { promise } = askWith(t.fake(), 'ExitPlanMode', { plan: 'p' })
    t.rt.respondPlan(lastItem(t.items(), 'plan').id, { approve: true })
    expect(await promise).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] })
    await settle()
    expect(t.rt.chat.permissionMode).toBe('bypassPermissions')
  })

  test('once plan mode is left for another mode, the next start is not launched for Bypass', async () => {
    const t = await workingChat({ permissionMode: 'bypassPermissions' })
    await t.rt.setPermissionMode('plan')
    askWith(t.fake(), 'ExitPlanMode', { plan: 'p' })
    t.rt.respondPlan(lastItem(t.items(), 'plan').id, { approve: true, mode: 'default' })
    await settle()
    await t.rt.close()
    t.rt.send('go on')
    expect(t.fake().options.permissionMode).toBe('default')
    expect(t.fake().options.allowDangerouslySkipPermissions).toBeUndefined()
  })

  test('a mode the CLI refuses is not claimed: the chat keeps its mode and says why', async () => {
    const t = await workingChat({ permissionMode: 'default' })
    t.fake().refuseMode = 'bypassPermissions'
    await t.rt.setPermissionMode('bypassPermissions')
    expect(t.rt.chat.permissionMode).toBe('default')
    expect(lastItem(t.items(), 'system')).toMatchObject({ level: 'warn', text: expect.stringContaining('was not launched with --dangerously-skip-permissions') })
  })
})

describe('ChatRuntime: MCP elicitation', () => {
  const form: ElicitationRequest = {
    serverName: 'connections',
    message: 'Pick a workspace',
    mode: 'form',
    requestedSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', title: 'Workspace', enum: ['a', 'b'], enumNames: ['Alpha', 'Beta'] },
        count: { type: 'integer', title: 'How many' },
      },
      required: ['workspace'],
    },
  }

  test('a form is shown, counted and notified; accept sends the values coerced, unknown ones dropped', async () => {
    const t = await workingChat()
    expect(typeof t.fake().options.onElicitation).toBe('function')
    const { promise } = elicit(t.fake(), form)
    const item = lastItem(t.items(), 'elicitation')
    expect(item).toMatchObject({ serverName: 'connections', message: 'Pick a workspace', mode: 'form', state: 'pending' })
    expect(item.fields?.map((f) => [f.name, f.type, f.required])).toEqual([
      ['workspace', 'choice', true],
      ['count', 'number', false],
    ])
    expect(t.rt.chat).toMatchObject({ status: 'needs_you', pendingCount: 1 })
    expect(t.notifies().map((n) => [n.reason, n.body])).toEqual([['needs_you', 'Pick a workspace']])

    t.rt.answerElicitation(item.id, { action: 'accept', values: { workspace: 'b', count: '3', extra: 'x' } })
    expect(await promise).toEqual({ action: 'accept', content: { workspace: 'b', count: 3 } })
    expect(lastItem(t.items(), 'elicitation')).toMatchObject({ state: 'accepted', values: { workspace: 'b', count: 3 } })
    expect(t.rt.chat).toMatchObject({ status: 'working', pendingCount: 0 })
    expect(store.loadItems('chat-1').find((i) => i.id === item.id)).toMatchObject({ state: 'accepted' })
  })

  test('an answer the form refuses leaves the request open; decline answers it', async () => {
    const t = await workingChat()
    const { promise } = elicit(t.fake(), form)
    const item = lastItem(t.items(), 'elicitation')
    expect(() => t.rt.answerElicitation(item.id, { action: 'accept', values: {} })).toThrow(ElicitationAnswerError)
    expect(() => t.rt.answerElicitation(item.id, { action: 'accept', values: { workspace: 'c' } })).toThrow('Workspace must be one of a, b')
    expect(t.rt.isPending(item.id)).toBe(true)
    expect(t.rt.chat.pendingCount).toBe(1)
    t.rt.answerElicitation(item.id, { action: 'decline' })
    expect(await promise).toEqual({ action: 'decline' })
    expect(lastItem(t.items(), 'elicitation').state).toBe('declined')
    expect(() => t.rt.answerElicitation(item.id, { action: 'decline' })).toThrow('no pending elicitation request')
  })

  test('a link: accepted once Jacob says he is done; a link that is not http(s) is not kept', async () => {
    const t = await workingChat()
    const { promise } = elicit(t.fake(), { serverName: 'connections', message: 'Sign in', mode: 'url', url: 'https://auth.example.test/start' })
    const item = lastItem(t.items(), 'elicitation')
    expect(item).toMatchObject({ mode: 'url', url: 'https://auth.example.test/start' })
    expect(item.fields).toBeUndefined()
    t.rt.answerElicitation(item.id, { action: 'accept' })
    expect(await promise).toEqual({ action: 'accept' })

    elicit(t.fake(), { serverName: 'evil', message: 'Click', mode: 'url', url: 'javascript:alert(1)' })
    expect(lastItem(t.items(), 'elicitation').url).toBeUndefined()
  })

  test('interrupt and the SDK aborting it expire it with a cancel', async () => {
    const t = await workingChat()
    const aborted = elicit(t.fake(), form)
    aborted.ac.abort()
    expect(await aborted.promise).toEqual({ action: 'cancel' })
    expect(lastItem(t.items(), 'elicitation').state).toBe('expired')
    expect(t.rt.chat.pendingCount).toBe(0)

    const open = elicit(t.fake(), form)
    await t.rt.interrupt()
    expect(await open.promise).toEqual({ action: 'cancel' })
    expect(lastItem(t.items(), 'elicitation').state).toBe('expired')
    expect(t.rt.chat.status).toBe('stopped')
  })
})
