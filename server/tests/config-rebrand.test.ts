// server/tests/config-rebrand.test.ts — an install upgrading from CC Manager UI keeps its state.
//
// These two resolvers decide where the run queue, settings, instance labels, accounts cache and the
// sqlite database are read from. Getting them wrong does not crash: the daemon boots happily onto an
// empty `~/.agenthydra` and the user simply finds their queue gone. So the cases that matter here
// are the failure paths, where "use the old location" must beat "start clean at the new one".
//
// Real directories under a scratch dir, not mocked fs: the whole point is renameSync's behaviour.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfigDir, resolveDbPath } from '../src/config'

let home: string
let savedEnv: Record<string, string | undefined>

// tests/setup.ts sets AGENTHYDRA_HOME for the whole suite, and resolveConfigDir honours it above
// everything else. These tests need it absent, so they clear it per test and put it back after —
// deleting it outright would silently un-isolate every test that runs later in this process and
// point it at the developer's real ~/.agenthydra.
const ENV_KEYS = ['AGENTHYDRA_HOME', 'CCMANAGERUI_HOME'] as const

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agenthydra-rebrand-'))
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  for (const k of ENV_KEYS) {
    const value = savedEnv[k]
    if (value === undefined) delete process.env[k]
    else process.env[k] = value
  }
})

/** A config dir with one recognisable file in it, so a move can be proved to carry contents. */
function seedDir(name: string, marker = 'runtime.json'): string {
  const dir = join(home, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, marker), '{"port":7787}')
  return dir
}

describe('resolveConfigDir', () => {
  test('a fresh install goes straight to the new dir', () => {
    expect(resolveConfigDir(home)).toBe(join(home, '.agenthydra'))
  })

  test('moves a pre-rename dir across, contents and all', () => {
    seedDir('.ccmanagerui')
    const resolved = resolveConfigDir(home)
    expect(resolved).toBe(join(home, '.agenthydra'))
    expect(existsSync(join(resolved, 'runtime.json'))).toBe(true)
    expect(existsSync(join(home, '.ccmanagerui'))).toBe(false)
  })

  test('does not touch a legacy dir once the new one exists', () => {
    // Both present means a previous run already migrated (or the user made the dir by hand). The
    // new dir is authoritative; merging the two would resurrect stale settings.
    seedDir('.ccmanagerui', 'stale.json')
    seedDir('.agenthydra')
    expect(resolveConfigDir(home)).toBe(join(home, '.agenthydra'))
    expect(existsSync(join(home, '.ccmanagerui', 'stale.json'))).toBe(true)
  })

  test('an explicit AGENTHYDRA_HOME wins over both', () => {
    seedDir('.ccmanagerui')
    process.env.AGENTHYDRA_HOME = join(home, 'portable')
    expect(resolveConfigDir(home)).toBe(join(home, 'portable'))
    expect(existsSync(join(home, '.ccmanagerui'))).toBe(true)
  })

  test('the pre-rename CCMANAGERUI_HOME is still honoured', () => {
    // A portable install or scheduled task set up before the rename still exports the old name.
    process.env.CCMANAGERUI_HOME = join(home, 'portable')
    expect(resolveConfigDir(home)).toBe(join(home, 'portable'))
  })

  test('the new name wins when both env vars are set', () => {
    process.env.CCMANAGERUI_HOME = join(home, 'old')
    process.env.AGENTHYDRA_HOME = join(home, 'new')
    expect(resolveConfigDir(home)).toBe(join(home, 'new'))
  })
})

describe('resolveDbPath', () => {
  test('a fresh install gets the new filename', () => {
    const data = join(home, 'data')
    mkdirSync(data)
    expect(resolveDbPath(data)).toBe(join(data, 'agenthydra.db'))
  })

  test('renames a pre-rename database in place', () => {
    const data = join(home, 'data')
    mkdirSync(data)
    writeFileSync(join(data, 'ccmanagerui.db'), 'sqlite')
    expect(resolveDbPath(data)).toBe(join(data, 'agenthydra.db'))
    expect(existsSync(join(data, 'ccmanagerui.db'))).toBe(false)
  })

  test('carries the -wal and -shm sidecars with it', () => {
    // These exist only after an unclean shutdown. Leaving them behind under the old stem would
    // strand the most recent committed transactions the main file has not absorbed yet.
    const data = join(home, 'data')
    mkdirSync(data)
    for (const name of ['ccmanagerui.db', 'ccmanagerui.db-wal', 'ccmanagerui.db-shm']) {
      writeFileSync(join(data, name), 'x')
    }
    resolveDbPath(data)
    expect(existsSync(join(data, 'agenthydra.db-wal'))).toBe(true)
    expect(existsSync(join(data, 'agenthydra.db-shm'))).toBe(true)
  })

  test('leaves a legacy database alone once the new one exists', () => {
    const data = join(home, 'data')
    mkdirSync(data)
    writeFileSync(join(data, 'ccmanagerui.db'), 'old')
    writeFileSync(join(data, 'agenthydra.db'), 'current')
    expect(resolveDbPath(data)).toBe(join(data, 'agenthydra.db'))
    expect(existsSync(join(data, 'ccmanagerui.db'))).toBe(true)
  })
})
