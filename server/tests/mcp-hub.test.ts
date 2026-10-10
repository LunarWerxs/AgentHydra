// server/tests/mcp-hub.test.ts - the shared-MCP sync, pinned on the round trip that makes it safe to switch on and off:
// a stdio entry the hub may serve moves to the store and points at the hub, a hub entry whose port moved follows the
// daemon, and switching off restores the owner's original exactly, in the account config and in a CLI instance file.
//
// The case drives explicit paths in a scratch dir, so no test can reach the real ~/.claude.json.

import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncSharedMcp } from '../src/mcp-hub'

const scratchDirs: string[] = []
afterAll(() => {
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

test('switching sharing on and off restores each stdio entry exactly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-mcphub-'))
  scratchDirs.push(dir)
  const configPath = join(dir, '.claude.json')
  const storePath = join(dir, 'shared-mcp.json')
  const instancePath = join(dir, 'instance.claude.json')
  const tool = { type: 'stdio', command: 'C:/Users/me/tools/alpha.exe', args: ['--serve'], env: {} }
  const kept = {
    type: 'stdio',
    command: 'C:/Users/me/tools/beta.exe',
    args: [],
    env: { NOTE: 'x' },
  }
  const remote = { type: 'http', url: 'https://example.test/mcp' }
  const original = { theme: 'dark', mcpServers: { alpha: tool, beta: kept, gamma: remote } }
  writeFileSync(configPath, JSON.stringify(original))
  writeFileSync(instancePath, JSON.stringify({ mcpServers: { alpha: tool } }))
  const sync = (daemonUrl: string, enabled: boolean) =>
    syncSharedMcp({
      daemonUrl,
      enabled,
      configPath,
      storePath,
      instancePaths: [instancePath],
      primary: true,
      env: {},
    })
  const hubAt = (port: number) => ({
    type: 'http',
    url: `http://127.0.0.1:${port}/api/mcp/shared/alpha`,
  })

  // Sharing: alpha is saved in the store and points at the hub; beta (its env is non-empty) and gamma stay as they are.
  expect(sync('http://127.0.0.1:7001', true)).toEqual({
    changed: ['alpha'],
    instances: 1,
    error: null,
  })
  expect(read(configPath)).toEqual({
    theme: 'dark',
    mcpServers: { alpha: hubAt(7001), beta: kept, gamma: remote },
  })
  expect(read(storePath)).toEqual({ alpha: tool })
  expect(read(instancePath)).toEqual({ mcpServers: { alpha: hubAt(7001) } })

  // A daemon on a new port moves the hub entries with it; the store is left alone.
  expect(sync('http://127.0.0.1:7002', true)).toEqual({
    changed: ['alpha'],
    instances: 1,
    error: null,
  })
  expect(read(configPath).mcpServers).toEqual({ alpha: hubAt(7002), beta: kept, gamma: remote })
  expect(read(storePath)).toEqual({ alpha: tool })
  expect(read(instancePath)).toEqual({ mcpServers: { alpha: hubAt(7002) } })

  // Switching off: the original goes back into the config and the instance file, then the store forgets it.
  expect(sync('http://127.0.0.1:7002', false)).toEqual({
    changed: ['alpha'],
    instances: 1,
    error: null,
  })
  expect(read(configPath)).toEqual(original)
  expect(read(instancePath)).toEqual({ mcpServers: { alpha: tool } })
  expect(read(storePath)).toEqual({})
})
