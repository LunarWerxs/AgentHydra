// server/tests/move-lands-before-it-archives.test.ts - the three primitives POST /migrate rests
// on now that it lands a chat FIRST, verifies the landing by read-back, and only then archives
// the source (server/src/session-launch.ts).
//
// The route used to archive the source before importing, and treated the hot import's ok as
// proof of landing. It is not: stampImportedChat's 20s wait ends `false` for "the app never
// created the row", the importer maps that to `titled: false`, and the route answered moved.
// Every failure of the app-side import - a target app busy with the previous chat of a bulk
// move, an engine the source app respawned so the import was refused as a live writer - left
// the chat archived on the old account, absent from the new one, and counted as moved
// (2026-09-08, "it's not moving all the chats"). These pin the read-back that replaces that
// word, the target-scoped residency read that makes retrying safe, and the un-hide of a record
// the target already held.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  awaitChatRecord,
  importSessionToDesktop,
  renderedInStore,
  unarchiveChatRecord,
} from '../src/session-launch'

// The importer test below must never launch anything: if the target-scoped residency read ever
// failed to see the record, the importer would go for the spawn, and this turns that into a
// `spawn-failed` result instead of a fifth desktop app on an empty profile.
const realSpawn = Bun.spawn
let spawnAttempts = 0
beforeEach(() => {
  spawnAttempts = 0
  ;(Bun as unknown as { spawn: unknown }).spawn = () => {
    spawnAttempts++
    throw new Error('this suite must never launch anything')
  }
})
afterEach(() => {
  ;(Bun as unknown as { spawn: unknown }).spawn = realSpawn
  expect(spawnAttempts).toBe(0)
})

/** A scratch instance dir with one store leaf; returns the dir and the leaf. */
function scratchInstance(): { dir: string; leaf: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ah-lands-first-'))
  const leaf = join(dir, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(leaf, { recursive: true })
  return { dir, leaf }
}

test('renderedInStore answers from the TARGET store alone: absent, imported shape, app-made shape', () => {
  const { dir, leaf } = scratchInstance()
  try {
    const sid = `sid-${crypto.randomUUID()}`
    expect(renderedInStore(dir, sid)).toBeNull()
    // The app's own filename with the CLI id inside - the shape a chat the owner started has.
    writeFileSync(
      join(leaf, 'local_app-made.json'),
      JSON.stringify({ cliSessionId: sid, isArchived: false }),
    )
    expect(renderedInStore(dir, sid)).toEqual({
      archived: false,
      path: join(leaf, 'local_app-made.json'),
    })
    // The imported shape, flagged archived: found, and reported as not on screen.
    const other = `sid-${crypto.randomUUID()}`
    writeFileSync(join(leaf, `local_${other}.json`), JSON.stringify({ isArchived: true }))
    expect(renderedInStore(dir, other)).toEqual({
      archived: true,
      path: join(leaf, `local_${other}.json`),
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderedInStore does not see a record that sits in ANOTHER profile', () => {
  const a = scratchInstance()
  const b = scratchInstance()
  try {
    const sid = `sid-${crypto.randomUUID()}`
    writeFileSync(join(a.leaf, `local_${sid}.json`), JSON.stringify({ isArchived: false }))
    expect(renderedInStore(a.dir, sid)).not.toBeNull()
    expect(renderedInStore(b.dir, sid)).toBeNull()
  } finally {
    rmSync(a.dir, { recursive: true, force: true })
    rmSync(b.dir, { recursive: true, force: true })
  }
})

test('the importer reads residency off the target store: a live copy already there means no spawn', async () => {
  // No findRendered seam injected - this is the DEFAULT the route runs with. The record is under
  // the target dir, so the importer must take its "already renders here" exit before Bun.spawn.
  const { dir, leaf } = scratchInstance()
  try {
    const sid = `sid-${crypto.randomUUID()}`
    writeFileSync(join(leaf, `local_${sid}.json`), JSON.stringify({ isArchived: false }))
    const r = await importSessionToDesktop({
      sessionId: sid,
      instanceDir: dir,
      title: 'A real name',
      isLive: () => false,
      isInstanceRunning: async () => true,
    })
    expect(r.ok).toBe(true)
    expect(r.alreadyRendered).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('awaitChatRecord returns the path at once when the record exists', async () => {
  const { dir, leaf } = scratchInstance()
  try {
    const sid = `sid-${crypto.randomUUID()}`
    const path = join(leaf, `local_${sid}.json`)
    writeFileSync(path, JSON.stringify({ isArchived: false }))
    let slept = 0
    const got = await awaitChatRecord(dir, sid, {
      sleep: async () => {
        slept++
      },
    })
    expect(got).toBe(path)
    expect(slept).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('awaitChatRecord returns null at the deadline when the app never creates the record', async () => {
  const { dir } = scratchInstance()
  try {
    let clock = 1_000
    let polls = 0
    const got = await awaitChatRecord(dir, `sid-${crypto.randomUUID()}`, {
      deadlineMs: 2_000,
      intervalMs: 500,
      now: () => clock,
      sleep: async (ms) => {
        polls++
        clock += ms
      },
    })
    expect(got).toBeNull()
    // 2000ms of deadline at 500ms intervals: four sleeps, then the fifth poll sees the deadline.
    expect(polls).toBe(4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('awaitChatRecord picks the record up when it appears between polls', async () => {
  const { dir, leaf } = scratchInstance()
  try {
    const sid = `sid-${crypto.randomUUID()}`
    const path = join(leaf, `local_${sid}.json`)
    let clock = 0
    let polls = 0
    const got = await awaitChatRecord(dir, sid, {
      deadlineMs: 10_000,
      intervalMs: 500,
      now: () => clock,
      sleep: async (ms) => {
        polls++
        clock += ms
        // The app creates the row on the third tick.
        if (polls === 3) writeFileSync(path, JSON.stringify({ isArchived: false }))
      },
    })
    expect(got).toBe(path)
    expect(polls).toBe(3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unarchiveChatRecord flips exactly one archived record, and leaves a visible one untouched', () => {
  const { leaf } = scratchInstance()
  try {
    const hidden = join(leaf, 'local_hidden.json')
    writeFileSync(hidden, JSON.stringify({ cliSessionId: 'h', isArchived: true, title: 'kept' }))
    expect(unarchiveChatRecord(hidden)).toBe(true)
    const after = JSON.parse(readFileSync(hidden, 'utf8'))
    expect(after.isArchived).toBe(false)
    expect(after.title).toBe('kept') // the rest of the record survives the flip

    const visible = join(leaf, 'local_visible.json')
    writeFileSync(visible, JSON.stringify({ cliSessionId: 'v', isArchived: false }))
    const before = statSync(visible).mtimeMs
    expect(unarchiveChatRecord(visible)).toBe(false)
    expect(statSync(visible).mtimeMs).toBe(before) // nothing written

    writeFileSync(join(leaf, 'local_garbage.json'), '{not json')
    expect(unarchiveChatRecord(join(leaf, 'local_garbage.json'))).toBe(false)
    expect(unarchiveChatRecord(join(leaf, 'local_missing.json'))).toBe(false)
  } finally {
    rmSync(join(leaf, '..', '..', '..'), { recursive: true, force: true })
  }
})
