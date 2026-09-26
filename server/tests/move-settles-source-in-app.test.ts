// A MOVE HAS TO TAKE THE CHAT OFF THE OLD ACCOUNT'S SCREEN, NOT JUST ITS DISK (owner report,
// 2026-09-26: "all it does is copy those chats to another account. They're still in the old one").
//
// POST /api/sessions/:id/migrate - the Instances "Move chats to account" menu and the Sessions
// migrate - settled the source with a disk flag alone. A running app keeps its chat list in memory
// and re-saves its own copy of each record, so the chat stayed in the old sidebar; and because the
// store now said "archived", the next move from that account answered "No chats to move" for chats
// the owner was looking at. settleMovedSource (server/src/move-source-settle.ts) is the order the
// route now follows. These pin each branch of it with every route faked, so nothing here touches a
// real profile or app.

import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countChatsByProfile } from '../src/chat-dossier'
import type { NativeArchiveOutcome } from '../src/claude-native-archive'
import { collectChats } from '../src/core/chat-store-scan'
import { type SettleDeps, settleMovedSource } from '../src/move-source-settle'
import type { UiArchiveOutcome } from '../src/ui-archive'

const SID = 'aaaaaaaa-1111-2222-3333-444444444444'
const SOURCE = 'C:\\instances\\source'

const verified: NativeArchiveOutcome = {
  kind: 'result',
  route: 'native',
  ok: true,
  verified: true,
  changed: true,
  dispatch: 'sent',
  timingsMs: { total: 5 },
}
const refused: NativeArchiveOutcome = {
  kind: 'result',
  route: 'native',
  ok: false,
  verified: false,
  changed: false,
  dispatch: 'not-sent',
  reason: 'session has live, pending, or transitioning work',
  timingsMs: { total: 5 },
}
const unavailable: NativeArchiveOutcome = {
  kind: 'unavailable',
  route: 'native',
  dispatch: 'not-sent',
  reason: 'Native control is not configured for this profile',
}

/** Every route faked, and every call to it recorded, so a test can say what was NOT done. */
function harness(opts: {
  running?: boolean
  native?: NativeArchiveOutcome
  ui?: UiArchiveOutcome
  diskArchived?: boolean | null
  carriers?: string[]
}) {
  const calls = {
    native: [] as Array<{ profile: string; leaving: string[] }>,
    flag: [] as string[],
    watch: [] as string[],
    ui: [] as string[],
  }
  const deps: SettleDeps = {
    carriers: (_id, roots) => opts.carriers ?? roots,
    diskArchived: () => opts.diskArchived ?? false,
    isRunning: async () => opts.running ?? false,
    native: async (profile, _id, o) => {
      calls.native.push({ profile, leaving: o.leavingCliSessionIds })
      return opts.native ?? unavailable
    },
    flag: async (_id, profile) => {
      calls.flag.push(profile)
      return { hits: [{ profile, changed: opts.diskArchived !== true }] }
    },
    watch: (profile) => {
      calls.watch.push(profile)
    },
    ui: async (profile) => {
      calls.ui.push(profile)
      return opts.ui ?? { clicked: true, verified: true }
    },
  }
  return { deps, calls }
}

test('a CLOSED old account gets the flag alone: its app reads the store when it next starts', async () => {
  const { deps, calls } = harness({ running: false })
  const [row] = await settleMovedSource(SID, [SOURCE], [], deps)
  expect(row).toEqual({ profile: SOURCE, via: 'flag', changed: true, stillShown: false })
  expect(calls.native).toEqual([])
  expect(calls.ui).toEqual([])
  expect(calls.watch).toEqual([])
})

test('a RUNNING old account is archived by its own app, and no flag is written under it', async () => {
  const { deps, calls } = harness({ running: true, native: verified })
  const [row] = await settleMovedSource(SID, [SOURCE], [], deps)
  expect(row).toEqual({ profile: SOURCE, via: 'native', changed: true, stillShown: false })
  expect(calls.native.map((c) => c.profile)).toEqual([SOURCE])
  // The app wrote its own record; a flag or a click on top would only race it.
  expect(calls.flag).toEqual([])
  expect(calls.ui).toEqual([])
})

