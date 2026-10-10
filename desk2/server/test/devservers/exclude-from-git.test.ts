import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { excludeFromGit } from '../../src/devservers/folder'

test('excluding a file from git does not hold the thread while git runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desk-exclude-'))
  try {
    Bun.spawnSync(['git', 'init', '-q', root])
    const dir = join(root, 'app')
    mkdirSync(dir)
    const file = join(dir, '.devwebui')
    writeFileSync(file, '{}')
    let fired = false
    setTimeout(() => {
      fired = true
    }, 0)
    expect(await excludeFromGit(file)).toBe(true)
    expect(fired).toBe(true)
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('/app/.devwebui')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
