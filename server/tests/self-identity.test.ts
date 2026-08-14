// server/tests/self-identity.test.ts — "which instance am I?" (server/src/core/self-identity.ts).
//
// The env fixtures below are REAL captures from a live Claude Desktop session on 2026-08-13, taken
// from two places at once: a Bash-tool child process and a stdio MCP server spawned by the same
// agent. They differ, and that difference is the entire bug — see DESKTOP_MCP_ENV.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  type AncestorProcess,
  describeSelfIdentity,
  detectSelfIdentity,
  looksLikeUserDataDir,
  type SelfIdentityDeps,
  userDataDirFromAgentExe,
  userDataDirFromCommandLine,
} from '../src/core/self-identity'

const INSTANCES_ROOT = join('C:', 'Users', 'blogi', '.claude-instances')
const INSTANCE_DIR = join(INSTANCES_ROOT, 'pap3r rotate')
const OTHER_INSTANCE_DIR = join(INSTANCES_ROOT, 'work')
const DEFAULT_DESKTOP_DIR = join('C:', 'Users', 'blogi', 'AppData', 'Roaming', 'Claude')
const DEFAULT_LOGIN_DIR = join('C:', 'Users', 'blogi', '.claude')
const HOST_SESSION_ID = 'local_cfb0838f-c8f3-4b2d-a812-26bf719b10e2'

/** The env a stdio MCP server actually sees inside a Claude Desktop session. Note what is NOT
 *  here: CLAUDE_CONFIG_DIR (a Desktop instance never sets it) and CLAUDE_CODE_EXECPATH (the Bash
 *  tool's children get it; an MCP server does not). Detection has to work from what is left. */
const DESKTOP_MCP_ENV = {
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
  CLAUDE_CODE_SESSION_ID: 'cd2dee6f-d11d-4bd6-a295-c18a07c6166f',
  CLAUDE_CODE_HOST_SESSION_ID: HOST_SESSION_ID,
}

/** A fake filesystem: a set of files/dirs that exist, plus each directory's child directories. */
function fakeFs(opts: { files?: string[]; dirs?: Record<string, string[]> }) {
  const files = new Set(opts.files ?? [])
  const dirs = opts.dirs ?? {}
  return {
    exists: (p: string) => files.has(p) || p in dirs,
    readDir: (p: string) => dirs[p] ?? null,
  }
}

/** A user-data dir is only accepted when it carries a Claude marker file, so every fixture that
 *  should resolve has to provide one. */
const marker = (dir: string) => join(dir, 'config.json')

function deps(over: Partial<SelfIdentityDeps> = {}): SelfIdentityDeps {
  return {
    env: {},
    exists: () => false,
    readDir: () => null,
    ancestry: async () => [],
    instancesRoot: () => INSTANCES_ROOT,
    defaultUserDataDir: () => DEFAULT_DESKTOP_DIR,
    defaultConfigDir: () => DEFAULT_LOGIN_DIR,
    ...over,
  }
}

describe('userDataDirFromAgentExe', () => {
  test('derives the instance dir from an isolated instance agent binary', () => {
    expect(
      userDataDirFromAgentExe(join(INSTANCE_DIR, 'claude-code', '2.1.227', 'claude.exe')),
    ).toBe(INSTANCE_DIR)
  })

  test('derives the default install dir the same way', () => {
    expect(
      userDataDirFromAgentExe(join(DEFAULT_DESKTOP_DIR, 'claude-code', '2.1.227', 'claude.exe')),
    ).toBe(DEFAULT_DESKTOP_DIR)
  })

  test('returns null for a binary that is not under a claude-code folder', () => {
    // A globally-installed CLI is not an instance and must never be guessed into one.
    expect(userDataDirFromAgentExe(join('C:', 'Program Files', 'nodejs', 'claude.exe'))).toBeNull()
    expect(userDataDirFromAgentExe('')).toBeNull()
  })

  test('handles forward slashes and a leading claude-code segment', () => {
    expect(userDataDirFromAgentExe('C:/x/inst/claude-code/2.1.227/claude.exe')).toBe(
      join('C:', 'x', 'inst'),
    )
    // idx === 0 → nothing above it to be an instance dir.
    expect(userDataDirFromAgentExe('claude-code/2.1.227/claude.exe')).toBeNull()
  })
})

