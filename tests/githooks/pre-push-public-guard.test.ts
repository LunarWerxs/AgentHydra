// tests/githooks/pre-push-public-guard.test.ts - the pre-push gate. A PUBLIC remote, or one whose
// visibility cannot be proven, refuses the push and prints the heading; AGENTHYDRA_PUSH_PUBLIC=1
// announces and proceeds; a private remote is untouched; a release tag is refused while
// docs/todo/TODO.md has an open section, and nothing overrides that.
//
// Drives the real, on-disk `.githooks/pre-push` and `.githooks/check-public-push.mjs` (copied
// fresh at test time, never duplicated by hand) against a throwaway repo pushing to a throwaway
// bare origin. The visibility lookup is stubbed through the environment, so nothing here reaches
// the network; the real lookup was proven by hand on 2026-09-12 (LunarWerxs/AgentHydra answered
// 200 + public, a private repo answered 404). It never touches this repo's own remote or index.
//
// Lives under tests/, not .githooks/tests/: `bun test` skips dot-directories, so a suite parked
// there passes by hand and never runs (see hook-tests-live-here.test.ts).
//
// Revert check: delete the `if (verdict !== "private")` block in check-public-push.mjs and the
// first four tests fail; delete the release-tag block and the tag tests fail.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openTodoSections,
  parseGithubSlug,
  parseRefLines,
} from '../../.githooks/check-public-push.mjs'
import { REPO_ROOT } from '../repo-root'

const HOOK_TEST_TIMEOUT = 20_000 // real git init/commit/push + a node subprocess; ~1s locally
const HEADING = '# WARNING: THIS REPOSITORY IS **PUBLIC**'

const REAL_PREPUSH = join(REPO_ROOT, '.githooks', 'pre-push')
const REAL_GUARD = join(REPO_ROOT, '.githooks', 'check-public-push.mjs')

type Env = Record<string, string>

/** The test's own environment never leaks a real override or stub into the sandbox. */
function envFor(overrides: Env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.AGENTHYDRA_PUSH_PUBLIC
  delete env.AGENTHYDRA_VISIBILITY_STUB
  return { ...env, ...overrides }
}

function git(cwd: string, env: Env, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', timeout: HOOK_TEST_TIMEOUT, env: envFor(env) },
  )
}

interface PushResult {
  status: number
  output: string
}

/** spawnSync rather than execFileSync: the hook speaks on stderr, and a push that SUCCEEDS with
 *  the override must still show the heading, which execFileSync's return value (stdout only)
 *  would hide. */
function push(repo: string, env: Env, ...refs: string[]): PushResult {
  const r = spawnSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'push', 'origin', ...refs],
    { cwd: repo, encoding: 'utf8', timeout: HOOK_TEST_TIMEOUT, env: envFor(env) },
  )
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function originHas(origin: string, ref: string): boolean {
  try {
    git(origin, {}, 'rev-parse', '--verify', '--quiet', ref)
    return true
  } catch {
    return false
  }
}

