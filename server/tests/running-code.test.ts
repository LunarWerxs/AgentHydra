// server/tests/running-code.test.ts — "is this daemon running the code on disk?"
// (server/src/core/running-code.ts).
//
// The failure it exists for: a source daemon outlives a commit or a pull into its checkout and goes
// on serving the old routes, and nothing says so. Pinned here:
//  * the checkout's commit is read straight from git's files for a branch, a packed ref, a detached
//    HEAD and a linked worktree, and an unreadable checkout answers null rather than throwing;
//  * restartNeeded is true only when BOTH commits are known and differ, never on a guess;
//  * a compiled build is never "stale" (it updates by replacing itself);
//  * the answer is cached for the TTL, because /api/health is polled;
//  * the message names both commits so a person and an agent read the same thing.

import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRunningCodeProbe,
  readCheckoutCommit,
  restartNeededMessage,
} from '../src/core/running-code'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agenthydra-runningcode-'))
  dirs.push(root)
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

test('a branch head is read from its loose ref', () => {
  const root = checkout({ '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': `${A}\n` })
  expect(readCheckoutCommit(root)).toBe(A)
})

test('a branch that only exists in packed-refs is read from there', () => {
  const root = checkout({
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${B} refs/heads/main\n${C} refs/tags/v1\n`,
  })
  expect(readCheckoutCommit(root)).toBe(B)
})

test('a detached HEAD is its own commit', () => {
  expect(readCheckoutCommit(checkout({ '.git/HEAD': `${C}\n` }))).toBe(C)
})

test('a linked worktree reads its own HEAD and the shared refs', () => {
  const main = checkout({
    '.git/refs/heads/feature': `${B}\n`,
    '.git/HEAD': 'ref: refs/heads/main\n',
  })
  const wtGit = join(main, '.git', 'worktrees', 'wt')
  mkdirSync(wtGit, { recursive: true })
  writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/feature\n')
  writeFileSync(join(wtGit, 'commondir'), '../..\n')
  const worktree = checkout({ '.git': `gitdir: ${wtGit}\n` })
  expect(readCheckoutCommit(worktree)).toBe(B)
})

test('no checkout, or a malformed one, reads as null and never throws', () => {
  expect(readCheckoutCommit(checkout({ 'README.md': 'no git here' }))).toBeNull()
  expect(readCheckoutCommit(checkout({ '.git/HEAD': 'ref: refs/heads/gone\n' }))).toBeNull()
  expect(readCheckoutCommit(checkout({ '.git/HEAD': 'garbage' }))).toBeNull()
  expect(readCheckoutCommit(checkout({ '.git': 'not a gitdir pointer' }))).toBeNull()
})

test('restart is needed only when the checkout moved after boot', () => {
  let disk: string | null = A
  let clock = 0
  const probe = createRunningCodeProbe({
    root: 'unused',
    compiled: false,
    ttlMs: 10_000,
    readCommit: () => disk,
    now: () => clock,
  })
  expect(probe.status()).toEqual({ bootCommit: A, diskCommit: A, restartNeeded: false })

  disk = B
  clock = 5_000 // inside the TTL: still the cached answer
  expect(probe.status().restartNeeded).toBe(false)
  clock = 10_000
  expect(probe.status()).toEqual({ bootCommit: A, diskCommit: B, restartNeeded: true })

  disk = null // an unreadable checkout later is not evidence either way
  clock = 20_000
  expect(probe.status()).toEqual({ bootCommit: A, diskCommit: null, restartNeeded: false })
})

test('a compiled build, or a checkout unreadable at boot, is never reported stale', () => {
  const compiled = createRunningCodeProbe({ root: 'x', compiled: true, readCommit: () => B })
  expect(compiled.status()).toEqual({ bootCommit: null, diskCommit: null, restartNeeded: false })
  let disk: string | null = null
  const unreadable = createRunningCodeProbe({ root: 'x', compiled: false, readCommit: () => disk })
  disk = B
  expect(unreadable.status().restartNeeded).toBe(false)
})

test('the message names both commits, and there is none when nothing is stale', () => {
  const message = restartNeededMessage({ bootCommit: A, diskCommit: B, restartNeeded: true })
  expect(message).toContain(A.slice(0, 7))
  expect(message).toContain(B.slice(0, 7))
  expect(message).toContain('/api/daemon/restart')
  expect(restartNeededMessage({ bootCommit: A, diskCommit: A, restartNeeded: false })).toBeNull()
})

test('the real checkout this suite runs in reads as a commit', () => {
  // This repository is itself a git checkout, so the reader must find a 40-hex commit here.
  expect(readCheckoutCommit(join(import.meta.dir, '..', '..'))).toMatch(/^[0-9a-f]{40}$/)
})
