// Transcript items in every state, for the Gallery's Transcript section and the 3,000-item check.
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { chatFixtures } from '@/dev/fixtures'

const now = Date.now()
const CWD = 'C:/Users/me/Desktop/Project/Agent Hydra/desk'
let seq = 0
const t = (secondsAgo: number) => now - secondsAgo * 1000 + seq++

export const transcriptChat: ChatSummary = {
  ...chatFixtures[0],
  id: 'gallery-transcript',
  cwd: CWD,
  status: 'working',
  activity: 'Bash: bun test ./web/test/transcript',
  turnStartedAt: now - 83 * 1000,
  queuedCount: 1,
}

const EDIT_OLD = `export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  return Math.floor(s / 60) + 'm'
}`
const EDIT_NEW = `export function formatElapsed(ms: number): string {
  if (ms < 1000) return \`\${Math.round(ms)}ms\`
  const s = Math.floor(ms / 1000)
  if (s < 60) return \`\${s}s\`
  const m = Math.floor(s / 60)
  return \`\${m}m \${String(s % 60).padStart(2, '0')}s\`
}`

const TEST_OUTPUT = Array.from({ length: 64 }, (_, i) =>
  i % 9 === 8 ? `(pass) transcript > diff > case ${i} [0.12ms]` : `(pass) transcript > tools > key argument ${i} [0.0${i % 10}ms]`,
).join('\n')

