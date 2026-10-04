// server/src/core/process-image.ts - the executable a running process was started from.
//
// A desktop chat's engine runs the Claude Code binary its own profile downloaded
// (`<profile>\claude-code\<version>\<hash>\claude.exe`), so the image says which desktop account
// hosts an engine when nothing in the engine's registry record does (chat-dossier.ts,
// engineHostedBy). One OpenProcess + QueryFullProcessImageNameW per pid: no process-table scan.

import { createRequire } from 'node:module'

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

let imageOf: ((pid: number) => string | null) | undefined

function load(): (pid: number) => string | null {
  if (process.platform !== 'win32') return () => null
  try {
    const { dlopen, FFIType, ptr } = createRequire(import.meta.url)('bun:ffi')
    const k = dlopen('kernel32.dll', {
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      QueryFullProcessImageNameW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols
    return (pid) => {
      const h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
      if (!h) return null
      try {
        const buf = new Uint16Array(1024)
        const size = new Uint32Array([buf.length])
        if (!k.QueryFullProcessImageNameW(h, 0, ptr(buf), ptr(size))) return null
        return String.fromCharCode(...buf.subarray(0, size[0]))
      } finally {
        k.CloseHandle(h)
      }
    }
  } catch {
    return () => null
  }
}

/** The full path of the executable `pid` runs, or null when it cannot be read: not Windows, no
 *  bun:ffi, or the process is gone or refuses the query. Null is unknown, never "not an engine". */
export function processImagePath(pid: number): string | null {
  imageOf ??= load()
  return imageOf(pid)
}
