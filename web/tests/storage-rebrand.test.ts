// web/tests/storage-rebrand.test.ts — pre-rename localStorage keys survive the AgentHydra rename.
//
// The regression this guards is silent: if the carry-over breaks, nothing throws and nothing logs.
// Every persisted preference just reverts to its default on the upgrade, and the user reads that as
// "the update reset my settings". So the cases here are the ones that would look like nothing at
// all: a value that fails to move, a stale value that overwrites a newer one, and a second run that
// undoes the first.
//
// Storage is a hand-rolled stub rather than jsdom's — the function takes its Storage by parameter
// precisely so this test needs no DOM, and the stub can be made to throw on demand.

import { describe, expect, test } from 'bun:test'
import { migrateLegacyStorageKeys, REBRAND_NOTICE_KEY } from '../src/lib/storage-rebrand'

/** Minimal Storage over a Map. `throwOn` makes the named operation throw, to exercise the
 *  private-browsing path where even reading `length` is a SecurityError. */
function stubStorage(
  initial: Record<string, string> = {},
  throwOn?: 'length' | 'setItem',
): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      if (throwOn === 'length') throw new Error('storage disabled')
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (throwOn === 'setItem') throw new Error('quota exceeded')
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    clear: () => map.clear(),
  } as Storage
}

/** The stub has no snapshot method; read it back through the Storage surface the code uses. */
function snapshot(store: Storage): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i)
    if (k !== null) out[k] = store.getItem(k) ?? ''
  }
  return out
}

describe('migrateLegacyStorageKeys', () => {
  test('moves a pre-rename key to the new namespace and drops the old one', () => {
    const store = stubStorage({ 'ccmanagerui.sessions.sidebarWidth': '420' })
    migrateLegacyStorageKeys(store)
    expect(snapshot(store)).toEqual({
      'agenthydra.sessions.sidebarWidth': '420',
      [REBRAND_NOTICE_KEY]: '1',
    })
  })

  test('moves every namespaced key, not just the first', () => {
    const store = stubStorage({
      'ccmanagerui.locale': '"en"',
      'ccmanagerui.sessions.period': '"24h"',
      'ccmanagerui.instances.cliOpen': 'true',
    })
    migrateLegacyStorageKeys(store)
    expect(snapshot(store)).toEqual({
      'agenthydra.locale': '"en"',
      'agenthydra.sessions.period': '"24h"',
      'agenthydra.instances.cliOpen': 'true',
      [REBRAND_NOTICE_KEY]: '1',
    })
  })

  test('a fresh install is not flagged for the rebrand notice', () => {
    // Nobody who has never run CC Manager UI should be told about a rename they did not live
    // through, so the flag is set from finding legacy keys, not from the app version.
    const store = stubStorage({ 'agenthydra.sessions.period': '"24h"' })
    migrateLegacyStorageKeys(store)
    expect(store.getItem(REBRAND_NOTICE_KEY)).toBeNull()
  })

  test('leaves keys outside the namespace alone', () => {
    // The theme key is owned by the shared kit and is NOT app-namespaced, so moving it would log the
    // user out of their theme choice across every LunarWerx app on this origin.
    const store = stubStorage({ 'lunarwerx-theme': 'dark', unrelated: '1' })
    migrateLegacyStorageKeys(store)
    expect(snapshot(store)).toEqual({ 'lunarwerx-theme': 'dark', unrelated: '1' })
  })

  test('an existing new-namespace value wins over the stale legacy one', () => {
    // Downgrade to v0.13.x, then upgrade again: the old build rewrote its own key, and that stale
    // value must not clobber the choice the newer build already recorded.
    const store = stubStorage({
      'ccmanagerui.sessions.period': '"7d"',
      'agenthydra.sessions.period': '"24h"',
    })
    migrateLegacyStorageKeys(store)
    expect(snapshot(store)).toEqual({
      'agenthydra.sessions.period': '"24h"',
      [REBRAND_NOTICE_KEY]: '1',
    })
  })

  test('is idempotent — a second run changes nothing', () => {
    const store = stubStorage({ 'ccmanagerui.sessions.showTools': 'true' })
    migrateLegacyStorageKeys(store)
    const afterFirst = snapshot(store)
    migrateLegacyStorageKeys(store)
    expect(snapshot(store)).toEqual(afterFirst)
  })

  test('storage that throws on read does not take the app down', () => {
    expect(() => migrateLegacyStorageKeys(stubStorage({}, 'length'))).not.toThrow()
  })

  test('storage that throws mid-write does not take the app down', () => {
    expect(() =>
      migrateLegacyStorageKeys(stubStorage({ 'ccmanagerui.locale': '"en"' }, 'setItem')),
    ).not.toThrow()
  })
})
