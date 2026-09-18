// server/src/core/crypto/keys.win.ts — Windows safeStorage master-key retrieval (PLAN.md §2).
//
// Chain: <instanceDir>/Local State -> os_crypt.encrypted_key (base64) -> strip the 5-byte
// ASCII 'DPAPI' prefix -> DPAPI CryptUnprotectData (CurrentUser scope) -> raw 32-byte AES-256
// key. No KDF on Windows — the DPAPI-unprotected bytes ARE the key.
//
// Primary path: bun:ffi -> crypt32.dll!CryptUnprotectData (verified feasible on this machine:
// a CryptProtectData/CryptUnprotectData round trip via bun:ffi succeeds and needs no
// PowerShell dependency, so it also works from the compiled --compile binary).
// Fallback path: shell out to PowerShell's
// [System.Security.Cryptography.ProtectedData]::Unprotect(...) — used only if the FFI dlopen
// or call itself fails (e.g. some future Bun/Windows quirk), so the feature still degrades
// gracefully rather than crashing.
//
// Nothing here throws for expected failure conditions (missing/locked file, bad JSON, missing
// key, DPAPI failure because a different user encrypted it, etc.) — every path returns `null`.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnCaptured } from '../process.ts'

/** DPAPI unprotect is a local, in-process CryptoAPI call - it answers in milliseconds or
 *  something is wrong. Ten seconds is pure slack. */
const DPAPI_TIMEOUT_MS = 10_000

const DPAPI_PREFIX = Buffer.from('DPAPI', 'ascii') // 5 ASCII bytes stripped from encrypted_key.

/** Per-instanceDir cache of the resolved 32-byte master key (normalized path -> key bytes). */
const masterKeyCache = new Map<string, Uint8Array>()

