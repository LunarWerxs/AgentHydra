// server/src/command-corrections.ts - fail-then-fix command pairs mined from transcripts.
//
// These pin what counts as a correction, which is where a plausible miner is quietly wrong: a
// failing test run followed by a passing one is not a mistake, an identical retry is not a fix, a
// `pytest` -> `python -m pytest` fix changes the base command, and each store records the outcome
// of a shell call in its own shape.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  baseCommand,
  ClaudeCommandReader,
  CodexCommandReader,
  type CommandRun,
  classifyCommandError,
  findCorrections,
  groupCorrections,
  mineCommandCorrections,
  openCodeCommandRuns,
  renderCorrectionRules,
} from '../src/command-corrections'
import type { TranscriptFile } from '../src/transcript'

const dir = mkdtempSync(join(tmpdir(), 'ah-corrections-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ok = (command: string): CommandRun => ({ command, failed: false, output: '', ts: 1 })
const bad = (command: string, output: string): CommandRun => ({
  command,
  failed: true,
  output,
  ts: 1,
})

describe('classify and base command', () => {
  test('each error kind is named from the error text', () => {
    expect(classifyCommandError("error: unknown option '--oneline=5'")).toBe('unknown-flag')
    expect(classifyCommandError('error: the following arguments are required: path')).toBe(
      'missing-arg',
    )
    expect(classifyCommandError("ls: cannot access 'srcx': No such file or directory")).toBe(
      'wrong-path',
    )
    expect(classifyCommandError('bash: pytest: command not found')).toBe('command-not-found')
    expect(classifyCommandError('open ./x: Permission denied')).toBe('permission-denied')
    expect(classifyCommandError('3 tests failed')).toBeNull()
  })

  test('the base skips a cd prefix and env, and keeps a git-style subcommand', () => {
    expect(baseCommand('cd "/repo dir" && FOO=1 git log --oneline')).toBe('git log')
    expect(baseCommand('C:/tools/Rg.exe -n foo')).toBe('rg')
    expect(baseCommand('sudo ls -la')).toBe('ls')
  })
})

describe('pairing', () => {
  test('a classified failure pairs with the next same-base success', () => {
    const pairs = findCorrections([
      bad('git log -n=5 --oneline', "error: unknown option 'n=5'"),
      ok('ls'),
      ok('git log -n 5 --oneline'),
    ])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({
      kind: 'unknown-flag',
      base: 'git log',
      wrong: 'git log -n=5 --oneline',
      right: 'git log -n 5 --oneline',
    })
  })

  test('an unclassified failure, an identical retry and a repeat failure are not corrections', () => {
    expect(findCorrections([bad('bun test a.ts', '1 fail'), ok('bun test a.ts')])).toEqual([])
    expect(
      findCorrections([bad('cat x.txt', 'No such file or directory'), ok('cat x.txt')]),
    ).toEqual([])
    // The next same-base attempt failed too: it gets its own pairing, the first one gets none.
    const pairs = findCorrections([
      bad('cat a.txt', 'No such file or directory'),
      bad('cat b.txt', 'No such file or directory'),
      ok('cat c.txt'),
    ])
    expect(pairs.map((p) => p.wrong)).toEqual(['cat b.txt'])
  })

  test('command not found pairs across a changed base when the arguments carry over', () => {
    const pairs = findCorrections([
      bad('pytest tests -q', 'bash: pytest: command not found'),
      ok('python -m pytest tests -q'),
    ])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ kind: 'command-not-found', base: 'pytest' })
  })
})

describe('grouping and the rules file', () => {
  test('groups count occurrences and sessions, and the rules file redacts secrets', () => {
    const key = `AKIA${'ABCDEFGHIJKLMNOP'}`
    const p = {
      kind: 'unknown-flag' as const,
      base: 'git log',
      wrong: `git log -n=5 ${key}`,
      right: 'git log -n 5',
      error: "unknown option 'n=5'",
      ts: 10,
    }
    const groups = groupCorrections([
      { ...p, sessionId: 's1' },
      { ...p, sessionId: 's1' },
      { ...p, sessionId: 's2' },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ count: 3, sessions: 2 })
    expect(groups[0]?.examples[0]).toMatchObject({ count: 3, sessions: 2 })
    const md = renderCorrectionRules(groups)
    expect(md).toContain('## `git log`: unknown flag (3 times, 2 sessions)')
    expect(md).toContain('use `git log -n 5`')
    expect(md).not.toContain(key)
  })
})

describe('store readers', () => {
  test('Claude joins a Bash call to its result by tool_use_id', () => {
    const r = new ClaudeCommandReader()
    const call = (id: string, command: string) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-01T10:00:00.000Z',
        message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
      })
    const result = (id: string, text: string, isError: boolean) =>
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }],
        },
      })
    for (const line of [
      call('a', 'ls srcx'),
      result('a', "Exit code 2\nls: cannot access 'srcx': No such file or directory", true),
      call('b', 'ls src'),
      result('b', 'index.ts', false),
      call('c', 'ls never-answered'),
    ])
      r.push(line)
    const runs = r.result()
    expect(runs.map((x) => [x.command, x.failed])).toEqual([
      ['ls srcx', true],
      ['ls src', false],
    ])
  })

  test('Codex reads the exit code from both output shapes and unwraps bash -lc', () => {
    const r = new CodexCommandReader()
    const call = (id: string, args: unknown) =>
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell',
          call_id: id,
          arguments: JSON.stringify(args),
        },
      })
    const out = (id: string, output: string) =>
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: id, output },
      })
    r.push(call('1', { command: ['bash', '-lc', 'rg --colour foo'] }))
    r.push(
      out(
        '1',
        JSON.stringify({ output: 'error: unexpected argument', metadata: { exit_code: 2 } }),
      ),
    )
    r.push(call('2', { cmd: 'rg --color never foo' }))
    r.push(out('2', 'Process exited with code 0\nfoo'))
    expect(r.result().map((x) => [x.command, x.failed])).toEqual([
      ['rg --colour foo', true],
      ['rg --color never foo', false],
    ])
  })

  test('OpenCode takes a failure from an error status or a non-zero exit', () => {
    const runs = openCodeCommandRuns([
      {
        type: 'tool',
        tool: 'bash',
        state: { status: 'error', input: { command: 'a' }, error: 'x' },
      },
      {
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'b' }, metadata: { exit: 1 } },
      },
      { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'c' } } },
      { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'd' } } },
    ])
    expect(runs.map((x) => [x.command, x.failed])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
    ])
  })
})

test('mining reads Claude transcripts end to end into grouped corrections', async () => {
  const lines = [
    {
      id: 't1',
      command: 'git status --shortt',
      result: "error: unknown option `shortt'",
      err: true,
    },
    { id: 't2', command: 'git status --short', result: ' M a.ts', err: false },
  ].flatMap(({ id, command, result, err }) => [
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, is_error: err, content: result }],
      },
    },
  ])
  const path = join(dir, 's.jsonl')
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8')
  const tf = (session_id: string): TranscriptFile => ({
    session_id,
    source: 'claude',
    path,
    project: 'p',
    mtime_ms: 1,
    size_bytes: 1,
    archived: false,
  })
  const report = await mineCommandCorrections({ files: [tf('s1'), tf('s2')] })
  expect(report.scanned).toBe(2)
  expect(report.groups).toHaveLength(1)
  expect(report.groups[0]).toMatchObject({
    kind: 'unknown-flag',
    base: 'git status',
    count: 2,
    sessions: 2,
  })
  expect(report.markdown).toContain('Not `git status --shortt`, use `git status --short`')
})
