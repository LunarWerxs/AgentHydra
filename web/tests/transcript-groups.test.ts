// web/tests/transcript-groups.test.ts - how the open transcript folds tool calls and reasoning into
// work rows (web/src/lib/transcript-groups.ts).
//
// The contract is what the reader sees: every run of work between two messages is ONE row, each
// tool's output sits under the call that produced it (a wrong pairing shows one command's output
// under another), nothing the transcript holds is dropped, and the row's sentence counts files for
// reads and edits rather than calls.

import { expect, test } from 'bun:test'
import {
  buildDisplayItems,
  formatToolInput,
  type GroupableEvent,
  summarizeWork,
  type WorkGroup,
} from '../src/lib/transcript-groups'

const at = (s: number) => `2026-10-04T10:00:${String(s).padStart(2, '0')}.000Z`
const say = (role: 'user' | 'assistant', text: string, s: number): GroupableEvent => ({
  role,
  kind: 'text',
  text,
  tool_name: null,
  timestamp: at(s),
})
const call = (tool: string, input: unknown, s: number): GroupableEvent => ({
  role: 'assistant',
  kind: 'tool_use',
  text: JSON.stringify(input),
  tool_name: tool,
  timestamp: at(s),
})
const out = (text: string, s: number, extra: Partial<GroupableEvent> = {}): GroupableEvent => ({
  role: 'user',
  kind: 'tool_result',
  text,
  tool_name: null,
  timestamp: at(s),
  ...extra,
})
const thought = (text: string, s: number): GroupableEvent => ({
  role: 'assistant',
  kind: 'thinking',
  text,
  tool_name: null,
  timestamp: at(s),
})

test('a run of work between two messages is one row, and its outputs sit under their calls', () => {
  const items = buildDisplayItems([
    say('user', 'fix the build', 0),
    thought('look at the config first', 2),
    // two calls issued together, answered in the order they were made
    call('Read', { file_path: 'D:/repo/vite.config.ts' }, 3),
    call('Bash', { command: 'bun run build' }, 3),
    out('export default {}', 5),
    out('Exit code 1\nerror TS2304', 9, { error: true }),
    say('assistant', 'The build fails on a missing type.', 10),
  ])

  expect(items.map((i) => i.type)).toEqual(['turn', 'work', 'turn'])
  const work = items[1] as WorkGroup
  expect(work.indices).toEqual([1, 2, 3, 4, 5])
  expect(work.steps.map((s) => [s.kind, s.tool, s.result?.text ?? null])).toEqual([
    ['thinking', null, null],
    ['tool', 'Read', 'export default {}'],
    ['tool', 'Bash', 'Exit code 1\nerror TS2304'],
  ])
  expect(work.steps.map((s) => s.preview)).toEqual([
    'look at the config first',
    '…/repo/vite.config.ts',
    'bun run build',
  ])
  expect(work.steps.map((s) => s.failed)).toEqual([false, false, true])
  expect(work.failed).toBe(true)
  // the work began when the prompt it answers was sent, and ended with its last output
  expect([work.startedAt, work.endedAt]).toEqual([Date.parse(at(0)), Date.parse(at(9))])
})

test('a result that names its tool pairs with that call, and one whose call scrolled away stays', () => {
  const items = buildDisplayItems([
    out('stale output of a call above the window', 1),
    call('grep', { pattern: 'TODO' }, 2),
    call('read_file', { path: 'a.py' }, 2),
    // DSH and Hermes name the tool on the result, and may answer out of order
    { ...out('print(1)', 3), tool_name: 'read_file' },
    { ...out('a.py:3: TODO', 4), tool_name: 'grep' },
  ])
  const work = items[0] as WorkGroup
  expect(work.steps.map((s) => [s.tool, s.call?.text ?? null, s.result?.text])).toEqual([
    [null, null, 'stale output of a call above the window'],
    ['grep', '{"pattern":"TODO"}', 'a.py:3: TODO'],
    ['read_file', '{"path":"a.py"}', 'print(1)'],
  ])
})

test('the summary counts files for reads and edits, calls for the rest, and says what it left out', () => {
  const steps = (
    buildDisplayItems([
      call('Read', { file_path: 'a.ts' }, 1),
      call('Read', { file_path: 'a.ts' }, 2),
      call('Read', { file_path: 'b.ts' }, 3),
      call('Edit', { file_path: 'a.ts' }, 4),
      call('Bash', { command: 'git status' }, 5),
      call('mcp__hswarm__hswarm_run', { label: 'x' }, 6),
      call('mcp__agenthydra__check_my_usage', {}, 7),
      call('TodoWrite', { todos: [] }, 8),
      thought('done?', 9),
    ])[0] as WorkGroup
  ).steps

  // edit and command outrank looking; at most three kinds, in the order they first happened
  expect(summarizeWork(steps)).toEqual({
    parts: [
      { category: 'read', count: 2, names: [] },
      { category: 'edit', count: 1, names: [] },
      { category: 'command', count: 1, names: [] },
    ],
    more: 3,
    thoughts: 1,
  })
  expect(summarizeWork(steps, 5).parts.find((p) => p.category === 'mcp')?.names).toEqual([
    'hswarm',
    'agenthydra',
  ])
})

test('a long input the daemon cut mid-JSON still yields its path and command', () => {
  const cut = (tool: string, json: string): GroupableEvent => ({
    ...call(tool, {}, 1),
    text: json,
  })
  const work = buildDisplayItems([
    cut('Write', '{"file_path":"C:\\\\src\\\\deep\\\\app.vue","content":"<template>…'),
    cut('exec_command', '{"cmd":["bash","-lc","git log --oneline -5"],"workdir":"/re'),
  ])[0] as WorkGroup
  expect(work.steps.map((s) => s.preview)).toEqual(['…/deep/app.vue', 'git log --oneline -5'])
})

test('an input reads one argument a line, and a cut-off one is shown exactly as it came', () => {
  const edit = { file_path: 'a.ts', old_string: 'one\ntwo', replace_all: false }
  expect(formatToolInput(JSON.stringify(edit))).toBe(
    'file_path: a.ts\nold_string:\n  one\n  two\nreplace_all: false',
  )
  // the daemon's 1200-character cut, and apply_patch's raw patch: half an object is not re-laid out
  const cut = '{"file_path":"a.ts","content":"<template>'
  expect(formatToolInput(cut)).toBe(cut)
  expect(formatToolInput('*** Begin Patch')).toBe('*** Begin Patch')
})
