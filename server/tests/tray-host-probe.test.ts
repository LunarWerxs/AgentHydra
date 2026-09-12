// server/tests/tray-host-probe.test.ts — "is the tray running?" answered BACKWARDS (2026-09-11).
//
// ⛔ THE BUG, found live while fixing the compiled build's missing tray toolkit. The probe ran
//   Get-Process -Name lunarwerx-tray -ErrorAction SilentlyContinue | Select -ExpandProperty Id
// and treated a NON-ZERO EXIT as "running". But -ErrorAction SilentlyContinue suppresses the error
// TEXT, not the error RECORD: with no such process powershell.exe exits 1. Measured on this machine
// that day: absent -> exit 1, present -> exit 0. So the single case the function exists to detect
// was the case it got exactly wrong, and `startTrayHostIfMissing` reported 'already-running' on
// every run since it shipped - the daemon-starts-its-own-tray fix of 2026-09-03 could never once
// have fired. The boot log said "tray host not started: already-running" while no tray host
// existed anywhere on the machine.
//
// Two rules come out of it, and both are pinned here: the probe reports an UNKNOWN instead of
// guessing, and an unknown makes the start path START (the host claims a named mutex, so a double
// start cannot produce two icons) while the tray INVARIANT keeps reading an unknown as "running",
// because that one can shut the daemon down.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { parseTrayHostCount, startTrayHostIfMissing, TRAY_HOST_EXE } from '../src/tray-host'

// Paths are built with node's join, never typed with separators: the suite also runs on the Linux
// CI leg, where a hand-written 'C:\app\misc\...' can only ever fail (it did, on the first run).
const APP_ROOT = join('C:', 'app')

function starter(isRunning: () => Promise<boolean | null>) {
  const spawned: string[] = []
  return {
    spawned,
    run: () =>
      startTrayHostIfMissing({
        appRoot: APP_ROOT,
        compiled: true,
        hideTray: () => false,
        platform: 'win32',
        exists: () => true, // the toolkit is there
        isRunning,
        spawnHost: (exe) => void spawned.push(exe),
      }),
  }
}

describe('parseTrayHostCount', () => {
  test('a count is a number, and only a number', () => {
    expect(parseTrayHostCount('0\r\n')).toBe(false)
    expect(parseTrayHostCount('1')).toBe(true)
    expect(parseTrayHostCount(' 2 \n')).toBe(true)
  })

  test('anything that is not a count is UNKNOWN, never a zero', () => {
    // The old code's mistake in miniature: "no output" is not "no process", it is "no answer".
    expect(parseTrayHostCount('')).toBeNull()
    expect(parseTrayHostCount('\r\n')).toBeNull()
    expect(parseTrayHostCount('Get-Process : command not found')).toBeNull()
  })
})

describe('startTrayHostIfMissing', () => {
  test('an absent host is STARTED', async () => {
    const s = starter(async () => false)
    const got = await s.run()
    expect(got.start).toBe(true)
    expect(s.spawned).toEqual([join(APP_ROOT, 'misc', TRAY_HOST_EXE)])
  })

  test('a host that IS running is left alone', async () => {
    const s = starter(async () => true)
    const got = await s.run()
    expect(got).toMatchObject({ start: false, reason: 'already-running' })
    expect(s.spawned).toEqual([])
  })

  test('an UNKNOWN starts it - the regression that kept the tray off for weeks', async () => {
    // This is the whole bug: the probe could not answer, the old default said "running", and the
    // app went without an icon forever. A duplicate is impossible (named mutex), so the only
    // honest default here is to try.
    const s = starter(async () => null)
    const got = await s.run()
    expect(got.start).toBe(true)
    expect(s.spawned).toHaveLength(1)
  })

  test('a materialized toolkit directory is used instead of <appRoot>/misc', async () => {
    const spawned: Array<{ exe: string; cwd: string }> = []
    const placed = join('C:', 'state', 'tray', '0.41.0')
    const got = await startTrayHostIfMissing({
      appRoot: APP_ROOT,
      compiled: true,
      hideTray: () => false,
      platform: 'win32',
      toolkitDir: placed,
      exists: () => true,
      isRunning: async () => false,
      spawnHost: (exe, cwd) => void spawned.push({ exe, cwd }),
    })
    expect(got.start).toBe(true)
    expect(spawned[0]?.exe).toBe(join(placed, TRAY_HOST_EXE))
    // The host resolves its config against its own directory, so the cwd must be that directory.
    expect(spawned[0]?.cwd).toBe(placed)
  })

  test('no toolkit anywhere is a named fault, not a silent skip', async () => {
    const got = await startTrayHostIfMissing({
      appRoot: APP_ROOT,
      compiled: true,
      hideTray: () => false,
      platform: 'win32',
      exists: () => false,
      isRunning: async () => false,
      spawnHost: () => {
        throw new Error('must not spawn')
      },
    })
    expect(got).toMatchObject({ start: false, reason: 'no-tray-toolkit' })
  })
})
