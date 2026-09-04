// A MOVE MUST NOT HIDE THE CHAT ON THE ACCOUNT IT LANDS ON (bug, reproduced live 2026-09-04).
//
// POST /api/sessions/:id/migrate archives the chat's old rows before landing it in the target.
// It used to do that with archiveDesktopChat(id, true) and NO roots, which walks the default
// desktop profile plus every isolated instance and flips the flag in each store carrying the
// chat — the TARGET's own record included. When the target already held a record (a re-migrate,
// or a target that is the account the chat is already on) the move archived it and nothing put
// it back: alreadyRendersIn reads an archived record as "not rendering" so the import proceeds,
// and the hot landing writes title/permission mode/carried settings but never isArchived. The
// route answered ok and the chat was invisible on the account it had just been moved to.
//
// The route now filters desktopProfileRoots() by the target dir, so these pin the two primitives
// that behaviour rests on: an excluded profile is genuinely untouched, and the failure rollback
// restores only what this call flipped.

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveDesktopChat, archiveRootsForMove, desktopProfileRoots } from '../src/session-launch'

const notRunning = async () => false
const SID = 'sess-move-target'

function profileHolding(sessionId: string, archived: boolean): string {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-move-'))
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  writeFileSync(
    join(store, `local_${sessionId}.json`),
    JSON.stringify({ cliSessionId: sessionId, isArchived: archived }),
  )
  return profile
}

function isArchived(profile: string, sessionId: string): boolean {
  const p = join(profile, 'claude-code-sessions', 'org-1', 'user-1', `local_${sessionId}.json`)
  return JSON.parse(readFileSync(p, 'utf8')).isArchived
}

// The target arrives as the caller typed it, in `instance_ref: 'desktop:<dir>'`, while the root
// list is built by the daemon — so the two spellings routinely disagree on slash shape, trailing
// separator and case. samePathKey is what reconciles them, and if it ever fails to match, the
// target is archived again and the bug is back. Each variant below is a spelling seen in a real
// instance_ref on this fleet.
// Case folding is deliberately platform-shaped (path-key.ts): win32 folds, POSIX does not,
// because two paths differing only by case ARE different files there. So the lowercased
// spelling is a Windows-only expectation - asserting it on Linux would be asserting a bug.
const SPELLINGS: Array<[string, (d: string) => string]> = [
  ['as given', (d) => d],
  ['forward slashes', (d) => d.replace(/\\/g, '/')],
  ['trailing separator', (d) => `${d}\\`],
  ...(process.platform === 'win32'
    ? ([['lowercased', (d: string) => d.toLowerCase()]] as Array<[string, (d: string) => string]>)
    : []),
]

test.each(SPELLINGS)(
  'archiving every profile EXCEPT the target (%s) leaves the target visible',
  async (_n, spell) => {
    const source = profileHolding(SID, false)
    const target = profileHolding(SID, false)

    // The route's own decision function, against a target spelled the way a caller typed it.
    const roots = archiveRootsForMove(spell(target), [source, target])
    const r = await archiveDesktopChat(SID, true, roots, notRunning)

    expect(roots).toEqual([source]) // the filter really did drop the target
    expect(r.ok).toBe(true)
    expect(isArchived(source, SID)).toBe(true)
    // The whole bug in one assertion: the account the chat is moving TO keeps it visible.
    expect(isArchived(target, SID)).toBe(false)
  },
)

test('the old unfiltered call is what hid it — pinned so the regression is unmistakable', async () => {
  const source = profileHolding(SID, false)
  const target = profileHolding(SID, false)
  await archiveDesktopChat(SID, true, [source, target], notRunning)
  expect(isArchived(target, SID)).toBe(true) // <- the reproduced defect, kept as documentation
})

test('a failed landing restores only the rows this move flipped', async () => {
  const source = profileHolding(SID, false)
  // A third account archived this chat long ago and must stay that way: un-archiving with no
  // roots would resurrect it, so a failed move would un-hide twins it never touched.
  const stranger = profileHolding(SID, true)

  const archived0 = await archiveDesktopChat(SID, true, [source, stranger], notRunning)
  const flipped = archived0.hits.filter((h) => h.changed).map((h) => h.profile)
  expect(flipped).toEqual([source]) // stranger was already archived → not "changed"

  await archiveDesktopChat(SID, false, flipped, notRunning)
  expect(isArchived(source, SID)).toBe(false)
  expect(isArchived(stranger, SID)).toBe(true)
})

test('desktopProfileRoots lists real profile dirs, so the route can filter one out', () => {
  const roots = desktopProfileRoots()
  expect(Array.isArray(roots)).toBe(true)
  expect(roots.length).toBeGreaterThan(0)
  // The default install is always first; the isolated instances follow.
  expect(roots[0]!.toLowerCase()).toContain('claude')
})
