// devservers/found.ts: scans merge into the found list by path (the first find's time kept), and the list the page
// shows leaves out what is already added, ignored or gone, files first.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DevWebDetectedProject, DevWebFoundFile, DevWebScanResult } from '@shared/devwebui'
import { listFound, mergeScan, readFound } from '../../src/devservers/found'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'devs-found-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const result = (files: DevWebFoundFile[], detected: DevWebDetectedProject[]): DevWebScanResult => ({ files, detected, scannedDirs: 1, truncated: false, timedOut: false, ms: 1, roots: [] })

const devwebui = (dir: string): string => {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, '.devwebui')
  writeFileSync(file, JSON.stringify({ name: 'Example', processes: [{ id: 'web', name: 'Web', command: 'bun dev' }] }))
  return file
}

test('a second scan of the same path keeps the first foundAt and does not add the path twice', () => {
  const home = tmp()
  const file = devwebui(path.join(tmp(), 'site'))
  mergeScan(home, result([{ path: file, name: 'Site', processes: 1, valid: true }], []), 'quick', 100)
  // The same file written with the other slash (and its case, off Linux): one item, its first time kept, its details new.
  const again = process.platform === 'linux' ? file : file.replace(/\\/g, '/').toUpperCase()
  mergeScan(home, result([{ path: again, name: 'Site 2', processes: 2, valid: true }], []), 'deep', 200)
  const items = readFound(home).items
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ foundAt: 100, name: 'Site 2', processes: 2 })
})

test('the list leaves out added, ignored and gone items, and puts files first, then most servers', () => {
  const home = tmp()
  const root = tmp()
  const one = devwebui(path.join(root, 'one'))
  const three = devwebui(path.join(root, 'three'))
  const loaded = devwebui(path.join(root, 'loaded'))
  for (const d of ['loaded/web', 'det', 'ign/app']) mkdirSync(path.join(root, d), { recursive: true })
  mergeScan(
    home,
    result(
      [
        { path: one, name: 'One', processes: 1, valid: true },
        { path: three, name: 'Three', processes: 3, valid: true },
        { path: loaded, name: 'Loaded', processes: 1, valid: true },
      ],
      [
        { path: path.join(root, 'det'), name: 'Det', processes: 5 },
        { path: path.join(root, 'loaded'), name: 'Loaded folder', processes: 1 },
        { path: path.join(root, 'loaded', 'web'), name: 'Inside loaded', processes: 1 },
        { path: path.join(root, 'ign', 'app'), name: 'Ignored', processes: 1 },
        { path: path.join(root, 'gone'), name: 'Gone', processes: 1 },
      ]
    ),
    'quick',
    100
  )
  const shown = listFound(home, [loaded], [path.join(root, 'ign')])
  expect(shown.map((i) => i.name)).toEqual(['Three', 'One', 'Det'])
})
