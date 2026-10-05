import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { TranscriptItem } from '@shared/protocol'
import { createNormalizer, type Emission, type NormalizerOptions } from '../../src/engine/normalize'
import * as hand from '../fixtures/hand-built'

const NOW = 1_000

function loadJsonl(name: string): SDKMessage[] {
  return readFileSync(join(import.meta.dir, '..', 'fixtures', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SDKMessage)
}

/** Replays a stream; returns every emission and the transcript folded from them (upserts + deltas). */
function replay(msgs: SDKMessage[], opts: NormalizerOptions = {}) {
  const n = createNormalizer({ now: () => NOW, formatTime: (ms) => new Date(ms).toISOString(), ...opts })
  const emissions: Emission[] = []
  for (const m of msgs) emissions.push(...n.handle(m))
  const items = new Map<string, TranscriptItem>()
  for (const e of emissions) {
    if (e.type === 'upsert') items.set(e.item.id, e.item)
    else if (e.type === 'delta') {
      const it = items.get(e.itemId) as { text: string } | undefined
      if (!it) throw new Error(`delta before upsert: ${e.itemId}`)
      items.set(e.itemId, { ...(it as object), text: it.text + e.text } as TranscriptItem)
    }
  }
  const of = <T extends Emission['type']>(t: T) => emissions.filter((e) => e.type === t) as Extract<Emission, { type: T }>[]
  return { emissions, items, list: [...items.values()], of, normalizer: n }
}

const get = <K extends TranscriptItem['kind']>(items: Map<string, TranscriptItem>, id: string, kind: K) => {
  const it = items.get(id)
  expect(it?.kind).toBe(kind)
  return it as Extract<TranscriptItem, { kind: K }>
}

describe('basic-turn.jsonl (recorded from a real SDK run)', () => {
  const msgs = loadJsonl('basic-turn.jsonl')
  const r = replay(msgs, { cwd: 'C:\\Users\\test\\AppData\\Local\\Temp', baseCostUsd: 1 })
  const listTool = 'toolu_01LZEYoKUMN8PMDq1MhLeWPF'
  const readTool = 'toolu_01BF8jtMw1W8cdrZ65uXJ3Ya'
  const textId = 'msg_011CfgATVCwGyvTNtEcmbaL1:1'

  test('items in order: two tools, the answer, the result (empty thinking dropped)', () => {
    expect(r.list.map((i) => `${i.kind}:${i.id.startsWith('result:') ? 'result' : i.id}`)).toEqual([
      `tool_use:${listTool}`,
      `tool_use:${readTool}`,
      `assistant_text:${textId}`,
      'result:result',
    ])
  })

  test('tools finish with their results', () => {
    const list = get(r.items, listTool, 'tool_use')
    expect(list).toMatchObject({ name: 'PowerShell', status: 'done', startedAt: NOW, endedAt: NOW })
    expect(list.result?.text).toContain('notes.txt')
    const read = get(r.items, readTool, 'tool_use')
    expect(read).toMatchObject({ name: 'Read', status: 'done', result: { isError: false } })
    expect(read.result?.text).toContain('Thursday at 10am')
    expect(read.input.file_path).toContain('notes.txt')
  })

  test('the answer streams as one upsert then deltas, then is finalized', () => {
    const forText = r.emissions.filter((e) => (e.type === 'upsert' && e.item.id === textId) || (e.type === 'delta' && e.itemId === textId))
    expect(forText[0]).toEqual({ type: 'upsert', item: { kind: 'assistant_text', id: textId, ts: NOW, text: 'The meeting', streaming: true } })
    expect(forText.slice(1, -1).map((e) => (e as { text: string }).text)).toEqual([' is', ' Thursday', ' at 10am.'])
    expect(forText.at(-1)).toEqual({ type: 'upsert', item: { kind: 'assistant_text', id: textId, ts: NOW, text: 'The meeting is Thursday at 10am.', streaming: false } })
  })

  test('result, cost, session id, activity, notification', () => {
    const result = r.list.find((i) => i.kind === 'result')
    expect(result).toMatchObject({ ok: true, costUsd: 0.01077895, turns: 3, durationMs: expect.any(Number) })
    const patches = r.of('chat').map((e) => e.patch)
    const init = msgs[0] as { session_id: string }
    expect(patches[0]).toEqual({ sessionId: init.session_id })
    expect(patches).toContainEqual({ costUsd: 1.01077895 })
    const activities = patches.filter((p) => 'activity' in p).map((p) => p.activity)
    expect(activities[0]).toBe('Thinking')
    // relative to the chat's cwd
    expect(activities).toContain('Read: ' + (get(r.items, readTool, 'tool_use').input.file_path as string).split(/[\\/]/).slice(-2).join('/'))
    expect(activities.at(-1)).toBe('Writing')
    expect(r.of('notify')).toEqual([{ type: 'notify', reason: 'finished', title: 'Hydra Desk', body: 'The meeting is Thursday at 10am.' }])
  })

  test('rate_limit_event "allowed" adds nothing', () => {
    expect(r.list.some((i) => i.kind === 'system')).toBe(false)
  })
})

describe('hand-built fixtures', () => {
  test('todo-write: thinking streams, TodoWrite fills the single todos item', () => {
    const r = replay(hand.todoWrite())
    const thinking = get(r.items, 'msg_todo_1:0', 'thinking')
    expect(thinking).toMatchObject({ text: 'Plan the work first.', streaming: false })
    expect(r.of('delta')).toEqual([{ type: 'delta', itemId: 'msg_todo_1:0', text: 'work first.' }])
    const todos = get(r.items, 'todos', 'todos')
    expect(todos.todos).toEqual([
      { content: 'Read the spec', status: 'completed', activeForm: 'Reading the spec' },
      { content: 'Write the code', status: 'in_progress', activeForm: 'Writing the code' },
    ])
    expect(r.list.filter((i) => i.kind === 'todos')).toHaveLength(1)
    expect(get(r.items, 'toolu_todo_1', 'tool_use').status).toBe('done')
    expect(get(r.items, 'toolu_todo_2', 'tool_use').status).toBe('done')
    expect(r.of('chat').filter((e) => 'activity' in e.patch).map((e) => e.patch.activity)).toEqual(['Thinking', 'Updating todos', 'Thinking', 'Updating todos', 'Thinking'])
  })

  test('sub-agent: parentToolUseId on its items, task events fold into one task item', () => {
    const r = replay(hand.subAgent())
    expect(get(r.items, 'toolu_agent', 'tool_use')).toMatchObject({ name: 'Agent', status: 'done' })
    expect(get(r.items, 'toolu_agent', 'tool_use').parentToolUseId).toBeUndefined()
    expect(get(r.items, 'msg_sub_1:0', 'assistant_text')).toMatchObject({ text: 'Reading it.', parentToolUseId: 'toolu_agent', streaming: false })
    const read = get(r.items, 'toolu_sub_read', 'tool_use')
    expect(read).toMatchObject({ parentToolUseId: 'toolu_agent', status: 'done' })
    expect(read.progress).toBeUndefined()
    const progressed = r.of('upsert').find((e) => e.item.id === 'toolu_sub_read' && (e.item as { progress?: string }).progress)
    expect((progressed?.item as { progress?: string }).progress).toBe('2s')
    expect(get(r.items, 'task:task_a', 'task')).toMatchObject({ taskId: 'task_a', description: 'Survey the repo', status: 'completed', summary: 'Found 3 packages' })
    expect(r.items.has('task:task_watch')).toBe(false) // ambient
    // sub-agent work does not overwrite the main activity
    expect(r.of('chat').filter((e) => 'activity' in e.patch).map((e) => e.patch.activity)).toEqual(['Agent: Survey the repo', 'Thinking'])
  })

  test('compact boundary: a system line, and "Compacting" while it runs', () => {
    const r = replay(hand.compactBoundary())
    const sys = r.list.filter((i) => i.kind === 'system')
    expect(sys).toHaveLength(1)
    expect(sys[0]).toMatchObject({ level: 'info', text: 'Conversation compacted (auto, 152k → 31k tokens)' })
    expect(r.of('chat').map((e) => e.patch)).toContainEqual({ activity: 'Compacting' })
  })

  test('rate limit: warning line, limit line naming the account, limitResetsAt, one limited notify', () => {
    const msgs = hand.rateLimit()
    const r = replay(msgs, { accountLabel: () => '#68 eek', title: () => 'My chat' })
    expect(get(r.items, 'rate_limit_warning:five_hour', 'system')).toMatchObject({ level: 'warn', text: '91% of the 5-hour limit used' })
    // keyed by the rejected event's uuid, so a later runtime's limit line does not replace this one
    const limit = get(r.items, `rate_limit:${(msgs[2] as { uuid: string }).uuid}`, 'system')
    expect(limit.level).toBe('error')
    expect(limit.text).toBe(`Usage limit reached (5-hour) on #68 eek. Resets ${new Date(1_791_086_400_000).toISOString()}.`)
    expect(r.of('chat').map((e) => e.patch)).toContainEqual({ limitResetsAt: 1_791_086_400_000 })
    expect(r.of('notify').map((e) => [e.reason, e.title])).toEqual([['limited', 'My chat']])
    expect(r.list.find((i) => i.kind === 'result')).toMatchObject({ ok: false, costUsd: 0 })
  })

  test('api retry: one line per turn, updated by each retry', () => {
    const r = replay(hand.apiRetry())
    const retries = r.list.filter((i) => i.kind === 'system')
    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({ id: 'api_retry:0', level: 'warn', text: 'API error 529 (overloaded), retrying in 4s (attempt 2 of 10)' })
    expect(r.of('upsert').filter((e) => e.item.id === 'api_retry:0')).toHaveLength(2)
  })

  test('refusal fallback and no-fallback become system lines', () => {
    const r = replay(hand.refusal())
    expect(r.list.filter((i) => i.kind === 'system').map((i) => [(i as { level: string }).level, (i as { text: string }).text])).toEqual([
      ['warn', 'Opus 5.5 declined this request; retried on Sonnet 5.5.'],
      ['error', 'The model declined this request.'],
    ])
  })

  test('denied tool, failing hook, unknown and broken messages, error result', () => {
    const r = replay(hand.deniedAndHook())
    expect(get(r.items, 'toolu_rm', 'tool_use')).toMatchObject({ status: 'denied', result: { isError: true } })
    expect(get(r.items, 'hook:hook_1', 'system')).toMatchObject({ level: 'warn', text: 'Hook lint (PostToolUse) failed (exit 2): eslint not found' })
    expect(r.list.find((i) => i.kind === 'result')).toMatchObject({ ok: false, error: 'Request was aborted.' })
    expect(r.of('notify').map((e) => e.reason)).toEqual(['error'])
  })

  test('an interrupted turn reads "Interrupted" and does not notify', () => {
    const msgs = hand.deniedAndHook()
    const n = createNormalizer({ now: () => NOW })
    const out: Emission[] = []
    for (const m of msgs.slice(0, -1)) out.push(...n.handle(m))
    n.noteInterrupt()
    out.push(...n.handle(msgs.at(-1)!))
    expect(out.find((e) => e.type === 'upsert' && e.item.kind === 'result')).toMatchObject({ item: { ok: false, error: 'Interrupted' } })
    expect(out.some((e) => e.type === 'notify')).toBe(false)
  })

  test('markDenied before the result lands', () => {
    const msgs = hand.deniedAndHook().filter((m) => !(m.type === 'system' && m.subtype === 'permission_denied'))
    const n = createNormalizer({ now: () => NOW })
    n.handle(msgs[0]!)
    n.handle(msgs[1]!)
    expect(n.markDenied('toolu_rm')).toEqual([]) // still running: applied when its result arrives
    const out = n.handle(msgs[2]!)
    expect(out[0]).toMatchObject({ type: 'upsert', item: { id: 'toolu_rm', status: 'denied' } })
  })

  test("a task settles when its notice comes, not at its last progress reading's duration", () => {
    let clock = 1_000
    const n = createNormalizer({ now: () => clock })
    const sys = (m: object) => n.handle({ type: 'system', uuid: `u${clock}`, session_id: 's', ...m } as unknown as SDKMessage)
    sys({ subtype: 'task_started', task_id: 't1', description: 'Review the pages', task_type: 'local_workflow' })
    clock = 4_000
    sys({ subtype: 'task_progress', task_id: 't1', usage: { total_tokens: 10, duration_ms: 3_000 } })
    clock = 61_000
    const out = sys({ subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'Reviewed' })
    expect(out.find((e) => e.type === 'upsert')).toMatchObject({ item: { ts: 1_000, status: 'completed', durationMs: 60_000 } })
  })

  test('cost per turn is the difference of the cumulative totals', () => {
    const n = createNormalizer({ now: () => NOW, baseCostUsd: 2 })
    const res = (total: number) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: total, num_turns: 1, duration_ms: 1, uuid: `u${total}` }) as unknown as SDKMessage
    n.handle(res(0.5))
    const out = n.handle(res(0.75))
    expect(out.find((e) => e.type === 'upsert')).toMatchObject({ item: { costUsd: 0.25 } })
    expect(out).toContainEqual({ type: 'chat', patch: { costUsd: 2.75 } })
  })
})