describe('.githooks/pre-push: a public remote is announced and refused', () => {
  let sandbox: string
  let repo: string
  let origin: string

  beforeEach(() => {
    // realpathSync.native: GitHub's Windows runner hands out an 8.3 temp path (RUNNER~1) while git
    // reports the worktree by its long name, and every path comparison in a hook test then misses.
    sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'ah-prepush-')))
    repo = join(sandbox, 'repo')
    origin = join(sandbox, 'origin')
    mkdirSync(join(repo, '.githooks'), { recursive: true })
    git(sandbox, {}, 'init', '-q', '--bare', origin)

    // Byte-identical copies of the REAL hook files, read fresh every run.
    writeFileSync(join(repo, '.githooks', 'pre-push'), readFileSync(REAL_PREPUSH))
    writeFileSync(join(repo, '.githooks', 'check-public-push.mjs'), readFileSync(REAL_GUARD))
    chmodSync(join(repo, '.githooks', 'pre-push'), 0o755) // git on POSIX refuses a non-executable hook

    git(repo, {}, 'init', '-q', '-b', 'main')
    git(repo, {}, 'config', 'core.hooksPath', '.githooks')
    git(repo, {}, 'remote', 'add', 'origin', origin)
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, {}, 'add', 'a.txt')
    git(repo, {}, 'commit', '-q', '-m', 'init')
  }, HOOK_TEST_TIMEOUT)

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  test(
    'PUBLIC without the override: heading printed, push refused, nothing lands',
    () => {
      const r = push(repo, { AGENTHYDRA_VISIBILITY_STUB: 'public' }, 'main')
      expect(r.status).not.toBe(0)
      expect(r.output).toContain(HEADING)
      expect(r.output).toContain('AGENTHYDRA_PUSH_PUBLIC=1')
      expect(originHas(origin, 'refs/heads/main')).toBe(false)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'PUBLIC with AGENTHYDRA_PUSH_PUBLIC=1: heading STILL printed, then the push proceeds',
    () => {
      const r = push(
        repo,
        { AGENTHYDRA_VISIBILITY_STUB: 'public', AGENTHYDRA_PUSH_PUBLIC: '1' },
        'main',
      )
      expect(r.status).toBe(0)
      expect(r.output).toContain(HEADING)
      expect(r.output).toContain('announced, proceeding')
      expect(originHas(origin, 'refs/heads/main')).toBe(true)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'PRIVATE: no heading, no friction',
    () => {
      const r = push(repo, { AGENTHYDRA_VISIBILITY_STUB: 'private' }, 'main')
      expect(r.status).toBe(0)
      expect(r.output).not.toContain(HEADING)
      expect(originHas(origin, 'refs/heads/main')).toBe(true)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'UNKNOWN is fail-closed: refused, and the output says it could not be proven private',
    () => {
      const r = push(repo, { AGENTHYDRA_VISIBILITY_STUB: 'unknown' }, 'main')
      expect(r.status).not.toBe(0)
      expect(r.output).toContain(HEADING)
      expect(r.output).toContain('could not be proven private')
      expect(originHas(origin, 'refs/heads/main')).toBe(false)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'no stub and a remote that is not GitHub: unknown, so refused without any network',
    () => {
      const r = push(repo, {}, 'main')
      expect(r.status).not.toBe(0)
      expect(r.output).toContain('is not a GitHub remote')
      expect(originHas(origin, 'refs/heads/main')).toBe(false)
    },
    HOOK_TEST_TIMEOUT,
  )

  describe('a release tag is refused while the work queue has an open section', () => {
    const PRIVATE = { AGENTHYDRA_VISIBILITY_STUB: 'private' }

    function writeTodo(repo: string, body: string) {
      mkdirSync(join(repo, 'docs', 'todo'), { recursive: true })
      writeFileSync(join(repo, 'docs', 'todo', 'TODO.md'), body)
    }

    test(
      'open section: refused by name, no override exists, the tag never lands',
      () => {
        writeTodo(repo, '# q\n\n## Contents\n\n- x\n\n## 1. Still open thing\n\nbody\n')
        git(repo, {}, 'tag', 'v1.2.3')
        const r = push(repo, { ...PRIVATE, AGENTHYDRA_PUSH_PUBLIC: '1' }, 'v1.2.3')
        expect(r.status).not.toBe(0)
        expect(r.output).toContain('release refused')
        expect(r.output).toContain('1. Still open thing')
        expect(originHas(origin, 'refs/tags/v1.2.3')).toBe(false)
      },
      HOOK_TEST_TIMEOUT,
    )

    test(
      'only the Contents heading left: the tag ships',
      () => {
        writeTodo(repo, '# q\n\n## Contents\n\n(nothing open)\n')
        git(repo, {}, 'tag', 'v1.2.3')
        const r = push(repo, PRIVATE, 'v1.2.3')
        expect(r.status).toBe(0)
        expect(originHas(origin, 'refs/tags/v1.2.3')).toBe(true)
      },
      HOOK_TEST_TIMEOUT,
    )

    test(
      'no queue file on this machine: nothing to gate on, the tag ships',
      () => {
        git(repo, {}, 'tag', 'v1.2.3')
        const r = push(repo, PRIVATE, 'v1.2.3')
        expect(r.status).toBe(0)
        expect(originHas(origin, 'refs/tags/v1.2.3')).toBe(true)
      },
      HOOK_TEST_TIMEOUT,
    )

    test(
      'a tag that is not a release (no v-semver name) is not gated',
      () => {
        writeTodo(repo, '# q\n\n## Contents\n\n## 1. Open\n')
        git(repo, {}, 'tag', 'checkpoint')
        const r = push(repo, PRIVATE, 'checkpoint')
        expect(r.status).toBe(0)
        expect(originHas(origin, 'refs/tags/checkpoint')).toBe(true)
      },
      HOOK_TEST_TIMEOUT,
    )
  })
})

describe('check-public-push.mjs: the parsers', () => {
  test('parseGithubSlug accepts every URL shape git uses for GitHub, with or without .git', () => {
    for (const url of [
      'https://github.com/LunarWerxs/AgentHydra.git',
      'https://github.com/LunarWerxs/AgentHydra',
      'git@github.com:LunarWerxs/AgentHydra.git',
      'ssh://git@github.com/LunarWerxs/AgentHydra.git',
      'https://github.com/LunarWerxs/AgentHydra/',
    ]) {
      expect(parseGithubSlug(url)).toEqual({ owner: 'LunarWerxs', repo: 'AgentHydra' })
    }
    expect(parseGithubSlug('https://gitlab.com/o/r.git')).toBeNull()
    expect(parseGithubSlug('C:/tmp/origin')).toBeNull()
  })

  test('parseRefLines tells a deletion (all-zero local sha) from a push', () => {
    const refs = parseRefLines(
      'refs/heads/main abc123 refs/heads/main 000\n' +
        '(delete) 0000000000000000000000000000000000000000 refs/tags/v0.8.0 def456\n',
    )
    expect(refs).toHaveLength(2)
    expect(refs[0]?.isDelete).toBe(false)
    expect(refs[1]?.isDelete).toBe(true)
    expect(refs[1]?.remoteRef).toBe('refs/tags/v0.8.0')
  })

  test('openTodoSections counts headings after Contents, or all but the state of play without it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-todo-'))
    try {
      const file = join(dir, 'TODO.md')
      writeFileSync(file, '# t\n\n## ⭐ STATE OF PLAY\n\n## Contents\n\n## 1. A\n\n## 2. B\n')
      expect(openTodoSections(file)).toEqual(['1. A', '2. B'])
      writeFileSync(file, '# t\n\n## ⭐ STATE OF PLAY, 2026-09-12\n\n## Only thing\n')
      expect(openTodoSections(file)).toEqual(['Only thing'])
      expect(openTodoSections(join(dir, 'missing.md'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