describe('userDataDirFromCommandLine', () => {
  test('parses all three Windows quotings', () => {
    expect(userDataDirFromCommandLine('claude.exe --user-data-dir=C:\\nospace\\x')).toBe(
      'C:\\nospace\\x',
    )
    expect(userDataDirFromCommandLine('claude.exe --user-data-dir="C:\\a b\\x"')).toBe('C:\\a b\\x')
    expect(userDataDirFromCommandLine('"claude.exe" "--user-data-dir=C:\\a b\\x"')).toBe(
      'C:\\a b\\x',
    )
  })

  test('returns null when the flag is absent', () => {
    expect(userDataDirFromCommandLine('claude.exe --output-format stream-json')).toBeNull()
  })
})

describe('looksLikeUserDataDir', () => {
  test('accepts a dir carrying either Claude marker, rejects a bare folder', () => {
    const withConfig = fakeFs({ files: [join(INSTANCE_DIR, 'config.json')] })
    const withLocalState = fakeFs({ files: [join(INSTANCE_DIR, 'Local State')] })
    expect(looksLikeUserDataDir(INSTANCE_DIR, withConfig.exists)).toBe(true)
    expect(looksLikeUserDataDir(INSTANCE_DIR, withLocalState.exists)).toBe(true)
    expect(looksLikeUserDataDir(INSTANCE_DIR, () => false)).toBe(false)
  })
})

describe('detectSelfIdentity — env signals', () => {
  test('CODEX_HOME identifies a Codex instance', async () => {
    const got = await detectSelfIdentity(deps({ env: { CODEX_HOME: 'C:\\codex' } }))
    expect(got).toMatchObject({
      configDir: 'C:\\codex',
      kind: 'codex',
      method: 'codex-home-env',
      confidence: 'exact',
    })
  })

  test('CLAUDE_CONFIG_DIR identifies a CLI instance', async () => {
    const got = await detectSelfIdentity(
      deps({ env: { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: 'C:\\cli-7' } }),
    )
    expect(got).toMatchObject({
      configDir: 'C:\\cli-7',
      kind: 'cli',
      method: 'claude-config-dir-env',
      confidence: 'exact',
    })
  })

  test('CLAUDE_CONFIG_DIR beats a desktop ancestor — a CLI launched inside a Desktop terminal still bills to its own login', async () => {
    const fs = fakeFs({ files: [marker(INSTANCE_DIR)] })
    const got = await detectSelfIdentity(
      deps({
        env: { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: 'C:\\cli-7' },
        ...fs,
        ancestry: async () => [
          {
            pid: 2,
            name: 'claude.exe',
            executablePath: null,
            commandLine: `--user-data-dir=${INSTANCE_DIR}`,
          },
        ],
      }),
    )
    expect(got.configDir).toBe('C:\\cli-7')
    expect(got.kind).toBe('cli')
    // …and the expensive walk was never made, because a cheaper signal already answered.
    expect(got.ruledOut.some((r) => r.includes('not walked'))).toBe(true)
  })

  test('CLAUDE_CODE_EXECPATH identifies the desktop instance that owns the agent binary', async () => {
    const fs = fakeFs({ files: [marker(INSTANCE_DIR)] })
    const got = await detectSelfIdentity(
      deps({
        env: {
          CLAUDECODE: '1',
          CLAUDE_CODE_EXECPATH: join(INSTANCE_DIR, 'claude-code', '2.1.227', 'claude.exe'),
        },
        ...fs,
      }),
    )
    expect(got).toMatchObject({
      configDir: INSTANCE_DIR,
      kind: 'desktop',
      method: 'execpath-env',
      confidence: 'exact',
    })
  })

  test('an EXECPATH pointing at a dir with no Claude marker is rejected, with a reason', async () => {
    const got = await detectSelfIdentity(
      deps({
        env: {
          CLAUDECODE: '1',
          CLAUDE_CODE_EXECPATH: join(INSTANCE_DIR, 'claude-code', '2.1.227', 'claude.exe'),
        },
      }),
    )
    expect(got.method).toBe('default-login')
    expect(got.ruledOut.some((r) => r.includes('not a Claude user-data dir'))).toBe(true)
  })
})

