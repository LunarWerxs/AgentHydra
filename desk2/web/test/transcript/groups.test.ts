import { describe, expect, test } from 'bun:test'
import type { TranscriptItem } from '@shared/protocol'
import { groupRows, rowGap, toolSummary, type RunItem, type ThinkingItem, type ToolItem } from '../../src/components/transcript/lib/groups'

const tool = (id: string, name: string, input: Record<string, unknown> = {}, status: ToolItem['status'] = 'done'): ToolItem => ({
  id,
  ts: 1,
  kind: 'tool_use',
  name,
  input,
  status,
  startedAt: 1,
})
const user = (id: string): TranscriptItem => ({ id, ts: 1, kind: 'user', text: 'hi' })
const text = (id: string, streaming = false): TranscriptItem => ({ id, ts: 1, kind: 'assistant_text', text: 'ok', streaming })
const think = (id: string, streaming = false): ThinkingItem => ({ id, ts: 1, kind: 'thinking', text: 'Checking the remote.', streaming })

const phrase = (items: RunItem[], cwd?: string) =>
  toolSummary(items, cwd)
    .phrases.map((p) => [p.text, p.target, p.after].filter(Boolean).join(' '))
    .join(', ')

describe('groupRows', () => {
  test('folds a run of tool calls into one row keyed by its first call', () => {
    const rows = groupRows([user('u'), tool('a', 'Bash'), tool('b', 'Read'), text('t'), tool('c', 'Bash')])
    expect(rows.map((r) => r.id)).toEqual(['u', 'tools:a', 't', 'tools:c'])
    expect(rows[1].kind === 'tools' && rows[1].items.map((i) => i.id)).toEqual(['a', 'b'])
  })

  test('a sub-agent call keeps its own card and breaks the run; a CliMayte call folds like any MCP tool', () => {
    const rows = groupRows([tool('a', 'Bash'), tool('g', 'Agent'), tool('m', 'mcp__agenthydra__climayte_run'), tool('b', 'Bash')])
    expect(rows.map((r) => r.id)).toEqual(['tools:a', 'g', 'tools:m'])
    expect(rows[2].kind === 'tools' && rows[2].items.map((i) => i.id)).toEqual(['m', 'b'])
  })

  test("a handoff's continuation line right after CliMayte's move line is not shown: the move line says it", () => {
    const moved: TranscriptItem = { id: 'moved:5', ts: 5, kind: 'system', level: 'info', text: 'CliMayte moved this chat from #1 to #2.' }
    const continued: TranscriptItem = { id: 'u2', ts: 6, kind: 'system', level: 'info', text: 'Continued in a fresh session on another account: the account neared its usage limit.' }
    expect(groupRows([user('u1'), text('t1'), moved, continued, text('t2')]).map((r) => r.id)).toEqual(['u1', 't1', 'moved:5', 't2'])
    // A handoff on the same account has no move line before it: its line stays.
    expect(groupRows([user('u1'), text('t1'), continued, text('t2')]).map((r) => r.id)).toEqual(['u1', 't1', 'u2', 't2'])
  })

  test('only the last finished assistant text of each turn ends the turn', () => {
    const rows = groupRows([user('u1'), text('t1'), tool('a', 'Bash'), text('t2'), user('u2'), text('t3', true)])
    const end = Object.fromEntries(rows.flatMap((r) => (r.kind === 'item' ? [[r.id, r.endOfTurn]] : [])))
    expect(end).toEqual({ u1: false, t1: false, t2: true, u2: false, t3: false })
  })

  test("a program's note starts a turn of its own, and its reply has no prompt of the person's to send again", () => {
    const note: TranscriptItem = { id: 'n', ts: 1, kind: 'note', from: 'AgentHydra', text: 'Ping 1' }
    const rows = groupRows([user('u1'), text('t1'), note, text('t2')])
    const end = Object.fromEntries(rows.flatMap((r) => (r.kind === 'item' ? [[r.id, r.endOfTurn]] : [])))
    expect(end).toEqual({ u1: false, t1: true, n: false, t2: true })
    const t2 = rows.find((r) => r.id === 't2')
    expect(t2?.kind === 'item' && t2.prompt).toBeNull()
  })

  test('a reply carries the id of the message it answers, so Undo under it goes back to before that message', () => {
    const rows = groupRows([user('u1'), text('t1'), user('u2'), tool('a', 'Bash'), text('t2')])
    const prompt = (id: string) => rows.flatMap((r) => (r.kind === 'item' && r.id === id ? [r.prompt?.id] : []))[0]
    expect(prompt('t1')).toBe('u1')
    expect(prompt('t2')).toBe('u2')
  })
})

describe('rowGap', () => {
  test('20px between turns, 12 beside a status row, 4 from a user message to a status row, none after the last row', () => {
    const rows = groupRows([user('u'), tool('a', 'Bash'), text('t'), user('u2'), text('t2')])
    expect(rows.map((_, i) => rowGap(rows, i))).toEqual([4, 12, 20, 12, 0])
  })
})

