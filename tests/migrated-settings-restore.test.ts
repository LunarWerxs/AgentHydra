// tests/migrated-settings-restore.test.ts - the RUNNING-target half of settings carry-over.
//
// A running app creates the import record itself and then re-saves its in-memory copy over
// whatever we write on disk. So the carried settings go on with the title/bypass stamp (once) and
// the sweep puts them back (every minute) until the app's next start. Pinned here: the stamp
// merges them; a re-save that drops them is repaired by restoreMigratedSettings; a record that
// already matches is left alone (no churn); rows for OTHER profiles are ignored; the prune runs.

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CarriedSettings } from '../server/src/chat-settings-carry'
import {
  applyCarriedSettingsToChat,
  restoreMigratedSettings,
  stampImportedChat,
} from '../server/src/session-launch'

const carried: CarriedSettings = {
  model: 'claude-opus-5',
  effort: 'xhigh',
  chromePermissionMode: 'skip_all_permission_checks',
  sessionSettings: { ultracode: true },
}

/** A profile whose app has just created the import record for `id` (bare, as the app makes it). */
function profileWithImport(id: string, extra: Record<string, unknown> = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-carry-'))
  const leaf = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(leaf, { recursive: true })
  const path = join(leaf, `local_${id}.json`)
  writeFileSync(
    path,
    JSON.stringify({
      sessionId: `local_${id}`,
      cliSessionId: id,
      permissionMode: 'default',
      effort: 'high',
      sessionSettings: { ultracode: false, keepMe: 1 },
      ...extra,
    }),
  )
  return { profile, path }
}

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

test('stampImportedChat merges the carried settings with the title and the bypass stamp', async () => {
  const { profile, path } = profileWithImport('sess-carry-1')
  const titled = await stampImportedChat(
    profile,
    'sess-carry-1',
    'Carried title',
    200,
    async () => {},
    carried,
  )
  expect(titled).toBe(true)
  const meta = read(path)
  expect(meta.title).toBe('Carried title')
  expect(meta.permissionMode).toBe('bypassPermissions')
  expect(meta.effort).toBe('xhigh')
  expect(meta.chromePermissionMode).toBe('skip_all_permission_checks')
  // key-by-key merge: the app's own session flag survives, ultracode flips on
  expect(meta.sessionSettings).toEqual({ ultracode: true, keepMe: 1 })
})

test('restoreMigratedSettings repairs a re-save that dropped the carried values, once', () => {
  const { profile, path } = profileWithImport('sess-carry-2')
  expect(applyCarriedSettingsToChat(profile, 'sess-carry-2', carried)).toBe(true)
  // the app re-saves its in-memory copy: effort and ultracode revert
  writeFileSync(
    path,
    JSON.stringify({ ...read(path), effort: 'high', sessionSettings: { ultracode: false } }),
  )
  const pruned: number[] = []
  const rows = [
    { session_id: 'sess-carry-2', target_dir: profile, settings: carried, updated_at: Date.now() },
  ]
  expect(
    restoreMigratedSettings(profile, rows, (ms) => {
      pruned.push(ms)
      return 0
    }),
  ).toBe(1)
  const meta = read(path)
  expect(meta.effort).toBe('xhigh')
  expect(meta.sessionSettings).toEqual({ ultracode: true })
  // converged: the next tick rewrites nothing
  expect(restoreMigratedSettings(profile, rows, () => 0)).toBe(0)
  expect(pruned.length).toBe(1)
})

test('restoreMigratedSettings leaves other profiles and vanished records alone', () => {
  const { profile, path } = profileWithImport('sess-carry-3')
  const other = mkdtempSync(join(tmpdir(), 'agenthydra-carry-other-'))
  const rows = [
    // a row for a different target: not ours to touch
    { session_id: 'sess-carry-3', target_dir: other, settings: carried, updated_at: 1 },
    // a row whose record does not exist here: nothing to write
    { session_id: 'sess-gone', target_dir: profile, settings: carried, updated_at: 1 },
  ]
  expect(restoreMigratedSettings(profile, rows, () => 0)).toBe(0)
  expect(read(path).effort).toBe('high')
})

test('an empty carried set is a no-op, not a rewrite', () => {
  const { profile, path } = profileWithImport('sess-carry-4')
  const before = readFileSync(path, 'utf8')
  expect(applyCarriedSettingsToChat(profile, 'sess-carry-4', {})).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe(before)
})
