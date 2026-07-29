import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tryAcquireInstanceModeStartupLock } from '../src/instance-mode-lock'

test('only one live process owns the instance-mode startup claim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmui-instance-lock-'))
  const lockPath = join(dir, 'startup.lock')
  try {
    const first = tryAcquireInstanceModeStartupLock({ lockPath, isProcessAlive: () => true })
    expect(first).not.toBeNull()
    expect(tryAcquireInstanceModeStartupLock({ lockPath, isProcessAlive: () => true })).toBeNull()
    first?.release()
    expect(existsSync(lockPath)).toBe(false)
    const next = tryAcquireInstanceModeStartupLock({ lockPath, isProcessAlive: () => true })
    expect(next).not.toBeNull()
    next?.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a dead owner is reclaimed, but release never deletes a successor lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmui-instance-lock-'))
  const lockPath = join(dir, 'startup.lock')
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: 123, token: 'dead', createdAt: Date.now() }))
    const lock = tryAcquireInstanceModeStartupLock({ lockPath, isProcessAlive: () => false })
    expect(lock).not.toBeNull()
    const owned = JSON.parse(readFileSync(lockPath, 'utf8')) as { token: string }
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        token: `${owned.token}-successor`,
        createdAt: Date.now(),
      }),
    )
    lock?.release()
    expect(existsSync(lockPath)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
