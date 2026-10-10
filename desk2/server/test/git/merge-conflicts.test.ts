import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GitError, mergeConflictFiles } from '../../src/git/git'
import { cleanTemps, commitAll, git, initRepo, tempDir } from './helpers'

// Each case spawns several git processes; on a busy Windows box that takes seconds.
setDefaultTimeout(30_000)

afterEach(cleanTemps)

/**
 * A repo whose origin/main (a ref made by hand, no remote and no network) changed a.ts, while the
 * branch `work` was cut from the first commit and changed a.ts too: the two sides conflict on a.ts.
 */
function diverged(): { dir: string; first: string } {
  const dir = initRepo()
  writeFileSync(join(dir, 'a.ts'), 'one\n')
  writeFileSync(join(dir, 'b.ts'), 'one\n')
  commitAll(dir, 'first')
  const first = git(dir, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(dir, 'a.ts'), 'trunk\n')
  commitAll(dir, 'trunk')
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(dir, 'checkout', '-q', '-b', 'work', first)
  writeFileSync(join(dir, 'a.ts'), 'work\n')
  commitAll(dir, 'work')
  return { dir, first }
}

describe('mergeConflictFiles', () => {
  test('lists the files that would conflict with origin/main, and names the base', async () => {
    const { dir } = diverged()
    expect(await mergeConflictFiles(dir)).toEqual({ state: 'conflicts', base: 'origin/main', files: ['a.ts'] })
  })

  test('a branch whose changes do not touch the base changes merges cleanly', async () => {
    const { dir, first } = diverged()
    git(dir, 'checkout', '-q', '-b', 'tidy', first)
    writeFileSync(join(dir, 'b.ts'), 'two\n')
    commitAll(dir, 'tidy')
    expect(await mergeConflictFiles(dir)).toEqual({ state: 'clean', base: 'origin/main', files: [] })
  })

  test('no base ref at all (no origin/main, no main) is unavailable with no base named', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'a.ts'), 'one\n')
    commitAll(dir, 'first')
    git(dir, 'checkout', '-q', '-b', 'work')
    git(dir, 'branch', '-q', '-m', 'main', 'trunk')
    expect(await mergeConflictFiles(dir)).toEqual({ state: 'unavailable', base: null, files: [] })
  })

  test('HEAD at the base commit is skipped: unavailable with no base named', async () => {
    const { dir } = diverged()
    git(dir, 'checkout', '-q', 'main')
    expect(await mergeConflictFiles(dir)).toEqual({ state: 'unavailable', base: null, files: [] })
  })

  test('a folder outside any repo is unavailable, not an error', async () => {
    expect(await mergeConflictFiles(tempDir())).toEqual({ state: 'unavailable', base: null, files: [] })
  })

  test('rejects a relative cwd as a bad request', async () => {
    await expect(mergeConflictFiles('relative/dir')).rejects.toBeInstanceOf(GitError)
  })
})
