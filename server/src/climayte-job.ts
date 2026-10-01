// server/src/climayte-job.ts — on Windows, a job object that ends whatever a CliMayte worker's CLI left
// running once its attempt is over (field note 43, 2026-10-01: w-8438217d finished and left
// `bun --bun vite services/events_explore/web --port 4289` running under an sh wrapper).
//
// The runner (climayte-runner.ts) puts ITSELF in a new job with KILL_ON_JOB_CLOSE before it starts
// the CLI, so the CLI and everything it starts are in it. Bun's and Node's own job for child
// processes allows silent breakaway, which is how a session's grandchildren outlived it; a breakaway
// only climbs a chain of nested jobs as far as every job allows it, and this one allows none, so
// nothing leaves. The runner holds the only handle: when it exits, the job closes and every process
// still in it ends. `leftovers` names them first, for the journal.

import { createRequire } from 'node:module'

const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** A process still running in the job when the CLI has exited. */
export interface Leftover {
  pid: number
  /** Its executable's file name, and its command line when it could be read (capped). */
  name: string
  command?: string
}

export interface WorkerJob {
  /** Every process in the job except `exceptPid` (the runner itself). */
  leftovers(exceptPid: number): Leftover[]
}

/** Puts this process in a new kill-on-close job. Null off Windows, without bun:ffi, or when a call
 *  is refused: the CLI then runs as it did before, and what it leaves is left. */
export function containWorker(): WorkerJob | null {
  if (process.platform !== 'win32') return null
  try {
    const { dlopen, FFIType, ptr } = createRequire(import.meta.url)('bun:ffi')
    const k = dlopen('kernel32.dll', {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      QueryInformationJobObject: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      QueryFullProcessImageNameW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols
    const job = k.CreateJobObjectW(null, null)
    if (!job) return null
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64; BasicLimitInformation.LimitFlags is
    // the DWORD at offset 16, after the two LARGE_INTEGER time limits.
    const info = new Uint8Array(144)
    new DataView(info.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true)
    const self = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, process.pid)
    const ok =
      k.SetInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        ptr(info),
        info.byteLength,
      ) &&
      self &&
      k.AssignProcessToJobObject(job, self)
    if (self) k.CloseHandle(self)
    if (!ok) {
      k.CloseHandle(job)
      return null
    }
    const nameOf = (pid: number): string => {
      const h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
      if (!h) return '?'
      try {
        const buf = new Uint16Array(1024)
        const size = new Uint32Array([buf.length])
        if (!k.QueryFullProcessImageNameW(h, 0, ptr(buf), ptr(size))) return '?'
        const path = String.fromCharCode(...buf.subarray(0, size[0]))
        return path.split(/[\\/]/).pop() || path
      } finally {
        k.CloseHandle(h)
      }
    }
    return {
      leftovers(exceptPid: number): Leftover[] {
        // JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts, then ULONG_PTR process ids.
        const buf = new Uint8Array(8 + 8 * 1024)
        if (
          !k.QueryInformationJobObject(
            job,
            JOB_OBJECT_BASIC_PROCESS_ID_LIST,
            ptr(buf),
            buf.byteLength,
            null,
          )
        )
          return []
        const dv = new DataView(buf.buffer)
        const pids: number[] = []
        for (let i = 0; i < dv.getUint32(4, true); i++) {
          const pid = Number(dv.getBigUint64(8 + 8 * i, true))
          if (pid !== exceptPid) pids.push(pid)
        }
        const commands = commandLines(pids)
        return pids.map((pid) => ({
          pid,
          name: nameOf(pid),
          ...(commands.get(pid) ? { command: commands.get(pid) } : {}),
        }))
      },
    }
  } catch {
    return null
  }
}

/** Command lines by pid, best effort and capped (one PowerShell call, only when there are any):
 *  "bun.exe" alone does not say it was a vite dev server. */
function commandLines(pids: number[]): Map<number, string> {
  const out = new Map<number, string>()
  if (!pids.length) return out
  try {
    const filter = pids.map((p) => `ProcessId=${p}`).join(' or ')
    const r = Bun.spawnSync(
      [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`,
      ],
      { stdout: 'pipe', stderr: 'ignore', windowsHide: true, timeout: 15_000 },
    )
    for (const line of r.stdout.toString().split(/\r?\n/)) {
      const [pid, ...rest] = line.split('\t')
      const command = rest.join('\t').trim()
      if (pid && command) out.set(Number(pid), command.slice(0, 200))
    }
  } catch {
    // names only
  }
  return out
}
