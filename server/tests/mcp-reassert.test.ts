// server/tests/mcp-reassert.test.ts - keeping Claude Code's MCP entry pointed at this daemon after
// boot (server/src/mcp-register.ts createMcpReasserter).
//
// The failure this exists for: a Claude client that was already open when the daemon registered
// itself rewrites ~/.claude.json from its own stale copy, the entry reverts, and a DIFFERENT
// session hours later finds an MCP server with no tools. Pinned here:
//  * a reverted entry is put back on the next run, and other keys in the file are left alone;
//  * a run against a correct file changes nothing and logs nothing;
//  * a failure that persists is logged once, not on every tick, and a recovery is visible;
//  * run() never throws, because it is called from a repeating timer.
//
// Every case drives an explicit configPath in a scratch dir, so nothing can reach the real file.

import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpReasserter, desiredEntry, MCP_SERVER_KEY } from '../src/mcp-register'

const scratchDirs: string[] = []
afterAll(() => {
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-mcpreassert-'))
  scratchDirs.push(dir)
  return dir
}
const URL_ = 'http://127.0.0.1:7787'
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, any>

function recorder() {
  const lines: Array<{ level: 'info' | 'warn'; message: string }> = []
  return {
    lines,
    log: {
      info: (message: string) => lines.push({ level: 'info', message }),
      warn: (message: string) => lines.push({ level: 'warn', message }),
    },
  }
}

test('an entry a Claude client reverted is put back on the next run, other keys untouched', () => {
  const configPath = join(scratch(), '.claude.json')
  const { lines, log } = recorder()
  const reasserter = createMcpReasserter({ daemonUrl: () => URL_, configPath, log })
  expect(reasserter.run(true)?.registered).toBe(true)

  // A long-lived client saves its stale copy: our entry points at a port nothing listens on.
  const stale = read(configPath)
  stale.mcpServers[MCP_SERVER_KEY] = { type: 'http', url: 'http://127.0.0.1:55835/api/mcp' }
  stale.someClientSetting = 'kept'
  writeFileSync(configPath, JSON.stringify(stale))

  const healed = reasserter.run(true)
  expect(healed).toMatchObject({ registered: true, action: 'updated', error: null })
  expect(read(configPath).mcpServers[MCP_SERVER_KEY]).toEqual(desiredEntry(URL_))
  expect(read(configPath).someClientSetting).toBe('kept')
  expect(lines.filter((l) => l.message.includes('updated'))).toHaveLength(1)
  expect(reasserter.last()).toBe(healed)
})

test('a correct file is left alone and nothing is logged', () => {
  const configPath = join(scratch(), '.claude.json')
  const { lines, log } = recorder()
  const reasserter = createMcpReasserter({ daemonUrl: () => URL_, configPath, log })
  reasserter.run(true)
  const before = readFileSync(configPath, 'utf8')
  lines.length = 0
  expect(reasserter.run(true)).toMatchObject({ registered: true, action: 'unchanged' })
  expect(readFileSync(configPath, 'utf8')).toBe(before)
  expect(lines).toEqual([])
})

test('a failure that persists is logged once, and the recovery is visible', () => {
  const configPath = join(scratch(), '.claude.json')
  writeFileSync(configPath, '{ this is not json')
  const { lines, log } = recorder()
  const reasserter = createMcpReasserter({ daemonUrl: () => URL_, configPath, log })
  for (let tick = 0; tick < 5; tick++) {
    expect(reasserter.run(true)).toMatchObject({ registered: false, action: 'failed' })
  }
  expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1)
  // The file is never rewritten while it cannot be parsed.
  expect(readFileSync(configPath, 'utf8')).toBe('{ this is not json')

  writeFileSync(configPath, '{}')
  expect(reasserter.run(true)).toMatchObject({ registered: true, action: 'added', error: null })
  expect(lines.filter((l) => l.level === 'info')).toHaveLength(1)
})

test('run never throws, even when resolving the daemon URL does', () => {
  const configPath = join(scratch(), '.claude.json')
  const { lines, log } = recorder()
  const reasserter = createMcpReasserter({
    daemonUrl: () => {
      throw Error('no port yet')
    },
    configPath,
    log,
  })
  expect(() => reasserter.run(true)).not.toThrow()
  expect(reasserter.last()).toBeNull()
  expect(lines.some((l) => l.level === 'warn' && l.message.includes('no port yet'))).toBe(true)
})

test('the URL is read on every run, so a later port hop is registered too', () => {
  const configPath = join(scratch(), '.claude.json')
  let url = URL_
  const reasserter = createMcpReasserter({ daemonUrl: () => url, configPath, log: recorder().log })
  reasserter.run(true)
  url = 'http://127.0.0.1:7788'
  expect(reasserter.run(true)).toMatchObject({ registered: true, action: 'updated' })
  expect(read(configPath).mcpServers[MCP_SERVER_KEY]).toEqual(desiredEntry(url))
})
