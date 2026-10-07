import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AhCliInstance } from '../../src/bridge/client'
import { mapExternal } from '../../src/bridge/external'
import { canResume, configRootOf, resumeAccount, sameLogin, type ResumeData } from '../../src/bridge/resume'

const home = mkdtempSync(join(tmpdir(), 'desk-resume-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const DEFAULT_DIR = join(home, '.claude')

const cli = (num: number, over: Partial<AhCliInstance> = {}): AhCliInstance => ({
  num,
  id: `cli-${num}`,
  name: `n${num}`,
  configDir: join(home, '.claude-cli', `n${num}`),
  loggedIn: true,
  lastUsageCheck: { account: `acct${num}@example.test`, session: null, weekAll: null, capturedAt: '2026-10-04T00:00:00Z' },
  ...over
})

// Desktop 'eek' has no CLI instance on its login; desktop 'other' is the login of CLI #135.
const data: ResumeData = {
  desktops: [
    { num: 51, name: 'eek', label: null, dir: join(home, '.claude-instances', 'eek'), uuid: 'u-eek', email: 'eek@example.test' },
    { num: 52, name: 'other', label: 'Other', dir: join(home, '.claude-instances', 'other'), uuid: 'u-other', email: 'acct135@example.test' }
  ],
  clis: [cli(135), cli(160, { loggedIn: false }), cli(161, { lastUsageCheck: { account: 'x@example.test', session: null, weekAll: null, capturedAt: '', signedOutAt: '2026-10-03' } })]
}

describe('resumeAccount: the CLI instance whose folder already holds the session', () => {
  test('a Claude Desktop session whose transcript is in ~/.claude is never resumed in place', () => {
    expect(resumeAccount({ source: 'desktop', instance: 'eek', instanceNum: null, configRoot: null }, data)).toBeNull()
    expect(resumeAccount({ source: 'desktop', instance: '#51', instanceNum: null, configRoot: DEFAULT_DIR }, data)).toBeNull()
    expect(resumeAccount({ source: 'desktop', instance: 'unknown', instanceNum: null, configRoot: DEFAULT_DIR }, data)).toBeNull()
  })

  test('a desktop transcript under a CLI folder resumes on that CLI instance when it is the same login', () => {
    const root = data.clis[0]!.configDir
    expect(resumeAccount({ source: 'desktop', instance: 'Other', instanceNum: null, configRoot: root }, data)).toBe('cli-135')
    expect(resumeAccount({ source: 'desktop', instance: 'eek', instanceNum: null, configRoot: root }, data)).toBeNull()
  })

  test('a terminal session resumes on its own signed-in CLI instance; one in ~/.claude is a copy', () => {
    expect(resumeAccount({ source: 'cli', instance: '#135', instanceNum: 135, configRoot: null }, data)).toBe('cli-135')
    expect(resumeAccount({ source: 'cli', instance: '#160', instanceNum: 160, configRoot: null }, data)).toBeNull()
    expect(resumeAccount({ source: 'cli', instance: '#161', instanceNum: 161, configRoot: null }, data)).toBeNull()
    expect(resumeAccount({ source: 'cli', instance: null, instanceNum: null, configRoot: null }, data)).toBeNull()
    expect(resumeAccount({ source: 'cli', instance: null, instanceNum: null, configRoot: DEFAULT_DIR }, data)).toBeNull()
    expect(resumeAccount({ source: 'cli', instance: null, instanceNum: null, configRoot: data.clis[0]!.configDir }, data)).toBe('cli-135')
  })

  test('CliMayte workers and Codex never resume here', () => {
    expect(resumeAccount({ source: 'climayte', instance: '#68', instanceNum: 68, configRoot: null }, data)).toBeNull()
    expect(resumeAccount({ source: 'codex', instance: null, instanceNum: null, configRoot: null }, data)).toBeNull()
  })
})

test('sameLogin prefers the account uuid, else the email', () => {
  expect(sameLogin({ uuid: 'a', email: 'x@y' }, { uuid: 'b', email: 'x@y' })).toBe(false)
  expect(sameLogin({ uuid: null, email: 'X@y ' }, { uuid: 'b', email: 'x@y' })).toBe(true)
  expect(sameLogin({ uuid: null, email: null }, { uuid: null, email: null })).toBe(false)
})

test('canResume: idle or stale there and a Claude Code session, whatever account it lands on', () => {
  expect(canResume({ status: 'idle', source: 'desktop' })).toBe(true)
  expect(canResume({ status: 'stale', source: 'cli' })).toBe(true)
  expect(canResume({ status: 'working', source: 'desktop' })).toBe(false)
  expect(canResume({ status: 'needs_you', source: 'desktop' })).toBe(false)
  expect(canResume({ status: 'idle', source: 'codex' })).toBe(false)
  expect(canResume({ status: 'idle', source: 'climayte' })).toBe(false)
})

test('mapExternal derives canResume from the status and source, with or without an owning account', () => {
  const NOW = Date.parse('2026-10-04T12:00:00Z')
  const list = mapExternal(
    {
      agentStatus: [],
      live: [],
      chats: [
        { instance: 'eek', chatId: 'c1', sessionId: 'idle-1', title: 'Idle', archived: false, lastActivityAt: new Date(NOW - 10 * 60_000).toISOString(), cwd: 'C:/w', live: true, unread: false },
        { instance: 'eek', chatId: 'c2', sessionId: 'busy-1', title: 'Busy', archived: false, lastActivityAt: new Date(NOW - 5_000).toISOString(), cwd: 'C:/w', live: true, unread: false }
      ],
      sessions: [],
      workers: []
    },
    new Set(),
    NOW,
    (q) => resumeAccount(q, data)
  )
  const by = new Map(list.map((s) => [s.id, s]))
  expect(by.get('idle-1')).toMatchObject({ status: 'idle', accountId: null, canResume: true })
  expect(by.get('busy-1')).toMatchObject({ status: 'working', accountId: null, canResume: false })
})

test('configRootOf', () => {
  expect(configRootOf('C:\\Users\\j\\.claude\\projects\\C--w\\s.jsonl')).toBe('C:\\Users\\j\\.claude')
  expect(configRootOf('/home/j/.claude-x/projects/a/s.jsonl')).toBe('/home/j/.claude-x')
  expect(configRootOf(null)).toBeNull()
})