describe('detectSelfIdentity — the Claude Desktop MCP case (the regression)', () => {
  const fs = fakeFs({
    files: [
      marker(INSTANCE_DIR),
      join(INSTANCE_DIR, 'claude-code-sessions'),
      join(INSTANCE_DIR, 'claude-code-sessions', 'a', 'b', `${HOST_SESSION_ID}.json`),
    ],
    dirs: {
      [INSTANCES_ROOT]: ['pap3r rotate', 'work'],
      [join(INSTANCE_DIR, 'claude-code-sessions')]: ['a'],
      [join(INSTANCE_DIR, 'claude-code-sessions', 'a')]: ['b'],
      [join(INSTANCE_DIR, 'claude-code-sessions', 'a', 'b')]: [],
    },
  })

  test('finds the instance by the session file it owns, with NO env dir and NO process walk', async () => {
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...fs, ancestry: async () => null }),
    )
    expect(got).toMatchObject({
      configDir: INSTANCE_DIR,
      kind: 'desktop',
      method: 'host-session-file',
      confidence: 'exact',
      conflict: false,
    })
    // The proof is the actual file, so a human can go look at it.
    expect(got.clues[0]?.proof).toBe(
      join(INSTANCE_DIR, 'claude-code-sessions', 'a', 'b', `${HOST_SESSION_ID}.json`),
    )
  })

  test('THE OLD BUG: this env must NOT resolve to the default ~/.claude login', async () => {
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...fs, ancestry: async () => null }),
    )
    expect(got.configDir).not.toBe(DEFAULT_LOGIN_DIR)
    expect(got.kind).not.toBe('default-login')
  })

  test('falls through to the process tree when no instance holds the session file', async () => {
    const bare = fakeFs({ files: [marker(INSTANCE_DIR)], dirs: { [INSTANCES_ROOT]: [] } })
    const chain: AncestorProcess[] = [
      {
        pid: 77928,
        name: 'node.exe',
        executablePath: 'C:\\Program Files\\nodejs\\node.exe',
        commandLine: 'node loader.mjs',
      },
      {
        pid: 76040,
        name: 'claude.exe',
        executablePath: join(INSTANCE_DIR, 'claude-code', '2.1.227', 'claude.exe'),
        commandLine: 'claude.exe --output-format stream-json',
      },
    ]
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...bare, ancestry: async () => chain }),
    )
    expect(got).toMatchObject({
      configDir: INSTANCE_DIR,
      kind: 'desktop',
      method: 'ancestor-execpath',
      confidence: 'exact',
    })
    expect(got.clues[0]?.proof).toContain('76040')
  })

  test('reads the Electron host’s --user-data-dir when the agent binary path is unavailable', async () => {
    const bare = fakeFs({ files: [marker(INSTANCE_DIR)], dirs: { [INSTANCES_ROOT]: [] } })
    const chain: AncestorProcess[] = [
      {
        pid: 76172,
        name: 'claude.exe',
        executablePath:
          'C:\\Users\\blogi\\AppData\\Local\\AnthropicClaude\\app-1.28929.0\\claude.exe',
        commandLine: `"claude.exe" "--user-data-dir=${INSTANCE_DIR}"`,
      },
    ]
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...bare, ancestry: async () => chain }),
    )
    expect(got).toMatchObject({
      configDir: INSTANCE_DIR,
      kind: 'desktop',
      method: 'ancestor-user-data-dir',
      confidence: 'exact',
    })
  })

  test('an unenumerable process tree is reported as such, not silently ignored', async () => {
    const bare = fakeFs({ dirs: { [INSTANCES_ROOT]: [] } })
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...bare, ancestry: async () => null }),
    )
    expect(got.confidence).toBe('assumed')
    expect(got.ruledOut.some((r) => r.includes('could not be enumerated'))).toBe(true)
  })
})

