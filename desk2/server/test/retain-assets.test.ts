import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KEEP_MS, retainAssets } from '../../scripts/retain-assets'

const temps: string[] = []

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function build(dir: string, files: Record<string, { text: string; ageMs: number }>) {
  mkdirSync(join(dir, 'assets'), { recursive: true })
  for (const [name, { text, ageMs }] of Object.entries(files)) {
    const path = join(dir, 'assets', name)
    writeFileSync(path, text)
    const at = (Date.now() - ageMs) / 1000
    utimesSync(path, at, at)
  }
}

test('a rebuild keeps the previous build chunks for a week, so an open window can still load them', () => {
  const root = mkdtempSync(join(tmpdir(), 'desk-retain-'))
  temps.push(root)
  const live = join(root, 'dist')
  const next = join(root, 'dist.next-1')
  build(live, {
    'SettingsView-OLD.js': { text: 'old settings', ageMs: 60_000 },
    'Shared-SAME.js': { text: 'old shared', ageMs: 60_000 },
    'Stale-GONE.js': { text: 'too old', ageMs: KEEP_MS + 60_000 },
  })
  build(next, { 'Shared-SAME.js': { text: 'new shared', ageMs: 0 } })

  expect(retainAssets(live, next)).toEqual(['SettingsView-OLD.js'])
  expect(readFileSync(join(next, 'assets', 'SettingsView-OLD.js'), 'utf8')).toBe('old settings')
  expect(readFileSync(join(next, 'assets', 'Shared-SAME.js'), 'utf8')).toBe('new shared')
  expect(existsSync(join(next, 'assets', 'Stale-GONE.js'))).toBe(false)
})

test('nothing to keep when there is no previous build', () => {
  const root = mkdtempSync(join(tmpdir(), 'desk-retain-'))
  temps.push(root)
  expect(retainAssets(join(root, 'dist'), join(root, 'dist.next-2'))).toEqual([])
})
