import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import * as jsc from 'bun:jsc'
import type { Timings } from './timings'

/** JSC's sampler as Bun 1.4 has it: bun-types names the traces call differently from the runtime. */
const sampler = jsc as unknown as { startSamplingProfiler(): void; samplingProfilerStackTraces(): { traces?: Trace[] } }

/** A stall past this many ms (beyond the timer's own tick) is written to the timings log. */
export const LOOP_STALL_MS = 200
/**
 * A stall this long starts JSC's sampling profiler, and from then on every stall this long is written with the
 * functions that ran in it (StallProfile). Owner, 2026-10-09: the sidebar kept emptying and refilling; under it the
 * server's thread was busy for 7 to 80 s at a time, 181 times that day (2,420 s), and nothing could say on what. The
 * profiler cannot be stopped once started, so it starts only on a server that has stalled this long: it samples the
 * thread every millisecond, and the samples between stalls are dropped every DRAIN_MS.
 */
export const PROFILE_STALL_MS = 2000
const TICK_MS = 50
const DRAIN_MS = 1000
const FRAMES_KEPT = 12
const LOG_MAX_BYTES = 2 * 1024 * 1024
/** JSC's line for a frame whose position it does not know. */
const NO_LINE = 4294967295

interface Frame {
  name?: string
  sourceURL?: string
  line?: number
}
interface Trace {
  frames: Frame[]
}

/** One stall's samples: the functions on top (self) and anywhere on the stack (total), each with its sample count. */
export interface StallProfile {
  samples: number
  self: [string, number][]
  total: [string, number][]
}

const frameLabel = (f: Frame): string => {
  const file = (f.sourceURL ?? '').replace(/^.*[\\/]desk2[\\/]/, '')
  return [f.name || '(anonymous)', file].filter(Boolean).join(' ')
}

/** The most frequent functions of a set of samples, by name and file. */
export function stallProfile(traces: readonly Trace[]): StallProfile {
  const self = new Map<string, number>()
  const total = new Map<string, number>()
  let samples = 0
  for (const t of traces) {
    if (!t.frames.length) continue
    samples++
    const top = t.frames[0]!
    const key = top.line && top.line !== NO_LINE ? `${frameLabel(top)}:${top.line}` : frameLabel(top)
    self.set(key, (self.get(key) ?? 0) + 1)
    for (const k of new Set(t.frames.map(frameLabel))) total.set(k, (total.get(k) ?? 0) + 1)
  }
  const most = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, FRAMES_KEPT)
  return { samples, self: most(self), total: most(total) }
}

function drain(): Trace[] {
  return sampler.samplingProfilerStackTraces().traces ?? []
}

function writeProfile(file: string, line: object): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`)
    } catch {
      // no log yet
    }
    appendFileSync(file, `${JSON.stringify(line)}\n`)
  } catch (err) {
    console.error('[loop-stall] could not write the stall profile:', err)
  }
}

/**
 * Logs a `loop_stall` span whenever the server's one thread runs nothing for more than the threshold. With
 * `profile`, a stall of `profile.afterMs` (PROFILE_STALL_MS) or more also starts the sampling profiler, and each
 * later one is appended to `profile.file` as a JSON line: when, how long, the CPU it took, and its StallProfile.
 */
export function watchLoopStalls(
  timings: Timings,
  threshold = LOOP_STALL_MS,
  profile?: { file: string; afterMs?: number },
): () => void {
  const profileAfter = profile?.afterMs ?? PROFILE_STALL_MS
  let sampling = false
  let last = performance.now()
  let drainedAt = last
  let lastCpu = process.cpuUsage()
  const tick = setInterval(() => {
    const now = performance.now()
    const late = now - last - TICK_MS
    last = now
    const cpu = process.cpuUsage()
    const cpuMs = Math.round((cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000)
    lastCpu = cpu
    if (late > threshold) timings.span({ stage: 'loop_stall', ms: late, cpu: cpuMs })
    if (!profile) return
    if (late >= profileAfter) {
      if (sampling) {
        writeProfile(profile.file, { at: new Date().toISOString(), ms: Math.round(late), cpu: cpuMs, ...stallProfile(drain()) })
      } else {
        sampler.startSamplingProfiler()
        sampling = true
      }
      drainedAt = now
    } else if (sampling && now - drainedAt >= DRAIN_MS) {
      drain()
      drainedAt = now
    }
  }, TICK_MS)
  tick.unref()
  return () => clearInterval(tick)
}
