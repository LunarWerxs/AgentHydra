import { expect, test } from 'bun:test'
import { spawnCaptured } from '../src/core/process.ts'

// spawnCaptured runs on a worker thread so Bun.spawn's 100-280 ms hold never lands on the daemon's
// loop; the contract the callers rely on must survive the hop.
test('spawnCaptured: stdout, stderr, exit code and env cross the worker', async () => {
  const r = await spawnCaptured(
    [process.execPath, '-e', 'console.log(process.env.SW_X); console.error("e"); process.exit(3)'],
    { env: { ...process.env, SW_X: 'hello' } },
  )
  expect(r).toEqual({ code: 3, stdout: 'hello\n', stderr: 'e\n', timedOut: false })
})

test('spawnCaptured: a hung child is killed at the deadline and reported timedOut', async () => {
  const r = await spawnCaptured(
    [process.execPath, '-e', 'console.log("a"); setInterval(()=>{},1000)'],
    {
      timeoutMs: 1500,
    },
  )
  expect(r.timedOut).toBe(true)
  expect(r.stdout).toBe('a\n')
})

test('spawnCaptured: a command that cannot start comes back as data', async () => {
  const r = await spawnCaptured(['definitely-not-a-command-xyz'])
  expect(r).toEqual({ code: null, stdout: '', stderr: '', timedOut: false })
})
