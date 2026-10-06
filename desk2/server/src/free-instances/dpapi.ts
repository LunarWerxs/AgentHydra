// Windows DPAPI (CurrentUser scope) through bun:ffi: the Free harness keeps each login encrypted this
// way (claudfree/state.py, `dpapi`), so the Free login sync opens and writes those files the same way.
// The FFI shape is AgentHydra's (server/src/dpapi-seal.mjs). Off Windows there is no DPAPI: both calls
// answer null, and the sync has nothing to read.

import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi'

const UI_FORBIDDEN = 0x1
type Api = {
  protect: (a: Uint8Array, b: null, c: null, d: null, e: null, f: number, g: Uint8Array) => number
  unprotect: (a: Uint8Array, b: null, c: null, d: null, e: null, f: number, g: Uint8Array) => number
  free: (p: number) => unknown
}
let api: Api | null | undefined
function load(): Api | null {
  if (api !== undefined) return api
  if (process.platform !== 'win32') return (api = null)
  try {
    const blob = [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr] as const
    const crypt32 = dlopen('crypt32.dll', {
      CryptProtectData: { args: blob, returns: FFIType.i32 },
      CryptUnprotectData: { args: blob, returns: FFIType.i32 }
    })
    const kernel32 = dlopen('kernel32.dll', { LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr } })
    api = {
      protect: crypt32.symbols.CryptProtectData as unknown as Api['protect'],
      unprotect: crypt32.symbols.CryptUnprotectData as unknown as Api['unprotect'],
      free: kernel32.symbols.LocalFree as unknown as Api['free']
    }
  } catch {
    api = null
  }
  return api
}

/** One DPAPI call over a DATA_BLOB {DWORD cbData; BYTE *pbData}; null when it fails (a file sealed by
 *  another Windows user or PC does not open). */
function run(bytes: Uint8Array, protect: boolean): Uint8Array | null {
  const a = load()
  if (!a || bytes.byteLength === 0) return null
  const input = new Uint8Array(16)
  const view = new DataView(input.buffer)
  view.setUint32(0, bytes.byteLength, true)
  view.setBigUint64(8, BigInt(ptr(bytes)), true)
  const output = new Uint8Array(16)
  if ((protect ? a.protect : a.unprotect)(input, null, null, null, null, UI_FORBIDDEN, output) === 0) return null
  const out = new DataView(output.buffer)
  const at = Number(out.getBigUint64(8, true))
  if (!at) return null
  const copy = new Uint8Array(toArrayBuffer(at as never, 0, out.getUint32(0, true))).slice()
  a.free(at)
  return copy
}

export const dpapiProtect = (bytes: Uint8Array): Uint8Array | null => run(bytes, true)
export const dpapiUnprotect = (bytes: Uint8Array): Uint8Array | null => run(bytes, false)