function normalizeDir(dir: string): string {
  return dir.replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * DATA_BLOB is `{ DWORD cbData; BYTE *pbData; }`. On x64 that's 4 bytes length + 4 bytes
 * padding + 8 bytes pointer = 16 bytes total, all little-endian.
 */
function makeDataBlobStruct(
  bytes: Uint8Array,
  ptrOf: (b: Uint8Array) => number | bigint,
): ArrayBuffer {
  const buf = new ArrayBuffer(16)
  const view = new DataView(buf)
  view.setUint32(0, bytes.length, true)
  view.setBigUint64(8, BigInt(ptrOf(bytes)), true)
  return buf
}

/**
 * Attempts DPAPI CryptUnprotectData via bun:ffi (crypt32.dll). Returns the unprotected bytes,
 * or null if the FFI path is unavailable or the call fails (bad user context, corrupted blob,
 * etc.) — callers fall back to the PowerShell path on null.
 */
async function unprotectViaFfi(blob: Uint8Array): Promise<Uint8Array | null> {
  try {
    // Dynamic import: bun:ffi only resolves under Bun, and we want this module to still be
    // importable (for typechecking / non-Windows dev) without exploding at load time.
    const { dlopen, FFIType, ptr, toArrayBuffer } = await import('bun:ffi')
    type Pointer = number & { __pointer__: null }

    const crypt32 = dlopen('crypt32.dll', {
      CryptUnprotectData: {
        args: [
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u32,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
    })

    const localFree = dlopen('kernel32.dll', {
      LocalFree: {
        args: [FFIType.ptr],
        returns: FFIType.ptr,
      },
    })

    try {
      const inBlob = makeDataBlobStruct(blob, (b) => ptr(b))
      const outBlobBuf = new ArrayBuffer(16)

      const ok = crypt32.symbols.CryptUnprotectData(
        ptr(inBlob),
        null,
        null,
        null,
        null,
        0,
        ptr(outBlobBuf),
      )

      if (!ok) return null

      const outView = new DataView(outBlobBuf)
      const outLen = outView.getUint32(0, true)
      const outPtr = outView.getBigUint64(8, true)

      if (outLen === 0 || outPtr === 0n) return null

      // toArrayBuffer aliases native memory; copy it out before LocalFree releases it.
      const outPtrValue = Number(outPtr) as Pointer
      const aliased = toArrayBuffer(outPtrValue, 0, outLen)
      const result = new Uint8Array(aliased).slice()

      try {
        localFree.symbols.LocalFree(outPtrValue)
      } catch {
        // Leaking a small LocalAlloc buffer on failure is not fatal — never let cleanup throw.
      }

      return result
    } finally {
      try {
        crypt32.close()
      } catch {
        // ignore
      }
      try {
        localFree.close()
      } catch {
        // ignore
      }
    }
  } catch {
    return null
  }
}

/**
 * Fallback: shell out to PowerShell's ProtectedData.Unprotect. Only used if the bun:ffi path
 * is unavailable or fails. Passes the blob as base64 on the command line and reads base64
 * back on stdout to avoid any binary-safety issues with process I/O.
 */
async function unprotectViaPowerShell(blob: Uint8Array): Promise<Uint8Array | null> {
  try {
    const b64 = Buffer.from(blob).toString('base64')
    const script = [
      'Add-Type -AssemblyName System.Security',
      `$bytes = [Convert]::FromBase64String('${b64}')`,
      '$unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect(',
      '  $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Console]::Out.Write([Convert]::ToBase64String($unprotected))',
    ].join('\n')

    // ⛔ THIS WAS A DEADLOCK, NOT MERELY A MISSING TIMEOUT (swept 2026-09-18). It opened
    // `stderr: 'pipe'` and NEVER READ IT, then awaited the stdout drain and proc.exited together.
    // A DPAPI `Unprotect` failure throws a .NET exception whose traceback runs to kilobytes; past
    // the pipe buffer PowerShell BLOCKS on that write, so it never exits, so stdout never closes
    // and `proc.exited` never settles. The credential-decrypt path then hangs whatever asked for
    // an account's token, with no deadline anywhere to break it. It is the same deadlock the
    // orchestrator adapter's own comment warns about - "a child that fills one pipe while the
    // other is unread" - reached in a different file. spawnCaptured drains BOTH streams and is
    // bounded, so the failure mode is now a null return with the traceback available.
    const r = await spawnCaptured(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
      { timeoutMs: DPAPI_TIMEOUT_MS },
    )

    if (r.timedOut || r.code !== 0) return null

    const trimmed = r.stdout.trim()
    if (!trimmed) return null

    return new Uint8Array(Buffer.from(trimmed, 'base64'))
  } catch {
    return null
  }
}

/**
 * Resolves the 32-byte safeStorage master key for a Windows Claude instance dir.
 *
 * @param instanceDir Full path to the isolated instance's data dir (contains `Local State`).
 * @returns the 32-byte key, or `null` on any expected failure (missing/locked file, bad JSON,
 *   missing os_crypt.encrypted_key, DPAPI unprotect failure — e.g. running as a different user
 *   than the one that encrypted it). Never throws.
 */
export async function getWindowsMasterKey(instanceDir: string): Promise<Uint8Array | null> {
  try {
    if (!instanceDir?.trim()) return null

    const cacheKey = normalizeDir(instanceDir)
    const cached = masterKeyCache.get(cacheKey)
    if (cached) return cached

    const localStatePath = join(instanceDir, 'Local State')
    if (!existsSync(localStatePath)) return null

    let raw: string
    try {
      raw = readFileSync(localStatePath, 'utf8')
    } catch {
      // Locked (Claude actively writing it) or permissions issue.
      return null
    }

    let localState: unknown
    try {
      localState = JSON.parse(raw)
    } catch {
      return null
    }

    const encryptedKeyB64 = (localState as { os_crypt?: { encrypted_key?: unknown } })?.os_crypt
      ?.encrypted_key
    if (typeof encryptedKeyB64 !== 'string' || !encryptedKeyB64) return null

    let encKeyBytes: Uint8Array
    try {
      encKeyBytes = new Uint8Array(Buffer.from(encryptedKeyB64, 'base64'))
    } catch {
      return null
    }

    if (encKeyBytes.length <= DPAPI_PREFIX.length) return null

    const prefix = encKeyBytes.subarray(0, DPAPI_PREFIX.length)
    if (!Buffer.from(prefix).equals(DPAPI_PREFIX)) {
      // Not the expected 'DPAPI' prefix — still attempt unprotect on the full bytes as a
      // best-effort fallback (older/newer Chromium versions), but this is the documented shape.
    }
    const dpapiBlob = Buffer.from(prefix).equals(DPAPI_PREFIX)
      ? encKeyBytes.subarray(DPAPI_PREFIX.length)
      : encKeyBytes

    let keyBytes = await unprotectViaFfi(dpapiBlob)
    if (!keyBytes) {
      keyBytes = await unprotectViaPowerShell(dpapiBlob)
    }

    if (!keyBytes || keyBytes.length === 0) return null

    masterKeyCache.set(cacheKey, keyBytes)
    return keyBytes
  } catch {
    return null
  }
}
