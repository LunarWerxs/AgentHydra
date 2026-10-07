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
  climayteSend,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  setCliMayteOwnerDir,
} from '../src/climayte'
import { workers } from '../src/climayte-core'
import { CHAT_NOTE, cliArgv, writeWorkerMcp } from '../src/climayte-launch'
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
    expect(prompt).not.toContain('a CliMayte worker')
  })

  test("a Desk chat's add-ons: its servers (the owner's of a name win) and its append, once", () => {
    writeFileSync(
      join(HOME, '.claude.json'),
      JSON.stringify({
        mcpServers: { shared: { type: 'http', url: 'http://owner.example.test/mcp' } },
      }),
    )
    const media = 'To show the person a picture, GIF or video, put it in your reply'
    const w = dispatch({
      title: 'a desk chat',
      chat: true,
      desk: {
        append: `Desk text. ${media}, as the Desk words it.`,
        mcpServers: {
          redesign: { type: 'http', url: 'http://desk.example.test/mcp' },
          shared: { type: 'http', url: 'http://desk.example.test/other' },
        },
      },
    })
    const file = writeWorkerMcp(w) ?? ''
    const servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers
    expect(servers.redesign.url).toBe('http://desk.example.test/mcp')
    expect(servers.shared.url).toBe('http://owner.example.test/mcp')

    const argv = cliArgv(w, 'sid', false, 'hooks.json', file)
    const prompt = readFileSync(valueAfter(argv, '--append-system-prompt-file') ?? '', 'utf8')
    expect(prompt.split('Desk text.').length).toBe(2)
    expect(prompt.split(media).length).toBe(2)
    expect(prompt.indexOf('main agent')).toBeLessThan(prompt.indexOf('Desk text.'))
    expect(prompt.indexOf('Desk text.')).toBeLessThan(prompt.indexOf(OWNER_RULES))
    rmSync(join(HOME, '.claude.json'))
  })

  test("a message brings a chat's add-ons as they are now, so a chat started before them gets them", () => {
    const w = dispatch({ title: 'an old chat', chat: true })
    expect(w.desk).toBeUndefined()
    const desk = {
      append: 'Design first.',
      mcpServers: { redesign: { type: 'http', url: 'http://desk.example.test/mcp' } },
    }
    expect(climayteSend(w.id, 'show me options', { desk }).ok).toBe(true)
    expect(w.desk).toEqual(desk)
    expect(JSON.parse(readFileSync(writeWorkerMcp(w) ?? '', 'utf8')).mcpServers.redesign.url).toBe(
      'http://desk.example.test/mcp',
    )

    const task = dispatch({ title: 'a task' })
    expect(climayteSend(task.id, 'hi', { desk })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/only for a chat/),
    })
    expect(
      climayteSend(w.id, 'hi', { desk: { append: 'x'.repeat(20_001), mcpServers: {} } }).ok,
    ).toBe(false)
    expect(w.desk).toEqual(desk)
  })

  test('a chat without desk keeps the media sentence once', () => {
    const w = dispatch({ title: 'plain chat', chat: true })
    const argv = cliArgv(w, 'sid', false, 'hooks.json', null)
    const prompt = readFileSync(valueAfter(argv, '--append-system-prompt-file') ?? '', 'utf8')
    expect(prompt.split('To show the person a picture').length).toBe(2)
  })

  test('desk is refused without chat, and a longer append is refused, not cut', () => {
    const desk = { append: 'x', mcpServers: {} }
    expect(() => dispatch({ title: 'not a chat', desk })).toThrow(/only for a chat/)
    expect(() =>
      dispatch({ chat: true, desk: { append: 'x'.repeat(20_001), mcpServers: {} } }),
    ).toThrow(/at most 20000/)
    expect(
      dispatch({ chat: true, desk: { append: 'x'.repeat(20_000), mcpServers: {} } }).desk,
    ).toBeDefined()
  })

  test("a chat's heir launches on the model and effort the chat had", () => {
    const w = dispatch({ title: 'heir', chat: true, model: 'opus', effort: 'max' })
    const first = cliArgv(w, 'sid', false, 'hooks.json', null)
    const heir = cliArgv(w, 'sid2', false, 'hooks.json', null)
    for (const flag of ['--model', '--effort'])
      expect(valueAfter(heir, flag)).toBe(valueAfter(first, flag))
    expect(valueAfter(heir, '--effort')).toBe('max')
  })

  test("an ordinary worker's argv is what it was: the worker brief, no chat flags", () => {
    const w = dispatch({ title: 'a task', model: 'sonnet', effort: 'medium', ownerWords: 'fixed' })
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
