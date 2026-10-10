import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PNG } from 'pngjs'
import { detectFolderIcon } from '../../src/projects/icon-detect'

const root = mkdtempSync(join(tmpdir(), 'ah-icon-detect-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let seq = 0
/** A fresh project folder under the temp root (each test gets its own, so the answer cache never mixes them). */
function folder(): string {
  const dir = join(root, `project-${seq++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function write(dir: string, rel: string, body: string | Buffer): string {
  const file = join(dir, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, body)
  return file
}

function png(): Buffer {
  return PNG.sync.write(new PNG({ width: 2, height: 2 }))
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>'

describe('detectFolderIcon', () => {
  test('a folder with public/favicon.svg gets that file', () => {
    const dir = folder()
    const file = write(dir, 'public/favicon.svg', SVG)
    expect(detectFolderIcon(dir)).toBe(resolve(file))
  })

  // Most projects here keep their app one folder down (a monorepo's web/, a product's site/).
  test("an app one folder down gives its own icon, after the folder's own files and HTML link", () => {
    const dir = folder()
    const file = write(dir, 'web/public/favicon.svg', SVG)
    expect(detectFolderIcon(dir)).toBe(resolve(file))
    const both = folder()
    const own = write(both, 'logo.svg', SVG)
    write(both, 'web/public/favicon.svg', SVG)
    expect(detectFolderIcon(both)).toBe(resolve(own))
  })

  test('a conventional file earlier in the list wins over a later one', () => {
    const dir = folder()
    const early = write(dir, 'icon.png', png())
    write(dir, 'public/favicon.svg', SVG)
    expect(detectFolderIcon(dir)).toBe(resolve(early))
  })

  test('an index.html icon link is found and resolved against the HTML file', () => {
    const dir = folder()
    write(dir, 'index.html', '<!doctype html><html><head><link rel="shortcut icon" href="img/mark.png"></head></html>')
    const file = write(dir, 'img/mark.png', png())
    expect(detectFolderIcon(dir)).toBe(resolve(file))
  })

  test('an href that escapes the folder is refused, even when the file it names exists', () => {
    const dir = folder()
    write(dir, '../escape-target.png', png())
    write(dir, 'index.html', '<link rel="icon" href="../escape-target.png">')
    expect(detectFolderIcon(dir)).toBeNull()
  })

  test('a file with the right name but not an image is refused', () => {
    const dir = folder()
    write(dir, 'icon.png', 'this is not a PNG, just text')
    expect(detectFolderIcon(dir)).toBeNull()
  })

  test('an empty folder answers null', () => {
    expect(detectFolderIcon(folder())).toBeNull()
  })
})