export const transcriptStates: TranscriptItem[] = [
  { id: 'u1', ts: t(600), kind: 'user', text: 'The elapsed counter on tool rows reads "0m" for anything under a minute. Fix formatElapsed and add a test.',
    images: [
      { mediaType: 'image/png', name: 'tool-row.png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
      { mediaType: 'image/png', name: 'history-only.png' },
    ],
  },
  {
    id: 'th1',
    ts: t(598),
    kind: 'thinking',
    text: 'The counter is built in lib/tools.ts. Seconds are floored before the minute branch, so 59s reads 0m after the first minute. I should show seconds under a minute and m + padded s above.',
  },
  {
    id: 'a1',
    ts: t(596),
    kind: 'assistant_text',
    text: 'Found it: `formatElapsed` drops the seconds once a minute passes. I will:\n\n1. Show **milliseconds** under a second\n2. Pad seconds after the minute (`2m 05s`)\n3. Add a regression test\n\nSee the [Bun test docs](https://bun.sh/docs/cli/test) for the runner.',
  },
  {
    id: 'r1',
    ts: t(590),
    kind: 'tool_use',
    name: 'Read',
    input: { file_path: `${CWD}/web/src/components/transcript/lib/tools.ts`, offset: 200, limit: 40 },
    status: 'done',
    result: { text: EDIT_OLD, isError: false },
    startedAt: t(590),
    endedAt: t(590) + 140,
  },
  {
    id: 'g1',
    ts: t(588),
    kind: 'tool_use',
    name: 'Grep',
    input: { pattern: 'formatElapsed\\(', path: `${CWD}/web/src` },
    status: 'done',
    result: { text: 'web/src/components/transcript/parts/ToolHeader.vue:51\nweb/src/components/transcript/TranscriptRow.vue:22', isError: false },
    startedAt: t(588),
    endedAt: t(588) + 90,
  },
  {
    id: 'gl1',
    ts: t(587),
    kind: 'tool_use',
    name: 'Glob',
    input: { pattern: 'web/test/**/*.test.ts' },
    status: 'done',
    result: { text: 'web/test/stores.desk.test.ts', isError: false },
    startedAt: t(587),
    endedAt: t(587) + 30,
  },
  {
    id: 'e1',
    ts: t(580),
    kind: 'tool_use',
    name: 'Edit',
    input: { file_path: `${CWD}/web/src/components/transcript/lib/tools.ts`, old_string: EDIT_OLD, new_string: EDIT_NEW },
    status: 'done',
    result: { text: 'The file has been updated.', isError: false },
    startedAt: t(580),
    endedAt: t(580) + 60,
  },
  {
    id: 'w1',
    ts: t(570),
    kind: 'tool_use',
    name: 'Write',
    input: {
      file_path: `${CWD}/web/test/transcript/elapsed.test.ts`,
      content: `import { expect, test } from 'bun:test'\nimport { formatElapsed } from '@/components/transcript/lib/tools'\n\ntest('pads seconds after a minute', () => {\n  expect(formatElapsed(125_000)).toBe('2m 05s')\n})\n`,
    },
    status: 'done',
    result: { text: 'File created successfully', isError: false },
    startedAt: t(570),
    endedAt: t(570) + 40,
  },
  {
    id: 'b-ok',
    ts: t(560),
    kind: 'tool_use',
    name: 'Bash',
    input: { command: 'bun test ./web/test/transcript', description: 'Run the transcript tests' },
    status: 'done',
    result: { text: TEST_OUTPUT + '\n\n 64 pass\n 0 fail\nRan 64 tests across 4 files. [212.00ms]', isError: false },
    startedAt: t(560),
    endedAt: t(560) + 2400,
  },
  {
    id: 'b-err',
    ts: t(540),
    kind: 'tool_use',
    name: 'Bash',
    input: { command: 'bun run --cwd web typecheck' },
    status: 'error',
    result: {
      text: "Exit code 2\nsrc/components/transcript/parts/ToolHeader.vue(51,7): error TS2322: Type 'number | null' is not assignable to type 'number'.",
      isError: true,
    },
    startedAt: t(540),
    endedAt: t(540) + 9100,
  },
  {
    id: 'me1',
    ts: t(530),
    kind: 'tool_use',
    name: 'MultiEdit',
    input: {
      file_path: `${CWD}/web/src/components/transcript/parts/ToolHeader.vue`,
      edits: [
        { old_string: 'const end = props.item.endedAt', new_string: 'const end = props.item.endedAt ?? null' },
        { old_string: "return formatElapsed(end - start)", new_string: "return end === null ? '' : formatElapsed(end - start)" },
      ],
    },
    status: 'done',
    result: { text: 'Applied 2 edits', isError: false },
    startedAt: t(530),
    endedAt: t(530) + 50,
  },
  {
    id: 'wf1',
    ts: t(520),
    kind: 'tool_use',
    name: 'WebFetch',
    input: { url: 'https://shiki.style/guide/bundles', prompt: 'Which entry loads languages lazily?' },
    status: 'done',
    result: { text: 'shiki/core with createHighlighterCore and explicit language imports loads only what you import.', isError: false },
    startedAt: t(520),
    endedAt: t(520) + 3200,
  },
  {
    id: 'ws1',
    ts: t(515),
    kind: 'tool_use',
    name: 'WebSearch',
    input: { query: 'markdown-it linkify target _blank rel noopener' },
    status: 'denied',
    startedAt: t(515),
    endedAt: t(515) + 10,
  },
  {
    id: 'tw1',
    ts: t(510),
    kind: 'tool_use',
    name: 'TodoWrite',
    input: {
      todos: [
        { content: 'Fix formatElapsed', status: 'completed', activeForm: 'Fixing formatElapsed' },
        { content: 'Add the regression test', status: 'completed', activeForm: 'Adding the regression test' },
        { content: 'Run the gates', status: 'in_progress', activeForm: 'Running the gates' },
      ],
    },
    status: 'done',
    result: { text: 'Todos have been modified successfully.', isError: false },
    startedAt: t(510),
    endedAt: t(510) + 5,
  },
  {
    id: 'mcp1',
    ts: t(505),
    kind: 'tool_use',
    name: 'mcp__connections__connections_execute',
    input: { local: true, tool_name: 'memory_search', params: { query: 'hydra desk transcript' } },
    status: 'done',
    result: { text: '{"results":[{"slug":"hydra-desk-ports","score":0.82}]}', isError: false },
    startedAt: t(505),
    endedAt: t(505) + 700,
  },
  {
    id: 'br1',
    ts: t(503),
    kind: 'tool_use',
    name: 'mcp__connections__connections_execute',
    input: { local: true, tool_name: 'browser_navigate', params: { profile: 'example-shop', url: 'https://shop.example.com/orders' } },
    status: 'done',
    result: { text: 'Navigated to https://shop.example.com/orders', isError: false },
    startedAt: t(503),
    endedAt: t(503) + 1800,
  },
  {
    id: 'br2',
    ts: t(502),
    kind: 'tool_use',
    name: 'mcp__claude_ai_Connections__connections_execute',
    input: { local: true, tool_name: 'browser_take_screenshot', params: { profile: 'example-shop' } },
    status: 'done',
    result: {
      text: '[image]',
      isError: false,
      images: [{ mediaType: 'image/png', name: 'orders.png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAAA5UlEQVR42u3aoQ2AMBCG0Y6DqEQiUE1HYtjO0CAYoKoKSSDk8pJvgnvyv7TtVYFLTgBYgAVYgAVYgAUYsAALsAALsB4B9/NS4AADFmABFmABFmABBizAAizAAizAAgxYgGdLXnUPMGDAgAEDBgwYMGDAgAUYMGDAgAEDBgwYsKxJAizAAizAAizAgAVYgAVYgPUJcDnan4MKGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgAQYMGDBgwIABAwYMGDBgf9GABViABViABViAAQuwAAuwAAuwAAswYAEWYAHWew3jN7WisxXAKgAAAABJRU5ErkJggg==' }],
    },
    startedAt: t(502),
    endedAt: t(502) + 900,
  },
  { id: 'br-say', ts: t(501), kind: 'assistant_text', text: 'The orders page loaded; now the sign-in check on the other profile.' },
  {
    id: 'br3',
    ts: t(500),
    kind: 'tool_use',
    name: 'mcp__connections__connections_execute',
    input: { local: true, tool_name: 'browser_click', params: { url: 'https://example.com/login' } },
    status: 'error',
    result: { text: 'Error: no element matches the selector "#sign-in" on https://example.com/login', isError: true },
    startedAt: t(500),
    endedAt: t(500) + 400,
  },
  {
    id: 'cm1',
    ts: t(500),
    kind: 'tool_use',
    name: 'mcp__agenthydra__climayte_run',
    input: {
      tasks: [
        { title: 'Composer: slash menu and drafts', prompt: 'Build the composer…', cwd: CWD, kind: 'code' },
        { prompt: 'Run the e2e smoke against a real account and report the proof', cwd: CWD, kind: 'check' },
      ],
    },
    status: 'done',
    result: { text: JSON.stringify({ workers: [{ id: 'worker-1', status: 'running' }, { id: 'worker-3', status: 'queued' }] }), isError: false },
    startedAt: t(500),
    endedAt: t(500) + 1300,
  },
  {
    id: 'ag1',
    ts: t(490),
    kind: 'tool_use',
    name: 'Agent',
    input: { description: 'Find every elapsed formatter', prompt: 'Search web/src for duplicated elapsed-time formatting and list the files.', subagent_type: 'Explore' },
    status: 'running',
    startedAt: t(490),
  },
  { id: 'ag1-a', ts: t(489), kind: 'assistant_text', text: 'Searching for duration formatting helpers.', parentToolUseId: 'ag1' },
  {
    id: 'ag1-g',
    ts: t(488),
    kind: 'tool_use',
    name: 'Grep',
    input: { pattern: 'padStart\\(2', path: `${CWD}/web/src` },
    status: 'done',
    result: { text: 'web/src/components/sidebar/ChatRow.vue:41', isError: false },
    startedAt: t(488),
    endedAt: t(488) + 80,
    parentToolUseId: 'ag1',
  },
  {
    id: 'ag1-r',
    ts: t(487),
    kind: 'tool_use',
    name: 'Read',
    input: { file_path: `${CWD}/web/src/components/sidebar/ChatRow.vue` },
    status: 'running',
    startedAt: t(487),
    parentToolUseId: 'ag1',
  },
  {
    id: 'task1',
    ts: t(480),
    kind: 'task',
    taskId: 'bg-1',
    description: 'Watch the dev server log',
    status: 'running',
    summary: 'Vite ready on 4797; no errors so far.',
  },
  {
    id: 'todos',
    ts: t(470),
    kind: 'todos',
    todos: [
      { content: 'Fix formatElapsed', status: 'completed' },
      { content: 'Add the regression test', status: 'completed' },
      { content: 'Run the gates', status: 'in_progress', activeForm: 'Running the gates' },
      { content: 'Screenshot the Gallery', status: 'pending' },
    ],
  },
  {
    id: 'perm-done',
    ts: t(460),
    kind: 'permission',
    toolName: 'Bash',
    input: { command: 'git push' },
    canAlwaysAllow: true,
    state: 'denied',
  },
  {
    id: 'q-done',
    ts: t(455),
    kind: 'question',
    questions: [{ question: 'Which theme for code?', header: 'Theme', multiSelect: false, options: [{ label: 'github-dark' }, { label: 'one-dark' }] }],
    state: 'answered',
    answers: { 'Which theme for code?': 'github-dark' },
  },
  { id: 'plan-done', ts: t(450), kind: 'plan', plan: '# Fix the elapsed counter\n\n1. Change formatElapsed\n2. Add a test', state: 'approved' },
  {
    id: 'a2',
    ts: t(440),
    kind: 'assistant_text',
    text: 'Highlighted code with a copy button:\n\n```ts\nexport function formatElapsed(ms: number): string {\n  if (ms < 1000) return `${Math.round(ms)}ms`\n  return `${Math.floor(ms / 1000)}s`\n}\n```\n\nRaw HTML stays text: <b>not bold</b>.',
  },
  {
    id: 'a-md',
    ts: t(435),
    kind: 'assistant_text',
    text: '### What changed\n\n- `formatElapsed` now has three branches\n  - under a second: `ms`\n  - under a minute: `s`\n- the test covers each branch\n\n| Input | Before | After |\n| --- | --- | --- |\n| 450 | 0s | 450ms |\n| 59 000 | 59s | 59s |\n| 125 000 | 2m | 2m 05s |\n\n> The minute branch was the only one users saw wrong.\n\n---\n\nRun `bun test ./web/test/transcript` to check.',
  },
  { id: 'sys-info', ts: t(430), kind: 'system', level: 'info', text: 'Conversation compacted (148k → 32k tokens)' },
  { id: 'sys-warn', ts: t(429), kind: 'system', level: 'warn', text: 'API retry 2/10 in 4s: overloaded' },
  { id: 'sys-err', ts: t(428), kind: 'system', level: 'error', text: 'Hook PreToolUse failed: exit 1' },
  { id: 'res1', ts: t(420), kind: 'result', ok: true, durationMs: 72_400, costUsd: 0.42, turns: 7 },
  { id: 'u2', ts: t(120), kind: 'user', text: 'Now push it.' },
  {
    id: 'perm-1',
    ts: t(110),
    kind: 'permission',
    toolName: 'Edit',
    input: { file_path: `${CWD}/web/src/stores/desk.ts`, old_string: "return location.protocol === 'https:' ? 'wss' : 'ws' + '://'", new_string: "return (location.protocol === 'https:' ? 'wss' : 'ws') + '://'" },
    blockedPath: `${CWD}/web/src/stores/desk.ts`,
    canAlwaysAllow: true,
    state: 'pending',
  },
  {
    id: 'q-1',
    ts: t(100),
    kind: 'question',
    questions: [
      {
        question: 'Where should drafts be kept?',
        header: 'Drafts',
        multiSelect: false,
        options: [
          { label: 'localStorage', description: 'Simple and built in' },
          { label: 'Server', description: 'Survives a browser reset' },
        ],
      },
    ],
    state: 'pending',
  },
  {
    id: 'plan-1',
    ts: t(95),
    kind: 'plan',
    plan: '# Push plan\n\n1. Run `bun test`\n2. Commit the transcript paths only\n3. Push to `origin/main`',
    state: 'pending',
  },
  { id: 'th2', ts: t(90), kind: 'thinking', text: 'Checking whether the remote is private before pushing', streaming: true },
  {
    id: 'b-run',
    ts: t(85),
    kind: 'tool_use',
    name: 'Bash',
    input: { command: 'bun test ./web/test/transcript' },
    status: 'running',
    progress: '(pass) transcript > diff > keeps context',
    startedAt: t(85),
  },
  { id: 'a3', ts: t(5), kind: 'assistant_text', text: 'Tests are running. While they do, here is what changed:\n\n- `formatElapsed` pads seconds', streaming: true },
  { id: 'u3', ts: t(2), kind: 'user', text: 'Also add the changelog line.', queued: true },
]

/** A long chat for the windowing check: `n` items cycling through every kind of row. */
export function makeStressItems(n = 3000): TranscriptItem[] {
  const base = now - n * 1000
  const out: TranscriptItem[] = []
  for (let i = 0; i < n; i++) {
    const ts = base + i * 1000
    const id = `s${i}`
    switch (i % 10) {
      case 0:
        out.push({ id, ts, kind: 'user', text: `Message ${i}: check the build output and fix whatever fails in step ${i}.` })
        break
      case 1:
        out.push({ id, ts, kind: 'thinking', text: `Thinking about step ${i}.` })
        break
      case 2:
      case 6:
        out.push({
          id,
          ts,
          kind: 'assistant_text',
          text: `Step **${i}**: the output names \`src/file-${i}.ts\`. ${'The fix is small and local. '.repeat(1 + (i % 4))}`,
        })
        break
      case 3:
        out.push({
          id,
          ts,
          kind: 'tool_use',
          name: 'Bash',
          input: { command: `bun test ./test/case-${i}.test.ts` },
          status: 'done',
          result: { text: `(pass) case ${i}\n 1 pass\n 0 fail`, isError: false },
          startedAt: ts,
          endedAt: ts + 800,
        })
        break
      case 4:
        out.push({
          id,
          ts,
          kind: 'tool_use',
          name: 'Read',
          input: { file_path: `${CWD}/src/file-${i}.ts` },
          status: 'done',
          result: { text: `export const x${i} = ${i}`, isError: false },
          startedAt: ts,
          endedAt: ts + 30,
        })
        break
      case 5:
        out.push({
          id,
          ts,
          kind: 'tool_use',
          name: 'Edit',
          input: { file_path: `${CWD}/src/file-${i}.ts`, old_string: `export const x${i} = ${i}\n`, new_string: `export const x${i} = ${i + 1}\n` },
          status: 'done',
          result: { text: 'ok', isError: false },
          startedAt: ts,
          endedAt: ts + 20,
        })
        break
      case 7:
        out.push({
          id,
          ts,
          kind: 'tool_use',
          name: 'Grep',
          input: { pattern: `x${i}`, path: `${CWD}/src` },
          status: 'done',
          result: { text: `src/file-${i}.ts:1`, isError: false },
          startedAt: ts,
          endedAt: ts + 15,
        })
        break
      case 8:
        out.push({ id, ts, kind: 'system', level: 'info', text: `Checkpoint ${i}` })
        break
      default:
        out.push({ id, ts, kind: 'result', ok: true, durationMs: 9000 + i, costUsd: 0.01 * (i % 7), turns: 3 })
    }
  }
  return out
}
