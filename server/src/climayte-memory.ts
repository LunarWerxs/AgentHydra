// server/src/climayte-memory.ts — a CliMayte worker starts only when the machine has the memory to
// run it (owner, 2026-10-04: the same progress with less memory and CPU; memory is the cause and
// CPU the side effect).
//
// Measured 2026-10-04 on the owner's PC (32 threads, 63 GB): 33 workers ran at once beside the
// owner's own work. Free RAM swung between 0.5 and 5.8 GB, commit stood at 157-170 GB of a 165-177 GB
// limit, and Windows spent about 5 of the 32 threads compressing and paging memory (System 2.8,
// Memory Compression 2.0). A worker started past that line adds no progress: every process on the
// box slows, and at the commit limit an allocation fails, so a CLI dies or a check goes red for the
// machine rather than the code. Placement (climayte-placement.ts) weighed the accounts' usage only;
// nothing weighed the machine.
//
// So a start waits while it would leave free memory under the floor, and goes on the first tick
// with room (3 s). Workers that started in the last RAMP_MS count as already full grown: a CLI
// reaches its size over its first minutes, so the next tick's reading does not show it yet, and
// without this a burst of starts would all pass on the same free figure. Nothing running is stopped
// or slowed. A machine it cannot read (macOS, whose free count leaves out reclaimable memory; a
// failed call) never holds work.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const GIB = 2 ** 30

/** What the machine has free now. `commit*` is Windows' commit charge (RAM plus page file): null
 *  elsewhere, where overcommit makes it no limit. */
export interface MachineMemory {
  freeBytes: number
  totalBytes: number
  commitFreeBytes: number | null
  commitLimitBytes: number | null
}

/** What one worker holds once grown: 24.5 GB over the 33 worker trees measured 2026-10-04 (its CLI
 *  544 MB private on average, its runner 123 MB, its shells and tools the rest). */
export const WORKER_BYTES = 0.75 * GIB
/** Free RAM a start must leave: 8% of the machine, fairjob's floor (exit 75; 20% never opened on a
 *  busy box, 2026-09-25). */
export const FREE_FLOOR_SHARE = 0.08
/** Commit a start must leave on Windows: 5% of the limit. Past the limit allocations fail outright,
 *  so this floor guards crashes where the RAM floor guards speed. */
export const COMMIT_FLOOR_SHARE = 0.05
/** A worker that started this recently is counted as full grown (WORKER_BYTES). */
export const RAMP_MS = 120_000

const gb = (bytes: number): string => (bytes / GIB).toFixed(1)

/** Why another worker may not start now, or null when it may. `growing`: workers that started within
 *  RAMP_MS, this tick's starts included. */
export function memoryShort(m: MachineMemory | null, growing: number): string | null {
  if (!m) return null
  const need = (growing + 1) * WORKER_BYTES
  const still =
    growing > 0
      ? ` (${growing} worker${growing === 1 ? '' : 's'} started in the last ${RAMP_MS / 60_000} minutes, still growing)`
      : ''
  const ramFloor = m.totalBytes * FREE_FLOOR_SHARE
  if (m.freeBytes - need < ramFloor)
    return `${gb(m.freeBytes)} GB of ${gb(m.totalBytes)} GB RAM free${still}; a worker needs about ${gb(WORKER_BYTES)} GB above ${gb(ramFloor)} GB`
  if (m.commitFreeBytes !== null && m.commitLimitBytes !== null) {
    const commitFloor = m.commitLimitBytes * COMMIT_FLOOR_SHARE
    if (m.commitFreeBytes - need < commitFloor)
      return `${gb(m.commitFreeBytes)} GB of the ${gb(m.commitLimitBytes)} GB commit limit left${still}; a worker needs about ${gb(WORKER_BYTES)} GB above ${gb(commitFloor)} GB`
  }
  return null
}

type StatusCall = (buf: Uint8Array) => boolean
let statusCall: StatusCall | null | undefined

/** kernel32's GlobalMemoryStatusEx, opened once (the tick reads it every 3 s). */
function windowsStatusCall(): StatusCall | null {
  if (statusCall !== undefined) return statusCall
  try {
    const { dlopen, FFIType, ptr } = createRequire(import.meta.url)('bun:ffi')
    const k = dlopen('kernel32.dll', {
      GlobalMemoryStatusEx: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols
    statusCall = (buf) => k.GlobalMemoryStatusEx(ptr(buf)) !== 0
  } catch {
    statusCall = null
  }
  return statusCall
}

/** MEMORYSTATUSEX is 64 bytes: dwLength at 0, then ullTotalPhys at 8, ullAvailPhys at 16,
 *  ullTotalPageFile (the commit limit) at 24 and ullAvailPageFile (commit left) at 32. */
function readWindows(): MachineMemory | null {
  const call = windowsStatusCall()
  if (!call) return null
  const buf = new Uint8Array(64)
  const view = new DataView(buf.buffer)
  view.setUint32(0, 64, true)
  if (!call(buf)) return null
  const at = (offset: number): number => Number(view.getBigUint64(offset, true))
  return {
    totalBytes: at(8),
    freeBytes: at(16),
    commitLimitBytes: at(24),
    commitFreeBytes: at(32),
  }
}

/** MemAvailable counts the cache the kernel can drop, which MemFree does not. */
function readLinux(): MachineMemory | null {
  const text = readFileSync('/proc/meminfo', 'utf8')
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)
    return m ? Number(m[1]) * 1024 : null
  }
  const free = kb('MemAvailable')
  const total = kb('MemTotal')
  if (free === null || total === null) return null
  return { freeBytes: free, totalBytes: total, commitFreeBytes: null, commitLimitBytes: null }
}

/** This machine's memory now, or null where it cannot be read (then nothing waits for memory). */
export function readMachineMemory(): MachineMemory | null {
  try {
    if (process.platform === 'win32') return readWindows()
    if (process.platform === 'linux') return readLinux()
  } catch {
    // unreadable: no gate rather than a held queue
  }
  return null
}
