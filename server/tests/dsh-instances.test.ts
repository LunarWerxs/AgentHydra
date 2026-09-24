// server/tests/dsh-instances.test.ts — DeepSeek Harness homes as managed instances
// (server/src/core/dsh-instances.ts).
//
// Everything here is filesystem truth: real directories, a real registry file, real session folders.
// What is NOT exercised is launching — that spawns the harness itself and opens a browser window, so
// it belongs in a manual check rather than in a suite that runs on every commit. What IS exercised
// is every decision a launch depends on: which homes exist, which one is the default, what the
// registry does when it is asked for something impossible, and the guards that stand between a
// mistyped name and somebody's chat history.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR, DSH_HOME } from '../src/config'
import {
  createDshInstance,
  deleteDshInstance,
  dshInstanceStores,
  listDshInstances,
  renameDshInstance,
  resolveDshEntry,
} from '../src/core/dsh-instances'

const STORE_PATH = join(CONFIG_DIR, 'dsh-instances.json')

/** The registry is one file under CONFIG_DIR, which the test env already points at a scratch dir
 *  (see config.ts's NODE_ENV=test branch). Clearing it between tests keeps each one about itself. */
function clearRegistry(): void {
  try {
    rmSync(STORE_PATH, { force: true })
  } catch {
    // nothing to clear
  }
}

function readRegistry(): { instances: Array<{ id: string; name: string; home: string }> } {
  return JSON.parse(readFileSync(STORE_PATH, 'utf8'))
}

describe('createDshInstance: a home, a number, and a registry entry', () => {
  test('creates the directory and records it', () => {
    clearRegistry()
    const result = createDshInstance('work')
    expect(result.ok).toBe(true)
    expect(result.dir).toBeTruthy()
    expect(existsSync(result.dir as string)).toBe(true)
    const store = readRegistry()
    expect(store.instances).toHaveLength(1)
    expect(store.instances[0]?.name).toBe('work')
    // The number comes from the one sequence every instance family shares, so it is a real handle.
    expect(typeof (result.data?.num as number)).toBe('number')
  })

  test('the home is EMPTY — the harness owns its own layout', () => {
    clearRegistry()
    const result = createDshInstance('empty-please')
    const home = result.dir as string
    // No sessions/, no storages/, no settings.yaml: `dsh` writes those on first run, and a
    // half-made home written by us would be a second source of truth for a layout we do not own.
    expect(existsSync(join(home, 'sessions'))).toBe(false)
    expect(existsSync(join(home, 'storages'))).toBe(false)
  })

  test('refuses a blank name, an over-long one, and a duplicate', () => {
    clearRegistry()
    expect(createDshInstance('   ').ok).toBe(false)
    expect(createDshInstance('x'.repeat(61)).ok).toBe(false)
    expect(createDshInstance('twin').ok).toBe(true)
    const dup = createDshInstance('TWIN')
    expect(dup.ok).toBe(false)
    // Case-insensitively, because "twin" and "TWIN" are the same instance to a person.
    expect(dup.message).toContain('already exists')
  })
})

describe('renameDshInstance', () => {
  test('changes the label and nothing else', () => {
    clearRegistry()
    const created = createDshInstance('before')
    const id = created.data?.id as string
    const home = created.dir as string
    expect(renameDshInstance(id, 'after').ok).toBe(true)
    const rec = readRegistry().instances[0]
    expect(rec?.name).toBe('after')
    expect(rec?.home).toBe(home)
  })

  test('refuses an unknown id and a name already taken', () => {
    clearRegistry()
    createDshInstance('one')
    const two = createDshInstance('two')
    expect(renameDshInstance('no-such-id', 'anything').ok).toBe(false)
    expect(renameDshInstance(two.data?.id as string, 'one').ok).toBe(false)
  })
})

