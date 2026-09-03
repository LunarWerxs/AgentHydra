// tests/chat-settings-carry.test.ts - what follows a chat across a migration, and what must not.
//
// The measured failure (16 chats, 2026-09-03): effort, ultracode and the Chrome permission mode
// arrived reset, and the owner put each back by hand. The properties pinned here: the carried set
// is exactly the person's settings; permissionMode is NOT carried (the bypass stamp owns it);
// connector ids never cross accounts; a cold record is the source minus its account and its moment,
// re-identified as an import; and the store leaf chosen is the account signed in NOW.

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyCarriedSettings,
  buildColdImportRecord,
  carriedSettingsMatch,
  chooseStoreLeaf,
  pickCarriedSettings,
} from '../server/src/chat-settings-carry'

const source = {
  sessionId: 'app-own-id-123',
  cliSessionId: 'abc-123',
  cwd: 'C:\\repo',
  originCwd: 'C:\\repo',
  createdAt: 1000,
  lastActivityAt: 2000,
  lastFocusedAt: 1500,
  model: 'claude-opus-5',
  effort: 'xhigh',
  chromePermissionMode: 'skip_all_permission_checks',
  sessionSettings: { ultracode: true },
  alwaysAllowedReasons: ['x'],
  sessionPermissionUpdates: [{ tool: 'Bash' }],
  permissionMode: 'acceptEdits',
  isArchived: true,
  title: 'Old title',
  titleSource: 'auto',
  enabledMcpTools: ['srv-a:tool1', 'srv-a:tool2'],
  remoteMcpServersConfig: { 'srv-a': {} },
  remoteControlAutoEligible: false,
  error: 'boom',
  errorAt: 3000,
  indexedAt: 4000,
  completedTurns: 7,
}

test("pickCarriedSettings takes the person's settings and nothing else", () => {
  const carried = pickCarriedSettings(source)
  expect(carried).toEqual({
    model: 'claude-opus-5',
    effort: 'xhigh',
    chromePermissionMode: 'skip_all_permission_checks',
    sessionSettings: { ultracode: true },
    alwaysAllowedReasons: ['x'],
    sessionPermissionUpdates: [{ tool: 'Bash' }],
  })
  // permissionMode is the bypass stamp's, not ours; connector ids are the source account's.
  expect('permissionMode' in carried).toBe(false)
  expect('enabledMcpTools' in carried).toBe(false)
})

test('a source that never set a value says nothing about it', () => {
  expect(pickCarriedSettings({ model: 'claude-opus-5' })).toEqual({ model: 'claude-opus-5' })
  expect(pickCarriedSettings({ effort: null })).toEqual({})
})

test('applyCarriedSettings writes over the target without touching what it does not carry', () => {
  const target = {
    cliSessionId: 'abc-123',
    permissionMode: 'bypassPermissions',
    model: 'claude-opus-5',
    sessionSettings: { ultracode: false, somethingTargetSide: 1 },
    enabledMcpTools: ['srv-b:tool9'],
  }
  const out = applyCarriedSettings(target, pickCarriedSettings(source))
  expect(out.effort).toBe('xhigh')
  expect(out.chromePermissionMode).toBe('skip_all_permission_checks')
  // sessionSettings merges key by key: the target-side flag survives, ultracode flips on.
  expect(out.sessionSettings).toEqual({ ultracode: true, somethingTargetSide: 1 })
  expect(out.permissionMode).toBe('bypassPermissions')
  expect(out.enabledMcpTools).toEqual(['srv-b:tool9'])
  // never mutates its input
  expect(target.sessionSettings).toEqual({ ultracode: false, somethingTargetSide: 1 })
})

test('carriedSettingsMatch is the sweep\'s "nothing to do"', () => {
  const carried = pickCarriedSettings(source)
  const converged = applyCarriedSettings({ cliSessionId: 'abc-123' }, carried)
  expect(carriedSettingsMatch(converged, carried)).toBe(true)
  expect(carriedSettingsMatch({ ...converged, effort: 'high' }, carried)).toBe(false)
  expect(
    carriedSettingsMatch({ ...converged, sessionSettings: { ultracode: false } }, carried),
  ).toBe(false)
  // extra target-side session flags do not count as drift
  expect(
    carriedSettingsMatch({ ...converged, sessionSettings: { ultracode: true, other: 2 } }, carried),
  ).toBe(true)
})

test('buildColdImportRecord: the source minus its account and its moment, re-identified as an import', () => {
  const rec = buildColdImportRecord(source, 'abc-123', 'New title', 9999)
  expect(rec.sessionId).toBe('local_abc-123')
  expect(rec.cliSessionId).toBe('abc-123')
  expect(rec.isArchived).toBe(false)
  expect(rec.title).toBe('New title')
  expect(rec.titleSource).toBe('tool')
  expect(rec.lastFocusedAt).toBe(9999)
  expect(rec.permissionMode).toBe('bypassPermissions')
  // settings intact
  expect(rec.effort).toBe('xhigh')
  expect(rec.sessionSettings).toEqual({ ultracode: true })
  expect(rec.chromePermissionMode).toBe('skip_all_permission_checks')
  // history intact
  expect(rec.createdAt).toBe(1000)
  expect(rec.completedTurns).toBe(7)
  expect(rec.cwd).toBe('C:\\repo')
  // the source account's connectors and the source's error state do not cross
  for (const k of [
    'enabledMcpTools',
    'remoteMcpServersConfig',
    'remoteControlAutoEligible',
    'error',
    'errorAt',
    'indexedAt',
  ])
    expect(k in rec).toBe(false)
})

test('chooseStoreLeaf picks the account signed in NOW, i.e. the leaf touched last', () => {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-leaf-'))
  const old = join(profile, 'claude-code-sessions', 'org-old', 'user-old')
  const cur = join(profile, 'claude-code-sessions', 'org-cur', 'user-cur')
  mkdirSync(old, { recursive: true })
  mkdirSync(cur, { recursive: true })
  writeFileSync(
    join(old, 'local_a.json'),
    JSON.stringify({ cliSessionId: 'a', lastActivityAt: 100 }),
  )
  writeFileSync(
    join(cur, 'local_b.json'),
    JSON.stringify({ cliSessionId: 'b', lastActivityAt: 900 }),
  )
  expect(chooseStoreLeaf(profile)).toBe(cur)
})

test('chooseStoreLeaf: an empty leaf still counts (a freshly signed-in profile has exactly that)', () => {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-leaf-empty-'))
  const leaf = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(leaf, { recursive: true })
  expect(chooseStoreLeaf(profile)).toBe(leaf)
})

test('chooseStoreLeaf: a profile that never signed in has nowhere the app would look', () => {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-leaf-none-'))
  expect(chooseStoreLeaf(profile)).toBeNull()
  mkdirSync(join(profile, 'claude-code-sessions'), { recursive: true })
  expect(chooseStoreLeaf(profile)).toBeNull()
})

test('chooseStoreLeaf: records without lastActivityAt rank by file time', () => {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-leaf-mtime-'))
  const a = join(profile, 'claude-code-sessions', 'org-1', 'user-a')
  const b = join(profile, 'claude-code-sessions', 'org-1', 'user-b')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  writeFileSync(join(a, 'local_a.json'), JSON.stringify({ cliSessionId: 'a' }))
  writeFileSync(join(b, 'local_b.json'), JSON.stringify({ cliSessionId: 'b' }))
  const past = new Date(Date.now() - 86_400_000)
  utimesSync(join(a, 'local_a.json'), past, past)
  utimesSync(a, past, past)
  expect(chooseStoreLeaf(profile)).toBe(b)
})
