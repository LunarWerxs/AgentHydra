import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GitFileChange } from '@shared/protocol'
import { GitError, gitDiff, gitStatus, MAX_DIFF_BYTES, MAX_FILES } from '../../src/git/git'
import { cleanTemps, commitAll, git, initRepo, tempDir } from './helpers'

// Every case spawns several git processes; on a busy Windows box that takes seconds.
setDefaultTimeout(30_000)

afterEach(cleanTemps)

function byPath(files: GitFileChange[]): Record<string, GitFileChange> {
  return Object.fromEntries(files.map((f) => [f.path, f]))
}

describe('gitStatus', () => {
  test('a folder outside any repo is isRepo false', async () => {
    const s = await gitStatus(tempDir())
    expect(s).toMatchObject({ isRepo: false, branch: null, files: [], added: 0, removed: 0 })
  })

  test('rejects a relative or missing cwd', async () => {
    await expect(gitStatus('relative/dir')).rejects.toBeInstanceOf(GitError)
    await expect(gitStatus(join(tempDir(), 'nope'))).rejects.toThrow(/no such folder/)
  })

  test('a fresh repo with no commit: branch name, untracked lines counted', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree')
    const s = await gitStatus(dir)
    expect(s.isRepo).toBe(true)
    expect(s.branch).toBe('main')
    expect(s.files).toEqual([{ path: 'a.txt', status: '??', added: 3, removed: 0 }])
    expect(s.added).toBe(3)
  })

  test('modify, add untracked, rename, delete: statuses and line counts', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'keep.txt'), 'a\nb\nc\n')
    writeFileSync(join(dir, 'old.txt'), 'x\ny\nz\nw\n')
    writeFileSync(join(dir, 'gone.txt'), '1\n2\n')
    commitAll(dir)

    writeFileSync(join(dir, 'keep.txt'), 'a\nB\nc\nd\n') // 2 added, 1 removed
    git(dir, 'mv', 'old.txt', 'new.txt')
    unlinkSync(join(dir, 'gone.txt'))
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'fresh.ts'), 'let a = 1\nlet b = 2\n')

    const s = await gitStatus(dir)
    expect(s.branch).toBe('main')
    expect(s.ahead).toBe(0)
    expect(s.behind).toBe(0) // no upstream
    const f = byPath(s.files)
    expect(f['keep.txt']).toEqual({ path: 'keep.txt', status: 'M', added: 2, removed: 1 })
    expect(f['new.txt']).toEqual({ path: 'new.txt', status: 'R', added: 0, removed: 0 })
    expect(f['gone.txt']).toEqual({ path: 'gone.txt', status: 'D', added: 0, removed: 2 })
    expect(f['sub/fresh.ts']).toEqual({ path: 'sub/fresh.ts', status: '??', added: 2, removed: 0 })
    expect(s.files).toHaveLength(4)
    expect(s.added).toBe(4)
    expect(s.removed).toBe(3)
    expect(s.truncated).toBe(false)
  })

  test('detached HEAD reports the short sha', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    commitAll(dir)
    const sha = git(dir, 'rev-parse', '--short', 'HEAD').trim()
    git(dir, 'checkout', '-q', '--detach')
    const s = await gitStatus(dir)
    expect(s.branch).toBe(sha)
    expect(s.files).toEqual([])
  })

  test('ahead and behind against the upstream', async () => {
    const remote = initRepo()
    writeFileSync(join(remote, 'a.txt'), 'a\n')
    commitAll(remote)
    const clone = tempDir()
    git(clone, 'clone', '-q', remote, '.')
    git(clone, 'config', 'user.name', 'Desk Test')
    git(clone, 'config', 'user.email', 'desk@test.invalid')
    git(clone, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(clone, 'b.txt'), 'b\n')
    commitAll(clone, 'local 1')
    writeFileSync(join(clone, 'c.txt'), 'c\n')
    commitAll(clone, 'local 2')
    writeFileSync(join(remote, 'd.txt'), 'd\n')
    commitAll(remote, 'remote 1')
    git(clone, 'fetch', '-q')
    const s = await gitStatus(clone)
    expect(s).toMatchObject({ branch: 'main', ahead: 2, behind: 1 })
  })

  test('a subfolder cwd lists paths from the repo top', async () => {
    const dir = initRepo()
    mkdirSync(join(dir, 'deep'))
    writeFileSync(join(dir, 'deep', 'x.txt'), 'x\n')
    commitAll(dir)
    writeFileSync(join(dir, 'deep', 'x.txt'), 'y\n')
    const s = await gitStatus(join(dir, 'deep'))
    expect(s.files).toEqual([{ path: 'deep/x.txt', status: 'M', added: 1, removed: 1 }])
  })

  test('a path with spaces and unicode', async () => {
    const dir = initRepo(join(tempDir('desk git ünï 漢字 '), ''))
    const name = 'my file — ü 漢.txt'
    writeFileSync(join(dir, name), 'a\n')
    commitAll(dir)
    writeFileSync(join(dir, name), 'a\nb\n')
    writeFileSync(join(dir, 'neu ö.txt'), 'n\n')
    const s = await gitStatus(dir)
    const f = byPath(s.files)
    expect(f[name]).toEqual({ path: name, status: 'M', added: 1, removed: 0 })
    expect(f['neu ö.txt']).toEqual({ path: 'neu ö.txt', status: '??', added: 1, removed: 0 })
    const d = await gitDiff(dir, name)
    expect(d).toContain('+b')
  })

  test('a binary file counts no lines', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
    commitAll(dir)
    writeFileSync(join(dir, 'img.bin'), Buffer.from([0, 9, 9, 9, 0, 254, 7]))
    writeFileSync(join(dir, 'new.bin'), Buffer.from([0, 0, 1]))
    const s = await gitStatus(dir)
    const f = byPath(s.files)
    expect(f['img.bin']).toEqual({ path: 'img.bin', status: 'M', added: 0, removed: 0 })
    expect(f['new.bin']).toEqual({ path: 'new.bin', status: '??', added: 0, removed: 0 })
  })

  test('a repeat poll reuses the numstat until a changed file changes again, in one git process', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'keep.txt'), 'a\n')
    commitAll(dir)
    writeFileSync(join(dir, 'keep.txt'), 'a\nb\n')
    writeFileSync(join(dir, 'new.txt'), 'n\n')
    expect((await gitStatus(dir)).added).toBe(2)

    const spawn = Bun.spawn
    let gits = 0
    ;(Bun as unknown as { spawn: unknown }).spawn = (...args: Parameters<typeof Bun.spawn>) => {
      gits++
      return spawn(...args)
    }
    try {
      const again = await gitStatus(dir)
      expect(again.added).toBe(2)
      expect(gits).toBe(1)

      // Same status letters, new content: the counts must follow the file, not the memo.
      writeFileSync(join(dir, 'keep.txt'), 'a\nb\nc\nd\n')
      writeFileSync(join(dir, 'new.txt'), 'n\no\n')
      const edited = await gitStatus(dir)
      expect(byPath(edited.files)['keep.txt']).toEqual({ path: 'keep.txt', status: 'M', added: 3, removed: 0 })
      expect(byPath(edited.files)['new.txt']).toEqual({ path: 'new.txt', status: '??', added: 2, removed: 0 })
      expect(edited.added).toBe(5)
    } finally {
      ;(Bun as unknown as { spawn: unknown }).spawn = spawn
    }
  })

  test(`caps the list at ${MAX_FILES} files and says so`, async () => {
    const dir = initRepo()
    for (let i = 0; i < MAX_FILES + 20; i++) writeFileSync(join(dir, `f${String(i).padStart(4, '0')}.txt`), 'x\n')
    const s = await gitStatus(dir)
    expect(s.files).toHaveLength(MAX_FILES)
    expect(s.truncated).toBe(true)
    expect(s.totalFiles).toBe(MAX_FILES + 20)
  })
})

