import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planManagedCopyPrune, pruneManagedCopies } from '../src/claude-native-launch'

const scratches: string[] = []
afterEach(async () => {
  for (const scratch of scratches.splice(0)) await rm(scratch, { recursive: true, force: true })
})

/** Copies named oldest-first; each gets a manifest whose age follows that order. */
async function root(names: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'hydra-native-prune-'))
  scratches.push(dir)
  for (const [index, name] of names.entries()) {
    await mkdir(join(dir, name), { recursive: true })
    await writeFile(join(dir, name, 'claude.exe'), 'x'.repeat(10))
    const manifest = join(dir, name, 'agenthydra-native-manifest.json')
    await writeFile(manifest, '{}')
    const when = new Date(Date.UTC(2026, 0, 1 + index))
    await utimes(manifest, when, when)
  }
  return dir
}

const names = (items: { dir: string }[]) => items.map((i) => i.dir.split(/[\\/]/).pop()).sort()

test('keeps the current copy and one previous, removes the rest', async () => {
  const dir = await root(['a', 'b', 'c', 'd'])
  const plan = await planManagedCopyPrune(dir, join(dir, 'd'), async () => [])
  expect(names(plan.keep)).toEqual(['c', 'd'])
  expect(names(plan.remove)).toEqual(['a', 'b'])
})

test('a copy a running process executes from is kept even when old', async () => {
  const dir = await root(['a', 'b', 'c', 'd'])
  const plan = await planManagedCopyPrune(dir, join(dir, 'd'), async () => [
    join(dir, 'a', 'claude.exe').toUpperCase(),
  ])
  expect(names(plan.keep)).toEqual(['a', 'c', 'd'])
  expect(names(plan.remove)).toEqual(['b'])
})

test('an unreadable process table removes nothing', async () => {
  const dir = await root(['a', 'b', 'c', 'd'])
  const removed = await pruneManagedCopies(dir, join(dir, 'd'), async () => null)
  expect(removed).toEqual([])
  expect(names((await planManagedCopyPrune(dir, join(dir, 'd'), async () => null)).keep)).toEqual([
    'a',
    'b',
    'c',
    'd',
  ])
})

test('a staging or set-aside folder untouched for over an hour is removed; a fresh one is not', async () => {
  const dir = await root(['a', 'b'])
  for (const name of ['.building-old', '.stale-old', '.building-new']) await mkdir(join(dir, name))
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000)
  for (const name of ['.building-old', '.stale-old'])
    await utimes(join(dir, name), twoHoursAgo, twoHoursAgo)
  const removed = await pruneManagedCopies(dir, join(dir, 'b'), async () => [])
  expect(removed.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual(['.building-old', '.stale-old'])
})

test('pruning deletes only the planned folders and leaves staging folders alone', async () => {
  const dir = await root(['a', 'b', 'c'])
  await mkdir(join(dir, '.building-x'))
  const removed = await pruneManagedCopies(dir, join(dir, 'c'), async () => [])
  expect(removed.map((p) => p.split(/[\\/]/).pop())).toEqual(['a'])
  const plan = await planManagedCopyPrune(dir, join(dir, 'c'), async () => [])
  expect(names(plan.keep)).toEqual(['b', 'c'])
})
