// Regression guard for the instance-launch DETACH contract (see buildInstanceLaunch).
//
// The bug this locks out: quitting AgentHydra took the launched Claude Desktop instance down
// with it. The Windows tray host quits by tree-killing the daemon's whole process tree
// (`taskkill /PID <daemon> /T /F`), so an instance launched as a DIRECT child of the daemon is in
// that tree and dies on Quit. Empirically (2026-07-12) neither `.unref()` nor Bun's
// `detached: true` breaks the Windows process tree; only a hand-off launcher (`cmd /c start`)
// re-parents the instance out of the tree. These tests pin that argv shape per-OS so a future
// "simplification" back to a plain `Bun.spawn([binary, ...args])` fails CI instead of silently
// reintroducing the regression.
import { expect, test } from 'bun:test'
import { buildInstanceLaunch, confirmLaunchSurvives } from '../src/core/instances'
import type { CMProcessInfo } from '../src/core/process'

const WIN_BIN = 'C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\app-1.0.0\\Claude.exe'
const WIN_ARGS = ['--user-data-dir', 'C:\\path with space\\profile']

test('win32: launches via WMI Win32_Process.Create so the instance escapes the daemon process tree', () => {
  const { argv, detached } = buildInstanceLaunch('win32', WIN_BIN, WIN_ARGS)
  // Handed to a transient PowerShell that drives the create — never spawned directly.
  expect(argv[0]).toBe('powershell')
  expect(argv).toContain('-NoProfile')
  expect(argv).toContain('-NonInteractive')

  const script = argv[argv.length - 1] as string
  // The WMI create is what makes this both tree-safe AND handle-leak-free.
  expect(script).toContain('Win32_Process')
  expect(script).toContain('Create')
  // The real binary still has to reach the CommandLine (unquoted: this fixture path has no spaces).
  expect(script).toContain(WIN_BIN)

  // The binary must NOT be argv[0]: a direct spawn is exactly the tree-kill regression.
  expect(argv[0]).not.toBe(WIN_BIN)
  // Windows detach comes from the hand-off, NOT Bun's (ineffective) detached flag.
  expect(detached).toBe(false)
})

test('win32: spaced --user-data-dir value survives as a single quoted CommandLine token', () => {
  const { argv } = buildInstanceLaunch('win32', WIN_BIN, WIN_ARGS)
  const script = argv[argv.length - 1] as string
  // WMI takes ONE command-line string, so the spaced path survives by quoting rather than by being
  // its own argv element — quoting it wrong is how `--user-data-dir` silently splits in two.
  expect(script).toContain('"C:\\path with space\\profile"')
})

test('darwin: launches via `open`, which hands off to LaunchServices (never our child)', () => {
  const args = ['-na', 'Claude', '--args', '--user-data-dir', '/Users/me/profile']
  const { argv, detached } = buildInstanceLaunch('darwin', 'Claude', args)
  expect(argv).toEqual(['open', ...args])
  expect(detached).toBe(false)
})

test('linux: direct spawn but detached:true (setsid), a genuine POSIX detach', () => {
  const { argv, detached } = buildInstanceLaunch('linux', '/usr/bin/claude', [
    '--user-data-dir',
    '/home/me/p',
  ])
  expect(argv).toEqual(['/usr/bin/claude', '--user-data-dir', '/home/me/p'])
  expect(detached).toBe(true)
})

test('an app that exits within seconds of starting is a failed launch, not "launched" (2026-09-24)', async () => {
  // launch_instance answered `launched` (pid 42632) for #26, and seconds later list_instances
  // showed it not running; fan_out then waited out its own 90s timer on an app that was gone.
  const dir = 'c:/i/luis'
  const main = { pid: 42632, dir, isMain: true } as CMProcessInfo
  const scans = [[main], []]
  let clock = 0
  const deps = {
    scan: async () => ({ ok: true as const, processes: scans.shift() ?? [] }),
    sleep: async (ms: number) => {
      clock += ms
    },
    now: () => clock,
    alive: () => false,
  }
  await expect(confirmLaunchSurvives(dir, deps)).rejects.toThrow('exited within')
})

// 2026-09-25 (owner: "why is Agent Hydra so friggin slow at opening instances"): the 5s window
// used to start when a ~1s scan happened to notice the app and end in another full scan, so every
// open paid ~8s on top of Claude's own startup. It now starts at the process's own CreationDate.
function survivalDeps(scans: CMProcessInfo[][], alive: (pid: number, clock: number) => boolean) {
  const t = { clock: 100_000, scans: 0 }
  return {
    t,
    deps: {
      scan: async () => {
        t.scans += 1
        return { ok: true as const, processes: scans.shift() ?? [] }
      },
      sleep: async (ms: number) => {
        t.clock += ms
      },
      now: () => t.clock,
      alive: (pid: number) => alive(pid, t.clock),
    },
  }
}

test('the survival window counts from the process start time, with one scan and no re-scan', async () => {
  const dir = 'c:/i/luis'
  const startedAgo = (ms: number) => new Date(100_000 - ms).toISOString()
  // Up 4s already when first seen: only the last second is waited for.
  const young = survivalDeps(
    [[{ pid: 7, dir, isMain: true, startTime: startedAgo(4_000) } as CMProcessInfo]],
    () => true,
  )
  await expect(confirmLaunchSurvives(dir, young.deps)).resolves.toBe(7)
  expect(young.t.clock - 100_000).toBe(1_000)
  expect(young.t.scans).toBe(1)
  // A managed launch that already waited out its inspector: nothing left to wait for.
  const old = survivalDeps(
    [[{ pid: 8, dir, isMain: true, startTime: startedAgo(9_000) } as CMProcessInfo]],
    () => true,
  )
  await expect(confirmLaunchSurvives(dir, old.deps)).resolves.toBe(8)
  expect(old.t.clock).toBe(100_000)
  // No readable start time: the full window from the sighting, as before.
  const blind = survivalDeps([[{ pid: 9, dir, isMain: true } as CMProcessInfo]], () => true)
  await expect(confirmLaunchSurvives(dir, blind.deps)).resolves.toBe(9)
  expect(blind.t.clock - 100_000).toBe(5_000)
})

test('an early exit is reported mid-window, and a main process under a new pid still counts', async () => {
  const dir = 'c:/i/luis'
  const main = {
    pid: 7,
    dir,
    isMain: true,
    startTime: new Date(100_000).toISOString(),
  } as CMProcessInfo
  const died = survivalDeps([[main], []], (_pid, clock) => clock < 101_000)
  await expect(confirmLaunchSurvives(dir, died.deps)).rejects.toThrow('exited within')
  expect(died.t.clock - 100_000).toBeLessThan(1_500)
  // A hand-off: the stub exits and the real app runs on - and must survive its own window.
  const successor = { pid: 70, dir, isMain: true } as CMProcessInfo
  const moved = survivalDeps([[main], [successor]], (pid) => pid !== 7)
  await expect(confirmLaunchSurvives(dir, moved.deps)).resolves.toBe(70)
  expect(moved.t.clock - 100_000).toBeGreaterThanOrEqual(5_000)
  const crashed = survivalDeps(
    [[main], [successor], []],
    (pid, clock) => pid === 70 && clock < 102_000,
  )
  await expect(confirmLaunchSurvives(dir, crashed.deps)).rejects.toThrow('pid 70')
})
