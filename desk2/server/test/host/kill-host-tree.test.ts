import { expect, test } from 'bun:test'
import { killHostTree, processStartedAt, recordedPidOwner } from '../../src/host/launch'

test.skipIf(process.platform !== 'win32')('ending a host tree with taskkill does not hold the thread', async () => {
  const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
  let fired = false
  setTimeout(() => {
    fired = true
  }, 0)
  await killHostTree(child.pid)
  expect(fired).toBe(true)
  await child.exited
  expect(child.killed || child.exitCode !== 0).toBe(true)
}, 20_000)

// A host or service file outlives its process after a crash or a reboot, and Windows gives the pid to the
// next process that starts. Killing by the recorded pid alone would end that stranger's whole tree.
test('a recorded pid another process has taken since is left alone', async () => {
  const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
  try {
    const started = await processStartedAt(child.pid)
    expect(started).not.toBeNull()
    expect(Math.abs((started as number) - Date.now())).toBeLessThan(30_000)
    // What its own file would say: the process is the one that wrote it.
    expect(await recordedPidOwner(child.pid, Date.now())).toBe('ours')
    // What a file from an hour ago says about the same pid: someone else's, so no kill.
    const hourAgo = Date.now() - 3_600_000
    expect(await recordedPidOwner(child.pid, hourAgo)).toBe('foreign')
    expect(await killHostTree(child.pid, hourAgo)).toBe(false)
    expect(child.exitCode).toBeNull()
    expect(child.killed).toBe(false)
  } finally {
    child.kill()
    await child.exited
  }
}, 20_000)

test('a pid whose start cannot be read is never proof enough to kill', async () => {
  expect(await recordedPidOwner(1234, Date.now(), async () => null)).toBe('unknown')
  expect(await recordedPidOwner(-1, Date.now())).toBe('unknown')
})
