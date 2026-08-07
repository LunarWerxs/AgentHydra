// server/tests/ui-prefs.test.ts — the cross-window UI preference mirror (server/src/core/ui-prefs.ts).
//
// This store exists for ONE reason: the quick-instances window can be served from a different PORT
// than the full manager, and a browser scopes localStorage per origin — port included — so the
// usage filter set in one simply is not there in the other. The properties worth pinning are the
// ones that make it safe to be a write-through mirror of the browser's own storage rather than a
// typed settings object: values round-trip byte-identical, only this app's namespace is accepted,
// the size is bounded, and a corrupt file degrades to "no preference set" instead of throwing into
// a boot path.
//
// CONFIG_DIR is redirected to a temp dir by tests/setup.ts (AGENTHYDRA_HOME), so nothing here
// touches the developer's real ~/.agenthydra.

import { afterEach, expect, test } from 'bun:test'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { uiPrefsFile } from '../src/core/paths'
import { readUiPrefs, writeUiPrefs } from '../src/core/ui-prefs'

const KEY = 'agenthydra.instances.usageFilter'

afterEach(() => {
  rmSync(uiPrefsFile(), { force: true })
})

test('a written preference reads back byte-identical', () => {
  // vueuse serializes booleans and numbers alike with String(); the client depends on getting back
  // exactly what it wrote, because it parses against the ref's own type rather than a schema here.
  writeUiPrefs({ [`${KEY}.enabled`]: 'true', [`${KEY}.threshold`]: '80' })
  expect(readUiPrefs()).toEqual({
    [`${KEY}.enabled`]: 'true',
    [`${KEY}.threshold`]: '80',
  })
})

test('a patch merges rather than replacing', () => {
  writeUiPrefs({ [`${KEY}.enabled`]: 'true', [`${KEY}.week`]: 'true' })
  const after = writeUiPrefs({ [`${KEY}.enabled`]: 'false' })
  expect(after[`${KEY}.enabled`]).toBe('false')
  expect(after[`${KEY}.week`]).toBe('true')
})

test('null deletes a key — "I no longer have an opinion", not an empty string', () => {
  writeUiPrefs({ [`${KEY}.hide`]: 'true' })
  const after = writeUiPrefs({ [`${KEY}.hide`]: null })
  expect(`${KEY}.hide` in after).toBe(false)
})

test('keys outside this app’s namespace are refused', () => {
  // Not a general key-value store for the frontend. Anything else is not ours to hold.
  const after = writeUiPrefs({
    'evil.token': 'abc',
    token: 'abc',
    'AGENTHYDRA.instances.x': 'no',
    [`${KEY}.enabled`]: 'true',
  })
  expect(after).toEqual({ [`${KEY}.enabled`]: 'true' })
})

test('non-string and oversized values are refused', () => {
  const after = writeUiPrefs({
    'agenthydra.a': 42,
    'agenthydra.b': { nested: true },
    'agenthydra.c': 'x'.repeat(257),
    'agenthydra.d': 'x'.repeat(256),
  })
  expect(Object.keys(after)).toEqual(['agenthydra.d'])
})

test('the key budget bounds new keys but never blocks updating an existing one', () => {
  const many: Record<string, string> = {}
  for (let i = 0; i < 70; i++) many[`agenthydra.k${i}`] = 'v'
  const filled = writeUiPrefs(many)
  expect(Object.keys(filled)).toHaveLength(64)

  // A full file must still accept a CHANGE to something it already holds — otherwise a user whose
  // store filled up would silently stop being able to move their own filter.
  const key = Object.keys(filled)[0] as string
  expect(writeUiPrefs({ [key]: 'changed' })[key]).toBe('changed')
})

test('a missing, empty or corrupt file reads as "nothing set" rather than throwing', () => {
  expect(existsSync(uiPrefsFile())).toBe(false)
  expect(readUiPrefs()).toEqual({})

  writeFileSync(uiPrefsFile(), '')
  expect(readUiPrefs()).toEqual({})

  writeFileSync(uiPrefsFile(), '{ not json')
  expect(readUiPrefs()).toEqual({})

  // An array parses fine as JSON but is not a preference map.
  writeFileSync(uiPrefsFile(), '["a","b"]')
  expect(readUiPrefs()).toEqual({})
})

test('a hand-edited file with junk entries yields only the well-formed ones', () => {
  writeFileSync(
    uiPrefsFile(),
    JSON.stringify({ [`${KEY}.enabled`]: 'true', 'not.ours': 'x', 'agenthydra.n': 5 }),
  )
  expect(readUiPrefs()).toEqual({ [`${KEY}.enabled`]: 'true' })
})
