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
// with room (3 s). Workers that started in the last RAMP_MS are still growing: a CLI reaches its
// size over its first minutes, so without a reserve a burst of starts would all pass on the same
// free figure. Each reserves only what it has left to grow (2026-10-06: free RAM already excludes
// what it holds now, and RAM is working set, not private bytes; reserving a full 0.75 GB again for
// 16 workers held starts on a 48 GB PC with 15 GB free). Nothing running is stopped
// or slowed. A machine it cannot read (macOS, whose free count leaves out reclaimable memory; a
// failed call) never holds work.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { linuxProcTable } from './core/process'
import { INFO_WORKING_SET, nativeProcessInfo, nativeProcessTable } from './core/win-process-table'

const GIB = 2 ** 30

/** What the machine has free now. `commit*` is Windows' commit charge (RAM plus page file): null
 *  elsewhere, where overcommit makes it no limit. */
export interface MachineMemory {
  freeBytes: number
  totalBytes: number
  commitFreeBytes: number | null
  commitLimitBytes: number | null
}

/** What one worker COMMITS once grown: 24.5 GB over the 33 worker trees measured 2026-10-04 (its CLI
 *  544 MB private on average, its runner 123 MB, its shells and tools the rest). Private bytes are
 *  the right unit for the commit check only. */
export const WORKER_COMMIT_BYTES = 0.75 * GIB
/** What a grown worker tree holds in RAM (working set), until some are measured: 23 workers at
 *  07:20 on 2026-10-06 held ~280 MB in claude.exe (flat from 0.4 to 105 minutes old) against ~560 MB
 *  private, plus its Connections loader (~85 MB) and a few MB of shells. */
export const DEFAULT_GROWN_BYTES = 0.45 * GIB
export const MIN_GROWN_BYTES = 0.25 * GIB
export const MAX_GROWN_BYTES = 1.0 * GIB
/** The learned size is re-measured at most this often. */
const LEARN_EVERY_MS = 60_000
/** At most this many grown workers are measured per refresh. */
const LEARN_SAMPLE = 30
/** Free RAM a start must leave: 8% of the machine, fairjob's floor (exit 75; 20% never opened on a
 *  busy box, 2026-09-25). */
export const FREE_FLOOR_SHARE = 0.08
/** Commit a start must leave on Windows: 5% of the limit. Past the limit allocations fail outright,
 *  so this floor guards crashes where the RAM floor guards speed. */
export const COMMIT_FLOOR_SHARE = 0.05
/** A worker that started this recently is still growing: it reserves what it has yet to grow. */
export const RAMP_MS = 120_000

const gb = (bytes: number): string => (bytes / GIB).toFixed(1)

/** The workers that started within RAMP_MS (this tick's starts included): each one's tree working
 *  set now, or null when it could not be read (or the worker only just started), which reserves
 *  the full expected size. `expectedBytes`: what a grown worker tree holds in RAM. */
export interface Growth {
  expectedBytes: number
  sets: (number | null)[]
}

/** Why another worker may not start now, or null when it may. A number is that many recent workers
 *  with unreadable trees (each reserves in full). RAM: free memory already excludes what the recent
 *  workers hold now, so each reserves only what it has left to grow (their expected size less their
 *  working set now) and the new one the whole expected size. Commit: every recent worker and the
 *  new one reserve WORKER_COMMIT_BYTES, since commit is private bytes and is charged at once. */
