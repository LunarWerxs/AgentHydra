// ---------------------------------------------------------------------------
// Per-process CPU + memory sampling — lowest-impact path per platform.
//
// IMPORTANT: the pid we're handed is not necessarily the process that holds the memory.
// A managed server spawned DIRECTLY (the common `bun …`/`node …` case — see spawn-plan.ts)
// IS the real server, but it still fans out children of its own (Vite's esbuild service,
// worker threads); and a server that needs a shell is spawned via `shell: true`, whose pid
// is the OS shell WRAPPER (cmd.exe on Windows) with the real 50–200 MB process a child of
// it. Either way, measuring one pid alone undercounts (the wrapper reported ~8 MB / ~0% CPU
// no matter how big the real server was). So for each requested pid we measure the ENTIRE
// descendant process tree and sum its working set + CPU.
//
// On Windows the daemon runs under Bun, so we call the Win32 API DIRECTLY via
// bun:ffi: CreateToolhelp32Snapshot builds a parent→children map in-process, and
// OpenProcess → GetProcessTimes + GetProcessMemoryInfo reads each subtree member.
// That means ZERO child processes: no powershell.exe, no conhost.exe, nothing
// spawned and torn down. Each sample is a handful of in-process function calls
// costing microseconds. The "thing that stays open" is just the daemon itself;
// turning monitoring off simply stops calling these — there's nothing to kill.
//
// Everywhere else (or if FFI ever fails to load) we fall back to `pidusage`,
// expanding the same subtree first (one `ps`/`Get-CimInstance` call builds the
// map). So the worst case is a graceful degrade to a still-correct subtree sum,
// and if even the tree walk fails we degrade to the single requested pid.
// ---------------------------------------------------------------------------

import { collectStdout } from "./spawn-capture";

export interface Sample {
  cpu: number; // percent of ONE core (can exceed 100 on multi-core / multi-process), matching pidusage
  memory: number; // resident working-set bytes
}

/** A sampler maps a list of pids → stats; missing pids are simply absent from the result. */
type Sampler = (pids: number[]) => Promise<Record<number, Sample>>;

let samplerPromise: Promise<Sampler> | null = null;

/** Sample CPU + memory for the given pids (each summed over its whole descendant tree). */
export function sampleMetrics(pids: number[]): Promise<Record<number, Sample>> {
  samplerPromise ??= buildSampler();
  return samplerPromise.then((s) => s(pids));
}

/** Which sampler is active — "ffi" (Windows, no child processes) or "pidusage" (fallback). */
export async function metricsBackend(): Promise<"ffi" | "pidusage"> {
  samplerPromise ??= buildSampler();
  await samplerPromise;
  return activeBackend;
}

let activeBackend: "ffi" | "pidusage" = "pidusage";

async function buildSampler(): Promise<Sampler> {
  if (
    process.platform === "win32" &&
    typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
  ) {
    const ffi = await tryBuildWindowsFfi();
    if (ffi) {
      activeBackend = "ffi";
      return ffi;
    }
  }
  activeBackend = "pidusage";
  return buildPidusage();
}

/**
 * Given a system-wide parent→children map, return `root` plus every descendant
 * (a flat, de-duplicated list). The `seen` set doubles as a cycle guard — PID
 * reuse can in theory make the "tree" point back at an ancestor. If the map is
 * empty (snapshot failed) this is just `[root]`, i.e. the old single-pid behavior.
 */
export function descendants(root: number, children: Map<number, number[]>): number[] {
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const stack: number[] = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    out.push(pid);
    const kids = children.get(pid);
    if (kids)
      for (const k of kids)
        if (!seen.has(k)) {
          seen.add(k);
          stack.push(k);
        }
  }
  return out;
}

// ---- Windows: direct Win32 calls, no spawning ----------------------------
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
// PROCESS_MEMORY_COUNTERS (x64): cb@0, PageFaultCount@4, PeakWorkingSetSize@8,
// WorkingSetSize@16, … — total 72 bytes. We only read WorkingSetSize.
const PMC_SIZE = 72;
const WORKING_SET_OFFSET = 16;

// PROCESSENTRY32 (ANSI, x64): th32ProcessID@8, th32ParentProcessID@32; total 304
// bytes (8-byte alignment around the ULONG_PTR th32DefaultHeapID field). dwSize@0
// MUST equal this exact size or Process32First fails with ERROR_BAD_LENGTH.
const PE32_SIZE = 304;
const PE32_PID_OFFSET = 8;
const PE32_PARENT_OFFSET = 32;
const TH32CS_SNAPPROCESS = 0x00000002;