test('a native REFUSAL is final: no flag, no click, and the account is reported as still showing it', async () => {
  const { deps, calls } = harness({ running: true, native: refused })
  const [row] = await settleMovedSource(SID, [SOURCE], [], deps)
  expect(row).toEqual({
    profile: SOURCE,
    via: 'native',
    changed: false,
    stillShown: true,
    reason: 'session has live, pending, or transitioning work',
  })
  // The runbook rule (AGENTS.md): a native refusal never triggers a disk-flag edit or a UI
  // fallback. It also keeps the store agreeing with the screen, which is what lets the next move
  // from that account find the chat instead of answering "No chats to move".
  expect(calls.flag).toEqual([])
  expect(calls.ui).toEqual([])
  expect(calls.watch).toEqual([])
})

test('native UNAVAILABLE takes the legacy path /desktop-archive takes: flag, watcher, the app control', async () => {
  const { deps, calls } = harness({ running: true, native: unavailable })
  const [row] = await settleMovedSource(SID, [SOURCE], [], deps)
  expect(row).toEqual({ profile: SOURCE, via: 'ui', changed: true, stillShown: false })
  expect(calls.flag).toEqual([SOURCE])
  expect(calls.watch).toEqual([SOURCE])
  expect(calls.ui).toEqual([SOURCE])
})

test('an unsettled click on the legacy path says the chat is still shown, and why', async () => {
  const { deps } = harness({
    running: true,
    native: unavailable,
    ui: { clicked: false, verified: false, reason: 'the row is not rendered' },
  })
  const [row] = await settleMovedSource(SID, [SOURCE], [], deps)
  expect(row).toEqual({
    profile: SOURCE,
    via: 'flag',
    changed: true,
    stillShown: true,
    reason: 'the row is not rendered',
  })
})

test('the batch list reaches the native archive, minus the chat itself', async () => {
  // Without it, a sibling's preview server in the same folder refuses every archive of a batch.
  const { deps, calls } = harness({ running: true, native: verified })
  await settleMovedSource(SID, [SOURCE], [SID, 'bbbbbbbb-1', 'cccccccc-2'], deps)
  expect(calls.native[0]?.leaving).toEqual(['bbbbbbbb-1', 'cccccccc-2'])
})

test('an older leftover already archived on disk is not reported as shown when native cannot confirm', async () => {
  const { deps } = harness({ running: true, native: refused, diskArchived: true })
  const [row] = await settleMovedSource(SID, [SOURCE], [], deps)
  expect(row?.stillShown).toBe(false)
  expect(row?.alreadyArchived).toBe(true)
})

test('only carriers are visited, and a route that throws still yields a row instead of a throw', async () => {
  const other = 'C:\\instances\\other'
  const { deps } = harness({ running: true, carriers: [SOURCE] })
  deps.native = async () => {
    throw new Error('inspector exploded')
  }
  const rows = await settleMovedSource(SID, [SOURCE, other], [], deps)
  expect(rows.map((r) => r.profile)).toEqual([SOURCE])
  expect(rows[0]).toMatchObject({ stillShown: true, reason: 'inspector exploded' })
})

// --- the number beside "Chats" --------------------------------------------------------------

const ROOT = mkdtempSync(join(tmpdir(), 'ah-chat-counts-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

function profileWith(name: string, chats: Array<{ id: string; archived: boolean }>): string {
  const dir = join(ROOT, name)
  const store = join(dir, 'claude-code-sessions', 'acct-1', 'org-1')
  mkdirSync(store, { recursive: true })
  for (const c of chats)
    writeFileSync(
      join(store, `local_${c.id}.json`),
      JSON.stringify({ cliSessionId: c.id, isArchived: c.archived }),
    )
  return dir
}

test('countChatsByProfile counts active and archived per dir, and an empty account is a real 0', () => {
  const busy = profileWith('busy', [
    { id: 'a1', archived: false },
    { id: 'a2', archived: false },
    { id: 'a3', archived: true },
  ])
  const quiet = profileWith('quiet', [{ id: 'q1', archived: true }])
  const empty = join(ROOT, 'never-used')
  mkdirSync(empty, { recursive: true })

  const counts = countChatsByProfile([busy, quiet, empty], collectChats)
  expect(counts[busy]).toEqual({ active: 2, archived: 1 })
  // Everything archived: the badge reads 0, which is the whole point of it.
  expect(counts[quiet]).toEqual({ active: 0, archived: 1 })
  expect(counts[empty]).toEqual({ active: 0, archived: 0 })
})
