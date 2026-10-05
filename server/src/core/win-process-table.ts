// server/src/core/win-process-table.ts - the Windows process table, read in-process.
//
// ⛔ WHY (2026-10-04). Every process question the daemon asked on Windows was a PowerShell spawn
// running `Get-CimInstance Win32_Process`: the Instances tab's Claude.exe scan, the Codex table's
// ChatGPT.exe scan, the tray watchdog's host count, CliMayte's runner check, whoami's ancestry
// walk. Measured on the owner's PC with ~620 processes: 9-14 of those a minute, each one a
// powershell.exe plus a conhost.exe plus WmiPrvSE reading the command line of EVERY process on
// the machine (WmiPrvSE p95 81% of a core, max 140%), while the PC froze every ~30 s. The same
// answers come from Toolhelp32 (pid, parent pid, exe name: one snapshot, a few ms) and, only for
// the processes a caller asks about, one OpenProcess with the least access there is.
//
// Every function returns null when it cannot answer here (not Windows, no bun:ffi, a call
// refused) and the caller then asks PowerShell exactly as before. Null is "could not look",
// never "none running".

import { createRequire } from 'node:module'

/** One row of the table, as Toolhelp32 reports it. */
export interface NativeProcess {
  pid: number
  ppid: number
  /** The executable's file name, `Claude.exe`. */
  name: string
}

/** What one process's own handle tells. Each field is null when that one query was refused. */
export interface NativeProcessInfo {
  commandLine: string | null
  executablePath: string | null
  /** Working-set bytes (what Win32_Process.WorkingSetSize reports). */
  workingSetSize: number | null
  /** Start time, ISO 8601 UTC. */
  creationDate: string | null
}

/** Test seam: process-scan-unknown.test.ts makes every scan fail, this one included, to prove
 *  "could not look" never reads as "none running". */
export const nativeProcessTableForTests = { disabled: false }

const TH32CS_SNAPPROCESS = 0x2
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const PROCESS_VM_READ = 0x10
const ProcessCommandLineInformation = 60
// PROCESSENTRY32W on x64: th32ProcessID at 8, th32ParentProcessID at 32, szExeFile (260 WCHARs)
// at 44, padded to 568.
const ENTRY_SIZE = 568
// The longest command line Windows allows is 32,767 WCHARs, after a 16-byte UNICODE_STRING.
const CMDLINE_BUF_BYTES = 16 + 65_536
// FILETIME counts 100 ns ticks from 1601-01-01; the Unix epoch is this many ms later.
const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000

interface Native {
  table(): NativeProcess[] | null
  info(pid: number): NativeProcessInfo | null
}

let native: Native | null | undefined
const utf16 = new TextDecoder('utf-16le')

