// reassertChatArchive is CANCELLABLE, and an unarchive is what cancels it.
//
// ⛔ THE BUG THESE PIN (measured live 2026-09-18, instance 56 / chat d9fc4886). The archive route
// already refused to FIRE the watcher on an unarchive - there is a good comment in
// desktop-sessions.ts saying why. What nobody handled is the watcher an EARLIER archive left
// running: it lives ten minutes, and inside that window it reverted every unarchive within ~1.5s
// while the route answered ok:true / changed:true. Three archive_desktop_chat calls AND a
// hand-written flip of the JSON were all lost, and daemon.log blamed "the app's re-save" four
// times for an app that was CLOSED for three of them.
//
// So: a watcher that cannot be called off is a bug, and a `changed:true` that does not survive the
// next second is a lie. These tests fail against the pre-2026-09-18 code.

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cancelChatArchiveReassert, reassertChatArchive } from '../src/session-launch'

const SESSION = 'd9fc4886-acc0-466f-ac71-a8238dd5ce3b'

/** A profile holding one chat record, in the store shape findChatMetaPath walks. */
function profileWithChat(isArchived: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-archive-cancel-'))
  const leaf = join(dir, 'claude-code-sessions', 'root-uuid', 'leaf-uuid')
  mkdirSync(leaf, { recursive: true })
  writeFileSync(
    join(leaf, `local_${SESSION}.json`),
    JSON.stringify({ cliSessionId: SESSION, title: 'Stackspire nitpicks and physics', isArchived }),
  )
  return dir
}

function readFlag(dir: string): boolean {
  const p = join(dir, 'claude-code-sessions', 'root-uuid', 'leaf-uuid', `local_${SESSION}.json`)
  return JSON.parse(readFileSync(p, 'utf8')).isArchived === true
}

function setFlag(dir: string, isArchived: boolean): void {
  const p = join(dir, 'claude-code-sessions', 'root-uuid', 'leaf-uuid', `local_${SESSION}.json`)
  const meta = JSON.parse(readFileSync(p, 'utf8'))
  meta.isArchived = isArchived
  writeFileSync(p, JSON.stringify(meta))
}

test('a cancelled watcher stops restoring, so a deliberate unarchive survives', async () => {
  const dir = profileWithChat(true)
  let ticks = 0
  // Unarchive on tick 2 (as the owner would), then cancel - exactly the live sequence.
  const watching = reassertChatArchive(dir, SESSION, {
    windowMs: 10_000,
    intervalMs: 1,
    maxRestores: 8,
    sleep: async () => {
      ticks++
      if (ticks === 2) {
        setFlag(dir, false)
        cancelChatArchiveReassert(dir, SESSION)
      }
    },
    now: () => ticks * 1_000,
  })
  const restores = await watching
  // Pre-fix this is 1 (or more) and the flag reads true: the watcher won the fight it should
  // have conceded the moment the owner said otherwise.
  expect(restores).toBe(0)
  expect(readFlag(dir)).toBe(false)
})

test('cancel reports whether a watcher was actually running', async () => {
  const dir = profileWithChat(true)
  expect(cancelChatArchiveReassert(dir, SESSION)).toBe(false) // nothing armed yet
  let ticks = 0
  // Collected rather than assigned: TS cannot see that the callback ran, so a `let` here narrows
  // to its initialiser and the assertion stops compiling.
  const sawLive: boolean[] = []
  await reassertChatArchive(dir, SESSION, {
    windowMs: 10_000,
    intervalMs: 1,
    sleep: async () => {
      ticks++
      if (ticks === 1) sawLive.push(cancelChatArchiveReassert(dir, SESSION))
    },
    now: () => ticks * 1_000,
  })
  expect(sawLive).toEqual([true])
  // And once it has ended, cancelling again is honest about there being nothing to stop.
  expect(cancelChatArchiveReassert(dir, SESSION)).toBe(false)
})

test('an uncancelled watcher still defends the flag - the fix must not disarm the real job', async () => {
  const dir = profileWithChat(true)
  let ticks = 0
  const restores = await reassertChatArchive(dir, SESSION, {
    windowMs: 10_000,
    intervalMs: 1,
    maxRestores: 8,
    // The APP flipping it back is the case this watcher exists for; nobody cancelled, so it wins.
    sleep: async () => {
      ticks++
      if (ticks === 2) setFlag(dir, false)
    },
    now: () => ticks * 1_000,
  })
  expect(restores).toBe(1)
  expect(readFlag(dir)).toBe(true)
})

test('a second watcher stands the first one down instead of racing it', async () => {
  const dir = profileWithChat(true)
  let ticks = 0
  // First watcher: long window, would normally keep running.
  const first = reassertChatArchive(dir, SESSION, {
    windowMs: 10_000,
    intervalMs: 1,
    sleep: async () => {
      ticks++
    },
    now: () => ticks * 100,
  })
  // Second watcher for the SAME chat supersedes it. windowMs:0 means it registers (which is what
  // stands the first one down) and then exits at once, without a tick of its own.
  const second = reassertChatArchive(dir, SESSION, {
    windowMs: 0,
    intervalMs: 1,
    sleep: async () => {},
    now: () => 1_000_000,
  })
  await second
  await first
  // The first returned rather than hanging on: superseded, not duplicated.
  expect(cancelChatArchiveReassert(dir, SESSION)).toBe(false)
})
