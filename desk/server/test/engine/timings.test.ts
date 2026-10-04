import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { DeskSettings } from '@shared/protocol'
import type { TimingSpan } from '@shared/timings'
import { ChatManager } from '../../src/engine/chat-manager'
import { buildReport, percentile } from '../../src/engine/timings'
import { fakeBridge, fakeQueries } from './manager/fakes'

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

const SETTINGS = { idleCloseMinutes: 30, defaultAccountId: 'default', defaultModel: null, defaultEffort: null, defaultPermissionMode: 'default', delegateToCliMayte: false } as unknown as DeskSettings
const msg = (m: object): SDKMessage => m as unknown as SDKMessage
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('speed tracking', () => {
  test('a turn writes a span for each stage, in order', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-timings-'))
    homes.push(home)
    // A clock in this month: the log rolls a file last written in another one.
    let clock = Date.now()
    const queries = fakeQueries()
    const manager = new ChatManager({ home, emit: () => {}, settings: () => SETTINGS, bridge: fakeBridge().bridge, queryImpl: queries.queryImpl, agentHydraMcp: null, now: () => clock, newChats: 'sdk', storeDebounceMs: 0 })
    const chat = await manager.create({ cwd: tmpdir(), prompt: 'hello' })
    await tick()
    const q = queries.last()
    const step = async (ms: number, m: object): Promise<void> => {
      clock += ms
      q.push(msg(m))
      await tick()
    }
    await step(800, { type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'SessionStart:startup', hook_event: 'SessionStart' })
    await step(11_000, { type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', outcome: 'success', stderr: 'origin-drift-tripwire.mjs: fetch timed out', exit_code: 0 })
    await step(200, { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5', tools: [], mcp_servers: [] })
    await step(1500, { type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } })
    await step(100, { type: 'assistant', session_id: 's1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } })
    await step(3000, { type: 'user', session_id: 's1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })
    await step(400, { type: 'result', subtype: 'success', is_error: false, session_id: 's1', duration_ms: 5000, duration_api_ms: 2100, num_turns: 1, result: 'done', total_cost_usd: 0.01, queued_turn_count: 0 })

    const spans = manager.timings.read().filter((s) => s.chatId === chat.id)
    expect(spans.map((s) => s.stage)).toEqual(['process_start', 'hook', 'session_start_hooks', 'ready', 'first_token', 'tool', 'api', 'turn'])
    const by = (stage: string): TimingSpan => spans.find((s) => s.stage === stage)!
    expect(by('process_start').ms).toBe(800)
    // The script a hook names in its own output is the row's name: the SDK gives only the event.
    expect(by('hook')).toMatchObject({ name: 'SessionStart:origin-drift-tripwire.mjs', ms: 11_000, ok: true })
    expect(by('session_start_hooks')).toMatchObject({ name: 'startup', ms: 11_000 })
    expect(by('ready')).toMatchObject({ ms: 12_000, cold: 'new' })
    expect(by('first_token').ms).toBe(1500)
    expect(by('tool')).toMatchObject({ name: 'Bash', ms: 3000 })
    expect(by('api').ms).toBe(2100)
    expect(by('turn')).toMatchObject({ ms: 17_000, cold: 'new', ok: true, kind: 'sdk', stages: { hooks: 11_000, ready: 12_000, first_token: 1500, tools: 3000, api: 2100 } })
    // Every line of the turn carries its id.
    expect(new Set(spans.map((s) => s.turnId))).toEqual(new Set([by('turn').turnId]))
    await manager.closeAll({ chats: true })
  })

  test('percentiles are nearest rank, and the report ranks by total time lost', () => {
    expect(percentile([], 0.5)).toBe(0)
    expect(percentile([40, 10, 30, 20], 0.5)).toBe(20)
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBe(90)
    expect(percentile([7], 0.9)).toBe(7)

    const now = new Date(2026, 9, 4, 15, 0, 0).getTime()
    const h = 3_600_000
    const span = (s: Partial<TimingSpan> & Pick<TimingSpan, 'stage' | 'ms'>): TimingSpan => ({ ts: now - h, ...s })
    const r = buildReport(
      [
        // The hook run twice loses the most; two Bash calls lose more than one Read.
        span({ stage: 'tool', name: 'Bash', ms: 2000 }),
        span({ stage: 'tool', name: 'Bash', ms: 3000 }),
        span({ stage: 'tool', name: 'Read', ms: 100 }),
        span({ stage: 'hook', name: 'SessionStart:slow.mjs', ms: 11_000 }),
        span({ stage: 'hook', name: 'SessionStart:slow.mjs', ms: 10_000 }),
        span({ stage: 'hook', name: 'PreToolUse:Bash', ms: 50 }),
        span({ stage: 'ready', ms: 13_000, cold: 'resume' }),
        span({ stage: 'ready', ms: 0, cold: 'warm' }),
        span({ stage: 'turn', ms: 20_000, chatId: 'a', turnId: 't1', accountNumber: 126, accountId: 'inst-126', model: 'opus', cwd: 'C:/x', cold: 'resume', stages: { ready: 13_000 } }),
        span({ stage: 'worker_turn', ms: 90_000, chatId: 'b', turnId: 't2', accountNumber: 61, accountId: 'inst-61', model: 'opus', cwd: 'C:/y', kind: 'worker' }),
        // A whole turn and the model's own time are not waits; yesterday's line is not today's, and one past 7 days is not read.
        span({ stage: 'api', ms: 500_000 }),
        { ts: now - 30 * h, stage: 'tool', name: 'Bash', ms: 60_000 },
        { ts: now - 9 * 24 * h, stage: 'tool', name: 'Bash', ms: 999_000 },
      ],
      now,
    )
    expect(r.spans).toBe(12)
    expect(r.slowNow.map((s) => [s.stage, s.name ?? null, s.totalMs])).toEqual([
      ['hook', 'SessionStart:slow.mjs', 21_000],
      ['ready', null, 13_000],
      ['tool', 'Bash', 5000],
      ['tool', 'Read', 100],
      ['hook', 'PreToolUse:Bash', 50],
    ])
    expect(r.week.find((s) => s.stage === 'tool')).toMatchObject({ count: 4, p50: 2000, p90: 60_000, max: 60_000, totalMs: 65_100 })
    expect(r.today.find((s) => s.stage === 'tool')).toMatchObject({ count: 3, p50: 2000, p90: 3000, max: 3000 })
    expect(r.coldStart.map((s) => s.name)).toEqual(['SessionStart:slow.mjs'])
    expect(r.ready.map((g) => [g.key, g.p50])).toEqual([['resume', 13_000], ['warm', 0]])
    expect(r.slowestTurns.map((t) => [t.chatId, t.ms, t.kind])).toEqual([['b', 90_000, 'worker'], ['a', 20_000, 'sdk']])
    expect(r.byAccount.map((g) => [g.key, g.turns])).toEqual([['#61', 1], ['#126', 1]])
    expect(r.byFolder[0]).toMatchObject({ key: 'C:/y', totalMs: 90_000 })
  })
})
