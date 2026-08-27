// server/tests/orchestrator-renames.test.ts - who owns a chat's NAME, pinned.
//
// A title written to disk is durable for a CLOSED instance and futile for a RUNNING one: the app
// holds its chat list in memory and re-saves the file when the chat next boots, so the sidebar
// keeps the old name until that app restarts (measured 2026-08-26: five chats imported with
// correct titles, all five wiped seconds after they were first messaged). The reviewer renames
// through the app itself, which is instant and which the app cannot overwrite.
//
// The subtle requirement, and the reason this list is PERSISTED rather than recomputed each pass:
// the sweep only reports what it CHANGED. Once the title is on disk the next sweep correctly skips
// that chat, so a recomputed list would empty itself within one cycle and the reviewer would never
// see the work. The tests below pin that, and pin the three ways an entry legitimately leaves.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addPendingRename,
  clearPendingRename,
  listPendingRenames,
  reconcilePendingRenames,
} from '../src/orchestrator'
import { normalizeRef } from '../src/placements'
import { sweepUntitledDesktopChats } from '../src/session-launch'

const NOW = Date.parse('2026-08-27T05:00:00Z')
const RUNNING = 'desktop:c:\\i\\rn-running'
const CLOSED = 'desktop:c:\\i\\rn-closed'
const running = () => new Set([normalizeRef(RUNNING) as string])

/** Start from empty: these tests share one settings/kv database. */
function reset() {
  for (const r of listPendingRenames()) clearPendingRename(r.sessionId)
}

test('only chats inside a RUNNING app need a native rename', () => {
  reset()
  const kept = reconcilePendingRenames(
    [
      { ref: RUNNING, sessionId: 'rn-1', title: 'Ship the parser' },
      // The disk write IS the durable answer for a closed instance: its app will simply read the
      // new name at its next start. Listing it would ask the reviewer to redo work already done.
      { ref: CLOSED, sessionId: 'rn-2', title: 'Fix the importer' },
    ],
    running(),
    NOW,
  )
  expect(kept.map((r) => r.sessionId)).toEqual(['rn-1'])
  expect(kept[0].title).toBe('Ship the parser')
  expect(listPendingRenames().map((r) => r.sessionId)).toEqual(['rn-1'])
})

test('a re-swept chat keeps its ORIGINAL timestamp, so the expiry measures how long it has waited', () => {
  reset()
  reconcilePendingRenames([{ ref: RUNNING, sessionId: 'rn-3', title: 'A' }], running(), NOW)
  const first = listPendingRenames()[0].at

  // Ten minutes later the janitor sees it again. If the timestamp reset on every pass, an entry
  // could never expire and a stale rename would sit in the feed forever.
  const later = NOW + 10 * 60_000
  reconcilePendingRenames([{ ref: RUNNING, sessionId: 'rn-3', title: 'A' }], running(), later)
  expect(listPendingRenames()[0].at).toBe(first)
})

test('an entry leaves when the reviewer reports the rename done', () => {
  reset()
  reconcilePendingRenames(
    [
      { ref: RUNNING, sessionId: 'rn-4', title: 'A' },
      { ref: RUNNING, sessionId: 'rn-5', title: 'B' },
    ],
    running(),
    NOW,
  )
  expect(clearPendingRename('rn-4')).toBe(1)
  expect(listPendingRenames().map((r) => r.sessionId)).toEqual(['rn-5'])
  // Clearing something that is not listed is a no-op, not an error: the reviewer may report a
  // rename the janitor never queued (the owner renamed it by hand first).
  expect(clearPendingRename('rn-never')).toBe(0)
})

test('an entry leaves when its app is no longer running, and when it goes stale', () => {
  reset()
  reconcilePendingRenames([{ ref: RUNNING, sessionId: 'rn-6', title: 'A' }], running(), NOW)
  // That instance shut down. Its app will read the disk title at its next start, so the native
  // rename is no longer needed and asking for one would be asking for nothing.
  expect(reconcilePendingRenames([], new Set<string>(), NOW)).toEqual([])

  reconcilePendingRenames([{ ref: RUNNING, sessionId: 'rn-7', title: 'A' }], running(), NOW)
  const eightDays = NOW + 8 * 24 * 3600 * 1000
  expect(reconcilePendingRenames([], running(), eightDays)).toEqual([])
  reset()
})

test('the seed parks the title it ASKED for, and re-parking replaces rather than duplicates', () => {
  reset()
  addPendingRename(RUNNING, 'rn-seed', 'Ship the parser')
  expect(listPendingRenames().map((r) => [r.sessionId, r.title])).toEqual([
    ['rn-seed', 'Ship the parser'],
  ])

  // Seeding again over the same id must not leave two entries fighting over one chat.
  addPendingRename(RUNNING, 'rn-seed', 'Ship the parser, take two')
  const now = listPendingRenames()
  expect(now.length).toBe(1)
  expect(now[0].title).toBe('Ship the parser, take two')

  // A blank title is not a rename request.
  addPendingRename(RUNNING, 'rn-blank', '   ')
  expect(listPendingRenames().some((r) => r.sessionId === 'rn-blank')).toBe(false)
  reset()
})

/** A desktop store with one chat, so the janitor can be pointed at it. */
function storeWith(title: string, cliSessionId: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ah-titles-'))
  const dir = join(root, 'claude-code-sessions', 'org', 'user')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `local_${cliSessionId}.json`),
    JSON.stringify({ sessionId: `local_${cliSessionId}`, cliSessionId, title }),
  )
  return root
}

function titleIn(root: string, cliSessionId: string): string {
  const p = join(root, 'claude-code-sessions', 'org', 'user', `local_${cliSessionId}.json`)
  return JSON.parse(readFileSync(p, 'utf8')).title ?? ''
}

test("AgentHydra's own seed preamble is never a chat's name", () => {
  // The owner found both halves of this on his sidebar 2026-08-27. A seeded chat's first user
  // message is fabricated plumbing, and the title scanner derives titles from the first user
  // message, so the plumbing was naming the chats.
  const PLUMBING =
    '[orchestrator] This thread was seeded by AgentHydra for a new task. The task prompt arrives next.'

  // (a) A chat already WEARING a plumbing title is replaceable, exactly like "Untitled".
  const a = storeWith(PLUMBING, 'sid-a')
  expect(sweepUntitledDesktopChats(() => 'Fix the importer', [a]).fixed).toBe(1)
  expect(titleIn(a, 'sid-a')).toBe('Fix the importer')

  // (b) A plumbing string offered AS the better title is refused, so the janitor cannot swap a
  //     useless name for the same useless name and call the chat fixed.
  const b = storeWith('Untitled', 'sid-b')
  expect(sweepUntitledDesktopChats(() => PLUMBING, [b]).fixed).toBe(0)
  expect(titleIn(b, 'sid-b')).toBe('Untitled')

  // (c) A real title is still left alone.
  const c = storeWith('Ship the parser', 'sid-c')
  expect(sweepUntitledDesktopChats(() => 'Something else', [c]).fixed).toBe(0)
  expect(titleIn(c, 'sid-c')).toBe('Ship the parser')
})
