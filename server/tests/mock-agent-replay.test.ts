// server/tests/mock-agent-replay.test.ts - the daemon's CLI spawn-and-parse paths, run against
// recorded sessions replayed by server/tests/mocks/mock-agent.mjs over a real process boundary.
//
// WHY a replay rather than a stub: the bugs these paths have had live in the pipe (line
// splitting, stdout vs stderr, exit codes, a child that talks first), which an in-process stub
// never exercises, and running the real CLI spends an account's quota and is not repeatable.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveClaudeExe } from '../src/config'
import { connectCodexRpc } from '../src/core/codex-rpc'
import { eventToTailEvents } from '../src/transcript'
import { checkUsage } from '../src/usage'

const MOCKS = join(import.meta.dir, 'mocks')
const MOCK_AGENT = join(MOCKS, 'mock-agent.mjs')
// Every test below but the first spawns a child: a cold Windows CI runner is far slower than a
// desktop, so each states its own timeout (scripts/checks/spawn-test-without-timeout.mjs).
const SPAWN_TIMEOUT_MS = 20_000
const ENV_KEYS = ['AGENTHYDRA_CLAUDE_PATH', 'AGENTHYDRA_MOCK_RECORDING', 'AGENTHYDRA_MOCK_NO_DELAY']
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
const roots: string[] = []

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function runClaude(args: string[]) {
  const proc = Bun.spawn([process.execPath, MOCK_AGENT, '--as', 'claude', ...args], {
    env: { ...process.env, AGENTHYDRA_MOCK_NO_DELAY: '1' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  const events = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return { events, code }
}

// Contract: AGENTHYDRA_CLAUDE_PATH names the CLI every spawn uses. Regression: resolveClaudeExe
// checked the npm-global install before PATH, so on a machine with Claude installed no overlay
// could ever swap the CLI and the replay below could not reach the daemon's own spawns.
test('AGENTHYDRA_CLAUDE_PATH overrides the resolved Claude CLI', () => {
  const wrapper = join(MOCKS, 'bin', process.platform === 'win32' ? 'claude.cmd' : 'claude')
  process.env.AGENTHYDRA_CLAUDE_PATH = wrapper
  expect(resolveClaudeExe()).toBe(wrapper)
})

// Contract: a live `claude -p --output-format stream-json` run turns into the same tail events the
// queue and session views show, in order, with the CLI bookkeeping lines (init, rate_limit_event,
// result) producing none. Gap: transcript tests read .jsonl from disk, never a live stdout pipe.
test(
  'a replayed stream-json run parses into ordered tail events',
  async () => {
    const { events, code } = await runClaude(['-p', 'summarise', '--output-format', 'stream-json'])
    expect(code).toBe(0)
    const tail = events.flatMap((ev) => eventToTailEvents(ev))
    expect(tail.map((e) => [e.role, e.kind, e.tool_name])).toEqual([
      ['assistant', 'text', null],
      ['assistant', 'tool_use', 'Read'],
      ['user', 'tool_result', null],
      ['assistant', 'text', null],
    ])
    expect(tail.at(-1)?.text).toBe('The project is a tiny demo.')
  },
  SPAWN_TIMEOUT_MS,
)

// Contract: the recording is chosen by the prompt's sha256, and a recorded exit code reaches the
// parent. Regression: a picker that ignored the prompt would replay the happy path for every run,
// so a test about the weekly wall would pass without ever seeing a rejected rate_limit_event.
test(
  'the prompt hash picks the weekly-wall recording and its exit code',
  async () => {
    const args = ['-p', '--output-format', 'stream-json', 'hit the wall']
    const { events, code } = await runClaude(args)
    expect(code).toBe(1)
    const wall = events.find((ev) => ev.type === 'rate_limit_event')
    expect(wall.rate_limit_info).toMatchObject({ status: 'rejected', rateLimitType: 'seven_day' })
    expect(events.at(-1)).toMatchObject({ type: 'result', is_error: true })
  },
  SPAWN_TIMEOUT_MS,
)

// Contract: checkUsage's CLI fallback spawns whatever resolveClaudeExe names, reads its stdout (the
// recorded stdin warning goes to stderr and must not matter) and parses the /usage screen. Gap:
// usage.test.ts pins the parser on a string; nothing ran the spawn, the bounded capture and the
// parse together.
// Skipped on Windows: the probe passes `--mcp-config '{"mcpServers":{}}'`, and Bun refuses to hand
// an argument holding cmd.exe special characters to a .cmd file (ERR_INVALID_ARG_VALUE), so the
// wrapper can never launch there. The real CLI is an .exe and is not affected; ubuntu CI runs this.
test.skipIf(process.platform === 'win32')(
  'the /usage probe reads a replayed screen through the real spawn',
  async () => {
    const wrapper = join(MOCKS, 'bin', process.platform === 'win32' ? 'claude.cmd' : 'claude')
    process.env.AGENTHYDRA_CLAUDE_PATH = wrapper
    process.env.AGENTHYDRA_MOCK_NO_DELAY = '1'
    process.env.AGENTHYDRA_MOCK_RECORDING = 'claude-usage-screen'
    const snap = await checkUsage({ forceCli: true, account: 'mock-replay@example.com' })
    expect(snap.session?.pct).toBe(12)
    expect(snap.weekAll?.pct).toBe(64)
    expect(snap.weekModel).toMatchObject({ label: 'Fable', pct: 41 })
  },
  SPAWN_TIMEOUT_MS,
)

// Contract: over a replayed `codex app-server`, the client pages with the recorded cursor, surfaces
// a recorded error as a rejection, and REFUSES the server-initiated approval request instead of
// approving it. Gap: codex-rpc.test.ts's server never asks the client anything, so a change that
// answered requests with a result (an approval) would pass there.
test(
  'Codex RPC over a replayed app-server pages, errors, and refuses approvals',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'mock-codex-'))
    roots.push(home)
    process.env.AGENTHYDRA_MOCK_NO_DELAY = '1'
    const rpc = await connectCodexRpc(home, {
      command: [process.execPath, MOCK_AGENT, '--as', 'codex', 'app-server'],
      timeoutMs: 10_000,
    })
    try {
      type Page = { data: Array<{ id: string }>; nextCursor: string | null }
      const first = await rpc.call<Page>('thread/list', { cursor: null })
      const second = await rpc.call<Page>('thread/list', { cursor: first.nextCursor })
      const ids = [...first.data, ...second.data].map((t) => t.id)
      expect(ids).toEqual(['thr_mock_1', 'thr_mock_2'])
      expect(second.nextCursor).toBeNull()
      const archiveError = await rpc.call('thread/archive', { threadId: 'thr_mock_1' }).then(
        () => '',
        (error: Error) => error.message,
      )
      expect(archiveError).toBe('thread is running')
      const { messages } = await rpc.call<{ messages: Array<Record<string, any>> }>('mock/received')
      const reply = messages.find((m) => m.id === 900 && m.method === undefined)
      expect(reply?.error?.code).toBe(-32601)
      expect(reply?.result).toBeUndefined()
    } finally {
      await rpc.close()
    }
  },
  SPAWN_TIMEOUT_MS,
)
