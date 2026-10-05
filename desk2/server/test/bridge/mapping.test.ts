// The pure mappings from AgentHydra's shapes to the protocol's, on the recorded samples.

import { describe, expect, test } from 'bun:test'
import { mapAccounts } from '../../src/bridge/accounts'
import { activeFor, mapWorkers, workersOfChat } from '../../src/bridge/climayte'
import { mapExternal, tailToItems, workerDetailToItems } from '../../src/bridge/external'
import { fixture, freshState, NOW } from './fake-hydra'

const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('accounts', () => {
  const accounts = mapAccounts(fixture('cli-instances'), fixture('corch-workers'))

  test('the default login comes first, then every CLI instance', () => {
    expect(accounts.map((a) => a.id)).toEqual(['default', 'cli-1', 'cli-2', 'cli-3', 'cli-4', 'cli-5'])
    expect(accounts[0]).toMatchObject({ id: 'default', configDir: null, signedIn: true, inUse: false, fiveHourPct: null })
  })

  test('an instance maps its plan, usage, resets and live sessions', () => {
    const a = accounts.find((x) => x.id === 'cli-1')!
    expect(a).toMatchObject({
      label: '#60 acct1 (Max 20x)',
      number: 60,
      configDir: 'C:\\Users\\me\\.claude-cli\\cli-1',
      email: 'user1@example.com',
      plan: 'Max 20x',
      signedIn: true,
      fiveHourPct: 17,
      weeklyPct: 39,
      fiveHourResetsAt: Date.parse('2026-10-04T02:50:00.000Z'),
      weeklyResetsAt: Date.parse('2026-10-09T07:00:00.000Z'),
      inUse: true, // 6 live sessions
    })
    const out = accounts.find((x) => x.id === 'cli-5')!
    expect(out).toMatchObject({ signedIn: false, fiveHourPct: null, weeklyPct: null, plan: null })
  })

  test('a running worker makes its account in use even before the live registry counts it', () => {
    const inst = fixture('cli-instances').map((i: any) => ({ ...i, liveSessions: 0 }))
    const busy = mapAccounts(inst, [{ ...fixture('corch-workers')[0], status: 'running', accountId: 'cli-2' }])
    expect(busy.find((a) => a.id === 'cli-2')!.inUse).toBe(true)
    expect(busy.find((a) => a.id === 'cli-3')!.inUse).toBe(false)
  })

  test('a Quick add name that already ends in its plan shows the plan once', () => {
    const inst = fixture('cli-instances')
    inst[1].name = 'someone@example.com (Pro)'
    const a = mapAccounts(inst, []).find((x) => x.id === 'cli-2')!
    expect(a.label).toBe('#61 someone@example.com (Pro)')
  })

  test('a reading taken before a sign-out is not used', () => {
    const inst = fixture('cli-instances')
    inst[1].lastUsageCheck.signedOutAt = '2026-10-03T20:00:00.000Z'
    const a = mapAccounts(inst, []).find((x) => x.id === 'cli-2')!
    expect(a.fiveHourPct).toBeNull()
    expect(a.weeklyPct).toBeNull()
  })
})