describe('gitDiff', () => {
  test('a modified file: unified diff against HEAD', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    commitAll(dir)
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\n')
    const d = await gitDiff(dir, 'a.txt')
    expect(d).toContain('--- a/a.txt')
    expect(d).toContain('+++ b/a.txt')
    expect(d).toContain('-two')
    expect(d).toContain('+TWO')
  })

  test('an untracked file shows as all added', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'base.txt'), 'b\n')
    commitAll(dir)
    writeFileSync(join(dir, 'new file.txt'), 'l1\nl2\n')
    const d = await gitDiff(dir, 'new file.txt')
    expect(d).toContain('new file mode')
    expect(d).toContain('+l1')
    expect(d).toContain('+l2')
    expect(d).not.toMatch(/^-l/m)
  })

  test('a deleted file shows as all removed; an unchanged file is empty', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'a.txt'), 'a1\n')
    writeFileSync(join(dir, 'same.txt'), 's\n')
    commitAll(dir)
    unlinkSync(join(dir, 'a.txt'))
    expect(await gitDiff(dir, 'a.txt')).toContain('-a1')
    expect(await gitDiff(dir, 'same.txt')).toBe('')
  })

  test('a binary file is a one-line note', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'b.bin'), Buffer.from([0, 1, 2]))
    commitAll(dir)
    writeFileSync(join(dir, 'b.bin'), Buffer.from([0, 3, 4]))
    writeFileSync(join(dir, 'u.bin'), Buffer.from([0, 5]))
    expect(await gitDiff(dir, 'b.bin')).toBe('Binary file b.bin changed (no text diff)\n')
    expect(await gitDiff(dir, 'u.bin')).toBe('Binary file u.bin changed (no text diff)\n')
  })

  test('a very large diff is capped at 200 KB', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'big.txt'), 'start\n')
    commitAll(dir)
    writeFileSync(join(dir, 'big.txt'), `${'0123456789abcdef0123456789abcdef0123456789abcdef\n'.repeat(20000)}`)
    const d = await gitDiff(dir, 'big.txt')
    expect(Buffer.byteLength(d)).toBeLessThan(MAX_DIFF_BYTES + 200)
    expect(d).toContain('diff truncated at 200 KB')
    const s = await gitStatus(dir)
    expect(byPath(s.files)['big.txt']).toMatchObject({ added: 20000, removed: 1 })
  })

  test('rejects a path outside the repo, a missing file and a non-repo', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    commitAll(dir)
    await expect(gitDiff(dir, '../x.txt')).rejects.toThrow(/outside the repository/)
    await expect(gitDiff(dir, 'missing.txt')).rejects.toThrow(/no such file/)
    await expect(gitDiff(tempDir(), 'a.txt')).rejects.toThrow(/not a git repository/)
  })
})
