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

const INSTANCES_ROOT = join('C:', 'Users', 'me', '.claude-instances')
const INSTANCE_DIR = join(INSTANCES_ROOT, 'pap3r rotate')
const OTHER_INSTANCE_DIR = join(INSTANCES_ROOT, 'work')
const DEFAULT_DESKTOP_DIR = join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Claude')
const DEFAULT_LOGIN_DIR = join('C:', 'Users', 'me', '.claude')
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
    // Every test defaults the chat-store cross-check to "nothing else claims this session" -
    // never the REAL collectChats, which would walk the operator's actual ~/.claude-instances
    // tree. Tests that exercise the cross-check itself override this explicitly.
    collectChats: () => [],
    ...over,
  }
}

/** A minimal DossierChat for the chat-store cross-check tests - only the fields lineageIdsOf
 *  actually reads vary per test; everything else is a fixed, inert default. */
function fakeChat(over: Partial<import('../src/core/chat-store-scan').DossierChat>) {
  return {
    instance: 'unset',
    metaPath: 'unset',
    metaMtime: null,
    chatId: null,
    cliSessionId: null,
    priorCliSessionIds: [],
    title: null,
    cwd: null,
    createdAt: null,
    lastActivityAt: null,
    archived: false,
    isArchived: false,
    permissionMode: null,
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

describe('detectSelfIdentity — a MIGRATED session (the same file in more than one instance)', () => {
  // THE SECOND REGRESSION (2026-09-01). A chat that has been migrated leaves its claude-code-sessions
  // file behind in every home it has had. An Orchestrate chat moved pap3r rotate2 -> funzypops ->
  // temp1 was reported as funzypops for HOURS, because the scan returned the first directory holding
  // the file and 'funzypops' sorts before 'temp1'. Every quota decision it made that day read the
  // wrong meter - it kept seeing a weekly of 0% that was real and belonged to someone else.
  const STALE_DIR = join(INSTANCES_ROOT, 'funzypops')
  const LIVE_DIR = join(INSTANCES_ROOT, 'temp1')
  const staleFile = join(STALE_DIR, 'claude-code-sessions', 'a', 'b', `${HOST_SESSION_ID}.json`)
  const liveFile = join(LIVE_DIR, 'claude-code-sessions', 'c', 'd', `${HOST_SESSION_ID}.json`)
  const fs = fakeFs({
    files: [marker(STALE_DIR), marker(LIVE_DIR), staleFile, liveFile],
    dirs: {
      [INSTANCES_ROOT]: ['funzypops', 'temp1'],
      [join(STALE_DIR, 'claude-code-sessions')]: ['a'],
      [join(STALE_DIR, 'claude-code-sessions', 'a')]: ['b'],
      [join(STALE_DIR, 'claude-code-sessions', 'a', 'b')]: [],
      [join(LIVE_DIR, 'claude-code-sessions')]: ['c'],
      [join(LIVE_DIR, 'claude-code-sessions', 'c')]: ['d'],
      [join(LIVE_DIR, 'claude-code-sessions', 'c', 'd')]: [],
    },
  })

  test('the NEWEST session file wins, not the first directory alphabetically', async () => {
    const mtimeMs = (p: string) => (p === liveFile ? 2_000 : p === staleFile ? 1_000 : null)
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...fs, mtimeMs, ancestry: async () => null }),
    )
    expect(got.configDir).toBe(LIVE_DIR)
    expect(got.method).toBe('host-session-file')
    expect(got.clues[0]?.proof).toBe(liveFile)
    // The choice is recorded, naming what was passed over - never a silent pick.
    expect(got.disambiguated).toContain('funzypops')
    expect(got.ruledOut.some((r) => r.includes('newest file'))).toBe(true)
  })

  test('the OLD BUG, pinned: alphabetical order alone must never decide it', async () => {
    // Same fixture, but the STALE copy is the newer file - the answer has to follow the
    // timestamp, proving directory order is not what is being consulted.
    const mtimeMs = (p: string) => (p === staleFile ? 2_000 : p === liveFile ? 1_000 : null)
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...fs, mtimeMs, ancestry: async () => null }),
    )
    expect(got.configDir).toBe(STALE_DIR)
  })

  test('with no timestamps to tell them apart it still answers, but says AMBIGUOUS', async () => {
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...fs, mtimeMs: () => null, ancestry: async () => null }),
    )
    expect(got.method).toBe('host-session-file')
    expect(got.disambiguated).toMatch(/AMBIGUOUS/)
  })

  test('a UNIQUE holder is untouched by any of this - no note, no disambiguation', async () => {
    const one = fakeFs({
      files: [marker(LIVE_DIR), liveFile],
      dirs: {
        [INSTANCES_ROOT]: ['temp1'],
        [join(LIVE_DIR, 'claude-code-sessions')]: ['c'],
        [join(LIVE_DIR, 'claude-code-sessions', 'c')]: ['d'],
        [join(LIVE_DIR, 'claude-code-sessions', 'c', 'd')]: [],
      },
    })
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...one, ancestry: async () => null }),
    )
    expect(got.configDir).toBe(LIVE_DIR)
    expect(got.disambiguated).toBeUndefined()
  })
})