export function memoryShort(m: MachineMemory | null, growing: number | Growth): string | null {
  if (!m) return null
  const g: Growth =
    typeof growing === 'number'
      ? { expectedBytes: DEFAULT_GROWN_BYTES, sets: Array.from({ length: growing }, () => null) }
      : growing
  const reserved = g.sets.reduce<number>(
    (sum, ws) => sum + (ws === null ? g.expectedBytes : Math.max(0, g.expectedBytes - ws)),
    0,
  )
  const need = g.expectedBytes
  const still =
    g.sets.length > 0
      ? ` (${g.sets.length} worker${g.sets.length === 1 ? '' : 's'} started in the last ${RAMP_MS / 60_000} minutes, still growing)`
      : ''
  const ramFloor = m.totalBytes * FREE_FLOOR_SHARE
  if (m.freeBytes - reserved - need < ramFloor)
    return `${gb(m.freeBytes)} GB of ${gb(m.totalBytes)} GB RAM free, ${gb(reserved)} GB reserved for growing workers${still}; a worker needs about ${gb(need)} GB above ${gb(ramFloor)} GB`
  if (m.commitFreeBytes !== null && m.commitLimitBytes !== null) {
    const commitFloor = m.commitLimitBytes * COMMIT_FLOOR_SHARE
    const commitNeed = (g.sets.length + 1) * WORKER_COMMIT_BYTES
    if (m.commitFreeBytes - commitNeed < commitFloor)
      return `${gb(m.commitFreeBytes)} GB of the ${gb(m.commitLimitBytes)} GB commit limit left${still}; a worker needs about ${gb(WORKER_COMMIT_BYTES)} GB above ${gb(commitFloor)} GB`
  }
  return null
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

let learned: { at: number; bytes: number } | null = null

/** Tests: forget the learned size. */
export function resetLearnedGrownBytes(): void {
  learned = null
}

/** Working sets of the process trees rooted at `pids` (runner and descendants), null where a tree
 *  could not be read. One process table serves all of them. */
export type TreeReader = (pids: (number | null)[]) => (number | null)[]

/** What the gate needs of the running workers: the runner pid and the start time of each. */
export interface RunningWorker {
  runnerPid: number | null
  startedAt: number
}

/** The Growth the gate reasons on at `now`. Workers within RAMP_MS are measured every tick; the
 *  expected grown size is the median over workers older than that, re-measured at most every
 *  LEARN_EVERY_MS and clamped to MIN..MAX_GROWN_BYTES (DEFAULT_GROWN_BYTES until any is read). */
export function growthOf(
  running: RunningWorker[],
  now: number,
  read: TreeReader = readTreeWorkingSets,
): Growth {
  const recent = running.filter((w) => w.startedAt > now - RAMP_MS)
  if (!learned || now - learned.at >= LEARN_EVERY_MS) {
    const old = running.filter((w) => w.startedAt <= now - RAMP_MS && w.runnerPid !== null)
    const sample = old.slice(0, LEARN_SAMPLE)
    const got = sample.length
      ? read(sample.map((w) => w.runnerPid)).filter((b): b is number => b !== null && b > 0)
      : []
    const bytes = got.length
      ? Math.min(MAX_GROWN_BYTES, Math.max(MIN_GROWN_BYTES, median(got)))
      : (learned?.bytes ?? DEFAULT_GROWN_BYTES)
    learned = { at: now, bytes }
  }
  return {
    expectedBytes: learned.bytes,
    sets: recent.length ? read(recent.map((w) => w.runnerPid)) : [],
  }
}

/** Sum the working set of each pid's tree from a process table (pid, parent, working set). */
export function treeSums(
  pids: (number | null)[],
  rows: { pid: number; ppid: number; workingSet: number | null }[],
): (number | null)[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const children = new Map<number, number[]>()
  for (const r of rows) {
    const list = children.get(r.ppid)
    if (list) list.push(r.pid)
    else children.set(r.ppid, [r.pid])
  }
  return pids.map((root) => {
    if (root === null || !byPid.has(root)) return null
    let sum = 0
    const seen = new Set<number>()
    const stack = [root]
    while (stack.length) {
      const pid = stack.pop()!
      if (seen.has(pid)) continue
      seen.add(pid)
      const ws = byPid.get(pid)?.workingSet
      if (ws === null || ws === undefined) {
        // the runner itself unreadable: no answer; a refused child only adds nothing
        if (pid === root) return null
      } else sum += ws
      for (const c of children.get(pid) ?? []) stack.push(c)
    }
    return sum
  })
}

/** Add `pid` and every descendant in `kids` to `wanted`. */
function markTree(pid: number, kids: Map<number, number[]>, wanted: Set<number>): void {
  if (wanted.has(pid)) return
  wanted.add(pid)
  for (const c of kids.get(pid) ?? []) markTree(c, kids, wanted)
}

/** Windows: working sets of the trees, asked only of the processes in them; null when the process
 *  table cannot be read. */
function windowsTreeWorkingSets(pids: (number | null)[]): (number | null)[] | null {
  const table = nativeProcessTable()
  if (!table) return null
  const wanted = new Set<number>()
  const kids = new Map<number, number[]>()
  for (const r of table) {
    const l = kids.get(r.ppid)
    if (l) l.push(r.pid)
    else kids.set(r.ppid, [r.pid])
  }
  for (const p of pids) if (p !== null) markTree(p, kids, wanted)
  const rows = table
    .filter((r) => wanted.has(r.pid))
    .map((r) => ({
      pid: r.pid,
      ppid: r.ppid,
      workingSet: nativeProcessInfo(r.pid, INFO_WORKING_SET)?.workingSetSize ?? null,
    }))
  return treeSums(pids, rows)
}

/** One process's resident bytes from /proc, null when it cannot be read. */
function linuxWorkingSet(pid: number): number | null {
  let workingSet: number | null = null
  try {
    workingSet = Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4096
    if (!Number.isFinite(workingSet)) workingSet = null
  } catch {
    // raced with an exit
  }
  return workingSet
}

/** Linux: working sets of the trees; null when the process table cannot be read. */
function linuxTreeWorkingSets(pids: (number | null)[]): (number | null)[] | null {
  const table = linuxProcTable()
  if (!table) return null
  const rows = table.map((r) => {
    const workingSet = linuxWorkingSet(r.pid)
    return { pid: r.pid, ppid: r.ppid, workingSet }
  })
  return treeSums(pids, rows)
}

/** Working set of each pid's tree on this machine, null where it cannot be read. */
export function readTreeWorkingSets(pids: (number | null)[]): (number | null)[] {
  const none = pids.map(() => null)
  try {
    if (process.platform === 'win32') return windowsTreeWorkingSets(pids) ?? none
    if (process.platform === 'linux') return linuxTreeWorkingSets(pids) ?? none
  } catch {
    // unreadable: every tree reserves in full
  }
  return none
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
