// The daemon's own-name copy of bun (src/core/own-name.ts): AgentHydra-daemon.exe, so a chat's
// `taskkill /IM bun.exe` passes the daemon by. The copy must follow bun (a changed bun is copied
// again), must be refreshable while a daemon runs on it, and must lead back to the real bun.

import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentCopy, readStamp, realRuntime, refreshCopy, stampPath } from '../src/core/own-name'

const scratch: string[] = []
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'own-name-'))
  scratch.push(d)
  return d
}
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('copies the runtime once, stamps it, and leads back to the real one', async () => {
  const d = dir()
  const source = join(d, 'bun.exe')
  writeFileSync(source, 'runtime v1')
  const target = join(d, 'bin', 'AgentHydra-daemon.exe')

  expect(currentCopy(source, target)).toBeNull()
  expect(await refreshCopy(source, target)).toEqual({ action: 'copied', path: target })
  expect(readFileSync(target, 'utf8')).toBe('runtime v1')
  expect(readStamp(target)?.source).toBe(source)
  expect(currentCopy(source, target)).toBe(target)
  expect(realRuntime(target)).toBe(source)
  expect(realRuntime(source)).toBe(source) // not a copy: itself

  expect(await refreshCopy(source, target)).toEqual({ action: 'current', path: target })
})

test('a changed runtime is copied again', async () => {
  const d = dir()
  const source = join(d, 'bun.exe')
  writeFileSync(source, 'runtime v1')
  const target = join(d, 'AgentHydra-daemon.exe')
  await refreshCopy(source, target)

  writeFileSync(source, 'runtime v2, a longer build')
  utimesSync(source, new Date(), new Date(Date.now() + 5000))
  expect(currentCopy(source, target)).toBeNull()
  expect((await refreshCopy(source, target)).action).toBe('copied')
  expect(readFileSync(target, 'utf8')).toBe('runtime v2, a longer build')
  expect(currentCopy(source, target)).toBe(target)
})

test('a copy whose source is gone leads back to itself, and a missing source fails without throwing', async () => {
  const d = dir()
  const target = join(d, 'AgentHydra-daemon.exe')
  writeFileSync(target, 'orphan copy')
  writeFileSync(
    stampPath(target),
    JSON.stringify({ source: join(d, 'gone.exe'), size: 1, mtimeMs: 1 }),
  )
  expect(realRuntime(target)).toBe(target)
  expect((await refreshCopy(join(d, 'gone.exe'), target)).action).toBe('failed')
  expect(readFileSync(target, 'utf8')).toBe('orphan copy')
})

test.skipIf(process.platform !== 'win32')(
  'a copy named as its own source in another spelling of its path is left as it is',
  async () => {
    // A daemon on an orphan copy refreshes from its process.execPath (the long, on-disk spelling)
    // into a copy path built from its config folder, which may be 8.3 or differ in case.
    const d = dir()
    const target = join(d, 'AgentHydra-daemon.exe')
    writeFileSync(target, 'orphan copy')
    const stamp = { source: join(d, 'gone.exe'), size: 1, mtimeMs: 1 }
    writeFileSync(stampPath(target), JSON.stringify(stamp))
    expect(await refreshCopy(target.toUpperCase(), target)).toEqual({
      action: 'current',
      path: target,
    })
    expect(readStamp(target)).toEqual(stamp)
  },
)

test.skipIf(process.platform !== 'win32')(
  'refreshes a copy a process is running from, and the copy runs as its own name',
  async () => {
    const d = dir()
    const target = join(d, 'AgentHydra-daemon.exe')
    expect((await refreshCopy(process.execPath, target)).action).toBe('copied')
    const child = Bun.spawn(
      [target, '-e', 'console.log(process.execPath); setTimeout(() => {}, 4000)'],
      {
        stdout: 'pipe',
        stderr: 'ignore',
        windowsHide: true,
      },
    )
    try {
      const reader = child.stdout.getReader()
      const first = new TextDecoder().decode((await reader.read()).value)
      // Windows may expand a short TEMP path (RUNNER~1) in process.execPath.
      // Compare the actual files while still requiring the copied daemon executable.
      expect(realpathSync.native(first.trim()).toLowerCase()).toBe(
        realpathSync.native(target).toLowerCase(),
      )

      // Stale on purpose: the stamp no longer matches, so the next refresh must replace a running exe.
      const stamp = readStamp(target)
      writeFileSync(stampPath(target), JSON.stringify({ ...stamp, mtimeMs: 1 }))
      expect((await refreshCopy(process.execPath, target)).action).toBe('copied')
      expect(currentCopy(process.execPath, target)).toBe(target)
      // The running one was moved aside, and stays until nothing runs it.
      expect(readdirSync(d).some((f) => f.endsWith('.old'))).toBe(true)
    } finally {
      child.kill()
      await child.exited
    }
    // The next refresh with nothing running clears what was moved aside.
    writeFileSync(stampPath(target), JSON.stringify({ ...readStamp(target), mtimeMs: 1 }))
    await refreshCopy(process.execPath, target)
    expect(readdirSync(d).some((f) => f.endsWith('.old'))).toBe(false)
    expect(existsSync(target)).toBe(true)
  },
  30_000,
)
