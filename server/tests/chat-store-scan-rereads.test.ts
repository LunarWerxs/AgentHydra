// The chat-store scan re-parses only the records that changed, and always the ones that did.
//
// Regression (2026-09-27): collectChats re-read and re-parsed EVERY record on every call - 3,395
// of them, 1.3 s on the daemon's one thread - and move_chats' migrate_batch polls it through
// /api/sessions/live?lineage=1 and /api/chats. /api/health went unanswered, and the tray watchdog
// tree-killed the daemon (and the batch with it) eight times in nine minutes. The scan runs here
// exactly as in production; the parses of this fixture's records are counted off the global
// JSON.parse by a marker only these records carry.
import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectChats, collectChatsAsync } from '../src/core/chat-store-scan'

const ROOT = mkdtempSync(join(tmpdir(), 'chat-store-rereads-'))
const MARK = 'rereads-fixture-'
const store = join(ROOT, 'profile', 'claude-code-sessions', 'acct-1', 'proj-1')
const parse = spyOn(JSON, 'parse')
const parsesOfFixture = () =>
  parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes(MARK)).length

afterAll(() => {
  parse.mockRestore()
  rmSync(ROOT, { recursive: true, force: true })
})

const record = (id: string, title: string) => {
  const path = join(store, `local_${id}.json`)
  writeFileSync(
    path,
    JSON.stringify({ cliSessionId: `${MARK}${id}`, title, isArchived: false, lastActivityAt: 1 }),
  )
  return path
}

test('a rescan re-parses only the records that changed, and still reads those', async () => {
  mkdirSync(store, { recursive: true })
  record('a', 'alpha')
  const beta = record('b', 'beta')
  record('c', 'gamma')
  // Past the racily-clean window (core/stat-stamp.ts RACY_MS), so an unchanged file may be reused.
  await Bun.sleep(1_100)
  const roots = [{ dir: join(ROOT, 'profile'), label: 'p' }]

  parse.mockClear()
  expect(
    collectChats(roots)
      .map((c) => c.title)
      .sort(),
  ).toEqual(['alpha', 'beta', 'gamma'])
  expect(parsesOfFixture()).toBe(3)

  parse.mockClear()
  expect(collectChats(roots)).toHaveLength(3)
  expect(parsesOfFixture()).toBe(0)

  // A same-size rewrite whose writer put the mtime back (as a stamp-preserving writer does) is
  // still read: a cached title here is the stale answer the dossier exists to catch.
  const before = statSync(beta)
  record('b', 'BETA')
  utimesSync(beta, before.atime, before.mtime)
  parse.mockClear()
  expect(collectChats(roots).find((c) => c.cliSessionId === `${MARK}b`)?.title).toBe('BETA')
  expect(parsesOfFixture()).toBe(1)

  // The async scan the routes answer from (so /api/health is never queued behind a stat per
  // record) is the same scan: the same rows from the same cache, and a changed record re-read.
  await Bun.sleep(1_100)
  collectChats(roots) // b was read inside its racy window above, so this scan reads it once more
  parse.mockClear()
  expect(await collectChatsAsync(roots)).toEqual(collectChats(roots))
  expect(parsesOfFixture()).toBe(0)
  record('c', 'GAMMA, rewritten')
  expect((await collectChatsAsync(roots)).find((c) => c.cliSessionId === `${MARK}c`)?.title).toBe(
    'GAMMA, rewritten',
  )
  expect(parsesOfFixture()).toBe(1)
})