describe('CliMayte workers', () => {
  const raw = fixture('corch-workers')
  const workers = mapWorkers(raw)

  test('maps each worker and lists the active ones first', () => {
    expect(workers.map((w) => [w.id, w.active])).toEqual([
      ['w-00000001', true],
      ['w-00000002', true],
      ['w-00000003', false],
      ['w-00000004', false],
    ])
    expect(workers[0]).toEqual({
      id: 'w-00000001',
      title: 'Worker task 1',
      description: 'Build the thing. Done means the tests pass.',
      group: 'g-abc123',
      status: 'running',
      active: true,
      account: '#60',
      model: 'claude-opus-5-5',
      effort: 'medium',
      kind: 'debug',
      cwd: 'C:\\Users\\me\\Desktop\\Project\\alpha',
      sessionId: sid(500),
      originSessionId: sid(1),
      originWorkerId: null,
      sessions: [],
      startedAt: 1791069626312,
      endedAt: null,
      lastActivityAt: 1791069687692,
      lastActivity: 'Bash bun test ./server/test',
      usedPct: 0,
      tokens: null,
      verdict: null,
      error: null,
    })
  })

  test('a settled worker has ended when it last changed and carries every token it was charged', () => {
    const done = workers.find((w) => w.id === 'w-00000003')!
    expect(done.endedAt).toBe(done.lastActivityAt)
    expect(done.tokens).toBe(56 + 24323 + 1905603 + 148694)
    expect(workers[0].endedAt).toBeNull()
  })

  test("a worker dispatched by another worker, or a wave's task, takes that worker (the wave's manager) and its session as its origin", () => {
    const child = { ...raw[0], id: 'w-child', sessionId: sid(600), origin: { kind: 'worker', workerId: 'w-00000001' } }
    const mapped = mapWorkers([...raw, child]).find((w) => w.id === 'w-child')!
    expect(mapped.originSessionId).toBe(sid(500))
    // The recorded wave: its task w-00000003 has no origin, only the wave its manager w-00000002 (dispatched
    // by the chat sid(1)) runs (owner, 2026-10-04: CliMayte's chats sit under the chat that spawned them).
    expect(workers.find((w) => w.id === 'w-00000003')).toMatchObject({ originWorkerId: 'w-00000002', originSessionId: sid(501) })
    expect(workers.find((w) => w.id === 'w-00000002')).toMatchObject({ originWorkerId: null, originSessionId: sid(1) })
    // The chat's own count finds the task through its manager, as the sidebar nests it.
    expect(workersOfChat(workers, { sessionId: sid(1) }).map((w) => w.id)).toEqual(['w-00000001', 'w-00000002', 'w-00000003', 'w-00000004'])
  })

  test('activeFor keeps the active workers a chat dispatched', () => {
    expect(activeFor(workers, sid(1)).map((w) => w.id)).toEqual(['w-00000001', 'w-00000002'])
    expect(activeFor(workers, sid(2))).toEqual([])
  })
})

describe('external sessions', () => {
  const s = freshState()
  const inputs = {
    agentStatus: s.agentStatus,
    live: s.live.sessions,
    chats: s.chats.rows,
    sessions: s.sessions,
    workers: s.workers,
  }

  test('merges workers, desktop chats, the live registry, hooks and fresh transcripts', () => {
    const list = mapExternal(inputs, new Set(), NOW)
    const by = new Map(list.map((x) => [x.id, x]))
    expect(list.length).toBe(7)
    // a hook said blocked: needs you, listed first
    expect(list[0]).toMatchObject({ id: sid(3), source: 'desktop', status: 'needs_you', activity: 'Waiting on you', instance: 'Claude-2' })
    expect(by.get(sid(1))).toMatchObject({ source: 'desktop', status: 'working', title: 'Desktop chat 3' })
    // its hook row is a restored, unconfirmed one: ignored; its transcript was written 22 s ago
    expect(by.get(sid(2))).toMatchObject({ source: 'desktop', status: 'working', activity: null })
    expect(by.get(sid(77))).toMatchObject({ source: 'cli', status: 'working', activity: '1 sub-agent running' })
    expect(by.get(sid(4))).toMatchObject({ source: 'cli', status: 'working', instance: 'Claude-4' })
    expect(by.get(sid(500))).toMatchObject({ source: 'climayte', status: 'working', instance: '#60', model: 'claude-opus-5-5' })
    expect(by.get(sid(501))).toMatchObject({ source: 'climayte', status: 'idle', activity: 'Waiting for an account' })
    // finished workers are not sessions anyone is running
    expect(by.has(sid(502))).toBe(false)
  })

  test('without a hook row the transcript age decides: idle, then stale after 2 h', () => {
    const noHooks = { ...inputs, agentStatus: [] }
    // a session only the index knows (written 16 s before NOW) stays listed, idle, for 10 minutes after its last write
    expect(mapExternal(noHooks, new Set(), NOW + 5 * 60_000).find((x) => x.id === sid(4))).toMatchObject({ source: 'cli', status: 'idle' })
    const later = mapExternal(noHooks, new Set(), NOW + 10 * 60_000)
    expect(later.find((x) => x.id === sid(3))!.status).toBe('idle')
    expect(later.some((x) => x.status === 'needs_you')).toBe(false)
    // and then leaves it
    expect(later.some((x) => x.id === sid(4))).toBe(false)
    const hoursLater = mapExternal(noHooks, new Set(), NOW + 3 * 3600_000)
    expect(hoursLater.find((x) => x.id === sid(3))!.status).toBe('stale')
  })

  // While 30 s was the whole window, an HSwarm job came and went with each burst of writes (owner, 2026-10-05).
  test("HSwarm's job transcripts stay out of the list however fresh; one asked for by id is still found", () => {
    const job = { ...inputs.sessions.find((r) => r.session_id === sid(4))!, session_id: sid(900), source: 'zswarm', last_activity_at: NOW - 5_000 }
    const withJob = { ...inputs, sessions: [...inputs.sessions, job] }
    expect(mapExternal(withJob, new Set(), NOW).some((x) => x.id === sid(900))).toBe(false)
    expect(mapExternal({ ...withJob, wanted: new Set([sid(900)]) }, new Set(), NOW).find((x) => x.id === sid(900))).toMatchObject({ source: 'other', status: 'working' })
  })

  // The desk list's cloud icon (ExternalRow) is drawn from this: nothing else carries AgentHydra's mark there.
  test("a Desktop chat the chat sync brought from another PC carries that PC's name; this PC's and workers carry none", () => {
    const synced = { ...inputs, sessions: inputs.sessions.map((r) => (r.session_id === sid(3) ? { ...r, from_pc: 'OTHER-PC' } : r)) }
    const by = new Map(mapExternal(synced, new Set(), NOW).map((x) => [x.id, x]))
    expect(by.get(sid(3))?.fromPc).toBe('OTHER-PC')
    expect(by.get(sid(1))?.fromPc).toBeNull()
    expect(by.get(sid(500))?.fromPc).toBeNull()
  })

  test("Hydra Desk's own chats are left out", () => {
    const list = mapExternal(inputs, new Set([sid(1), sid(500)]), NOW)
    expect(list.map((x) => x.id)).not.toContain(sid(1))
    expect(list.map((x) => x.id)).not.toContain(sid(500))
    expect(list.length).toBe(5)
  })
})

