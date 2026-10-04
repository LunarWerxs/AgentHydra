// server/tests/climayte-chat.test.ts — a chat worker (task `chat: true`) launches like the owner's
// own `claude`, not like a delegated worker (owner, 2026-10-04: a chat asked to answer a company
// drafted the mail and handed it back, because its worker brief told it to report, not act).
//
// No account is signed in here, so every worker waits; the argv is built from the worker record the
// dispatch made, by the same function a launch uses.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { CHAT_NOTE, cliArgv } from '../src/climayte-launch'
import { WORKER_BRIEF } from '../src/climayte-lib'

const scratch = mkdtempSync(join(tmpdir(), 'climayte-chat-'))
// The owner's `.claude` sits in a home of its own; the chat's folder is outside it, so the CLI's
// CLAUDE.md walk does not reach the owner's file and the launch has to carry it.
const HOME = join(scratch, 'home')
const OWNER = join(HOME, '.claude')
const CWD = join(scratch, 'repo')
const OWNER_RULES = 'Read Connections first: call lane_brief.'

beforeAll(() => {
  mkdirSync(OWNER, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  writeFileSync(join(OWNER, 'CLAUDE.md'), OWNER_RULES)
  setCliMayteAccountsProvider(() => [])
  setCliMayteClaudeCommand(['claude'])
  setCliMayteOwnerDir(OWNER)
})
afterAll(() => {
  climayteCancel({ group: 'chat-test' })
  setCliMayteOwnerDir(null)
  setCliMayteClaudeCommand(null)
  setCliMayteAccountsProvider(null)
  rmSync(scratch, { recursive: true, force: true })
})

const dispatch = (task: Record<string, unknown>) => {
  const reply = climayteRun({
    group: 'chat-test',
    tasks: [{ prompt: 'Answer the company', cwd: CWD, ...task }],
  })
  const w = workers.get(reply.workers[0]?.id ?? '')
  if (!w) throw new Error('no worker made')
  return w
}

const valueAfter = (argv: string[], flag: string): string | undefined =>
  argv[argv.indexOf(flag) + 1]

describe('chat workers', () => {
  test('a chat gets no worker brief, the owner instructions and skills, and Opus xhigh', () => {
    const w = dispatch({ title: 'a chat', chat: true })
    expect(w).toMatchObject({ chat: true, effort: 'xhigh' })
    expect(w.model).toContain('opus')
    expect(w.auto).toBeUndefined()

    const argv = cliArgv(w, 'sid', false, 'hooks.json', null)
    expect(argv).not.toContain(WORKER_BRIEF)
    expect(argv).not.toContain('--append-system-prompt')
    expect(valueAfter(argv, '--effort')).toBe('xhigh')
    expect(valueAfter(argv, '--add-dir')).toBe(HOME)
    const prompt = readFileSync(valueAfter(argv, '--append-system-prompt-file') ?? '', 'utf8')
    expect(prompt.startsWith(CHAT_NOTE)).toBe(true)
    expect(prompt).toContain(OWNER_RULES)
    expect(prompt).not.toContain('CliMayte worker')
  })

  test("an ordinary worker's argv is what it was: the worker brief, no chat flags", () => {
    const w = dispatch({ title: 'a task', model: 'sonnet', effort: 'medium', modelWhy: 'fixed' })
    expect(w.chat).toBeUndefined()
    const argv = cliArgv(w, 'sid', false, 'hooks.json', 'mcp.json')
    expect(argv).toEqual([
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--session-id',
      'sid',
      '--model',
      w.model as string,
      '--effort',
      'medium',
      '--mcp-config',
      'mcp.json',
      '--settings',
      'hooks.json',
      '--append-system-prompt',
      WORKER_BRIEF,
    ])
  })
})
