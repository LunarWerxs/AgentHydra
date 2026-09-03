// tests/automation-stamp-sweep.test.ts - the standing sweep re-stamps only running profiles, adds
// up what it fixed, and cannot be killed by one bad store.
//
// The property that matters most is the last one. This runs on a repeating timer inside a daemon
// that exits on an unhandled rejection (scripts/checks/timer-callback-can-kill-the-daemon.mjs), so
// a single profile whose store throws must cost that profile's pass and nothing else.

import { expect, test } from 'bun:test'
import { runAutomationStampSweepOnce } from '../server/src/automation-stamp-sweep'

test('sweeps every running dir and returns the total re-stamped', async () => {
  const seen: string[] = []
  const total = await runAutomationStampSweepOnce({
    listRunningDirs: async () => ['C:/i/a', 'C:/i/b', 'C:/i/c'],
    reassert: (dir) => {
      seen.push(dir)
      return dir.endsWith('b') ? 3 : 1
    },
    log: () => {},
  })
  expect(seen).toEqual(['C:/i/a', 'C:/i/b', 'C:/i/c'])
  expect(total).toBe(5)
})

test('a profile whose store throws is skipped, the others still run, nothing escapes', async () => {
  const seen: string[] = []
  const total = await runAutomationStampSweepOnce({
    listRunningDirs: async () => ['C:/i/a', 'C:/i/broken', 'C:/i/c'],
    reassert: (dir) => {
      seen.push(dir)
      if (dir.endsWith('broken')) throw new Error('EBUSY')
      return 2
    },
    log: () => {},
  })
  expect(seen).toHaveLength(3)
  expect(total).toBe(4)
})

test('an instance listing that fails is a pass skipped, not a throw', async () => {
  const total = await runAutomationStampSweepOnce({
    listRunningDirs: async () => {
      throw new Error('wmic unavailable')
    },
    reassert: () => {
      throw new Error('must not be reached')
    },
  })
  expect(total).toBe(0)
})

test('says something only when it changed something', async () => {
  const lines: string[] = []
  await runAutomationStampSweepOnce({
    listRunningDirs: async () => ['C:/i/a'],
    reassert: () => 0,
    log: (m) => lines.push(m),
  })
  expect(lines).toEqual([])
  await runAutomationStampSweepOnce({
    listRunningDirs: async () => ['C:/i/a'],
    reassert: () => 2,
    log: (m) => lines.push(m),
  })
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('2 imported chat(s)')
})
