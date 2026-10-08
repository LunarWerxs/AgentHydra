import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkoutOf, localFolderPath, subfolders, withoutPath, withPath } from '../../src/projects/choices'

const base = () => mkdtempSync(join(tmpdir(), 'choices-'))

describe('localFolderPath', () => {
  test('accepts an existing absolute folder and returns it resolved', () => {
    const dir = base()
    expect(localFolderPath(dir)).toBe(dir)
  })

  test('refuses a relative path, a file, a missing folder and a non-string', () => {
    const dir = base()
    const file = join(dir, 'note.txt')
    writeFileSync(file, 'x')
    for (const bad of ['relative/path', file, join(dir, 'missing'), 42, undefined]) {
      expect(() => localFolderPath(bad)).toThrow()
    }
  })
})

describe('subfolders', () => {
  test('lists one level of folders and skips dot-folders and files', () => {
    const root = base()
    mkdirSync(join(root, 'app'))
    mkdirSync(join(root, 'app', 'deeper'))
    mkdirSync(join(root, '.cache'))
    writeFileSync(join(root, 'README.md'), 'x')
    expect(subfolders(root)).toEqual([join(root, 'app')])
  })

  test('a missing root has no folders', () => {
    expect(subfolders(join(base(), 'nope'))).toEqual([])
  })
})

describe('withPath and withoutPath', () => {
  test('adds a folder once, whatever its case', () => {
    const list = withPath(['C:/Work/App'], 'c:/work/app')
    expect(list).toEqual(['C:/Work/App'])
    expect(withPath([], 'C:/Work/App')).toEqual(['C:/Work/App'])
  })

  test('removes a folder whichever spelling it was kept under', () => {
    expect(withoutPath(['C:/Work/App', 'C:/Other'], 'c:/work/app')).toEqual(['C:/Other'])
  })
})

describe('checkoutOf', () => {
  test('rolls a subfolder up to the checkout holding its .git', () => {
    const repo = base()
    mkdirSync(join(repo, '.git'))
    const inner = join(repo, 'packages', 'core')
    mkdirSync(inner, { recursive: true })
    expect(checkoutOf(inner)).toBe(repo)
  })

  test('a folder with no checkout above it is its own', () => {
    const dir = base()
    expect(checkoutOf(dir)).toBe(dir)
  })
})
