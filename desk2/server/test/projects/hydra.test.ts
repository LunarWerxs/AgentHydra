import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { iconFileIn, parseHelper, placedRows } from '../../src/projects/hydra'

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'hydra-projects-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('parseHelper', () => {
  test('reads a quoted interpreter and a quoted ph.py that hold spaces', () => {
    const helper = '"C:\\Program Files\\Python\\python.exe" "C:\\Tools\\Project Hydra\\ph.py" mcp --connect'
    expect(parseHelper(helper)).toEqual({ python: 'C:\\Program Files\\Python\\python.exe', ph: 'C:\\Tools\\Project Hydra\\ph.py' })
  })

  test('returns null for a line that does not name ph.py', () => {
    expect(parseHelper('node server.js')).toBeNull()
  })
})

describe('placedRows', () => {
  test('keeps placed projects and drops the set-aside marks and rows without a path', () => {
    const rows = [
      { key: 'kept', path: 'C:/Projects/kept', group_name: 'Work', mark: null },
      { key: 'retired', path: 'C:/Projects/retired', mark: 'retired' },
      { key: 'archived', path: 'C:/Projects/archived', mark: 'archive' },
      { key: 'nopath', path: '', mark: null },
    ]
    expect(placedRows(rows)).toEqual([{ key: 'kept', path: resolve('C:/Projects/kept'), group: 'Work' }])
  })

  test('refuses an answer that is not a list', () => {
    expect(() => placedRows({ error: 'no' })).toThrow('ph next answered something other than a list')
  })
})

describe('iconFileIn', () => {
  test('finds a logo inside the icons folder and refuses a name that climbs out of it', () => {
    const root = join(base, 'hydra')
    mkdirSync(join(root, 'icons'), { recursive: true })
    writeFileSync(join(root, 'icons', 'logo.png'), 'x')
    writeFileSync(join(root, 'secret.png'), 'x')
    expect(iconFileIn(root, 'logo.png')).toBe(resolve(root, 'icons', 'logo.png'))
    expect(iconFileIn(root, '../secret.png')).toBeNull()
    expect(iconFileIn(root, null)).toBeNull()
  })
})
