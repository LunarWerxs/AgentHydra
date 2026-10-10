// preload.ts (loaded by desk2/bunfig.toml): a remove of the folder the suite runs in throws and deletes nothing. Bun on
// Windows empties the working folder for rmSync(''), which took every file under desk2/ on 2026-10-10. Each check runs
// from a throwaway folder, so a broken guard empties only that. And process.env cannot be swapped for a copy, which is
// what had left that run with no Chrome to find.

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const back = process.cwd()
const temps: string[] = []

afterEach(() => {
  process.chdir(back)
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workIn(): string {
  const dir = mkdtempSync(join(tmpdir(), 'desk-preload-'))
  temps.push(dir)
  writeFileSync(join(dir, 'keep.txt'), 'keep')
  process.chdir(dir)
  return dir
}

test("rmSync of '' or '.' throws, names the folder, and leaves its files", () => {
  const dir = workIn()
  expect(() => rmSync('', { recursive: true, force: true })).toThrow(/folder the tests run in/)
  expect(() => rmSync('.', { recursive: true, force: true })).toThrow(/folder the tests run in/)
  expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('keep')
})

test('the promise rm rejects the same way, and a remove of a folder beside it still works', async () => {
  const dir = workIn()
  await expect(rm('', { recursive: true, force: true })).rejects.toThrow(/folder the tests run in/)
  expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('keep')
  const other = mkdtempSync(join(tmpdir(), 'desk-preload-other-'))
  rmSync(other, { recursive: true, force: true })
  expect(existsSync(other)).toBe(false)
})

test('process.env cannot be replaced by a copy, and its keys still set and delete', () => {
  expect(() => {
    ;(process as { env: unknown }).env = { ...process.env }
  }).toThrow()
  process.env.DESK_PRELOAD_PROBE = '1'
  expect(process.env.DESK_PRELOAD_PROBE).toBe('1')
  delete process.env.DESK_PRELOAD_PROBE
  expect(process.env.DESK_PRELOAD_PROBE).toBeUndefined()
})
