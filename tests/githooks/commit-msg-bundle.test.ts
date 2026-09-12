// tests/githooks/commit-msg-bundle.test.ts - a `wip: bundle` commit must name every file it swept
// from another session (Mine: / Swept: blocks), and the list must match the commit exactly.
// Ordinary commits are never touched. scripts/save-bundle.ts writes a conforming message from the
// dirty tree and is driven end to end here.
//
// Drives the real, on-disk `.githooks/commit-msg`, `.githooks/check-bundle-message.mjs` and
// `scripts/save-bundle.ts` (never duplicated by hand) inside a throwaway repo. This working tree
// has other sessions' files staged at any moment, so nothing here runs `git add` or `git commit`
// against it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../repo-root'

const HOOK_TEST_TIMEOUT = 20_000

const REAL_HOOK = join(REPO_ROOT, '.githooks', 'commit-msg')
const REAL_GUARD = join(REPO_ROOT, '.githooks', 'check-bundle-message.mjs')
const SAVE_BUNDLE = join(REPO_ROOT, 'scripts', 'save-bundle.ts')

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', timeout: HOOK_TEST_TIMEOUT },
  )
}

interface Result {
  status: number
  output: string
}

function run(fn: () => string): Result {
  try {
    return { status: 0, output: fn() }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function commitWith(repo: string, message: string): Result {
  const file = join(repo, '..', 'MESSAGE')
  writeFileSync(file, message)
  return run(() => git(repo, 'commit', '-q', '-F', file))
}

function saveBundle(repo: string, ...args: string[]): Result {
  return run(() =>
    execFileSync(process.execPath, [SAVE_BUNDLE, ...args], {
      cwd: repo,
      encoding: 'utf8',
      timeout: HOOK_TEST_TIMEOUT,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }),
  )
}

describe('.githooks/commit-msg: a bundle commit names what it swept', () => {
  let sandbox: string
  let repo: string

  beforeEach(() => {
    // realpathSync.native: GitHub's Windows runner hands out an 8.3 temp path (RUNNER~1) while git
    // reports the worktree by its long name; save-bundle.ts canonicalises too, this keeps the
    // sandbox honest on its own.
    sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'ah-bundle-')))
    repo = join(sandbox, 'repo')
    mkdirSync(join(repo, '.githooks'), { recursive: true })
    writeFileSync(join(repo, '.githooks', 'commit-msg'), readFileSync(REAL_HOOK))
    writeFileSync(join(repo, '.githooks', 'check-bundle-message.mjs'), readFileSync(REAL_GUARD))
    chmodSync(join(repo, '.githooks', 'commit-msg'), 0o755)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'core.hooksPath', '.githooks')
    git(repo, 'config', 'commit.gpgsign', 'false')
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'hooks')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    git(repo, 'add', 'a.txt', 'b.txt')
  }, HOOK_TEST_TIMEOUT)

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  test(
    'an ordinary commit is not touched',
    () => {
      expect(commitWith(repo, 'feat: normal work\n').status).toBe(0)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'a bundle with no Mine:/Swept: blocks is refused and told how to write them',
    () => {
      const r = commitWith(repo, 'wip: bundle a peer session\n')
      expect(r.status).not.toBe(0)
      expect(r.output).toContain('must say what it swept')
      expect(r.output).toContain('save:bundle')
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'a complete list passes, and the message is kept verbatim',
    () => {
      const r = commitWith(repo, 'wip: bundle x\n\nMine:\n  a.txt\nSwept:\n  b.txt\n')
      expect(r.status).toBe(0)
      expect(git(repo, 'log', '-1', '--format=%B')).toContain('Swept:\n  b.txt')
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'a staged file under neither block is refused by name',
    () => {
      const r = commitWith(repo, 'wip: bundle x\n\nMine:\n  a.txt\nSwept:\n')
      expect(r.status).not.toBe(0)
      expect(r.output).toContain('under neither Mine: nor Swept:')
      expect(r.output).toContain('b.txt')
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'a listed file that is not in the commit is refused as stale',
    () => {
      const r = commitWith(repo, 'wip: bundle x\n\nMine:\n  a.txt\nSwept:\n  b.txt\n  gone.txt\n')
      expect(r.status).not.toBe(0)
      expect(r.output).toContain('the list is stale')
      expect(r.output).toContain('gone.txt')
    },
    HOOK_TEST_TIMEOUT,
  )

  describe('scripts/save-bundle.ts writes the message from the dirty tree', () => {
    test(
      '--dry-run prints the partition and commits nothing',
      () => {
        writeFileSync(join(repo, 'c.txt'), 'c\n') // untracked: a peer's new file
        const r = saveBundle(repo, '--mine', 'a.txt', '--dry-run')
        expect(r.status).toBe(0)
        expect(r.output).toContain('Mine:\n  a.txt')
        expect(r.output).toContain('Swept:\n  b.txt\n  c.txt')
        expect(git(repo, 'log', '--oneline').trim().split('\n')).toHaveLength(1)
      },
      HOOK_TEST_TIMEOUT,
    )

    test(
      'the real thing sweeps the whole tree, passes the hook, and the trailer lands',
      () => {
        writeFileSync(join(repo, 'c.txt'), 'c\n')
        const r = saveBundle(repo, '--mine', 'a.txt', '--trailer', 'Co-Authored-By: t <t@t>')
        expect(r.status).toBe(0)
        const body = git(repo, 'log', '-1', '--format=%B')
        expect(body.startsWith('wip: bundle ')).toBe(true)
        expect(body).toContain('Mine:\n  a.txt')
        expect(body).toContain('Swept:\n  b.txt\n  c.txt')
        expect(body).toContain('Co-Authored-By: t <t@t>')
        expect(git(repo, 'status', '--porcelain').trim()).toBe('')
      },
      HOOK_TEST_TIMEOUT,
    )

    test(
      'a --mine path that is not dirty is refused: a false claim of ownership is worse than none',
      () => {
        const r = saveBundle(repo, '--mine', 'nope.txt')
        expect(r.status).toBe(2)
        expect(r.output).toContain('not dirty')
        expect(git(repo, 'log', '--oneline').trim().split('\n')).toHaveLength(1)
      },
      HOOK_TEST_TIMEOUT,
    )

    test(
      'when every dirty file is yours there is nothing to bundle',
      () => {
        const r = saveBundle(repo, '--mine', 'a.txt', 'b.txt')
        expect(r.status).toBe(2)
        expect(r.output).toContain('nothing to sweep')
      },
      HOOK_TEST_TIMEOUT,
    )

    test(
      'a cwd spelled differently from the path git reports still resolves --mine (8.3 names, junctions)',
      () => {
        // GitHub's Windows runner runs from C:\Users\RUNNER~1\... while `git rev-parse
        // --show-toplevel` answers the long name, and `relative()` between the two climbed to the
        // drive root: every --mine path read as "not dirty". A junction (symlink elsewhere) is the
        // same shape on any machine, so this proves the canonicalisation without an 8.3 volume.
        writeFileSync(join(repo, 'c.txt'), 'c\n')
        const alias = join(sandbox, 'alias')
        symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir')
        const r = saveBundle(alias, '--mine', 'a.txt', '--dry-run')
        expect(r.status).toBe(0)
        expect(r.output).toContain('Mine:\n  a.txt')
        expect(r.output).toContain('Swept:\n  b.txt\n  c.txt')
      },
      HOOK_TEST_TIMEOUT,
    )
  })
})
