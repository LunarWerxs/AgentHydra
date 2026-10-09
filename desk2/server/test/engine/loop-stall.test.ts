import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchLoopStalls } from '../../src/engine/loop-stall'
import { Timings } from '../../src/engine/timings'

const hold = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // the thread is busy: no timer runs meanwhile
  }
}
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

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
})