describe('detectSelfIdentity — a STALE filename hit vs. the chat store (filed 2026-09-07)', () => {
  // THE THIRD REGRESSION. Unlike the 2026-09-01 fixture above (the SAME filename copied to both
  // homes, so mtime disambiguates it), a chat moved through /import-desktop gets a BRAND NEW
  // filename at its new home and records the old id only inside `priorCliSessionIds` - so the
  // filename-only scan finds just the ONE stale copy at the OLD instance and never even sees the
  // new home. A real whoami call answered instance #12 (stale) with confidence "exact" while the
  // session actually ran on #5; a `move_chats { to: "here" }` then landed three chats on the wrong
  // account. bareId strips HOST_SESSION_ID's 'local_' prefix the same way lineageIdsOf does.
  const STALE_DIR = join(INSTANCES_ROOT, 'pap3r rotate2')
  const LIVE_DIR = join(INSTANCES_ROOT, '5claude')
  const bareId = HOST_SESSION_ID.slice('local_'.length)
  const staleFile = join(STALE_DIR, 'claude-code-sessions', 'a', 'b', `${HOST_SESSION_ID}.json`)
  const fs = fakeFs({
    files: [marker(STALE_DIR), marker(LIVE_DIR), staleFile],
    dirs: {
      [INSTANCES_ROOT]: ['pap3r rotate2', '5claude'],
      [join(STALE_DIR, 'claude-code-sessions')]: ['a'],
      [join(STALE_DIR, 'claude-code-sessions', 'a')]: ['b'],
      [join(STALE_DIR, 'claude-code-sessions', 'a', 'b')]: [],
      // 5claude holds NO file named after HOST_SESSION_ID at all - only its own metadata file,
      // under a different name, records the old id (via collectChats below, not the filesystem).
      [join(LIVE_DIR, 'claude-code-sessions')]: [],
    },
  })

  test('a unique filename hit is downgraded to assumed when the store names a DIFFERENT owner', async () => {
    const collectChats = () => [
      fakeChat({ instance: STALE_DIR, chatId: `local_${bareId}` }),
      fakeChat({
        instance: LIVE_DIR,
        chatId: 'local_33882364-a521-4713-bcc2-ef3b7e792a85',
        cliSessionId: '33882364-a521-4713-bcc2-ef3b7e792a85',
        priorCliSessionIds: [bareId],
      }),
    ]
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...fs, collectChats, ancestry: async () => null }),
    )
    // The file hit is still what is RETURNED (never silently swapped for the store's guess) -
    // but it must never be reported with total confidence again.
    expect(got.configDir).toBe(STALE_DIR)
    expect(got.method).toBe('host-session-file')
    expect(got.confidence).toBe('assumed')
    expect(got.storeConflict).toContain(LIVE_DIR)
    expect(got.ruledOut.some((r) => r.includes('CONFLICT') && r.includes(LIVE_DIR))).toBe(true)
  })

  test('agreement: the store confirms the SAME owner - stays exact, no conflict noise', async () => {
    const collectChats = () => [fakeChat({ instance: STALE_DIR, chatId: `local_${bareId}` })]
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...fs, collectChats, ancestry: async () => null }),
    )
    expect(got.configDir).toBe(STALE_DIR)
    expect(got.confidence).toBe('exact')
    expect(got.storeConflict).toBeUndefined()
  })

  test('a store conflict on a signal that did NOT win never downgrades the real winner', async () => {
    // CLAUDE_CONFIG_DIR (stage 2) answers first; the host-session-file conflict below is real but
    // irrelevant, because nothing ever acted on that clue.
    const collectChats = () => [
      fakeChat({ instance: STALE_DIR, chatId: `local_${bareId}` }),
      fakeChat({ instance: LIVE_DIR, priorCliSessionIds: [bareId] }),
    ]
    const got = await detectSelfIdentity(
      deps({
        env: { ...DESKTOP_MCP_ENV, CLAUDE_CONFIG_DIR: 'C:\\cli-7' },
        ...fs,
        collectChats,
        ancestry: async () => null,
      }),
    )
    expect(got.configDir).toBe('C:\\cli-7')
    expect(got.confidence).toBe('exact')
    expect(got.storeConflict).toBeUndefined()
  })

  test('no chat-store signal at all (e.g. an unreadable file) leaves the filename hit untouched', async () => {
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...fs, collectChats: () => [], ancestry: async () => null }),
    )
    expect(got.configDir).toBe(STALE_DIR)
    expect(got.confidence).toBe('exact')
    expect(got.storeConflict).toBeUndefined()
  })
})

