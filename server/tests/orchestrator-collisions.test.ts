// server/tests/orchestrator-collisions.test.ts — which live chats are standing on each other's feet.
//
// Placement weighed account headroom and nothing else, so the orchestrator would happily point a
// second chat at a repository another chat was already editing. The owner heard about it from the
// chats themselves (2026-08-25: threads reporting their work had been "overridden by other chats"),
// and the commit nudge sharpened it by telling one chat to commit a tree another was halfway
// through changing.
//
// This is deliberately repo-level, not file-level: same repository means they CAN clobber, which is
// all the reviewer needs in order to route around it. What the tests pin is that the grouping is
// right at the two edges that matter - a linked worktree counts as its parent repo, and a lone
// chat is never reported as a collision.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collisionsFor, repoRootForCwd } from '../src/orchestrator'

const root = mkdtempSync(join(tmpdir(), 'agenthydra-collide-'))
const repoA = join(root, 'repo-a')
const repoB = join(root, 'repo-b')
// A linked worktree of repo A, in the layout Claude Code creates them.
const worktree = join(repoA, '.claude', 'worktrees', 'vibrant-saha')
const nested = join(repoA, 'packages', 'web')
const loose = join(root, 'not-a-repo')

for (const d of [repoA, repoB, worktree, nested, loose]) mkdirSync(d, { recursive: true })
for (const d of [repoA, repoB]) writeFileSync(join(d, '.git'), 'gitdir: whatever')
// The worktree carries its own .git FILE, which is what makes it look like a separate repo.
writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere')

function chat(sessionId: string, cwd: string) {
  return { pid: 1, sessionId, cwd, name: sessionId, startedAt: 0, transcriptPath: null }
}

test('a subfolder resolves to its repository root', () => {
  expect(repoRootForCwd(nested)).toBe(repoA)
})

test('a linked worktree counts as the repo it belongs to, not a separate place', () => {
  // The case that forced this: one chat in the repo, another in its worktree, editing the same
  // history from two paths that share no prefix below the repo.
  expect(repoRootForCwd(worktree)).toBe(repoA)
})

test('a directory in no repository resolves to null', () => {
  expect(repoRootForCwd(loose)).toBe(null)
})

test('two chats in one repo collide, even via a worktree', () => {
  const out = collisionsFor([chat('s1', repoA), chat('s2', worktree)])
  expect(out).toHaveLength(1)
  expect(out[0]?.where).toBe(repoA)
  expect(out[0]?.chats.map((c) => c.sessionId).sort()).toEqual(['s1', 's2'])
})

test('chats in different repos are not a collision', () => {
  expect(collisionsFor([chat('s1', repoA), chat('s2', repoB)])).toEqual([])
})

test('a lone chat is never a collision', () => {
  // The normal case, and the one a false positive would ruin: an orchestrator that cries
  // collision over every single chat gets ignored exactly when it is right.
  expect(collisionsFor([chat('s1', repoA)])).toEqual([])
  expect(collisionsFor([])).toEqual([])
})

test('chats outside any repo still collide when they share a directory', () => {
  const out = collisionsFor([chat('s1', loose), chat('s2', loose)])
  expect(out).toHaveLength(1)
  expect(out[0]?.where).toBe(loose)
})

test('the busiest repo is reported first', () => {
  const out = collisionsFor([
    chat('a', repoB),
    chat('b', repoB),
    chat('c', repoA),
    chat('d', nested),
    chat('e', worktree),
  ])
  expect(out.map((g) => g.chats.length)).toEqual([3, 2])
  expect(out[0]?.where).toBe(repoA)
})
