import { beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_GROWN_BYTES,
  growthOf,
  MAX_GROWN_BYTES,
  type MachineMemory,
  memoryShort,
  RAMP_MS,
  resetLearnedGrownBytes,
  treeSums,
} from '../src/climayte-memory'

const GIB = 2 ** 30
const gib = (n: number): number => n * GIB
const box = (
  free: number,
  total = 47.9,
  commit?: { left: number; limit: number },
): MachineMemory => ({
  freeBytes: gib(free),
  totalBytes: gib(total),
  commitFreeBytes: commit ? gib(commit.left) : null,
  commitLimitBytes: commit ? gib(commit.limit) : null,
})
const sets = (n: number, gbEach: number | null): (number | null)[] =>
  Array.from({ length: n }, () => (gbEach === null ? null : gib(gbEach)))

describe('memoryShort: a growing worker reserves only what it has left to grow', () => {
  test('(a) 15.5 of 47.9 GB free, 16 workers 90 s old already at 0.35 GB: a start is allowed', () => {
    const growth = { expectedBytes: DEFAULT_GROWN_BYTES, sets: sets(16, 0.35) }
    expect(memoryShort(box(15.5), growth)).toBeNull()
    // the old gate: 17 x 0.75 GB = 12.75 GB needed above a 3.8 GB floor held it
    expect(15.5 - 17 * 0.75).toBeLessThan(47.9 * 0.08)
  })

  test('(b) 16 workers just launched at 0.02 GB each are still mostly reserved', () => {
    const fresh = { expectedBytes: DEFAULT_GROWN_BYTES, sets: sets(16, 0.02) }
    const grown = { expectedBytes: DEFAULT_GROWN_BYTES, sets: sets(16, 0.35) }
    // 10 GB free: 16 x 0.43 reserved leaves 2.7 GB, under the 3.8 GB floor
    const held = memoryShort(box(10), fresh)
    expect(held).toContain('6.9 GB reserved for growing workers')
    expect(held).toContain('16 workers started in the last 2 minutes')
    expect(memoryShort(box(10), grown)).toBeNull()
  })

  test('(c) the 8% RAM floor and the commit floor still hold', () => {
    const none = { expectedBytes: DEFAULT_GROWN_BYTES, sets: [] }
    // floor 3.83 GB, need 0.45 GB
    expect(memoryShort(box(4.2), none)).toContain('RAM free')
    expect(memoryShort(box(4.4), none)).toBeNull()
    // commit: 12% of 100 GB = 12 GB, a worker commits 0.75 GB however much RAM there is
    expect(memoryShort(box(40, 47.9, { left: 12.5, limit: 100 }), none)).toContain('commit limit')
    expect(memoryShort(box(40, 47.9, { left: 13, limit: 100 }), none)).toBeNull()
    // the commit check stays on private bytes for every recent worker, grown or not
    expect(
      memoryShort(box(40, 47.9, { left: 15, limit: 100 }), {
        expectedBytes: DEFAULT_GROWN_BYTES,
        sets: sets(4, 0.45),
      }),
    ).toContain('commit limit')
    expect(memoryShort(null, 50)).toBeNull()
  })

  test('(d) an unreadable tree reserves the full expected amount', () => {
    const unread = { expectedBytes: DEFAULT_GROWN_BYTES, sets: sets(16, null) }
    // 16 x 0.45 = 7.2 GB reserved: 10 GB free is short, 15.5 GB is not
    expect(memoryShort(box(10), unread)).toContain('7.2 GB reserved')
    expect(memoryShort(box(15.5), unread)).toBeNull()
    // a tree whose runner cannot be read gives null; a refused child only adds nothing
    const rows = [
      { pid: 1, ppid: 0, workingSet: gib(0.1) },
      { pid: 2, ppid: 1, workingSet: null },
      { pid: 3, ppid: 1, workingSet: gib(0.2) },
      { pid: 9, ppid: 0, workingSet: null },
    ]
    expect(treeSums([1, 9, 77, null], rows)).toEqual([gib(0.1) + gib(0.2), null, null, null])
  })
})

describe('growthOf: the expected grown size is learned from workers past the ramp', () => {
  beforeEach(resetLearnedGrownBytes)
  const now = 10 * RAMP_MS
  const old = (pid: number) => ({ runnerPid: pid, startedAt: now - 2 * RAMP_MS })
  const young = (pid: number) => ({ runnerPid: pid, startedAt: now - 1000 })
  const reader = (by: Record<number, number | null>) => (pids: (number | null)[]) =>
    pids.map((p) => (p === null ? null : (by[p] ?? null)))

  test('median of the old workers, until then the default; clamped; read only every minute', () => {
    expect(growthOf([young(5)], now, reader({ 5: gib(0.1) })).expectedBytes).toBe(
      DEFAULT_GROWN_BYTES,
    )
    resetLearnedGrownBytes()
    const run = [old(1), old(2), old(3), young(5)]
    const g = growthOf(run, now, reader({ 1: gib(0.3), 2: gib(0.5), 3: gib(0.9), 5: gib(0.1) }))
    expect(g.expectedBytes).toBe(gib(0.5))
    expect(g.sets).toEqual([gib(0.1)])
    // inside the minute the learned value stands, whatever the old workers now read
    expect(
      growthOf(run, now + 30_000, reader({ 1: gib(0.9), 2: gib(0.9), 3: gib(0.9) })).expectedBytes,
    ).toBe(gib(0.5))
    resetLearnedGrownBytes()
    expect(growthOf([old(1)], now, reader({ 1: gib(3) })).expectedBytes).toBe(MAX_GROWN_BYTES)
  })
})
