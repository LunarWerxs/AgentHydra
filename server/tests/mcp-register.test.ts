// server/tests/mcp-register.test.ts - the automatic MCP registration, pinned on the two things
// that make it safe to run unattended on every boot: it writes exactly one key of somebody else's
// config file, and it refuses outright rather than rewriting a file it could not parse.
//
// Every case drives an explicit `configPath` in a scratch dir, so no test can reach the real
// ~/.claude.json - the file this module is otherwise designed to edit in place.

import { expect, test } from 'bun:test'
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeCodeConfigPath,
  desiredEntry,
  MCP_SERVER_KEY,
  mcpRegistrationStatus,
  resetMcpRegisterMemory,
  syncMcpRegistration,
} from '../src/mcp-register'

const scratch = () => mkdtempSync(join(tmpdir(), 'agenthydra-mcpreg-'))
const URL_ = 'http://127.0.0.1:7787'
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

test('a missing config file is created with only our entry in it', () => {
  const configPath = join(scratch(), '.claude.json')
  const res = syncMcpRegistration({ daemonUrl: URL_, enabled: true, configPath })
  expect(res.action).toBe('added')
  expect(res.registered).toBe(true)
  expect(res.error).toBeNull()
  expect(read(configPath)).toEqual({
    mcpServers: { [MCP_SERVER_KEY]: { type: 'http', url: `${URL_}/api/mcp` } },
  })
})

test('every other server and every unrelated key survives, byte for byte in value', () => {
  const configPath = join(scratch(), '.claude.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      oauthAccount: { emailAddress: 'me@example.com' },
      projects: { 'C:\\work': { history: [1, 2, 3] } },
      mcpServers: {
        codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] },
      },
    }),
  )
  syncMcpRegistration({ daemonUrl: URL_, enabled: true, configPath })
  const after = read(configPath)
  expect(after.oauthAccount).toEqual({ emailAddress: 'me@example.com' })
  expect(after.projects).toEqual({ 'C:\\work': { history: [1, 2, 3] } })
  const servers = after.mcpServers as Record<string, unknown>
  expect(servers.codegraph).toEqual({
    type: 'stdio',
    command: 'codegraph',
    args: ['serve', '--mcp'],
  })
  expect(servers[MCP_SERVER_KEY]).toEqual({ type: 'http', url: `${URL_}/api/mcp` })
})

test('a second boot on the same port writes nothing', () => {
  const configPath = join(scratch(), '.claude.json')
  syncMcpRegistration({ daemonUrl: URL_, enabled: true, configPath })
  const before = readFileSync(configPath, 'utf8')
  const res = syncMcpRegistration({ daemonUrl: URL_, enabled: true, configPath })
  expect(res.action).toBe('unchanged')
  expect(readFileSync(configPath, 'utf8')).toBe(before)
})

test('a port hop rewrites the URL rather than leaving a dead one behind', () => {
  const configPath = join(scratch(), '.claude.json')
  syncMcpRegistration({ daemonUrl: URL_, enabled: true, configPath })
  const res = syncMcpRegistration({
    daemonUrl: 'http://127.0.0.1:7788',
    enabled: true,
    configPath,
  })
  expect(res.action).toBe('updated')
  const servers = read(configPath).mcpServers as Record<string, unknown>
  expect(servers[MCP_SERVER_KEY]).toEqual({ type: 'http', url: 'http://127.0.0.1:7788/api/mcp' })
})

