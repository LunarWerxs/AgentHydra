// SHARED LunarWerx server-lib — source of truth: lunarwerx-ui/src/server-lib/dpapi-seal.mjs,
// synced by sync.mjs into each opting app's server tree (edit HERE, then `node sync.mjs`).
//
// DPAPI seal/unseal for the Connections OAuth refresh token AT REST (Windows).
//
// The "Sign in with Connections" daemons persist the @cnct/connect session through a
// ConnectStore. That session's durable secret is the refresh token (inside the TokenSet
// JSON stored under `cnx.connect.tokens.<clientId>`). On Windows this module seals that
// value with DPAPI (CryptProtectData, CurrentUser scope) via bun:ffi, so a state file/db
// copied to another machine or user can't be replayed — the same at-rest protection the
// Rust apps give their token (QuickDictate src/sync.rs, SageThumbs 2K cred_store.rs).
//
// Runtime-agnostic (Bun + Node): the FFI path is Bun-only AND Windows-only. Everywhere
// else (non-Windows, or Node with no bun:ffi) seal()/unseal() degrade to a plaintext
// PASSTHROUGH — never a crash. bun:ffi is loaded lazily via createRequire so merely
// importing this file under Node does not throw.
//
// Migration: a value that is NOT a DPAPIv1 blob (a legacy plaintext token already on
// disk from before this change) is returned unchanged by unseal(), so an existing
// signed-in daemon stays signed in across the upgrade; the next write re-seals it.
import { createRequire } from "node:module";

const MARKER = "DPAPIv1:";
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
const IS_WINDOWS = process.platform === "win32";

const enc = new TextEncoder();
const dec = new TextDecoder();

// Lazy, one-shot FFI init. `undefined` = untried, an object = ready, `null` = unavailable
// (non-Windows, non-Bun, or a load failure) so we stop retrying and fall back to plaintext.
let _ffi;
function ffi() {
  if (_ffi !== undefined) return _ffi;
  if (!IS_WINDOWS) {
    _ffi = null;
    return _ffi;
  }
  try {
    const require = createRequire(import.meta.url);
    // bun:ffi is a Bun builtin; under Node this require throws and we fall back to plaintext.
    const { dlopen, FFIType, ptr, toArrayBuffer } = require("bun:ffi");
    const blobArgs = [
      FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr,
    ];
    const crypt32 = dlopen("crypt32.dll", {
      CryptProtectData: { args: blobArgs, returns: FFIType.i32 },
      CryptUnprotectData: { args: blobArgs, returns: FFIType.i32 },
    });
    const kernel32 = dlopen("kernel32.dll", {
      LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
    });
    _ffi = { ptr, toArrayBuffer, crypt32, kernel32 };
  } catch {
    _ffi = null;
  }
  return _ffi;
}

// One DPAPI call. `protect` seals, otherwise unseals. Marshals a DATA_BLOB {DWORD cbData;
// BYTE *pbData} (16 bytes on x64: length at offset 0, pointer at offset 8), copies the
// CNG-allocated output out, then LocalFree's it. Returns the output bytes, or null on
// failure — a foreign/corrupt blob unseals to null (matching the Rust apps' "reads as not
// signed in"), never a throw.
function dpapi(bytes, protect) {
  const f = ffi();
  if (!f) return null;

  const inBlob = new Uint8Array(16);
  const inDv = new DataView(inBlob.buffer);
  inDv.setUint32(0, bytes.byteLength, true);
  inDv.setBigUint64(8, BigInt(f.ptr(bytes)), true);

  const outBlob = new Uint8Array(16);
  const fn = protect ? f.crypt32.symbols.CryptProtectData : f.crypt32.symbols.CryptUnprotectData;
  const ok = fn(inBlob, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, outBlob);
  if (ok === 0) return null;

  const outDv = new DataView(outBlob.buffer);
  const outLen = outDv.getUint32(0, true);
  const outPtr = outDv.getBigUint64(8, true);
  if (outPtr === 0n) return null;
  const copy = new Uint8Array(f.toArrayBuffer(Number(outPtr), 0, outLen)).slice();
  f.kernel32.symbols.LocalFree(Number(outPtr));
  return copy;
}

/** True when seal() will actually DPAPI-encrypt (Windows + bun:ffi). Elsewhere seal() is a
 *  plaintext passthrough. Exposed for tests + status reporting. */
export function sealingActive() {
  return ffi() !== null;
}

/** Seal a plaintext string for storage. On Windows/Bun returns `DPAPIv1:<base64>`; everywhere
 *  else returns the input unchanged (documented plaintext fallback — never throws). */
export function seal(plaintext) {
  if (typeof plaintext !== "string" || plaintext === "") return plaintext;
  const sealed = dpapi(enc.encode(plaintext), true);
  if (!sealed) return plaintext; // FFI unavailable → plaintext fallback
  return MARKER + Buffer.from(sealed).toString("base64");
}

/** Reverse seal(). A value WITHOUT the DPAPIv1 marker (legacy plaintext already on disk) is
 *  returned as-is — that is the upgrade migration. A DPAPIv1 blob that fails to decrypt (copied
 *  from another machine/user, or corrupt) returns null, i.e. "no usable credential". */
export function unseal(stored) {
  if (typeof stored !== "string" || stored === "") return stored ?? null;
  if (!stored.startsWith(MARKER)) return stored; // legacy plaintext → migrate on next write
  let raw;
  try {
    raw = Uint8Array.from(Buffer.from(stored.slice(MARKER.length), "base64"));
  } catch {
    return null;
  }
  const plain = dpapi(raw, false);
  return plain ? dec.decode(plain) : null;
}

/**
 * Wrap a ConnectStore so the value under `tokenKey` (the @cnct/connect TokenSet — the durable
 * refresh token) is DPAPI-sealed at rest, while every other key (the transient PKCE record) is
 * passed through untouched. Handles a sync OR async inner store.
 */
export function wrapTokenStore(inner, tokenKey) {
  return {
    get(key) {
      const raw = inner.get(key);
      if (key !== tokenKey) return raw;
      if (raw && typeof raw.then === "function") return raw.then((v) => (v == null ? v : unseal(v)));
      return raw == null ? raw : unseal(raw);
    },
    set(key, value) {
      return inner.set(key, key === tokenKey ? seal(value) : value);
    },
    remove(key) {
      return inner.remove(key);
    },
  };
}
