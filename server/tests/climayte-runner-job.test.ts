// The Windows runner's job (misc/climayte-runner-native/src/job.rs), seen from outside as the daemon
// sees it: through the exit file. What a worker leaves running ends with its runner and is named
// there (field note 43: a finished worker left `bun vite` on port 4289 running), and one worker's
// tree has a ceiling on how many processes it may have alive at once (2026-10-03: a self-calling
// shell function started about 3,000 processes and froze the desktop).
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RunnerExit, type RunnerPids, runnerArgv } from '../src/climayte-runner'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Run the stand-in CLI `script` under the runner; what it printed and the exit file. */
async function underRunner(script: string, maxProcesses?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'ah-runner-job-'))
  dirs.push(dir)
  const cli = join(dir, 'cli.ts')
  writeFileSync(cli, script)
  for (const f of ['in.txt', 'out.log', 'err.log']) writeFileSync(join(dir, f), '')
  const spec = join(dir, 'spec.json')
  writeFileSync(
    spec,
    JSON.stringify({
      argv: [process.execPath, cli],
      cwd: dir,
      env: { ...(process.env as Record<string, string>) },
      stdin: join(dir, 'in.txt'),
      stdout: join(dir, 'out.log'),
      stderr: join(dir, 'err.log'),
      pidFile: join(dir, 'pid.json'),
      exitFile: join(dir, 'exit.json'),
      ...(maxProcesses ? { maxProcesses } : {}),
    }),
  )
  const runner = Bun.spawn(runnerArgv(spec), {
    cwd: dir,
    stdout: 'ignore',
    stderr: 'ignore',
    windowsHide: true,
  })
  expect(await runner.exited).toBe(0)
  const out = readFileSync(join(dir, 'out.log'), 'utf8').trim().split('\n').pop() as string
  const exit = JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8')) as RunnerExit
  const pids = JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8')) as RunnerPids
  return { printed: JSON.parse(out), exit, pids }
}

/** Starts `want` idle children, reports how many started and are alive, then ends them. They live
 *  past two of the runner's 2-second samples, so `peakProcesses` sees them. */
const SPAWN_IDLE = (want: number) => `const kids = []
let refused = 0
for (let i = 0; i < ${want}; i++) {
  try {
    kids.push(Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 20000)'], { stdout: 'ignore', stderr: 'ignore' }))
  } catch {
    refused++
  }
}
await Bun.sleep(4500)
const alive = kids.filter((k) => k.exitCode === null && k.signalCode === null).length
console.log(JSON.stringify({ alive, refused }))
for (const k of kids) k.kill()
`

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform !== 'win32')('the Windows runner job', () => {
  test('without a ceiling every child runs, and the exit file says how many the tree had', async () => {
    const { printed, exit } = await underRunner(SPAWN_IDLE(12))
    expect(printed).toEqual({ alive: 12, refused: 0 })
    // The runner, the CLI and its 12 children at least.
    expect(exit.peakProcesses).toBeGreaterThanOrEqual(14)
  }, 60_000)

  test('with a ceiling the tree never has more processes alive than it', async () => {
    const { printed } = await underRunner(SPAWN_IDLE(12), 6)
    // The runner and the CLI count, console hosts do not: at most 4 of the 12.
    expect(printed.alive).toBeLessThanOrEqual(4)
  }, 60_000)

  test('what the CLI leaves running is named in the exit file and ends with the runner', async () => {
    // `start /b` runs ping from a cmd that exits at once, so ping outlives the CLI the way a dev
    // server under an sh wrapper did.
    const { exit, pids } =
      await underRunner(`const cmd = Bun.spawn(['cmd.exe', '/d', '/c', 'start', '/b', 'ping', '-n', '60', '127.0.0.1'], { stdout: 'ignore', stderr: 'ignore' })
await cmd.exited
await Bun.sleep(500)
console.log(JSON.stringify({ started: true }))
`)
    const ping = exit.left?.find((l) => /^ping\.exe$/i.test(l.name))
    expect(ping?.command).toContain('127.0.0.1')
    // The runner is in its own job, and is not its own leftover.
    expect(exit.left?.some((l) => l.pid === pids.runner)).toBe(false)
    const deadline = Date.now() + 5_000
    while (ping && alive(ping.pid) && Date.now() < deadline) await Bun.sleep(100)
    expect(ping && alive(ping.pid)).toBe(false)
  }, 60_000)
})
