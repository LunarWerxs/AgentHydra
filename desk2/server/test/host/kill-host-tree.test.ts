import { expect, test } from 'bun:test'
import { killHostTree } from '../../src/host/launch'

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
