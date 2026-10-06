// server/tests/climayte-sealed.test.ts — a sealed task (task `sealed: {...}`) launches the CLI with
// its own system prompt, its one MCP config and nothing else: no built-in tool, no settings source,
// no owner MCP server, no worker brief (docs/CLIMAYTE.md, "Sealed tasks").
//
// No account is signed in here, so every worker waits; the argv is built from the worker record the
// dispatch made, by the same function a launch uses.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteRun,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  setCliMayteOwnerDir,
} from '../src/climayte'
import { workers } from '../src/climayte-core'
import { cliArgv, writeWorkerMcp } from '../src/climayte-launch'
import { WORKER_BRIEF } from '../src/climayte-lib'

const scratch = mkdtempSync(join(tmpdir(), 'climayte-sealed-test-'))
const OWNER = join(scratch, 'home', '.claude')
const PROMPT = join(scratch, 'visitor.md')
const MCP = join(scratch, 'mcp.json')
const sealed = { systemPromptFile: PROMPT, mcpConfig: MCP, allowedTools: ['mcp__hands__*'] }

beforeAll(() => {
  mkdirSync(OWNER, { recursive: true })
  writeFileSync(join(OWNER, 'CLAUDE.md'), 'Owner rules.')
  writeFileSync(PROMPT, 'You are a visitor.')
  writeFileSync(
    MCP,
    JSON.stringify({ mcpServers: { hands: { command: 'node', args: ['h.mjs'] } } }),
  )
  setCliMayteAccountsProvider(() => [])
  setCliMayteClaudeCommand(['claude'])
  setCliMayteOwnerDir(OWNER)
})
afterAll(() => {
  climayteCancel({ group: 'sealed-test' })
  for (const w of workers.values())
    if (w.group === 'sealed-test') rmSync(w.cwd, { recursive: true, force: true })
  setCliMayteOwnerDir(null)
  setCliMayteClaudeCommand(null)
  setCliMayteAccountsProvider(null)
  rmSync(scratch, { recursive: true, force: true })
})

const run = (task: Record<string, unknown>) =>
  climayteRun({
    group: 'sealed-test',
    model: 'sonnet',
    effort: 'medium',
    ownerWords: 'fixed',
    tasks: [task as { prompt: string; cwd: string }],
  })

describe('sealed tasks', () => {
  test('the launch carries the sealed flags and nothing of the owner or the worker brief', () => {
    const reply = run({ title: 'a visitor', sealed: { ...sealed, prompt: 'Visit the page' } })
    const w = workers.get(reply.workers[0]?.id ?? '')
    if (!w) throw new Error('no worker made')
    expect(w.sealed).toEqual(sealed)
    expect(w.prompt).toBe('Visit the page')
    // An empty folder of its own, not one the task named.
    expect(existsSync(w.cwd) && readdirSync(w.cwd)).toEqual([])

    // With an owner dir an ordinary worker gets a config written for it (the owner's servers and
    // climayte-worker); a sealed one gets its own file back.
    expect(writeWorkerMcp(w)).toBe(MCP)
    const argv = cliArgv(w, 'sid', false, 'hooks.json', MCP)
    expect(argv).toEqual([
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'default',
      '--session-id',
      'sid',
      '--model',
      w.model as string,
      '--effort',
      'medium',
      '--mcp-config',
      MCP,
      '--settings',
      'hooks.json',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--tools',
      '',
      '--allowedTools',
      'mcp__hands__*',
      '--system-prompt-file',
      PROMPT,
    ])
    expect(argv).not.toContain(WORKER_BRIEF)
  })

  test('a missing file or no allowed tool is refused, and no worker is made', () => {
    const before = workers.size
    const gone = join(scratch, 'gone.md')
    expect(() => run({ prompt: 'p', sealed: { ...sealed, systemPromptFile: gone } })).toThrow(
      `task 1: sealed.systemPromptFile '${gone}' is not an existing file`,
    )
    expect(() => run({ prompt: 'p', sealed: { ...sealed, mcpConfig: gone } })).toThrow(
      'is not an existing file',
    )
    expect(() => run({ prompt: 'p', sealed: { ...sealed, mcpConfig: PROMPT } })).toThrow(
      'is not JSON with an mcpServers object',
    )
    expect(() => run({ prompt: 'p', sealed: { ...sealed, allowedTools: [] } })).toThrow(
      'sealed.allowedTools must be a non-empty array',
    )
    expect(() => run({ sealed })).toThrow('task 1: prompt is empty')
    expect(workers.size).toBe(before)
  })
})
