// server/tests/config-data-dir.test.ts - one app, one database.
//
// A daemon started from a checkout used to keep its state in `server/data` while the installed one
// kept it under `~/.agenthydra/data`, so the same app read two different sqlite files: settings,
// the run queue, orchestrator acks, `/delayo` holds and the done-mark ledger all diverged. Nothing
// crashes when that happens, which is the problem - the daemon boots happily onto whichever half it
// found and every conclusion drawn from it is confidently wrong. So the cases pinned here are the
// ones that fail SILENTLY: state left behind by a move that did not happen, state discarded by one
// that should not have, and a split nobody was told about.
//
// Real directories under a scratch dir, not a mocked fs: the whole point is renameSync's behaviour.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDataDir } from '../src/config'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agenthydra-datadir-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A data directory holding a recognisable database, so a move can be proved to carry contents. */
function seedData(dir: string, contents: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agenthydra.db'), contents)
  return dir
}

const configDir = () => join(root, '.agenthydra')
const canonical = () => join(root, '.agenthydra', 'data')
const checkout = () => join(root, 'checkout', 'server', 'data')

test('a fresh install resolves straight to the per-user data dir', () => {
  expect(resolveDataDir(configDir(), checkout())).toEqual({ dir: canonical(), notice: null })
})

test('a compiled build never migrates anything, even with a checkout beside it', () => {
  // IS_COMPILED passes null: a release has always kept state under CONFIG_DIR, and a `server/data`
  // sitting next to the exe would belong to some unrelated checkout, not to this install.
  seedData(checkout(), 'checkout')
  expect(resolveDataDir(configDir(), null)).toEqual({ dir: canonical(), notice: null })
  expect(existsSync(join(checkout(), 'agenthydra.db'))).toBe(true)
})

test("moves a checkout's server/data across, contents and all, leaving nothing behind", () => {
  seedData(checkout(), 'checkout')
  writeFileSync(join(checkout(), 'usage-history.json'), '{"kept":true}')
  const resolved = resolveDataDir(configDir(), checkout())
  expect(resolved).toEqual({ dir: canonical(), notice: null })
  expect(readFileSync(join(canonical(), 'agenthydra.db'), 'utf8')).toBe('checkout')
  expect(readFileSync(join(canonical(), 'usage-history.json'), 'utf8')).toBe('{"kept":true}')
  // Left behind, it would keep being written by anything holding a stale absolute path, and the
  // next reader would have two candidates again.
  expect(existsSync(checkout())).toBe(false)
})

test('an empty destination does not block the move', () => {
  // Something merely made the directory - a boot that got no further, a backup tool, an unpacked
  // archive. Treating that as state would strand the real database forever.
  mkdirSync(canonical(), { recursive: true })
  seedData(checkout(), 'checkout')
  expect(resolveDataDir(configDir(), checkout())).toEqual({ dir: canonical(), notice: null })
  expect(readFileSync(join(canonical(), 'agenthydra.db'), 'utf8')).toBe('checkout')
})

test('two populated dirs: the canonical one is used, NEITHER is touched, and the split is reported', () => {
  // The one case with no safe guess. Preferring either side silently discards somebody's history,
  // and mtime is not evidence - running the other one once inverts it. So say so instead.
  seedData(canonical(), 'installed')
  seedData(checkout(), 'checkout')
  const resolved = resolveDataDir(configDir(), checkout())
  expect(resolved.dir).toBe(canonical())
  expect(resolved.notice).toContain(checkout())
  expect(readFileSync(join(canonical(), 'agenthydra.db'), 'utf8')).toBe('installed')
  expect(readFileSync(join(checkout(), 'agenthydra.db'), 'utf8')).toBe('checkout')
})

test('a move that cannot happen keeps using the state where it stands, and says so', () => {
  // A live daemon holding the sqlite file open on Windows, a cross-device home, a permission
  // problem. Booting onto an empty database instead would look like a working app whose queue,
  // settings and done-marks had all vanished. Forced here by making the config dir's parent a file.
  writeFileSync(join(root, 'blocked'), 'not a directory')
  seedData(checkout(), 'checkout')
  const resolved = resolveDataDir(join(root, 'blocked', '.agenthydra'), checkout())
  expect(resolved.dir).toBe(checkout())
  expect(resolved.notice).toContain('still using it in place')
  expect(readFileSync(join(checkout(), 'agenthydra.db'), 'utf8')).toBe('checkout')
})

test('a cross-volume move falls back to copy-then-delete, not to giving up', () => {
  // A checkout on D: and a profile on C: is the normal Windows development layout, and renameSync
  // throws EXDEV across volumes. Giving up there would mean the consolidation never happens for
  // precisely the people living with the split. Only the throw is simulated; the copy is real.
  seedData(checkout(), 'checkout')
  writeFileSync(join(checkout(), 'usage-history.json'), '{"kept":true}')
  const exdev = () => {
    throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
  }
  expect(resolveDataDir(configDir(), checkout(), exdev)).toEqual({ dir: canonical(), notice: null })
  expect(readFileSync(join(canonical(), 'agenthydra.db'), 'utf8')).toBe('checkout')
  expect(readFileSync(join(canonical(), 'usage-history.json'), 'utf8')).toBe('{"kept":true}')
  expect(existsSync(checkout())).toBe(false)
})

test('a rename that fails for any OTHER reason is not copied around', () => {
  // EBUSY is a live daemon holding the sqlite file open. Copying it anyway would fork the database
  // under a running writer, which is worse than the split this whole resolver exists to end.
  seedData(checkout(), 'checkout')
  const busy = () => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
  }
  const resolved = resolveDataDir(configDir(), checkout(), busy)
  expect(resolved.dir).toBe(checkout())
  expect(resolved.notice).toContain('still using it in place')
  expect(existsSync(join(canonical(), 'agenthydra.db'))).toBe(false)
  expect(readFileSync(join(checkout(), 'agenthydra.db'), 'utf8')).toBe('checkout')
})

test('a legacy dir that IS the canonical one is a no-op, not a move onto itself', () => {
  seedData(canonical(), 'installed')
  expect(resolveDataDir(configDir(), canonical())).toEqual({ dir: canonical(), notice: null })
  expect(readFileSync(join(canonical(), 'agenthydra.db'), 'utf8')).toBe('installed')
})