describe('transcripts', () => {
  test('the tail becomes user, thinking, text and tool calls paired with their results', () => {
    const items = tailToItems(fixture('tail'))
    expect(items.map((i) => (i.kind === 'tool_use' ? `${i.name}:${i.status}` : i.kind))).toEqual([
      'user',
      'thinking',
      'assistant_text',
      'Bash:done',
      'Grep:done',
      'Read:error',
      'mcp__agenthydra__check_my_usage:done',
      'Edit:done',
      'assistant_text',
      'Bash:running',
    ])
    const tools = items.filter((i) => i.kind === 'tool_use') as Extract<(typeof items)[number], { kind: 'tool_use' }>[]
    expect(tools[0].input).toEqual({ command: 'bun test', description: 'Run tests' })
    expect(tools[0].result).toEqual({ text: '3 pass 1 fail', isError: false })
    expect(tools[0].endedAt).toBe(Date.parse('2026-10-03T23:10:09.000Z'))
    expect(tools[2].result?.isError).toBe(true)
    // its result was empty (the tail drops those): closed as done without one
    expect(tools[3].result).toBeUndefined()
    // AgentHydra cut this input: kept raw rather than dropped
    expect(Object.keys(tools[4].input)).toEqual(['raw'])
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
  })

  test('a worker detail becomes its task, event lines and running last tool', () => {
    const items = workerDetailToItems(fixture('corch-worker-detail'))
    expect(items.map((i) => i.kind)).toEqual(['system', 'user', 'system', 'tool_use', 'tool_use', 'assistant_text', 'system'])
    expect(items[1]).toMatchObject({ kind: 'user', text: 'Build the thing. Done means the tests pass.' })
    expect(items[3]).toMatchObject({ kind: 'tool_use', name: 'Read', input: { file_path: 'C:\\Users\\me\\Desktop\\Project\\alpha\\SPEC.md' } })
    expect(items[4]).toMatchObject({ kind: 'tool_use', name: 'Bash', input: { command: 'bun test' }, status: 'done' })
  })
})
