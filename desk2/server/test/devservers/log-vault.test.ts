// devservers/log-vault.ts in a temp folder: seq keeps counting across a reopen (a service restart), a page answers the
// lines just before `before`, oldest first, and the files stay bounded by rotation.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LogVault } from '../../src/devservers/log-vault'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'devs-logs-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const ID = 'p1.web'

test('seq keeps counting up after the vault is opened again on the same folder', () => {
  const dir = tmp()
  const first = new LogVault(dir)
  expect([1, 2, 3].map((n) => first.add(ID, 'stdout', `line ${n}`, n))).toEqual([1, 2, 3])
  first.flush()
  const second = new LogVault(dir)
  expect(second.add(ID, 'stderr', 'line 4', 4)).toBe(4)
  expect(second.page(ID, {}).lines.map((l) => [l.seq, l.stream, l.line])).toEqual([
    [1, 'stdout', 'line 1'],
    [2, 'stdout', 'line 2'],
    [3, 'stdout', 'line 3'],
    [4, 'stderr', 'line 4'],
  ])
})

test('a page answers the lines just before `before`, oldest first, with `more` only when older ones exist', () => {
  const vault = new LogVault(tmp())
  for (let n = 1; n <= 10; n++) vault.add(ID, 'stdout', `line ${n}`, n)
  const cases: [{ before?: number; limit?: number }, number[], boolean][] = [
    [{ limit: 3 }, [8, 9, 10], true],
    [{ before: 8, limit: 3 }, [5, 6, 7], true],
    [{ before: 4, limit: 3 }, [1, 2, 3], false],
    [{ before: 3, limit: 5 }, [1, 2], false],
    [{}, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], false],
  ]
  for (const [opts, seqs, more] of cases) {
    const page = vault.page(ID, opts)
    expect([opts, page.lines.map((l) => l.seq), page.more]).toEqual([opts, seqs, more])
  }
})

test('the log rotates by size: a few files at most, the oldest lines dropped, seq still counting', () => {
  const dir = tmp()
  const vault = new LogVault(dir)
  const big = 'x'.repeat(10_000)
  let written = 0
  let seq = 0
  // Four rounds of a little over 1 MB each, each flushed on its own so every round meets the size check.
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 110; i++) seq = vault.add(ID, 'stdout', big, i)
    vault.flush()
    written += 110 * big.length
  }
  const files = readdirSync(dir)
  expect(files.length).toBeLessThanOrEqual(3)
  const onDisk = files.reduce((n, f) => n + statSync(path.join(dir, f)).size, 0)
  expect(onDisk).toBeLessThan(written)
  expect(vault.page(ID, { before: 2, limit: 1 }).lines).toEqual([])
  expect(vault.page(ID, { limit: 1 }).lines.map((l) => l.seq)).toEqual([seq])
  expect(seq).toBe(440)
})
