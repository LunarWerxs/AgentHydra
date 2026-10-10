import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureUpstream } from '../../src/repoyeti/api'

test('recording a branch upstream never runs git on the thread synchronously', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desk-upstream-'))
  const realSpawnSync = Bun.spawnSync
  try {
    Bun.spawnSync(['git', '-C', root, 'init', '-q', '-b', 'main'])
    Bun.spawnSync(['git', '-C', root, 'remote', 'add', 'origin', 'https://example.test/owner/repo.git'])
    let syncCalls = 0
    Bun.spawnSync = ((...args: Parameters<typeof realSpawnSync>) => {
      syncCalls++
      return realSpawnSync(...args)
    }) as typeof Bun.spawnSync
    try {
      await ensureUpstream(root, 'main')
    } finally {
      Bun.spawnSync = realSpawnSync
    }
    expect(syncCalls).toBe(0)
    const merge = Bun.spawnSync(['git', '-C', root, 'config', '--get', 'branch.main.merge'], { stdout: 'pipe' })
    expect(merge.stdout.toString().trim()).toBe('refs/heads/main')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