async function openKernel32() {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const { symbols } = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetProcessTimes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    // K32-prefixed export lives in kernel32 (Win7+), so no separate psapi.dll load.
    K32GetProcessMemoryInfo: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    // Toolhelp snapshot — enumerate the whole process table in-process (no spawn).
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
    Process32First: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    Process32Next: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  return { symbols, ptr };
}
type Kernel32 = Awaited<ReturnType<typeof openKernel32>>;

/** Scratch buffers reused across samples — the manager serialises sampling (its metricsRunning
 *  guard), so there's never an overlapping read into these. */
function createWin32Buffers() {
  const creation = new Uint8Array(8);
  const exit = new Uint8Array(8);
  const kernel = new Uint8Array(8);
  const user = new Uint8Array(8);
  const mem = new Uint8Array(PMC_SIZE);
  const pe = new Uint8Array(PE32_SIZE);
  return {
    creation,
    exit,
    kernel,
    user,
    mem,
    pe,
    dvK: new DataView(kernel.buffer),
    dvU: new DataView(user.buffer),
    dvM: new DataView(mem.buffer),
    dvPe: new DataView(pe.buffer),
  };
}
type Win32Buffers = ReturnType<typeof createWin32Buffers>;

const win32U64 = (dv: DataView, off: number) =>
  dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 2 ** 32;

/** Build a system-wide parent→children map from one toolhelp snapshot. On any failure returns an
 *  empty map → descendants() degrades to the single requested pid. */
function snapshotWin32Children(k: Kernel32, buf: Win32Buffers): Map<number, number[]> {
  const children = new Map<number, number[]>();
  let snap: number | null = null;
  try {
    snap = k.symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  } catch {
    return children;
  }
  if (!snap) return children; // null/0 handle → give up. INVALID_HANDLE_VALUE (-1, truthy) falls through; Process32First then returns 0 and the loop below is simply skipped.
  try {
    buf.dvPe.setUint32(0, PE32_SIZE, true); // dwSize — required before Process32First
    let ok = k.symbols.Process32First(snap, k.ptr(buf.pe));
    while (ok) {
      const pid = buf.dvPe.getUint32(PE32_PID_OFFSET, true);
      const parent = buf.dvPe.getUint32(PE32_PARENT_OFFSET, true);
      const list = children.get(parent);
      if (list) list.push(pid);
      else children.set(parent, [pid]);
      ok = k.symbols.Process32Next(snap, k.ptr(buf.pe));
    }
  } catch {
    /* partial map is fine — we just walk what we got */
  } finally {
    try {
      k.symbols.CloseHandle(snap);
    } catch {
      /* ignore */
    }
  }
  return children;
}

/** Sample one root pid's whole descendant tree; returns null if nothing was actually measured
 *  (caller then keeps the last-known value instead of flashing 0% / 0 B). */
function sampleWin32Root(
  k: Kernel32,
  buf: Win32Buffers,
  root: number,
  children: Map<number, number[]>,
  t: number,
  last: Map<number, { cpu100ns: number; t: number }>,
  seen: Set<number>,
): Sample | null {
  let cpu = 0;
  let memory = 0;
  let any = false; // got at least one real CPU/memory reading?
  for (const pid of descendants(root, children)) {
    const h = k.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (!h) continue; // process gone or access denied — leave it out of the sum
    // Opened OK → keep this pid's CPU history even if a read below transiently
    // fails, so a one-off GetProcessTimes failure can't evict it and force a
    // spurious 0% on the next cycle (the cleanup loop prunes only truly-gone pids).
    seen.add(pid);
    try {
      if (
        k.symbols.GetProcessTimes(
          h,
          k.ptr(buf.creation),
          k.ptr(buf.exit),
          k.ptr(buf.kernel),
          k.ptr(buf.user),
        )
      ) {
        any = true;
        const cpu100ns = win32U64(buf.dvK, 0) + win32U64(buf.dvU, 0); // kernel + user, in 100-ns ticks
        const prev = last.get(pid);
        last.set(pid, { cpu100ns, t });
        if (prev) {
          const cpuMs = (cpu100ns - prev.cpu100ns) / 1e4; // 100-ns ticks → ms
          const wallMs = t - prev.t;
          if (wallMs > 0) cpu += Math.max(0, (cpuMs / wallMs) * 100);
        }
      }
      if (k.symbols.K32GetProcessMemoryInfo(h, k.ptr(buf.mem), PMC_SIZE)) {
        any = true;
        memory += win32U64(buf.dvM, WORKING_SET_OFFSET);
      }
    } finally {
      k.symbols.CloseHandle(h);
    }
  }
  return any ? { cpu, memory } : null;
}

