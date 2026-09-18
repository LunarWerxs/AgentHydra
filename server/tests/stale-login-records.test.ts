// server/tests/stale-login-records.test.ts - a chat record filed under an account the profile is
// no longer signed into is ON DISK and NOT ON SCREEN, and every question a move asks must say so.
//
// The desktop app files one record per chat at `claude-code-sessions/<accountUuid>/<orgUuid>/`
// and renders only the folder of config.json's `lastKnownAccountUuid`. On 2026-09-18 instance #12
// was re-logged into another account twenty minutes after four chats were moved in: the chats
// vanished from the app, and list_chats, chat_dossier and every move ("nothing to do: already
// lives here") went on reporting them present, because every scan globbed `*/*/local_*.json`
// across all account folders. These pin the tag, the visible-only residency read, the set-aside
// a re-home performs, and the cold landing's choice of folder.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectChats, listChats } from '../src/chat-dossier'
import { chooseStoreLeaf } from '../src/chat-settings-carry'
import {
  coldImportSessionToDesktop,
  findVisibleChatMetaPath,
  renderedInStore,
  restoreSetAsideRecords,
  setAsideStaleLoginRecords,
  staleLoginChatRecords,
} from '../src/session-launch'

const OLD = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const NOW = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const ORG = 'cccccccc-3333-4333-8333-cccccccccccc'
const OLD_ORG = 'dddddddd-4444-4444-8444-dddddddddddd'

/** A profile signed into NOW that still carries a leaf from its previous login, OLD. */
function profile(opts: { login?: string | null; oldIsNewer?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'stale-login-'))
  const login = opts.login === undefined ? NOW : opts.login
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(login ? { lastKnownAccountUuid: login } : { locale: 'en-US' }),
  )
  const oldLeaf = join(dir, 'claude-code-sessions', OLD, OLD_ORG)
  const nowLeaf = join(dir, 'claude-code-sessions', NOW, ORG)
  mkdirSync(oldLeaf, { recursive: true })
  mkdirSync(nowLeaf, { recursive: true })
  // The four chats that vanished: unarchived, filed under the previous login.
  writeFileSync(
    join(oldLeaf, 'local_rusttor-id.json'),
    JSON.stringify({
      cliSessionId: 'rusttor-id',
      title: 'RustTor',
      isArchived: false,
      lastActivityAt: opts.oldIsNewer ? 9_000 : 1_000,
    }),
  )
  // A chat the app does show.
  writeFileSync(
    join(nowLeaf, 'local_visible-id.json'),
    JSON.stringify({
      cliSessionId: 'visible-id',
      title: 'Odin scan',
      isArchived: false,
      lastActivityAt: 5_000,
    }),
  )
  return dir
}

test('every record is tagged with its account folder and whether the app shows it', () => {
  const dir = profile()
  const chats = collectChats([{ dir, label: 'twelve' }])
  const stale = chats.find((c) => c.title === 'RustTor')
  const shown = chats.find((c) => c.title === 'Odin scan')
  expect(stale?.accountUuid).toBe(OLD)
  expect(stale?.loginUuid).toBe(NOW)
  expect(stale?.staleLogin).toBe(true)
  expect(shown?.staleLogin).toBe(false)
})

test('an unknown signed-in account is null, never a guess in either direction', () => {
  const dir = profile({ login: null })
  for (const c of collectChats([{ dir, label: 'signed-out' }])) expect(c.staleLogin).toBeNull()
})

test('list_chats counts the unarchived chats the owner cannot see, and flags each row', () => {
  const dir = profile()
  const got = listChats(
    {},
    { roots: [{ dir, label: 'twelve' }], liveIds: new Map(), markFor: () => null },
  )
  expect(got.counts.unarchived).toBe(2)
  expect(got.counts.staleLogin).toBe(1)
  expect(got.rows.find((r) => r.title === 'RustTor')?.staleLogin).toBe(true)
  expect(got.rows.find((r) => r.title === 'Odin scan')?.staleLogin).toBe(false)
})

test('a record under a previous login is not "already here" and does not verify a landing', () => {
  const dir = profile()
  // The exact answer that turned four re-homes into "nothing to do".
  expect(findVisibleChatMetaPath(dir, 'rusttor-id')).toBeNull()
  expect(renderedInStore(dir, 'rusttor-id')).toBeNull()
  expect(renderedInStore(dir, 'visible-id')?.path).toContain(NOW)
  expect(staleLoginChatRecords(dir, 'rusttor-id')).toHaveLength(1)
  expect(staleLoginChatRecords(dir, 'visible-id')).toHaveLength(0)
})

