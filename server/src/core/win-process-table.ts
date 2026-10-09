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

/** Which facts to ask a process's handle for. Each is its own call, and the executable path is the
 *  slow one (2026-10-08: QueryFullProcessImageNameW was 30% of a 7.7 s daemon stall while CliMayte's
 *  tick only wanted command lines and working sets), so a caller asks for what it reads. */
export const INFO_COMMAND_LINE = 1
export const INFO_EXECUTABLE_PATH = 2
export const INFO_WORKING_SET = 4
export const INFO_CREATION_DATE = 8
const INFO_ALL = INFO_COMMAND_LINE | INFO_EXECUTABLE_PATH | INFO_WORKING_SET | INFO_CREATION_DATE

interface Native {
  table(): NativeProcess[] | null
  info(pid: number, want: number): NativeProcessInfo | null
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
      info(pid, want) {
        // VM_READ is asked for only so the memory query works on older builds; the limited right
        // alone answers everything else, and is all a protected or elevated process grants.
        const h =
          ((want & INFO_WORKING_SET) !== 0 &&
            k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid)) ||
          k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
        if (!h) return null
        try {
          let commandLine: string | null = null
          const status =
            want & INFO_COMMAND_LINE
              ? nt.NtQueryInformationProcess(
                  h,
                  ProcessCommandLineInformation,
                  ptr(cmd),
                  cmd.byteLength,
                  ptr(cmdLen),
                )
              : -1
          if (status >= 0) {
            // A UNICODE_STRING (Length, MaximumLength, Buffer) whose Buffer points into `cmd`.
            const bytes = cmdView.getUint16(0, true)
            const offset = Number(cmdView.getBigUint64(8, true)) - ptr(cmd)
            if (offset >= 16 && offset + bytes <= cmd.byteLength)
              commandLine = utf16.decode(cmd.subarray(offset, offset + bytes))
          }

          let executablePath: string | null = null
          imageLen[0] = image.length
          if (
            want & INFO_EXECUTABLE_PATH &&
            k.QueryFullProcessImageNameW(h, 0, ptr(image), ptr(imageLen))
          )
            executablePath = text(image, imageLen[0]!)

          let creationDate: string | null = null
          if (
            want & INFO_CREATION_DATE &&
            k.GetProcessTimes(h, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))
          ) {
            const ms = Number(times[0]! / 10_000n) - FILETIME_UNIX_EPOCH_MS
            if (ms > 0) creationDate = new Date(ms).toISOString()
          }

          let workingSetSize: number | null = null
          memView.setUint32(0, mem.byteLength, true)
          if (want & INFO_WORKING_SET && k.K32GetProcessMemoryInfo(h, ptr(mem), mem.byteLength))
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

/**
 * One snapshot answers every caller within this long. The stall profiler had `table` on top of the daemon's
 * blocked main thread (2026-10-09): agent-status, the worker list and the live sessions each took a fresh
 * snapshot of ~1,500 processes, several requests a second from every chat and Desk, ~1 core in all.
 */
const TABLE_TTL_MS = 1000
/** A `mustHave` pid that never shows (exited, or never started) retakes at most this often. */
const MUST_HAVE_RETAKE_MS = 200
let lastTable: { at: number; rows: NativeProcess[] } | null = null
const copyRows = (rows: NativeProcess[]) => rows.map((p) => ({ ...p }))

/**
 * Every process on the machine: pid, parent pid and exe name (at most TABLE_TTL_MS old). A caller after one
 * pid that may have just started passes it as `mustHave`: a snapshot without it is retaken. Null when it
 * cannot be read here.
 */
export function nativeProcessTable(mustHave?: number): NativeProcess[] | null {
  const now = Date.now()
  if (
    lastTable &&
    now - lastTable.at < TABLE_TTL_MS &&
    !nativeProcessTableForTests.disabled &&
    (mustHave === undefined ||
      now - lastTable.at < MUST_HAVE_RETAKE_MS ||
      lastTable.rows.some((p) => p.pid === mustHave))
  )
    return copyRows(lastTable.rows)
  try {
    const rows = lib()?.table() ?? null
    lastTable = rows ? { at: now, rows } : null
    return rows ? copyRows(rows) : null
  } catch {
    return null
  }
}

/** One process's command line, executable, working set and start time, or only the `want` ones
 *  (INFO_* bits; the rest come back null). Null when the pid does not open or this cannot be asked
 *  here. An exited process whose handle someone still holds (the daemon holds its own children's)
 *  opens with a null command line; the table never lists it. */
export function nativeProcessInfo(pid: number, want = INFO_ALL): NativeProcessInfo | null {
  try {
    return lib()?.info(pid, want) ?? null
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
      const command = n.info(pid, INFO_COMMAND_LINE)?.commandLine
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
