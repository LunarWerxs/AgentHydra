import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOOP_STALL_MS, watchLoopStalls } from '../../src/engine/loop-stall'
import { Timings } from '../../src/engine/timings'

const hold = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // the thread is busy: no timer runs meanwhile
  }
}
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
function stallingWork(ms: number): void {
  hold(ms)
}

describe('event-loop stall probe', () => {
  test('logs a loop_stall span for a blocked thread', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-stall-'))
    try {
      const timings = new Timings(home)
      const stop = watchLoopStalls(timings)
      await pause(60)
      hold(400)
      await pause(120)
      stop()
      const stalls = timings.read().filter((s) => s.stage === 'loop_stall')
      expect(stalls.some((s) => s.ms >= 300)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a busy stall shows its CPU time, a sleeping one does not', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-stall-'))
    try {
      const timings = new Timings(home)
      const stop = watchLoopStalls(timings)
      await pause(60)
      hold(400)
      await pause(120)
      Bun.sleepSync(400)
      await pause(120)
      stop()
      const stalls = timings.read().filter((s) => s.stage === 'loop_stall' && s.ms >= 300)
      const cpu = stalls.map((s) => s.cpu ?? 0)
      expect(cpu.length).toBeGreaterThanOrEqual(2)
      expect(Math.max(...cpu)).toBeGreaterThan(Math.min(...cpu) + 20)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20_000)

  test('a long stall is written with the functions that ran in it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-stall-'))
    const file = join(home, 'logs', 'loop-stalls.jsonl')
    try {
      const stop = watchLoopStalls(new Timings(home), LOOP_STALL_MS, { file, afterMs: 150 })
      await pause(60)
      // The first long stall starts the profiler; the next is written with what ran in it.
      hold(200)
      await pause(120)
      stallingWork(400)
      await pause(120)
      stop()
      const lines = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { ms: number; total: [string, number][] })
      expect(lines.some((l) => l.ms >= 300 && l.total.some(([f]) => f.startsWith('stallingWork ')))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20_000)
})
