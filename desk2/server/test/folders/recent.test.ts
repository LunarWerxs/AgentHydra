// The folder menu's Recent list (server/src/folders/recent.ts): chat folders and opened folders merged, latest
// first; a folder taken off stays off until it is used again; the marks survive a restart.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecentFolders } from '../../src/folders/recent'

const temps: string[] = []

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A temp root with these sub-folders on disk; answers their full paths. */
function folders(...names: string[]): string[] {
  const root = mkdtempSync(join(tmpdir(), 'desk-recent-'))
  temps.push(root)
  return names.map((n) => {
    mkdirSync(join(root, n))
    return join(root, n)
  })
}

function store(file: string, clock: { t: number }) {
  return new RecentFolders(file, () => clock.t)
}

describe('RecentFolders', () => {
  test('chat folders and opened folders, latest first, one row per folder, gone folders left out', () => {
    const [a, b, c] = folders('alpha', 'beta', 'gamma')
    const clock = { t: 25 }
    const recent = store(join(temps[0], 'folders.json'), clock)
    recent.remember(c)
    const chats = [
      { cwd: a, createdAt: 1, updatedAt: 10 },
      { cwd: b, createdAt: 2, updatedAt: 30 },
      { cwd: a, createdAt: 3, updatedAt: 20 },
      { cwd: join(temps[0], 'deleted'), createdAt: 4, updatedAt: 40 },
    ]
    expect(recent.list(chats)).toEqual([b, c, a])
  })

  test.if(process.platform === 'win32')('a Windows folder in another case or with forward slashes is the same row', () => {
    const [a] = folders('alpha')
    const recent = store(join(temps[0], 'folders.json'), { t: 5 })
    const other = a.toUpperCase().replaceAll('\\', '/')
    expect(recent.list([{ cwd: a, createdAt: 1, updatedAt: 1 }, { cwd: other, createdAt: 2, updatedAt: 2 }])).toEqual([other])
  })

  test('a folder taken off stays off while its chats carry on, and comes back when used again', () => {
    const [a, b] = folders('alpha', 'beta')
    const clock = { t: 40 }
    const recent = store(join(temps[0], 'folders.json'), clock)
    const chats = [
      { cwd: a, createdAt: 10, updatedAt: 50 }, // still active after the X
      { cwd: b, createdAt: 11, updatedAt: 12 },
    ]
    recent.forget(a)
    recent.forget(b)
    expect(recent.list(chats)).toEqual([])

    clock.t = 60
    recent.remember(b) // chosen again in the menu
    expect(recent.list(chats)).toEqual([b])
    expect(recent.list([...chats, { cwd: a, createdAt: 70, updatedAt: 70 }])).toEqual([a, b]) // a new chat in it
  })

  test('the marks survive a restart; an unreadable file starts empty', () => {
    const [a, b] = folders('alpha', 'beta')
    const file = join(temps[0], 'folders.json')
    const clock = { t: 100 }
    const first = store(file, clock)
    first.remember(a)
    first.forget(b)
    const chats = [{ cwd: b, createdAt: 1, updatedAt: 200 }]
    first.flushSync()
    expect(store(file, clock).list(chats)).toEqual([a])

    writeFileSync(file, '{ not json')
    expect(store(file, clock).list(chats)).toEqual([b])
  })
})