test('turning it off REMOVES the entry - off cannot mean "stops being refreshed"', () => {
  const configPath = join(scratch(), '.claude.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { type: 'stdio' } } }))
  syncMcpRegistration({ daemonUrl: URL_, enabled: true, configPath })
  const res = syncMcpRegistration({ daemonUrl: URL_, enabled: false, configPath })
  expect(res.action).toBe('removed')
  expect(res.registered).toBe(false)
  const servers = read(configPath).mcpServers as Record<string, unknown>
  expect(servers[MCP_SERVER_KEY]).toBeUndefined()
  expect(servers.other).toEqual({ type: 'stdio' })
})

test('off with nothing registered is a no-op, not a write', () => {
  const configPath = join(scratch(), '.claude.json')
  const res = syncMcpRegistration({ daemonUrl: URL_, enabled: false, configPath })
  expect(res.action).toBe('absent')
  expect(res.error).toBeNull()
})

// ⛔ THE ONE THAT MATTERS. ~/.claude.json holds the user's logins and project history. A parse
// failure is exactly when a naive "read, default to {}, write" would replace all of it with our
// single key - destroying real state to add a convenience. It must refuse and say so.
test('a config that does not parse is reported, never rewritten', () => {
  const configPath = join(scratch(), '.claude.json')
  const damaged = '{"mcpServers": {"codegraph": {'
  writeFileSync(configPath, damaged)
  const res = syncMcpRegistration({ daemonUrl: URL_, enabled: true, configPath })
  expect(res.action).toBe('failed')
  expect(res.registered).toBe(false)
  expect(res.error).toContain('not valid JSON')
  expect(readFileSync(configPath, 'utf8')).toBe(damaged)
})

test('a config that is valid JSON but not an object is refused the same way', () => {
  const configPath = join(scratch(), '.claude.json')
  writeFileSync(configPath, '[1,2,3]')
  const res = syncMcpRegistration({ daemonUrl: URL_, enabled: true, configPath })
  expect(res.action).toBe('failed')
  expect(readFileSync(configPath, 'utf8')).toBe('[1,2,3]')
})

test('an empty file is Claude Code not having written yet, not damage', () => {
  const configPath = join(scratch(), '.claude.json')
  writeFileSync(configPath, '   \n')
  expect(syncMcpRegistration({ daemonUrl: URL_, enabled: true, configPath }).action).toBe('added')
})

test('a trailing slash on the daemon URL does not become a double slash in the entry', () => {
  expect(desiredEntry('http://127.0.0.1:7787/').url).toBe('http://127.0.0.1:7787/api/mcp')
})

// ⛔ CLAUDE CODE WRITES THIS FILE TOO, with the same read-modify-write-and-rename shape. Whoever
// renames second wins the whole file, so a write must be abandoned rather than allowed to land on
// top of a change that arrived while it was being prepared.
test('a config that changes under us is NOT overwritten from the stale snapshot', () => {
  const configPath = join(scratch(), '.claude.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
  // Stand in for Claude Code: rewrite the file (with something we would otherwise destroy) every
  // time our code reads it, so every attempt races and all of them must decline.
  const theirs = JSON.stringify({
    mcpServers: { other: { type: 'stdio' } },
    projects: { 'C:\\work': { history: [1, 2, 3] } },
  })
  let landed = 0
  const res = syncMcpRegistration(
    { daemonUrl: URL_, enabled: true, configPath },
    {
      afterRead: (p) => {
        landed++
        writeFileSync(p, `${theirs}\n`.slice(0, theirs.length + landed)) // a different file each try
      },
    },
  )
  expect(res.action).toBe('failed')
  expect(res.error).toContain('another process')
  expect(landed).toBe(3) // bounded, not a spin
  // Their write survived - no key of theirs was replaced by our stale snapshot.
  const after = readFileSync(configPath, 'utf8')
  expect(after.startsWith(theirs)).toBe(true)
  expect(after).not.toContain(MCP_SERVER_KEY)
})

// A read-only config READS perfectly, so the status call cannot discover the failure by itself.
// Without the remembered write error the panel says "Not registered yet." and gives no reason -
// which is exactly the case the DTO field documents itself as existing for.
test('a failed WRITE is reported by the read-only status, not silently dropped', () => {
  const configPath = join(scratch(), '.claude.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
  resetMcpRegisterMemory()
  const res = syncMcpRegistration(
    { daemonUrl: URL_, enabled: true, configPath },
    {
      writeConfig: () => {
        throw new Error('EACCES: permission denied')
      },
    },
  )
  expect(res.action).toBe('failed')
  expect(res.error).toContain('EACCES')
  const status = mcpRegistrationStatus({ daemonUrl: URL_, configPath })
  expect(status.registered).toBe(false)
  expect(status.error).toContain('EACCES')
  // And it clears once a write succeeds, rather than haunting the panel forever.
  syncMcpRegistration({ daemonUrl: URL_, enabled: true, configPath })
  expect(mcpRegistrationStatus({ daemonUrl: URL_, configPath }).error).toBeNull()
})

// A dotfile manager may have made ~/.claude.json a symlink into its own store. Renaming over the
// LINK replaces it with a regular file and orphans the real config.
test('a symlinked config is written through, not replaced by a regular file', () => {
  const dir = scratch()
  const real = join(dir, 'real-claude.json')
  const link = join(dir, '.claude.json')
  writeFileSync(real, JSON.stringify({ mcpServers: {}, keepMe: true }))
  try {
    symlinkSync(real, link)
  } catch {
    return // unprivileged Windows cannot create symlinks; the guard is still correct
  }
  expect(syncMcpRegistration({ daemonUrl: URL_, enabled: true, configPath: link }).action).toBe(
    'added',
  )
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  const after = JSON.parse(readFileSync(real, 'utf8')) as Record<string, unknown>
  expect(after.keepMe).toBe(true)
  expect((after.mcpServers as Record<string, unknown>)[MCP_SERVER_KEY]).toEqual({
    type: 'http',
    url: `${URL_}/api/mcp`,
  })
})

// CLAUDE_CONFIG_DIR is Claude Code's own relocation: when it is set, THAT directory is the
// ambient user scope, and registering into the home directory would write a file the client
// never reads.
test('the config path follows CLAUDE_CONFIG_DIR, and AGENTHYDRA_MCP_CONFIG beats both', () => {
  expect(claudeCodeConfigPath({ CLAUDE_CONFIG_DIR: 'C:\\alt' })).toBe(
    join('C:\\alt', '.claude.json'),
  )
  expect(
    claudeCodeConfigPath({ CLAUDE_CONFIG_DIR: 'C:\\alt', AGENTHYDRA_MCP_CONFIG: 'C:\\x\\y.json' }),
  ).toBe('C:\\x\\y.json')
})