describe('deleteDshInstance: the guards around somebody else’s chat history', () => {
  test('removing forgets the instance and LEAVES the files', () => {
    clearRegistry()
    const created = createDshInstance('keep-my-files')
    const home = created.dir as string
    const result = deleteDshInstance(created.data?.id as string)
    expect(result.ok).toBe(true)
    expect(existsSync(home)).toBe(true)
    expect(readRegistry().instances).toHaveLength(0)
    // The message has to say where the home still is, or "removed" reads as "deleted".
    expect(result.message).toContain(home)
  })

  test('deleting files requires the name typed back', () => {
    clearRegistry()
    const created = createDshInstance('precious')
    const home = created.dir as string
    const wrong = deleteDshInstance(created.data?.id as string, {
      deleteFiles: true,
      confirmName: 'Precious',
    })
    expect(wrong.ok).toBe(false)
    expect(existsSync(home)).toBe(true)
    const right = deleteDshInstance(created.data?.id as string, {
      deleteFiles: true,
      confirmName: 'precious',
    })
    expect(right.ok).toBe(true)
    expect(existsSync(home)).toBe(false)
  })

  test('a home OUTSIDE the managed directory is never deleted, even with the name typed', () => {
    clearRegistry()
    const created = createDshInstance('hand-edited')
    const id = created.data?.id as string
    // The registry is a plain JSON file a person can edit. Point one at somewhere precious and the
    // delete must refuse rather than recurse into it.
    const elsewhere = join(CONFIG_DIR, `not-ours-${crypto.randomUUID()}`)
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'keepme.txt'), 'evidence')
    const store = readRegistry()
    ;(store.instances[0] as { home: string }).home = elsewhere
    writeFileSync(STORE_PATH, JSON.stringify(store))

    const result = deleteDshInstance(id, { deleteFiles: true, confirmName: 'hand-edited' })
    expect(result.ok).toBe(false)
    expect(existsSync(join(elsewhere, 'keepme.txt'))).toBe(true)
    // And the record is still there: a refusal must not half-succeed by forgetting the instance.
    expect(readRegistry().instances).toHaveLength(1)
  })

  test('the DEFAULT home is not deletable from here at all', () => {
    clearRegistry()
    const result = deleteDshInstance('default', { deleteFiles: true, confirmName: 'anything' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not something AgentHydra created')
  })
})

describe('listDshInstances / dshInstanceStores', () => {
  test('a created instance is listed, and is not the default', async () => {
    clearRegistry()
    const created = createDshInstance('second-account')
    const rows = await listDshInstances()
    const mine = rows.find((r) => r.id === created.data?.id)
    expect(mine?.name).toBe('second-account')
    expect(mine?.isDefault).toBe(false)
    expect(mine?.running).toBe(false)
    expect(mine?.sessions).toBe(0)
  })

  test('sessions are counted from the directory tree, no logs opened', async () => {
    clearRegistry()
    const created = createDshInstance('counted')
    const home = created.dir as string
    mkdirSync(join(home, 'sessions', '--p1--', 'session-a'), { recursive: true })
    mkdirSync(join(home, 'sessions', '--p1--', 'session-b'), { recursive: true })
    mkdirSync(join(home, 'sessions', '--p2--', 'session-c'), { recursive: true })
    const rows = await listDshInstances()
    expect(rows.find((r) => r.id === created.data?.id)?.sessions).toBe(3)
  })

  test('a registered home that was deleted from under us still lists rather than vanishing', async () => {
    clearRegistry()
    const created = createDshInstance('gone')
    rmSync(created.dir as string, { recursive: true, force: true })
    const rows = await listDshInstances()
    expect(rows.some((r) => r.id === created.data?.id)).toBe(true)
  })

  test('the store list skips a home that is not on disk — a reader must not walk a missing root', () => {
    clearRegistry()
    const created = createDshInstance('vanished')
    const home = created.dir as string
    expect(dshInstanceStores()).toContain(home)
    rmSync(home, { recursive: true, force: true })
    expect(dshInstanceStores()).not.toContain(home)
  })

  test('the default home is in the store list exactly when it exists', () => {
    clearRegistry()
    const stores = dshInstanceStores()
    expect(stores.includes(DSH_HOME)).toBe(existsSync(DSH_HOME))
  })
})

describe('resolveDshEntry', () => {
  test('returns null rather than a guess when the harness is not installed', () => {
    // An empty environment removes the only Windows candidate; the POSIX ones are absolute paths
    // that do not exist on a machine without a global install. Null is what the launcher turns into
    // "install it with npm i -g", which is a better answer than spawning a path that is not there.
    const entry = resolveDshEntry({})
    if (entry !== null) expect(existsSync(entry)).toBe(true)
  })
})
