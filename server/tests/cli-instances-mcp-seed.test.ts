// server/tests/cli-instances-mcp-seed.test.ts — a new CLI instance inherits the user's MCP servers.
//
// `CLAUDE_CONFIG_DIR` isolates a CLI instance COMPLETELY: Claude Code does not fall back to
// `~/.claude.json` for a redirected config dir, so an instance created as a bare `mkdir` has zero
// MCP servers and keeps zero forever. Found 2026-09-16 on a real install: an instance sat at
// `mcpServers: {}` while the user's own config carried five, so a session launched into it had none
// of the tooling every other session on that machine had. It looked healthy and was quietly blind.
//
// What the seed must NOT do is the other half of the contract: logins are the user's (an OAuth flow
// an AI must never perform) and folder trust is `ensureProjectTrusted`'s deliberate per-folder job.
// So the seeded file carries `mcpServers` and nothing else.
//
// `os.homedir()` reads USERPROFILE/HOME at call time, so each test points it at a scratch home and
// restores it. CONFIG_DIR is already redirected to a temp dir by tests/setup.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCliInstance, deleteCliInstance } from '../src/core/cli-instances'

/** id + name, because deleteCliInstance REFUSES without a confirmName that matches exactly. Passing
 *  the id alone leaves the dir on disk, and a later file's reconcile then reports it as an orphan. */
const created: Array<{ id: string; name: string }> = []
let scratchHome: string
let savedHome: string | undefined
let savedUserProfile: string | undefined

/** Point `os.homedir()` at a scratch dir holding `config` as the user's ~/.claude.json. */
function withUserConfig(config: Record<string, unknown> | null): void {
  if (config) writeFileSync(join(scratchHome, '.claude.json'), JSON.stringify(config, null, 2))
}

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), 'ah-seed-home-'))
  mkdirSync(scratchHome, { recursive: true })
  savedHome = process.env.HOME
  savedUserProfile = process.env.USERPROFILE
  process.env.HOME = scratchHome
  process.env.USERPROFILE = scratchHome
})

afterEach(() => {
  for (const { id, name } of created.splice(0)) {
    expect(deleteCliInstance(id, name).ok).toBe(true)
  }
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  if (savedUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedUserProfile
})

/** Create an instance and return the path of the `.claude.json` it should have been seeded with. */
function makeInstance(name: string): string {
  const result = createCliInstance(name)
  expect(result.ok).toBe(true)
  created.push({ id: result.data?.id as string, name })
  return join(result.dir as string, '.claude.json')
}

describe('a new CLI instance inherits the user MCP servers', () => {
  test('copies every server from the user config', () => {
    withUserConfig({
      mcpServers: {
        zswarm: { type: 'stdio', command: 'python', args: ['zswarm.py', 'mcp'] },
        codegraph: { type: 'stdio', command: 'codegraph', args: ['mcp'] },
      },
    })
    const file = makeInstance('seeded')
    expect(existsSync(file)).toBe(true)
    const seeded = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(seeded.mcpServers).sort()).toEqual(['codegraph', 'zswarm'])
    expect(seeded.mcpServers.zswarm.args).toEqual(['zswarm.py', 'mcp'])
  })

  test('carries mcpServers ONLY — never logins, trust or onboarding state', () => {
    withUserConfig({
      mcpServers: { zswarm: { type: 'stdio', command: 'python' } },
      oauthAccount: { emailAddress: 'owner@example.com' },
      projects: { 'C:/secret': { hasTrustDialogAccepted: true } },
      hasCompletedOnboarding: true,
      userID: 'should-not-travel',
    })
    const seeded = JSON.parse(readFileSync(makeInstance('minimal'), 'utf8'))
    expect(Object.keys(seeded)).toEqual(['mcpServers'])
  })

  test('writes nothing when the user has no servers to give', () => {
    withUserConfig({ mcpServers: {}, hasCompletedOnboarding: true })
    expect(existsSync(makeInstance('empty-servers'))).toBe(false)
  })

  test('writes nothing when there is no user config at all', () => {
    withUserConfig(null)
    expect(existsSync(makeInstance('no-config'))).toBe(false)
  })
})
