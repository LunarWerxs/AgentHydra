import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatError } from '../../src/engine/chat-manager'
import { revealFile, selectArg } from '../../src/engine/reveal'

const dir = mkdtempSync(join(tmpdir(), 'desk-revealfile-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const file = join(dir, 'my clip, 1.mp4')
writeFileSync(file, 'x')
mkdirSync(join(dir, 'out'))
writeFileSync(join(dir, 'out', 'a.md'), 'x')

function run(body: unknown, sourceOf?: (id: string) => string | null) {
  const files: string[] = []
  const folders: string[] = []
  const res = revealFile(body, '/api/media/', { file: (f) => files.push(f), folder: (f) => folders.push(f), sourceOf })
  return { res, files, folders }
}
const status = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof ChatError ? e.status : -1
  }
  return 0
}

describe('reveal a file', () => {
  test('the argument selects the file, quoted so a comma or space cannot split it, with backslashes', () => {
    expect(selectArg('C:/Users/me/a b,c.mp4')).toBe('/select,"C:\\Users\\me\\a b,c.mp4"')
    expect(selectArg('C:\\')).toBe('/select,"C:\\\\"')
  })
  test('an absolute file is selected; a folder just opens', () => {
    const a = run({ path: file })
    expect(a.files).toEqual([file])
    expect(a.res.folder).toBe(false)
    const b = run({ path: dir })
    expect(b.folders).toEqual([dir])
    expect(b.files).toEqual([])
  })
  test('a relative path is taken from the chat folder', () => {
    expect(run({ path: 'out/a.md', cwd: dir }).files).toEqual([join(dir, 'out', 'a.md')])
    expect(status(() => run({ path: 'out/a.md' }))).toBe(400)
  })
  test('a cached media id opens the file it came from; an unknown one is a 404', () => {
    expect(run({ media: '/api/media/abc.mp4' }, () => file).files).toEqual([file])
    expect(status(() => run({ media: '/api/media/abc.mp4' }, () => null))).toBe(404)
    expect(status(() => run({ media: '/etc/passwd' }, () => file))).toBe(400)
  })
  test('network and device paths are refused before the disk is asked, a missing file is 404', () => {
    for (const path of ['\\\\evil-host\\share\\a.txt', '//evil-host/share/a.txt', '\\\\?\\C:\\Windows\\a.txt', '\\\\.\\C:\\a.txt']) {
      expect(status(() => run({ path }))).toBe(400)
    }
    expect(status(() => run({ path: 'out/a.md', cwd: '\\\\evil-host\\share' }))).toBe(400)
    expect(status(() => run({ path: join(dir, 'missing.txt') }))).toBe(404)
    expect(status(() => run({}))).toBe(400)
    expect(status(() => run({ path: '' }))).toBe(400)
  })
})