/** Sample CPU+memory for a batch of root pids (each summed over its whole descendant tree),
 *  using already-open kernel32 handles + scratch buffers. */
async function sampleWin32Pids(
  pids: number[],
  k: Kernel32,
  buf: Win32Buffers,
  last: Map<number, { cpu100ns: number; t: number }>,
): Promise<Record<number, Sample>> {
  const out: Record<number, Sample> = {};
  if (pids.length === 0) return out;

  const children = snapshotWin32Children(k, buf);
  const t = performance.now();
  const seen = new Set<number>();
  for (const root of pids) {
    const sample = sampleWin32Root(k, buf, root, children, t, last, seen);
    if (sample) out[root] = sample;
  }
  // Drop history for pids we no longer track so the map can't grow without bound.
  for (const pid of last.keys()) if (!seen.has(pid)) last.delete(pid);
  return out;
}

async function tryBuildWindowsFfi(): Promise<Sampler | null> {
  try {
    const k = await openKernel32();
    const buf = createWin32Buffers();
    // CPU% needs deltas: remember each pid's cumulative CPU time + the wall clock
    // at last read. Keyed by the actual OS pid (NOT the requested root), so a child
    // that comes and goes contributes accurate per-pid deltas to its tree's total.
    // performance.now() is a monotonic clock (immune to wall-clock jumps).
    const last = new Map<number, { cpu100ns: number; t: number }>();
    return (pids: number[]) => sampleWin32Pids(pids, k, buf, last);
  } catch {
    return null; // not under Bun, FFI blocked, or symbol mismatch — fall back
  }
}

// ---- Fallback: pidusage (cross-platform; spawns a short-lived helper) -----
async function buildPidusage(): Promise<Sampler> {
  const pidusage = (await import("pidusage")).default;
  return async (pids: number[]) => {
    if (pids.length === 0) return {};
    // Expand every requested root into its subtree, then query the UNION once so
    // pidusage still runs a single batched call for the whole fleet.
    const tree = await spawnProcessTree();
    const subtrees = new Map<number, number[]>();
    const all = new Set<number>();
    for (const root of pids) {
      const sub = descendants(root, tree);
      subtrees.set(root, sub);
      for (const p of sub) all.add(p);
    }
    let stats: Record<number, { cpu: number; memory: number } | undefined>;
    try {
      stats = (await pidusage([...all])) as Record<
        number,
        { cpu: number; memory: number } | undefined
      >;
    } catch {
      return {}; // whole-batch failure — caller keeps last-known values
    }
    const out: Record<number, Sample> = {};
    for (const root of pids) {
      let cpu = 0;
      let memory = 0;
      let any = false;
      for (const pid of subtrees.get(root)!) {
        const s = stats[pid];
        if (s) {
          cpu += s.cpu;
          memory += s.memory;
          any = true;
        }
      }
      if (any) out[root] = { cpu, memory };
    }
    return out;
  };
}

/**
 * Build a system-wide parent→children map by spawning ONE helper (used only on the
 * pidusage fallback path). Unix: `ps -A -o pid=,ppid=`. Windows-without-Bun:
 * `Get-CimInstance Win32_Process` (ProcessId + ParentProcessId). Any failure →
 * empty map, so descendants() degrades to the single requested pid.
 */
async function spawnProcessTree(): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  const add = (parent: number, pid: number) => {
    if (!Number.isFinite(parent) || !Number.isFinite(pid) || pid === parent) return;
    const list = map.get(parent);
    if (list) list.push(pid);
    else map.set(parent, [pid]);
  };
  try {
    let out: string;
    if (process.platform === "win32") {
      const ps = `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`;
      out = await collectStdout("powershell", ["-NoProfile", "-Command", ps]);
    } else {
      out = await collectStdout("ps", ["-A", "-o", "pid=,ppid="]);
    }
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) add(Number(m[2]), Number(m[1])); // (ppid → pid)
    }
  } catch {
    /* empty map → single-pid behavior */
  }
  return map;
}
