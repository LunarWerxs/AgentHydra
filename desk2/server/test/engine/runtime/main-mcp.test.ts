// A chat gets the MCP servers plain `claude` would get in its folder under Jacob's main .claude.json, and
// skips AgentHydra's worker-rules CLAUDE.md copy. Every config here is fake.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { ChatSummary } from '@shared/protocol'
import { ChatRuntime } from '../../../src/engine/chat-runtime'
import { ChatStore } from '../../../src/engine/store'
import { DEFAULT_SETTINGS } from '../../../src/settings'

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'desk-mainmcp-'))
  temps.push(d)
  return d
}

function runtime(cwd: string, mainClaudeJson: string, configDir: string | null) {
  const home = temp()
  const chat = {
    id: 'c1', sessionId: null, title: 't', cwd, account: { id: 'a', label: 'A', configDir }, accountAuto: false, model: null, effort: null,
    permissionMode: 'default', delegateToCliMayte: false, status: 'closed', activity: null, turnStartedAt: null, lastError: null, limitResetsAt: null,
    unread: false, pinned: false, archived: false, group: null, forkedFrom: null, createdAt: 1, updatedAt: 1, costUsd: 0, contextPct: null,
    pendingCount: 0, queuedCount: 0, climayteActive: 0,
  } as ChatSummary
  return new ChatRuntime({
    chat,
    store: new ChatStore(home, { debounceMs: 1 }),
    emit: () => {},
    queryImpl: () => ({}) as unknown as Query,
    env: {},
    settings: DEFAULT_SETTINGS,
    agentHydraMcp: null,
    mainClaudeJson,
  })
}

describe('a chat\'s MCP servers from the main config', () => {
  test('gets the user-level servers and its own folder\'s local ones (any case or slash), never another folder\'s', () => {
    const cwd = join(temp(), 'Folder X')
    mkdirSync(cwd)
    const other = join(temp(), 'Folder Y')
    const main = join(temp(), '.claude.json')
    const key = cwd.replace(/\\/g, '/')
    writeFileSync(
      main,
      JSON.stringify({
        mcpServers: { connections: { command: 'fake-conn' }, agenthydra: { type: 'http', url: 'http://fake.invalid/mcp' }, junk: 'x' },
        projects: {
          [process.platform === 'win32' ? key.toUpperCase() : key]: { mcpServers: { codegraph: { command: 'fake-cg' } } },
          [other.replace(/\\/g, '/')]: { mcpServers: { elsewhere: { command: 'fake-else' } } },
        },
      }),
    )
    // the folder's .mcp.json owns a name the user level also has
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { connections: { command: 'project-conn' } } }))
    const names = Object.keys(runtime(cwd, main, null).buildOptions().mcpServers ?? {}).sort()
    expect(names).toEqual(['agenthydra', 'codegraph'])
    mkdirSync(other)
    expect(Object.keys(runtime(other, main, null).buildOptions().mcpServers ?? {}).sort()).toEqual(['agenthydra', 'connections', 'elsewhere'])
  })

  test('a missing main config adds nothing', () => {
    const cwd = temp()
    expect(runtime(cwd, join(temp(), 'nope.json'), null).buildOptions().mcpServers).toBeUndefined()
  })
})

describe('the worker-rules CLAUDE.md copy', () => {
  test('is excluded and Jacob\'s real CLAUDE.md is appended; a hand-written account CLAUDE.md is left alone', () => {
    const root = temp()
    mkdirSync(join(root, '.claude'))
    writeFileSync(join(root, '.claude', 'CLAUDE.md'), 'REAL pointer instructions')
    const main = join(root, '.claude.json')
    writeFileSync(main, '{}')
    const acct = temp()
    writeFileSync(join(acct, 'CLAUDE.md'), '# Rules for a CliMayte worker\n\nyou are headless')
    const o = runtime(temp(), main, acct).buildOptions()
    expect((o.settings as { claudeMdExcludes: string[] }).claudeMdExcludes).toEqual([join(acct, 'CLAUDE.md').replace(/\\/g, '/')])
    expect(JSON.stringify(o.systemPrompt)).toContain('REAL pointer instructions')
    writeFileSync(join(acct, 'CLAUDE.md'), '# My own notes')
    expect(runtime(temp(), main, acct).buildOptions().settings).toBeUndefined()
  })
})

describe('the owner\'s hooks', () => {
  test('run in a chat on an extra account, whose folder carries none; a default-account chat already loads them', () => {
    const root = temp()
    mkdirSync(join(root, '.claude'))
    const hooks = { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'fake-gate' }] }] }
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks, theme: 'dark' }))
    writeFileSync(join(root, '.claude', 'CLAUDE.md'), 'REAL pointer instructions')
    const main = join(root, '.claude.json')
    writeFileSync(main, '{}')
    const acct = temp()
    expect((runtime(temp(), main, acct).buildOptions().settings as { hooks: unknown }).hooks).toEqual(hooks)
    // the worker-rules copy is still skipped beside them
    writeFileSync(join(acct, 'CLAUDE.md'), '# Rules for a CliMayte worker\n\nyou are headless')
    const o = runtime(temp(), main, acct).buildOptions().settings as { hooks: unknown; claudeMdExcludes: string[] }
    expect([o.hooks, o.claudeMdExcludes]).toEqual([hooks, [join(acct, 'CLAUDE.md').replace(/\\/g, '/')]])
    // given again on the default account, every hook would run twice
    expect(runtime(temp(), main, null).buildOptions().settings).toBeUndefined()
  })
})
