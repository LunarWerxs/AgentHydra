// server/tests/climayte-browser-mcp.test.ts — a worker that is not a chat gets AgentHydra's browser tools (Desk's
// /mcp/browser, for its own folder) in its MCP config; a chat worker does not, since its Desk chat has them already.
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
import { writeWorkerMcp } from '../src/climayte-launch'

const scratch = mkdtempSync(join(tmpdir(), 'climayte-browser-mcp-test-'))
const OWNER = join(scratch, 'home', '.claude')
const WORK = join(scratch, 'work')

beforeAll(() => {
  mkdirSync(OWNER, { recursive: true })
  mkdirSync(WORK, { recursive: true })
  writeFileSync(join(OWNER, 'CLAUDE.md'), 'Owner rules.')
  setCliMayteAccountsProvider(() => [])
  setCliMayteClaudeCommand(['claude'])
  setCliMayteOwnerDir(OWNER)
})
afterAll(() => {
  climayteCancel({ group: 'browser-mcp-test' })
  for (const w of workers.values())
    if (w.group === 'browser-mcp-test') rmSync(w.cwd, { recursive: true, force: true })
  setCliMayteOwnerDir(null)
  setCliMayteClaudeCommand(null)
  setCliMayteAccountsProvider(null)
  rmSync(scratch, { recursive: true, force: true })
})

describe('the browser tools in a worker config', () => {
  test('a worker that is not a chat gets the browser server for its folder', () => {
    const reply = climayteRun({
      group: 'browser-mcp-test',
      model: 'sonnet',
      effort: 'medium',
      ownerWords: 'fixed',
      tasks: [{ prompt: 'Look at the page', cwd: WORK }],
    })
    const w = workers.get(reply.workers[0]?.id ?? '')
    if (!w) throw new Error('no worker made')
    const file = writeWorkerMcp(w)
    if (!file) throw new Error('no config written')
    const servers = (
      JSON.parse(readFileSync(file, 'utf8')) as {
        mcpServers: Record<string, { type: string; url: string }>
      }
    ).mcpServers
    expect(servers.browser?.type).toBe('http')
    expect(servers.browser?.url).toBe(
      `http://127.0.0.1:${Number(process.env.HYDRA_DESK_PORT) || 7798}/mcp/browser?worker=${encodeURIComponent(w.id)}&cwd=${encodeURIComponent(w.cwd)}`,
    )
  })

  test('a chat worker does not get the browser server', () => {
    const reply = climayteRun({
      group: 'browser-mcp-test',
      model: 'sonnet',
      effort: 'medium',
      ownerWords: 'fixed',
      tasks: [{ prompt: 'Look at the page', cwd: WORK }],
    })
    const w = workers.get(reply.workers[0]?.id ?? '')
    if (!w) throw new Error('no worker made')
    const file = writeWorkerMcp({ ...w, chat: true })
    if (!file) throw new Error('no config written')
    const servers = (
      JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown> }
    ).mcpServers
    expect(servers.browser).toBeUndefined()
    expect(servers['climayte-worker']).toBeDefined()
  })

  test("the owner's generic Desk browser entry is replaced by the worker's own", () => {
    writeFileSync(
      join(scratch, 'home', '.claude.json'),
      JSON.stringify({
        mcpServers: { browser: { type: 'http', url: 'http://127.0.0.1:7798/mcp/browser' } },
      }),
    )
    const reply = climayteRun({
      group: 'browser-mcp-test',
      model: 'sonnet',
      effort: 'medium',
      ownerWords: 'fixed',
      tasks: [{ prompt: 'Look at the page', cwd: WORK }],
    })
    const w = workers.get(reply.workers[0]?.id ?? '')
    if (!w) throw new Error('no worker made')
    const file = writeWorkerMcp(w)
    if (!file) throw new Error('no config written')
    const servers = (
      JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, { url: string }> }
    ).mcpServers
    expect(servers.browser?.url).toBe(
      `http://127.0.0.1:${Number(process.env.HYDRA_DESK_PORT) || 7798}/mcp/browser?worker=${encodeURIComponent(w.id)}&cwd=${encodeURIComponent(w.cwd)}`,
    )
    rmSync(join(scratch, 'home', '.claude.json'), { force: true })
  })

  test("a foreign browser server of the owner's is kept over the worker's", () => {
    const foreign = { type: 'stdio', command: 'example-browser', args: ['--serve'] }
    writeFileSync(
      join(scratch, 'home', '.claude.json'),
      JSON.stringify({ mcpServers: { browser: foreign } }),
    )
    const reply = climayteRun({
      group: 'browser-mcp-test',
      model: 'sonnet',
      effort: 'medium',
      ownerWords: 'fixed',
      tasks: [{ prompt: 'Look at the page', cwd: WORK }],
    })
    const w = workers.get(reply.workers[0]?.id ?? '')
    if (!w) throw new Error('no worker made')
    const file = writeWorkerMcp(w)
    if (!file) throw new Error('no config written')
    const servers = (
      JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown> }
    ).mcpServers
    expect(servers.browser).toEqual(foreign)
    rmSync(join(scratch, 'home', '.claude.json'), { force: true })
  })
})