describe('detectSelfIdentity — honesty about what it does not know', () => {
  test('the default login is ASSUMED, never exact', async () => {
    const got = await detectSelfIdentity(deps({ env: { CLAUDECODE: '1' } }))
    expect(got).toMatchObject({
      configDir: DEFAULT_LOGIN_DIR,
      kind: 'default-login',
      method: 'default-login',
      confidence: 'assumed',
    })
  })

  test('outside Claude Code entirely, it refuses to guess', async () => {
    const got = await detectSelfIdentity(deps({ env: {} }))
    expect(got).toMatchObject({ configDir: null, kind: 'unknown', confidence: 'none' })
  })

  test('two signals naming different dirs raise conflict, and the winner is still the top one', async () => {
    const fs = fakeFs({
      files: [
        marker(OTHER_INSTANCE_DIR),
        join(OTHER_INSTANCE_DIR, 'claude-code-sessions'),
        join(OTHER_INSTANCE_DIR, 'claude-code-sessions', `${HOST_SESSION_ID}.json`),
      ],
      dirs: {
        [INSTANCES_ROOT]: ['work'],
        [join(OTHER_INSTANCE_DIR, 'claude-code-sessions')]: [],
      },
    })
    const got = await detectSelfIdentity(
      deps({ env: { ...DESKTOP_MCP_ENV, CLAUDE_CONFIG_DIR: 'C:\\cli-7' }, ...fs }),
    )
    expect(got.configDir).toBe('C:\\cli-7')
    expect(got.conflict).toBe(true)
    expect(got.clues).toHaveLength(2)
  })

  test('ruledOut explains every signal that came up empty', async () => {
    const got = await detectSelfIdentity(deps({ env: { CLAUDECODE: '1' } }))
    const joined = got.ruledOut.join('\n')
    expect(joined).toContain('CODEX_HOME')
    expect(joined).toContain('CLAUDE_CONFIG_DIR')
    expect(joined).toContain('CLAUDE_CODE_EXECPATH')
    expect(joined).toContain('CLAUDE_CODE_HOST_SESSION_ID')
  })
})

describe('describeSelfIdentity', () => {
  const detection = {
    configDir: INSTANCE_DIR,
    kind: 'desktop' as const,
    method: 'host-session-file' as const,
    confidence: 'exact' as const,
    clues: [],
    ruledOut: [],
    conflict: false,
  }

  test('names the instance, the account and how it was established', () => {
    expect(
      describeSelfIdentity(detection, {
        num: 11,
        name: 'pap3r rotate',
        email: 'someone@example.com',
        plan: 'Pro',
      }),
    ).toBe('instance #11 (pap3r rotate) — someone@example.com · Pro [exact: host-session-file]')
  })

  test('says so plainly when there is no instance behind the dir', () => {
    expect(describeSelfIdentity(detection, null)).toContain('unmanaged desktop credential dir')
  })

  test('distinguishes the default login from an unidentified process', () => {
    expect(
      describeSelfIdentity(
        { ...detection, kind: 'default-login', method: 'default-login', confidence: 'assumed' },
        null,
      ),
    ).toContain('Not a managed instance')
    expect(
      describeSelfIdentity(
        { ...detection, configDir: null, kind: 'unknown', method: null, confidence: 'none' },
        null,
      ),
    ).toContain('Could not identify')
  })
})