describe('detectSelfIdentity — a FROZEN host-session env pointing at a DEAD chat (filed 2026-09-08)', () => {
  // THE FOURTH REGRESSION, and the one the 2026-09-07 storeConflict guard cannot catch. The
  // AgentHydra MCP server is long-lived and shared: its CLAUDE_CODE_HOST_SESSION_ID froze to the
  // chat that STARTED it (a #12 chat), which has since been ARCHIVED. A live #5 chat then called
  // whoami; the frozen id has NO lineage link to that caller, so no cross-check can connect them —
  // but the chat it names being ARCHIVED proves the env is stale (a live caller's own session is
  // never archived). whoami answered #12 "exact" and `move_chats { to: "here" }` landed 13 chats on
  // the wrong account (#5's chats landed on #12) before the operator caught it.
  const HOST_DIR = join(INSTANCES_ROOT, 'pap3r rotate2')
  const bareId = HOST_SESSION_ID.slice('local_'.length)
  const hostFile = join(HOST_DIR, 'claude-code-sessions', 'a', 'b', `${HOST_SESSION_ID}.json`)
  const fs = fakeFs({
    files: [marker(HOST_DIR), hostFile],
    dirs: {
      [INSTANCES_ROOT]: ['pap3r rotate2'],
      [join(HOST_DIR, 'claude-code-sessions')]: ['a'],
      [join(HOST_DIR, 'claude-code-sessions', 'a')]: ['b'],
      [join(HOST_DIR, 'claude-code-sessions', 'a', 'b')]: [],
    },
  })

  test('an ARCHIVED host-session chat downgrades a unique filename hit to assumed', async () => {
    const collectChats = () => [
      fakeChat({
        instance: HOST_DIR,
        chatId: `local_${bareId}`,
        cliSessionId: bareId,
        archived: true,
        isArchived: true,
        title: 'a chat that was archived long before this call',
      }),
    ]
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...fs, collectChats, ancestry: async () => null }),
    )
    // The file hit is still what is RETURNED — never silently swapped — but never "exact" again.
    expect(got.configDir).toBe(HOST_DIR)
    expect(got.method).toBe('host-session-file')
    expect(got.confidence).toBe('assumed')
    expect(got.staleHostSession).toContain('ARCHIVED')
    // The OLD (storeConflict) guard finds no OTHER owner, so it never fires here — that is the
    // whole point of the new one.
    expect(got.storeConflict).toBeUndefined()
    expect(got.ruledOut.some((r) => r.includes('STALE ENV'))).toBe(true)
  })

  test('an UNARCHIVED host-session chat stays exact — a genuine live per-chat server', async () => {
    const collectChats = () => [
      fakeChat({
        instance: HOST_DIR,
        chatId: `local_${bareId}`,
        cliSessionId: bareId,
        archived: false,
        isArchived: false,
      }),
    ]
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...fs, collectChats, ancestry: async () => null }),
    )
    expect(got.confidence).toBe('exact')
    expect(got.staleHostSession).toBeUndefined()
  })

  test('with no chat-store signal at all the filename hit is untouched (archived check needs a match)', async () => {
    const got = await detectSelfIdentity(
      deps({ env: DESKTOP_MCP_ENV, ...fs, collectChats: () => [], ancestry: async () => null }),
    )
    expect(got.confidence).toBe('exact')
    expect(got.staleHostSession).toBeUndefined()
  })

  test('a stale-env finding on a signal that did NOT win never downgrades the real winner', async () => {
    // CLAUDE_CONFIG_DIR (stage 2) answers first; the archived host-session finding is real but
    // irrelevant, because nothing ever acted on that clue.
    const collectChats = () => [
      fakeChat({ instance: HOST_DIR, chatId: `local_${bareId}`, archived: true, isArchived: true }),
    ]
    const got = await detectSelfIdentity(
      deps({
        env: { ...DESKTOP_MCP_ENV, CLAUDE_CONFIG_DIR: 'C:\\cli-7' },
        ...fs,
        collectChats,
        ancestry: async () => null,
      }),
    )
    expect(got.configDir).toBe('C:\\cli-7')
    expect(got.confidence).toBe('exact')
    expect(got.staleHostSession).toBeUndefined()
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
        executablePath: 'C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\app-1.28929.0\\claude.exe',
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
