import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { browse, BrowseError } from '../../src/git/browse'
import { cleanTemps, tempDir } from './helpers'

// Every case spawns several git processes; on a busy Windows box that takes seconds.
setDefaultTimeout(30_000)

afterEach(cleanTemps)

const IS_WIN = process.platform === 'win32'

function hide(path: string): void {
  if (!IS_WIN) return
  const r = Bun.spawnSync(['attrib', '+h', path], { windowsHide: true, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`attrib failed: ${r.stderr.toString()}`)
}

describe('browse', () => {
  test('lists sub-folders only, sorted, skipping dot and hidden folders', async () => {
    const root = tempDir('desk browse ü ')
    mkdirSync(join(root, 'b dir'))
    mkdirSync(join(root, 'A'))
    mkdirSync(join(root, '漢字'))
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'secret'))
    hide(join(root, 'secret'))
    writeFileSync(join(root, 'file.txt'), 'x')
    const r = await browse(root)
    expect(r.path).toBe(root)
    expect(r.parent).toBe(dirname(root))
    const expected = ['A', 'b dir', '漢字'].map((n) => join(root, n))
    if (!IS_WIN) expected.push(join(root, 'secret'))
    expect([...r.dirs].sort()).toEqual([...expected].sort())
    expect(r.dirs.slice(0, 2)).toEqual([join(root, 'A'), join(root, 'b dir')])
  })

  test('empty path lists the drives on Windows', async () => {
    const r = await browse('')
    if (IS_WIN) {
      expect(r.path).toBe('')
      expect(r.parent).toBeNull()
      expect(r.dirs.length).toBeGreaterThan(0)
      for (const d of r.dirs) expect(d).toMatch(/^[A-Z]:\\$/)
      expect(r.dirs).toContain(`${process.env.SystemDrive ?? 'C:'}\\`.toUpperCase())
    } else {
      expect(r.path).toBe('/')
      expect(r.parent).toBeNull()
    }
  })

  test.if(IS_WIN)('a drive root has the drive list as parent and hides system folders', async () => {
    const drive = `${process.env.SystemDrive ?? 'C:'}\\`
    const r = await browse(drive)
    expect(r.parent).toBe('')
    expect(r.dirs.some((d) => d.endsWith('System Volume Information'))).toBe(false)
    expect(r.dirs.some((d) => d.endsWith('$Recycle.Bin'))).toBe(false)
  })

  test('rejects relative, missing and file paths with the real reason', async () => {
    const root = tempDir()
    writeFileSync(join(root, 'f.txt'), 'x')
    await expect(browse('relative/dir')).rejects.toThrow(/must be absolute/)
    await expect(browse(join(root, 'missing'))).rejects.toThrow(/no such folder/)
    await expect(browse(join(root, 'f.txt'))).rejects.toThrow(/not a folder/)
    await expect(browse('relative')).rejects.toBeInstanceOf(BrowseError)
  })
})
