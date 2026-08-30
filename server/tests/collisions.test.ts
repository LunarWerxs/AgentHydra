// server/tests/collisions.test.ts - the same-repo collision guard pinned: it groups live
// chats by repo root, reports only real crowds, and says why it matters.
import { expect, test } from 'bun:test'
import { liveCollisions } from '../src/collisions'

const deps = (
  live: Array<{ sessionId: string; cwd: string }>,
  repoRoot: (cwd: string) => string | null = (c) => c,
) => ({ live: () => live, repoRoot, instanceOf: () => 'desktop:C:/i/work' })

test('two live chats in one repo are a collision; one is not news', () => {
  const none = liveCollisions(deps([{ sessionId: 'a', cwd: 'D:/repo' }]))
  expect(none).toEqual([])
  const hit = liveCollisions(
    deps(
      [
        { sessionId: 'a', cwd: 'D:/repo/sub' },
        { sessionId: 'b', cwd: 'D:/repo/other' },
      ],
      () => 'D:/repo',
    ),
  )
  expect(hit.length).toBe(1)
  expect(hit[0]?.chats.map((c) => c.sessionId).sort()).toEqual(['a', 'b'])
  // The report has to say what the danger IS, or a reader cannot act on it.
  expect(hit[0]?.why).toContain('overwrite')
})

test('different repos are not a collision', () => {
  const out = liveCollisions(
    deps([
      { sessionId: 'a', cwd: 'D:/one' },
      { sessionId: 'b', cwd: 'D:/two' },
    ]),
  )
  expect(out).toEqual([])
})

test('the same session listed twice is not colliding with itself', () => {
  // A stale registry file beside a live one produces exactly this.
  const out = liveCollisions(
    deps([
      { sessionId: 'a', cwd: 'D:/repo' },
      { sessionId: 'a', cwd: 'D:/repo' },
    ]),
  )
  expect(out).toEqual([])
})

test('repo roots are matched case/slash-insensitively, like every other path here', () => {
  const out = liveCollisions(
    deps(
      [
        { sessionId: 'a', cwd: 'D:/Repo' },
        { sessionId: 'b', cwd: String.raw`d:\repo` },
      ],
      (c) => c,
    ),
  )
  expect(out.length).toBe(1)
})

test('chats outside any repo still collide on a shared cwd', () => {
  const out = liveCollisions(
    deps(
      [
        { sessionId: 'a', cwd: 'D:/scratch' },
        { sessionId: 'b', cwd: 'D:/scratch' },
      ],
      () => null, // not in a repo
    ),
  )
  expect(out.length).toBe(1)
  expect(out[0]?.where).toBe('D:/scratch')
})

test('a chat with no cwd is skipped rather than grouped under an empty key', () => {
  const out = liveCollisions(
    deps([
      { sessionId: 'a', cwd: '' },
      { sessionId: 'b', cwd: '' },
    ]),
  )
  expect(out).toEqual([])
})

test('the most crowded repo is reported first', () => {
  const out = liveCollisions(
    deps(
      [
        { sessionId: 'a', cwd: 'D:/two' },
        { sessionId: 'b', cwd: 'D:/two' },
        { sessionId: 'c', cwd: 'D:/three' },
        { sessionId: 'd', cwd: 'D:/three' },
        { sessionId: 'e', cwd: 'D:/three' },
      ],
      (c) => c,
    ),
  )
  expect(out[0]?.chats.length).toBe(3)
  expect(out[1]?.chats.length).toBe(2)
})
