// server/tests/mcp-register.test.ts - the automatic MCP registration, pinned on the two things
// that make it safe to run unattended on every boot: it writes exactly one key of somebody else's
// config file, and it refuses outright rather than rewriting a file it could not parse.
//
// Every case drives an explicit `configPath` in a scratch dir, so no test can reach the real
// ~/.claude.json - the file this module is otherwise designed to edit in place.

import { afterAll, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeCodeConfigPath,
  createMcpReasserter,
  desiredEntry,
  deskBrowserMcpUrl,
  MCP_BROWSER_KEY,
  MCP_SERVER_KEY,
  mcpRegistrationStatus,
  resetMcpRegisterMemory,
  syncMcpRegistration,
} from '../src/mcp-register'

const scratchDirs: string[] = []
afterAll(() => {
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-mcpreg-'))
  scratchDirs.push(dir)
  return dir
}
const URL_ = 'http://127.0.0.1:7787'
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

test('a missing config file is created with only our entry in it', () => {
  const configPath = join(scratch(), '.claude.json')
  const res = syncMcpRegistration({ daemonUrl: URL_, enabled: true, configPath })
  expect(res.action).toBe('added')
  expect(res.registered).toBe(true)
  expect(res.error).toBeNull()
  expect(read(configPath)).toEqual({
    mcpServers: {
      [MCP_SERVER_KEY]: { type: 'http', url: `${URL_}/api/mcp` },
      [MCP_BROWSER_KEY]: { type: 'http', url: deskBrowserMcpUrl() },
    },
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
        // Pad with one MORE newline each time, so every attempt changes the file's SIZE. The
        // slice this replaced clamped at the string's own length, so attempts 2 and 3 rewrote
        // byte-identical content: nothing had changed, no race guard of any kind could see one,
        // and the test only went green when the clock happened to tick mid-rewrite (measured
        // 4 pass / 4 fail here, and red on windows-latest while ubuntu passed on finer mtimes).
        // A size change is detected on every platform regardless of timestamp resolution.
        writeFileSync(p, theirs + '\n'.repeat(landed)) // 1, 2, 3 newlines: a different SIZE each try
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

// A write failure belongs only to the keys that were being written. A browser entry already correct
// is not written, so it must not report the agenthydra entry's EACCES.
test('a failed write is reported only against the key that was being written', () => {
  const configPath = join(scratch(), '.claude.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: { [MCP_BROWSER_KEY]: { type: 'http', url: deskBrowserMcpUrl() } },
    }),
  )
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
  expect(res.browser.action).toBe('unchanged')
  expect(res.browser.registered).toBe(true)
  expect(res.browser.error).toBeNull()
  expect(mcpRegistrationStatus({ daemonUrl: URL_, configPath }).browser.error).toBeNull()
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

// 2026-10-03: a side-run on 7801 rewrote the machine-wide ~/.claude.json every minute, fighting the
// primary daemon for the `agenthydra` key, so Claude sessions started in its minutes got tools from
// the scratch store. A daemon that is not the primary install must leave another daemon's entry alone.
test('a side-run reasserter leaves the other daemon entry in the machine config untouched', () => {
  const configPath = join(scratch(), '.claude.json')
  const other = `${JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { type: 'http', url: `${URL_}/api/mcp` } } }, null, 2)}
`
  writeFileSync(configPath, other)
  const reasserter = createMcpReasserter({
    daemonUrl: () => 'http://127.0.0.1:7801',
    configPath,
    primary: false,
    env: {},
  })
  const res = reasserter.run(true)
  expect(res?.action).toBe('side-run')
  expect(res?.error).toBeNull()
  expect(readFileSync(configPath, 'utf8')).toBe(other)
})

// A side-run that names its own file (AGENTHYDRA_MCP_CONFIG) is not touching the machine's.
test('a side-run with its own AGENTHYDRA_MCP_CONFIG still registers into that file', () => {
  const configPath = join(scratch(), 'own.json')
  const res = syncMcpRegistration({
    daemonUrl: 'http://127.0.0.1:7801',
    enabled: true,
    configPath,
    primary: false,
    env: { AGENTHYDRA_MCP_CONFIG: configPath },
  })
  expect(res.action).toBe('added')
  expect(read(configPath)).toEqual({
    mcpServers: {
      [MCP_SERVER_KEY]: { type: 'http', url: 'http://127.0.0.1:7801/api/mcp' },
      [MCP_BROWSER_KEY]: { type: 'http', url: DESK },
    },
  })
})

// 2026-10-06: scripts/smoke-release.ts started a throwaway daemon with a scratch AGENTHYDRA_HOME
// from inside a CliMayte worker, whose env carries CLAUDE_CONFIG_DIR=<an account's dir>. The scratch
// store sits inside that config dir's reach, so the daemon counted as primary and wrote its random
// port into the account's real .claude.json; the entry outlived the daemon. A relocated home with
// no AGENTHYDRA_MCP_CONFIG of its own must never reach an inherited config.
test('a relocated AGENTHYDRA_HOME never writes into an inherited CLAUDE_CONFIG_DIR', () => {
  const account = scratch()
  const configPath = join(account, '.claude.json')
  const res = syncMcpRegistration({
    daemonUrl: 'http://127.0.0.1:59714',
    enabled: true,
    primary: true,
    env: { AGENTHYDRA_HOME: join(scratch(), 'state'), CLAUDE_CONFIG_DIR: account },
  })
  expect(res.action).toBe('side-run')
  expect(existsSync(configPath)).toBe(false)
})

const DESK = 'http://127.0.0.1:7798/mcp/browser'
const FOREIGN_BROWSER = { type: 'stdio', command: 'example-browser', args: ['--serve'] }
const OUR_AGENTHYDRA = { type: 'http', url: `${URL_}/api/mcp` }

test('the browser entry is added beside the agenthydra entry, and a second run changes nothing', () => {
  const configPath = join(scratch(), '.claude.json')
  const first = syncMcpRegistration({ daemonUrl: URL_, deskUrl: DESK, enabled: true, configPath })
  expect(first.browser.action).toBe('added')
  expect(first.browser.registered).toBe(true)
  expect(first.browser.conflict).toBeNull()
  const before = readFileSync(configPath, 'utf8')
  const second = syncMcpRegistration({ daemonUrl: URL_, deskUrl: DESK, enabled: true, configPath })
  expect(second.action).toBe('unchanged')
  expect(second.browser.action).toBe('unchanged')
  expect(readFileSync(configPath, 'utf8')).toBe(before)
})

test('a desk port change rewrites the browser URL', () => {
  const configPath = join(scratch(), '.claude.json')
  syncMcpRegistration({ daemonUrl: URL_, deskUrl: DESK, enabled: true, configPath })
  const res = syncMcpRegistration({
    daemonUrl: URL_,
    deskUrl: 'http://127.0.0.1:7800/mcp/browser',
    enabled: true,
    configPath,
  })
  expect(res.browser.action).toBe('updated')
  const servers = read(configPath).mcpServers as Record<string, unknown>
  expect(servers[MCP_BROWSER_KEY]).toEqual({
    type: 'http',
    url: 'http://127.0.0.1:7800/mcp/browser',
  })
})

test('a foreign browser server is kept byte for byte and reported as a conflict', () => {
  const configPath = join(scratch(), '.claude.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: { [MCP_SERVER_KEY]: OUR_AGENTHYDRA, [MCP_BROWSER_KEY]: FOREIGN_BROWSER },
    }),
  )
  const before = readFileSync(configPath, 'utf8')
  const res = syncMcpRegistration({ daemonUrl: URL_, deskUrl: DESK, enabled: true, configPath })
  expect(res.browser.action).toBe('conflict')
  expect(res.browser.registered).toBe(false)
  expect(res.browser.conflict).not.toBeNull()
  expect(res.browser.error).toBeNull()
  expect(readFileSync(configPath, 'utf8')).toBe(before)
})

test('a foreign browser server does not stop the agenthydra entry from being added', () => {
  const configPath = join(scratch(), '.claude.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers: { [MCP_BROWSER_KEY]: FOREIGN_BROWSER } }))
  const res = syncMcpRegistration({ daemonUrl: URL_, deskUrl: DESK, enabled: true, configPath })
  expect(res.action).toBe('added')
  expect(res.browser.action).toBe('conflict')
  const servers = read(configPath).mcpServers as Record<string, unknown>
  expect(servers[MCP_SERVER_KEY]).toEqual(OUR_AGENTHYDRA)
  expect(servers[MCP_BROWSER_KEY]).toEqual(FOREIGN_BROWSER)
})

test('turning it off removes our browser entry and keeps the other servers', () => {
  const configPath = join(scratch(), '.claude.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { type: 'stdio' } } }))
  syncMcpRegistration({ daemonUrl: URL_, deskUrl: DESK, enabled: true, configPath })
  const res = syncMcpRegistration({ daemonUrl: URL_, deskUrl: DESK, enabled: false, configPath })
  expect(res.browser.action).toBe('removed')
  expect(res.browser.registered).toBe(false)
  const servers = read(configPath).mcpServers as Record<string, unknown>
  expect(servers[MCP_BROWSER_KEY]).toBeUndefined()
  expect(servers[MCP_SERVER_KEY]).toBeUndefined()
  expect(servers.other).toEqual({ type: 'stdio' })
})

test('turning it off keeps a foreign browser server', () => {
  const configPath = join(scratch(), '.claude.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers: { [MCP_BROWSER_KEY]: FOREIGN_BROWSER } }))
  syncMcpRegistration({ daemonUrl: URL_, deskUrl: DESK, enabled: true, configPath })
  syncMcpRegistration({ daemonUrl: URL_, deskUrl: DESK, enabled: false, configPath })
  const servers = read(configPath).mcpServers as Record<string, unknown>
  expect(servers[MCP_SERVER_KEY]).toBeUndefined()
  expect(servers[MCP_BROWSER_KEY]).toEqual(FOREIGN_BROWSER)
})

test('a side-run sync writes nothing to the machine config, browser entry included', () => {
  const configPath = join(scratch(), '.claude.json')
  const before = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`
  writeFileSync(configPath, before)
  const res = syncMcpRegistration({
    daemonUrl: 'http://127.0.0.1:7801',
    deskUrl: DESK,
    enabled: true,
    configPath,
    primary: false,
    env: {},
  })
  expect(res.action).toBe('side-run')
  expect(readFileSync(configPath, 'utf8')).toBe(before)
})

test('a relocated AGENTHYDRA_HOME with its own AGENTHYDRA_MCP_CONFIG still registers there', () => {
  const configPath = join(scratch(), 'own.json')
  const res = syncMcpRegistration({
    daemonUrl: 'http://127.0.0.1:59714',
    enabled: true,
    primary: true,
    env: {
      AGENTHYDRA_HOME: join(scratch(), 'state'),
      CLAUDE_CONFIG_DIR: scratch(),
      AGENTHYDRA_MCP_CONFIG: configPath,
    },
  })
  expect(res.action).toBe('added')
})

// A real install may live outside ~/.agenthydra (docs/REFERENCE.md, install.ps1 honour a relocated
// AGENTHYDRA_HOME). With no inherited CLAUDE_CONFIG_DIR its target is the user's own ~/.claude.json,
// which is exactly where it must keep registering.
test('a relocated AGENTHYDRA_HOME with no CLAUDE_CONFIG_DIR still registers into ~/.claude.json', () => {
  const home = scratch()
  const env = { AGENTHYDRA_HOME: join(home, 'agenthydra') }
  const wrote: string[] = []
  // The write is stubbed: the target here is the machine's real ~/.claude.json, never to be touched.
  const res = syncMcpRegistration(
    { daemonUrl: 'http://127.0.0.1:7799', enabled: true, primary: true, env },
    { writeConfig: (path) => void wrote.push(path) },
  )
  expect(res.action).not.toBe('side-run')
  expect(wrote).toEqual([claudeCodeConfigPath(env)])
})
