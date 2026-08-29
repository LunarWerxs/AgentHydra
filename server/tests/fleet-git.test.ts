// server/tests/fleet-git.test.ts - Piece 3 pinned against REAL git fixtures: non-repos, a clean
// main repo, dirty counts, off-main and detached flags, upstream-less ahead=null, repo-root
// dedupe across session cwds, and error honesty when git itself fails. Every test that reaches
// a subprocess states an explicit timeout (scripts/checks/spawn-test-without-timeout.mjs).
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fleetGit } from '../src/fleet-git'

const GIT_TEST_TIMEOUT = 30_000

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(
    ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  )
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

function makeRepo(prefix: string, branch = 'main'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  git(dir, 'init', '-q', '-b', branch)
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'root')
  return dir
}

test(
  'a non-repo cwd is reported under notRepo, not invented into a repo',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-plain-'))
    const r = await fleetGit([dir])
    expect(r.repos).toEqual([])
    expect(r.notRepo).toEqual([dir])
  },
  GIT_TEST_TIMEOUT,
)

test(
  'a clean repo on main: dirty 0, offMain false, ahead null (no upstream), no error',
  async () => {
    const dir = makeRepo('fg-clean-')
    const r = await fleetGit([dir])
    expect(r.repos.length).toBe(1)
    const repo = r.repos[0]
    expect(repo?.branch).toBe('main')
    expect(repo?.detached).toBe(false)
    expect(repo?.offMain).toBe(false)
    expect(repo?.dirtyCount).toBe(0)
    expect(repo?.aheadCount).toBe(null)
    expect(repo?.error).toBe(null)
  },
  GIT_TEST_TIMEOUT,
)

test(
  'dirty files are counted, and a feature branch flags offMain',
  async () => {
    const dir = makeRepo('fg-dirty-')
    git(dir, 'checkout', '-q', '-b', 'feature/x')
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'b.txt'), 'b')
    const r = await fleetGit([dir])
    const repo = r.repos[0]
    expect(repo?.dirtyCount).toBe(2)
    expect(repo?.branch).toBe('feature/x')
    expect(repo?.offMain).toBe(true)
  },
  GIT_TEST_TIMEOUT,
)

test(
  'a detached HEAD is detached and offMain',
  async () => {
    const dir = makeRepo('fg-detached-')
    const sha = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'checkout', '-q', sha)
    const r = await fleetGit([dir])
    expect(r.repos[0]?.detached).toBe(true)
    expect(r.repos[0]?.offMain).toBe(true)
  },
  GIT_TEST_TIMEOUT,
)

test(
  'two session cwds in one repo dedupe to one entry carrying both',
  async () => {
    const dir = makeRepo('fg-dedupe-')
    const sub = join(dir, 'srv')
    mkdirSync(sub)
    const r = await fleetGit([dir, sub, dir])
    expect(r.repos.length).toBe(1)
    expect(r.repos[0]?.cwds.length).toBe(2)
  },
  GIT_TEST_TIMEOUT,
)

test(
  'ahead counts against a real upstream',
  async () => {
    const upstream = makeRepo('fg-up-')
    const dir = mkdtempSync(join(tmpdir(), 'fg-clone-'))
    git(dir, 'clone', '-q', upstream, 'c')
    const clone = join(dir, 'c')
    git(clone, 'commit', '--allow-empty', '-q', '-m', 'one ahead')
    git(clone, 'commit', '--allow-empty', '-q', '-m', 'two ahead')
    const r = await fleetGit([clone])
    expect(r.repos[0]?.aheadCount).toBe(2)
  },
  GIT_TEST_TIMEOUT,
)

test('a git failure yields nulls plus an error string, never a silent zero', async () => {
  const r = await fleetGit(['D:/anywhere'], {
    runGit: async (args) =>
      args.includes('--show-toplevel')
        ? { ok: true, out: 'D:/anywhere', err: '' }
        : { ok: false, out: '', err: 'index.lock held by another process' },
  })
  const repo = r.repos[0]
  expect(repo?.dirtyCount).toBe(null)
  expect(repo?.branch).toBe(null)
  expect(repo?.error).toContain('index.lock')
})

test('repos sort dirtiest first, deterministically', async () => {
  const fake = async (args: string[]) => {
    if (args.includes('--show-toplevel')) return { ok: true, out: args[1] ?? '', err: '' }
    if (args.includes('--abbrev-ref')) return { ok: true, out: 'main', err: '' }
    if (args.includes('--porcelain'))
      return {
        ok: true,
        out: Array((args[1] ?? '').includes('b') ? 3 : 1)
          .fill('M x')
          .join('\n'),
        err: '',
      }
    return { ok: false, out: '', err: 'no upstream' }
  }
  const r = await fleetGit(['/repo/a', '/repo/b'], { runGit: fake })
  expect(r.repos.map((x) => x.root)).toEqual(['/repo/b', '/repo/a'])
  expect(r.repos[0]?.dirtyCount).toBe(3)
  expect(r.repos[1]?.dirtyCount).toBe(1)
})
