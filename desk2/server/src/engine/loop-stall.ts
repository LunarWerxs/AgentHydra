import type { Timings } from './timings'

/** A stall past this many ms (beyond the timer's own tick) is written to the timings log. */
export const LOOP_STALL_MS = 200
const TICK_MS = 50

/** Logs a `loop_stall` span whenever the server's one thread runs nothing for more than the threshold. */
export function watchLoopStalls(timings: Timings, threshold = LOOP_STALL_MS): () => void {
  let last = performance.now()
  let lastCpu = process.cpuUsage()
  const tick = setInterval(() => {
    const now = performance.now()
    const late = now - last - TICK_MS
    last = now
    const cpu = process.cpuUsage()
    const cpuMs = Math.round((cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000)
    lastCpu = cpu
    if (late > threshold) timings.span({ stage: 'loop_stall', ms: late, cpu: cpuMs })
  }, TICK_MS)
  tick.unref()
  return () => clearInterval(tick)
}
