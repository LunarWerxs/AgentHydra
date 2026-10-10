import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionMetaStore } from '../src/engine/session-meta'
import { RecentFolders } from '../src/folders/recent'
import { createSettingsStore, settingsPath } from '../src/settings'

const dirs: string[] = []
function scratchHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'desk-aw-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

describe('session meta writes', () => {
  test('a tombstone is not on disk when the call returns, and is after the write lands', async () => {
    const home = scratchHome()
    const store = new SessionMetaStore(home)
    store.tombstone(['s-1'])
    expect(existsSync(store.tombFile)).toBe(false)
    await until(() => existsSync(store.tombFile))
    expect(JSON.parse(readFileSync(store.tombFile, 'utf8'))).toEqual(['s-1'])
  })

  test('shutdown flush writes a pending mark and tombstone at once', () => {
    const home = scratchHome()
    const store = new SessionMetaStore(home)
    store.patch('s-2', { pinned: true })
    store.tombstone(['s-2'])
    store.flushSync()
    expect(Object.keys(JSON.parse(readFileSync(store.file, 'utf8')))).toEqual(['s-2'])
    expect(JSON.parse(readFileSync(store.tombFile, 'utf8'))).toEqual(['s-2'])
  })
})

describe('recent folders writes', () => {
  test('a remembered folder is written after the call, and shutdown flush writes it at once', async () => {
    const home = scratchHome()
    const file = join(home, 'recent-folders.json')
    const folder = join(home, 'project')
    mkdirSync(folder)
    const recent = new RecentFolders(file, () => 1000)
    recent.remember(folder)
    expect(existsSync(file)).toBe(false)
    await until(() => existsSync(file))
    expect(readFileSync(file, 'utf8')).toContain('project')
  })

  test('flushSync writes the folder without waiting for the drain', () => {
    const home = scratchHome()
    const file = join(home, 'recent-folders.json')
    const folder = join(home, 'project')
    mkdirSync(folder)
    const recent = new RecentFolders(file, () => 1000)
    recent.remember(folder)
    recent.flushSync()
    expect(readFileSync(file, 'utf8')).toContain('project')
  })
})

describe('settings writes', () => {
  test('update returns the new settings before the file is written, and flushSync writes them', () => {
    const home = scratchHome()
    const store = createSettingsStore(home)
    const next = store.update({ babysitter: false })
    expect(next.babysitter).toBe(false)
    expect(existsSync(settingsPath(home))).toBe(false)
    store.flushSync()
    expect(JSON.parse(readFileSync(settingsPath(home), 'utf8')).babysitter).toBe(false)
  })

  test('a settings file that cannot be written does not fail the update', () => {
    const home = scratchHome()
    mkdirSync(settingsPath(home))
    const log = spyOn(console, 'error').mockImplementation(() => {})
    const store = createSettingsStore(home)
    const next = store.update({ babysitter: false })
    expect(next.babysitter).toBe(false)
    expect(store.get().babysitter).toBe(false)
    log.mockRestore()
  })
})
