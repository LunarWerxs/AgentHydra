// CPU and memory of a server's whole process tree (ported from DevWebUI's metrics.ts). The pid handed in is rarely the
// process holding the memory: a server run through a shell has the shell as its pid, and a direct one still fans out
// (Vite's esbuild, workers). So each pid is summed over its descendants.
//
// Windows (under Bun) calls the Win32 API through bun:ffi: a toolhelp snapshot gives the parent map, and
// GetProcessTimes / GetProcessMemoryInfo read each member, with no child process at all. Elsewhere one `ps` call gives
// the same (pid, parent, resident KB, cumulative cpu time). A pid that cannot be measured is left out of the answer,
// so the caller keeps its last value rather than flashing 0.

import { spawn } from 'node:child_process'

export interface Sample {
  /** Percent of ONE core (can pass 100 for several processes). */
  cpu: number
  /** Resident bytes. */
  memory: number
}

type Sampler = (pids: number[]) => Promise<Record<number, Sample>>

let sampler: Promise<Sampler> | null = null

/** Samples each root pid over its whole descendant tree. */
export function sampleMetrics(pids: number[]): Promise<Record<number, Sample>> {
  sampler ??= buildSampler()
  return sampler.then((s) => s(pids))
}

/** `root` and every descendant, de-duplicated (the seen set also guards against pid reuse making a cycle). */
export function descendants(root: number, children: Map<number, number[]>): number[] {
  const out: number[] = []
  const seen = new Set<number>([root])
  const stack = [root]
  while (stack.length) {
    const pid = stack.pop()!
    out.push(pid)
    for (const k of children.get(pid) ?? [])
      if (!seen.has(k)) {
        seen.add(k)
        stack.push(k)
      }
  }
  return out
}

async function buildSampler(): Promise<Sampler> {
  if (process.platform === 'win32') return (await windowsFfi()) ?? (async () => ({}))
  return psSampler()
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
// PROCESS_MEMORY_COUNTERS (x64): WorkingSetSize is at 16; the struct is 72 bytes.
const PMC_SIZE = 72
const WORKING_SET_OFFSET = 16
// PROCESSENTRY32 (ANSI, x64): pid at 8, parent pid at 32, 304 bytes; dwSize must be exact or Process32First fails.
const PE32_SIZE = 304
const PE32_PID_OFFSET = 8
const PE32_PARENT_OFFSET = 32
const TH32CS_SNAPPROCESS = 2

const u64 = (dv: DataView, off: number): number => dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 2 ** 32

type Ffi = typeof import('bun:ffi')

function openKernel({ dlopen, FFIType }: Ffi) {
  return dlopen('kernel32.dll', {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    K32GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
    Process32First: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    Process32Next: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  }).symbols
}

/** Everything one Windows sampler keeps between samples. The scratch buffers are shared: the manager runs one sample at a time. */
interface Win {
  k: ReturnType<typeof openKernel>
  ptr: Ffi['ptr']
  creation: Uint8Array
  exit: Uint8Array
  kernel: Uint8Array
  user: Uint8Array
  mem: Uint8Array
  pe: Uint8Array
  // Keyed by pid and creation time: a pid Windows hands to a new process between two samples starts a new baseline
  // instead of reading as a spike (or a clamped 0) that a short alert could fire on.
  last: Map<number, { cpu100ns: number; t: number; created: number }>
}

const dv = (b: Uint8Array): DataView => new DataView(b.buffer)

function addChild(children: Map<number, number[]>, parent: number, pid: number): void {
  const list = children.get(parent)
  if (list) list.push(pid)
  else children.set(parent, [pid])
}

/** Every process's parent, from a toolhelp snapshot (a partial map when the walk fails part way). */
function snapshot(w: Win): Map<number, number[]> {
  const children = new Map<number, number[]>()
  let snap: number | null = null
  try {
    snap = w.k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) as unknown as number | null
  } catch {
    return children
  }
  if (!snap) return children
  const dvPe = dv(w.pe)
  try {
    dvPe.setUint32(0, PE32_SIZE, true)
    let ok = w.k.Process32First(snap as never, w.ptr(w.pe))
    while (ok) {
      addChild(children, dvPe.getUint32(PE32_PARENT_OFFSET, true), dvPe.getUint32(PE32_PID_OFFSET, true))
      ok = w.k.Process32Next(snap as never, w.ptr(w.pe))
    }
  } catch {
    // a partial map is fine
  } finally {
    try {
      w.k.CloseHandle(snap as never)
    } catch {
      // ignore
    }
  }
  return children
}