test('with the signed-in account unknown, residency answers as it always did', () => {
  const dir = profile({ login: null })
  expect(findVisibleChatMetaPath(dir, 'rusttor-id')).toContain(OLD)
  expect(staleLoginChatRecords(dir, 'rusttor-id')).toHaveLength(0)
})

test('set-aside moves the stale record into a backup and restore puts it back', () => {
  const dir = profile()
  const backupRoot = mkdtempSync(join(tmpdir(), 'stale-login-backup-'))
  const original = staleLoginChatRecords(dir, 'rusttor-id')[0]
  const body = readFileSync(original, 'utf8')
  const moved = setAsideStaleLoginRecords(dir, 'rusttor-id', { backupRoot, now: () => 0 })
  expect(moved).toHaveLength(1)
  expect(existsSync(original)).toBe(false)
  expect(readFileSync(moved[0].to, 'utf8')).toBe(body)
  expect(moved[0].to).toContain(OLD)
  expect(restoreSetAsideRecords(moved)).toBe(1)
  expect(readFileSync(original, 'utf8')).toBe(body)
  // Restoring never overwrites a record that has since taken the old place.
  const again = setAsideStaleLoginRecords(dir, 'rusttor-id', { backupRoot, now: () => 1 })
  writeFileSync(original, '{"cliSessionId":"rusttor-id","title":"newer"}')
  expect(restoreSetAsideRecords(again)).toBe(0)
  expect(JSON.parse(readFileSync(original, 'utf8')).title).toBe('newer')
})

test('a new record goes in the SIGNED-IN account folder even when the old one was touched later', () => {
  // Minutes after a re-login the previous account's leaf still holds the newest activity; the
  // old recency guess put a cold landing there, invisible.
  const dir = profile({ oldIsNewer: true })
  expect(chooseStoreLeaf(dir)).toBe(join(dir, 'claude-code-sessions', NOW, ORG))
  const unknown = profile({ login: null, oldIsNewer: true })
  expect(chooseStoreLeaf(unknown)).toBe(join(unknown, 'claude-code-sessions', OLD, OLD_ORG))
})

test('a cold re-home lands where the app looks and leaves no stale twin behind', async () => {
  const dir = profile({ oldIsNewer: true })
  const backupRoot = mkdtempSync(join(tmpdir(), 'stale-login-backup-'))
  const got = await coldImportSessionToDesktop({
    sessionId: 'rusttor-id',
    instanceDir: dir,
    title: 'RustTor',
    sourceMeta: { cliSessionId: 'rusttor-id', title: 'RustTor', model: 'opus' },
    force: true,
    isLive: () => false,
    isInstanceRunning: async () => false,
    setAsideStale: (d, s) => setAsideStaleLoginRecords(d, s, { backupRoot }),
  })
  expect(got.ok).toBe(true)
  expect(got.alreadyRendered).toBeUndefined()
  expect(got.path).toBe(join(dir, 'claude-code-sessions', NOW, ORG, 'local_rusttor-id.json'))
  expect(got.staleLoginSetAside).toHaveLength(1)
  expect(staleLoginChatRecords(dir, 'rusttor-id')).toHaveLength(0)
  expect(renderedInStore(dir, 'rusttor-id')?.path).toBe(got.path)
})

test('an account uuid spelled in another case is the same account, not a stale login', () => {
  const dir = profile({ login: NOW.toUpperCase() })
  const shown = collectChats([{ dir, label: 'twelve' }]).find((c) => c.title === 'Odin scan')
  expect(shown?.staleLogin).toBe(false)
  expect(findVisibleChatMetaPath(dir, 'visible-id')).not.toBeNull()
  expect(staleLoginChatRecords(dir, 'visible-id')).toHaveLength(0)
})

test('a signed-in account with no chat folder yet is refused honestly, never landed elsewhere', async () => {
  const dir = profile({ login: 'ffffffff-0000-0000-0000-000000000000' })
  const got = await coldImportSessionToDesktop({
    sessionId: 'rusttor-id',
    instanceDir: dir,
    title: 'RustTor',
    sourceMeta: { cliSessionId: 'rusttor-id', title: 'RustTor' },
    force: true,
    isLive: () => false,
    isInstanceRunning: async () => false,
    setAsideStale: () => [],
  })
  expect(got.ok).toBe(false)
  expect(got.reason).toContain('has no chat folder yet')
  expect(got.reason).not.toContain('never signed in')
})