describe('toolSummary', () => {
  test('counts commands and names a single file by its base name', () => {
    expect(phrase([tool('a', 'Bash'), tool('b', 'Bash'), tool('c', 'Bash'), tool('d', 'Read', { file_path: 'C:\\p\\docs\\screen-half.png' })], 'C:\\p')).toBe(
      'Ran 3 commands, read screen-half.png',
    )
  })

  test('mixes a command with one unknown tool', () => {
    expect(phrase([tool('a', 'Bash'), tool('b', 'Skill')])).toBe('Ran a command, used a tool')
  })

  test('a lone MCP call reads as server: tool, present tense while running', () => {
    expect(phrase([tool('a', 'mcp__connections__memory_search', {}, 'running')])).toBe('Using connections: memory search')
    expect(phrase([tool('a', 'mcp__connections__memory_search')])).toBe('Used connections: memory search')
  })

  test('says searched code and puts failures after the clause they belong to, as the real app does', () => {
    const items = [
      ...Array.from({ length: 9 }, (_, i) => tool(`b${i}`, 'Bash', {}, i === 4 ? 'error' : 'done')),
      tool('g1', 'Grep', { pattern: 'a' }),
      tool('g2', 'Grep', { pattern: 'b' }),
      tool('r', 'Read', { file_path: 'src/index.ts' }),
      tool('m1', 'mcp__agenthydra__climayte_status'),
      tool('m2', 'mcp__agenthydra__climayte_run'),
    ]
    expect(phrase(items)).toBe('Ran 9 commands (1 failed), searched code, read index.ts, used 2 tools')
    expect(phrase([tool('m', 'mcp__agenthydra__climayte_run')])).toBe('Used agenthydra: climayte run')
    expect(toolSummary(items).phrases[2]).toEqual({ text: 'read index.ts' })
    expect(toolSummary([tool('i', 'Read', { file_path: 'tmp/screen-half.png' })]).phrases[0]).toEqual({ text: 'Read', target: 'screen-half.png' })
  })

  test('sums diff lines and counts failures', () => {
    const s = toolSummary([
      tool('a', 'Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y\nz' }),
      tool('b', 'Bash', {}, 'error'),
    ])
    expect(s.added).toBe(2)
    expect(s.removed).toBe(1)
    expect(s.failed).toBe(1)
    expect(s.running).toBe(false)
  })
})

describe('thinking in a tool run', () => {
  // Owner, 2026-10-08: seven status rows between two paragraphs ("Ran a command", "Thought process", "Ran 2 commands", ...).
  test('a tool call and thinking block with nothing between them are one run: the seven rows read as one sentence', () => {
    const items = [tool('a', 'Bash'), think('k1'), tool('b', 'Bash'), tool('c', 'Bash'), think('k2'), tool('d', 'Bash'), tool('e', 'Bash'), think('k3'), tool('f', 'Bash')]
    const rows = groupRows([user('u'), ...items, text('t')])
    expect(rows.map((r) => r.id)).toEqual(['u', 'tools:a', 't'])
    expect(rows[1].kind === 'tools' && phrase(rows[1].items)).toBe('Ran 6 commands, thought 3 times')
  })

  test('a thinking block alone before prose stays its own row, never a run of thinking only', () => {
    const rows = groupRows([user('u'), think('k'), text('t')])
    expect(rows.map((r) => r.id)).toEqual(['u', 'k', 't'])
    expect(rows[1].kind).toBe('item')
  })

  test('a run that opens with a thinking block keeps the id of that block, and its steps run in order', () => {
    const rows = groupRows([think('k'), tool('a', 'Bash')])
    expect(rows.map((r) => r.id)).toEqual(['tools:k'])
    expect(rows[0].kind === 'tools' && rows[0].items.map((i) => i.id)).toEqual(['k', 'a'])
  })

  test('with thinking not folded, every block is its own row and breaks the run, as before', () => {
    const items = [tool('a', 'Bash'), think('k1'), tool('b', 'Bash'), tool('c', 'Bash'), think('k2'), tool('d', 'Bash'), tool('e', 'Bash'), think('k3'), tool('f', 'Bash')]
    expect(groupRows(items, false).map((r) => r.id)).toEqual(['tools:a', 'k1', 'tools:b', 'k2', 'tools:d', 'k3', 'tools:f'])
  })

  test('a run with a streaming thinking block is running and says "thinking" in its clause', () => {
    expect(phrase([tool('a', 'Bash'), think('k', true)])).toBe('Ran a command, thinking')
    expect(toolSummary([tool('a', 'Bash'), think('k', true)]).running).toBe(true)
    expect(toolSummary([tool('a', 'Bash'), think('k')]).running).toBe(false)
  })
})