/** One process's CPU since the last sample and its working set; null when it cannot be opened. */
function measure(w: Win, pid: number, t: number): { cpu: number; memory: number; any: boolean } | null {
  const h = w.k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (!h) return null
  const got = { cpu: 0, memory: 0, any: false }
  try {
    if (w.k.GetProcessTimes(h, w.ptr(w.creation), w.ptr(w.exit), w.ptr(w.kernel), w.ptr(w.user))) {
      got.any = true
      const cpu100ns = u64(dv(w.kernel), 0) + u64(dv(w.user), 0)
      const created = u64(dv(w.creation), 0)
      const prev = w.last.get(pid)
      w.last.set(pid, { cpu100ns, t, created })
      if (prev && prev.created === created && t > prev.t) got.cpu = Math.max(0, ((cpu100ns - prev.cpu100ns) / 1e4 / (t - prev.t)) * 100)
    }
    if (w.k.K32GetProcessMemoryInfo(h, w.ptr(w.mem), PMC_SIZE)) {
      got.any = true
      got.memory = u64(dv(w.mem), WORKING_SET_OFFSET)
    }
  } finally {
    w.k.CloseHandle(h)
  }
  return got
}

function sampleWindows(w: Win, pids: number[]): Record<number, Sample> {
  const out: Record<number, Sample> = {}
  if (!pids.length) return out
  const children = snapshot(w)
  const t = performance.now()
  const seen = new Set<number>()
  for (const root of pids) {
    const sum = { cpu: 0, memory: 0, any: false }
    for (const pid of descendants(root, children)) {
      const m = measure(w, pid, t)
      if (!m) continue
      seen.add(pid)
      sum.cpu += m.cpu
      sum.memory += m.memory
      sum.any ||= m.any
    }
    if (sum.any) out[root] = { cpu: sum.cpu, memory: sum.memory }
  }
  for (const pid of w.last.keys()) if (!seen.has(pid)) w.last.delete(pid)
  return out
}

async function windowsFfi(): Promise<Sampler | null> {
  try {
    const ffi = await import('bun:ffi')
    const w: Win = {
      k: openKernel(ffi),
      ptr: ffi.ptr,
      creation: new Uint8Array(8),
      exit: new Uint8Array(8),
      kernel: new Uint8Array(8),
      user: new Uint8Array(8),
      mem: new Uint8Array(PMC_SIZE),
      pe: new Uint8Array(PE32_SIZE),
      last: new Map(),
    }
    return async (pids) => sampleWindows(w, pids)
  } catch {
    return null
  }
}

/** `ps`' cputime ([DD-]HH:MM:SS or MM:SS.xx) in seconds. */
export function cpuSeconds(text: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text)
  return m ? (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]) : 0
}

/** `ps -A`'s pid, parent, resident KB and cpu time for every process ('' when it cannot run). */
function runPs(): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = ''
    try {
      const c = spawn('ps', ['-A', '-o', 'pid=,ppid=,rss=,cputime='], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      c.stdout.setEncoding('utf8')
      c.stdout.on('data', (d: string) => (buf += d))
      c.on('error', () => resolve(''))
      c.on('close', () => resolve(buf))
    } catch {
      resolve('')
    }
  })
}

function parsePs(text: string): { rows: Map<number, { rss: number; cpu: number }>; children: Map<number, number[]> } {
  const rows = new Map<number, { rss: number; cpu: number }>()
  const children = new Map<number, number[]>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    rows.set(pid, { rss: Number(m[3]) * 1024, cpu: cpuSeconds(m[4]!) })
    addChild(children, Number(m[2]), pid)
  }
  return { rows, children }
}

function psSampler(): Sampler {
  const last = new Map<number, { cpu: number; t: number }>()
  return async (pids) => {
    const out: Record<number, Sample> = {}
    if (!pids.length) return out
    const { rows, children } = parsePs(await runPs())
    const t = performance.now()
    const seen = new Set<number>()
    for (const root of pids) {
      let cpu = 0
      let memory = 0
      let any = false
      for (const pid of descendants(root, children)) {
        const r = rows.get(pid)
        if (!r) continue
        any = true
        seen.add(pid)
        memory += r.rss
        const prev = last.get(pid)
        last.set(pid, { cpu: r.cpu, t })
        // A pid whose CPU time went down is a new process under a reused pid: it starts a new baseline.
        if (prev && r.cpu >= prev.cpu && t > prev.t) cpu += ((r.cpu - prev.cpu) * 1000 * 100) / (t - prev.t)
      }
      if (any) out[root] = { cpu, memory }
    }
    for (const pid of last.keys()) if (!seen.has(pid)) last.delete(pid)
    return out
  }
}
