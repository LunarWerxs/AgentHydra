import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { iconFileIn, parseHelper, placedRows, readRegistry } from '../../src/projects/hydra'

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

describe('readRegistry logos', () => {
  function registry(files: Record<string, string>): string {
    const root = join(base, 'hydra')
    mkdirSync(join(root, 'registry', 'projects'), { recursive: true })
    mkdirSync(join(root, 'icons'), { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'registry', 'projects', name), body)
    return root
  }

  test('uses the top-level icon when the project has no launch row', () => {
    const root = registry({ 'example-app.yaml': 'key: example-app\nname: Example App\nicon: example.svg\n' })
    writeFileSync(join(root, 'icons', 'example.svg'), '<svg/>')
    const entry = readRegistry(root).get('example-app')
    expect(iconFileIn(root, entry!.icon)).toBe(resolve(root, 'icons', 'example.svg'))
  })

  test('the launch row icon wins over the top-level one', () => {
    const root = registry({
      'example-app.yaml': 'key: example-app\nname: Example App\nicon: top.svg\nlaunch:\n- id: example-app\n  icon: launch.png\n',
    })
    expect(readRegistry(root).get('example-app')!.icon).toBe('launch.png')
  })

  test('a top-level icon that climbs out of the icons folder is refused', () => {
    const root = registry({ 'example-app.yaml': 'key: example-app\nname: Example App\nicon: ../secret.png\n' })
    writeFileSync(join(root, 'secret.png'), 'x')
    expect(iconFileIn(root, readRegistry(root).get('example-app')!.icon)).toBeNull()
  })

  test('a duplicate entry for the same repo takes the logo of the entry that has one', () => {
    const root = registry({
      'example-tool.yaml': 'key: example-tool\nname: Example Tool\nremote: https://github.com/example/tool.git\nlaunch:\n- id: example-tool\n  icon: tool.png\n',
      'example-tool-2.yaml': 'key: example-tool-2\nname: Example Tool\nremote: https://github.com/example/tool.git\nkind: app\n',
    })
    writeFileSync(join(root, 'icons', 'tool.png'), 'x')
    const dup = readRegistry(root).get('example-tool-2')!
    expect(dup.icon).toBe('tool.png')
    expect(iconFileIn(root, dup.icon)).toBe(resolve(root, 'icons', 'tool.png'))
  })
})