function load(): Native | null {
  if (process.platform !== 'win32') return null
  try {
    const { dlopen, FFIType, ptr } = createRequire(import.meta.url)('bun:ffi')
    const k = dlopen('kernel32.dll', {
      CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
      Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      QueryFullProcessImageNameW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      GetProcessTimes: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      K32GetProcessMemoryInfo: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols
    const nt = dlopen('ntdll.dll', {
      NtQueryInformationProcess: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
    }).symbols

    // One set of buffers for every call: FFI calls are synchronous and JS is single-threaded.
    const entry = new Uint8Array(ENTRY_SIZE)
    const entryView = new DataView(entry.buffer)
    const entryName = new Uint16Array(entry.buffer, 44, 260)
    const cmd = new Uint8Array(CMDLINE_BUF_BYTES)
    const cmdView = new DataView(cmd.buffer)
    const cmdLen = new Uint32Array(1)
    const image = new Uint16Array(32_768)
    const imageLen = new Uint32Array(1)
    const times = new BigUint64Array(4)
    // PROCESS_MEMORY_COUNTERS on x64 is 72 bytes; WorkingSetSize is the SIZE_T at 16.
    const mem = new Uint8Array(72)
    const memView = new DataView(mem.buffer)

    const text = (u16: Uint16Array, length: number) => utf16.decode(u16.subarray(0, length))

    return {
      table() {
        const snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        // INVALID_HANDLE_VALUE is -1, which bun:ffi hands back as a pointer it cannot represent.
        if (!snap || snap === -1) return null
        try {
          const rows: NativeProcess[] = []
          entryView.setUint32(0, ENTRY_SIZE, true)
          let ok = k.Process32FirstW(snap, ptr(entry))
          if (!ok) return null
          while (ok) {
            const nul = entryName.indexOf(0)
            rows.push({
              pid: entryView.getUint32(8, true),
              ppid: entryView.getUint32(32, true),
              name: text(entryName, nul === -1 ? entryName.length : nul),
            })
            entryView.setUint32(0, ENTRY_SIZE, true)
            ok = k.Process32NextW(snap, ptr(entry))
          }
          return rows
        } finally {
          k.CloseHandle(snap)
        }
      },
      info(pid) {
        // VM_READ is asked for only so the memory query works on older builds; the limited right
        // alone answers everything else, and is all a protected or elevated process grants.
        const h =
          k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid) ||
          k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
        if (!h) return null
        try {
          let commandLine: string | null = null
          const status = nt.NtQueryInformationProcess(
            h,
            ProcessCommandLineInformation,
            ptr(cmd),
            cmd.byteLength,
            ptr(cmdLen),
          )
          if (status >= 0) {
            // A UNICODE_STRING (Length, MaximumLength, Buffer) whose Buffer points into `cmd`.
            const bytes = cmdView.getUint16(0, true)
            const offset = Number(cmdView.getBigUint64(8, true)) - ptr(cmd)
            if (offset >= 16 && offset + bytes <= cmd.byteLength)
              commandLine = utf16.decode(cmd.subarray(offset, offset + bytes))
          }

          let executablePath: string | null = null
          imageLen[0] = image.length
          if (k.QueryFullProcessImageNameW(h, 0, ptr(image), ptr(imageLen)))
            executablePath = text(image, imageLen[0]!)

          let creationDate: string | null = null
          if (k.GetProcessTimes(h, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))) {
            const ms = Number(times[0]! / 10_000n) - FILETIME_UNIX_EPOCH_MS
            if (ms > 0) creationDate = new Date(ms).toISOString()
          }

          let workingSetSize: number | null = null
          memView.setUint32(0, mem.byteLength, true)
          if (k.K32GetProcessMemoryInfo(h, ptr(mem), mem.byteLength))
            workingSetSize = Number(memView.getBigUint64(16, true))

          return { commandLine, executablePath, workingSetSize, creationDate }
        } finally {
          k.CloseHandle(h)
        }
      },
    }
  } catch {
    return null
  }
}

function lib(): Native | null {
  if (nativeProcessTableForTests.disabled) return null
  if (native === undefined) native = load()
  return native
}

/** Every process on the machine: pid, parent pid and exe name. Null when it cannot be read here. */
export function nativeProcessTable(): NativeProcess[] | null {
  try {
    return lib()?.table() ?? null
  } catch {
    return null
  }
}

/** One process's command line, executable, working set and start time. Null when the pid does not
 *  open or this cannot be asked here. An exited process whose handle someone still holds (the
 *  daemon holds its own children's) opens with a null command line; the table never lists it. */
export function nativeProcessInfo(pid: number): NativeProcessInfo | null {
  try {
    return lib()?.info(pid) ?? null
  } catch {
    return null
  }
}

/** Command lines by pid, for each of `pids` that could be read (a pid that is gone or refuses to
 *  open has no entry). Null when this cannot be asked here. */
export function nativeCommandLines(pids: readonly number[]): Map<number, string> | null {
  const n = lib()
  if (!n) return null
  const out = new Map<number, string>()
  for (const pid of pids) {
    try {
      const command = n.info(pid)?.commandLine
      if (command) out.set(pid, command)
    } catch {
      // that one process only
    }
  }
  return out
}

/** The processes whose exe name is one of `names` (any case, as WMI's Name filter matched), each
 *  with what its handle tells; a process that refuses to open keeps its row with null fields.
 *  Null when the table cannot be read here. */
export function nativeProcessesNamed(
  names: readonly string[],
): (NativeProcess & NativeProcessInfo)[] | null {
  const table = nativeProcessTable()
  if (!table) return null
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  return table
    .filter((p) => wanted.has(p.name.toLowerCase()))
    .map((p) => ({
      ...p,
      ...(nativeProcessInfo(p.pid) ?? {
        commandLine: null,
        executablePath: null,
        workingSetSize: null,
        creationDate: null,
      }),
    }))
}
