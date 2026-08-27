// server/src/core/crypto/index.ts — cross-platform safeStorage decryptor (PLAN.md §2).
//
// THE GOLDEN MODULE. Decrypts an Electron `safeStorage`-encrypted base64 blob (as found in an
// isolated Claude Desktop instance's `config.json`, e.g. the `oauth:tokenCacheV2` value) back
// to its plaintext UTF-8 string (typically JSON containing an `sk-ant-oat01…` token).
//
// Dispatch is by `process.platform`:
//   - win32:        v10 -> AES-256-GCM, key = raw DPAPI-unprotected 32 bytes (keys.win.ts)
//   - darwin:       v10 -> AES-128-CBC, key = PBKDF2-SHA1(Keychain pw, 1003 iters) (keys.mac.ts)
//   - linux/other:  v10/v11 -> AES-128-CBC, key = PBKDF2-SHA1(secret, 1 iter) (keys.linux.ts)
//
// Blob layout (after base64-decode):
//   - Windows:      ascii 'v10' (3 bytes) + nonce (12 bytes) + ciphertext + GCM tag (16 bytes)
//   - mac/linux:    ascii 'v10'/'v11' (3 bytes) + ciphertext (CBC, IV is NOT embedded — it's a
//                   fixed 16 bytes of 0x20 ' ' space characters, PKCS7-padded plaintext)
//
// Never throws: every expected failure (bad base64, wrong/missing version prefix, truncated
// blob, key retrieval failure, decrypt/tag-mismatch failure, bad UTF-8) returns `null`.

import { deriveLinuxKey, getLinuxMasterKey, linuxFallbackPassword } from './keys.linux'
import { deriveMacKey, getMacMasterKey } from './keys.mac'
import { getWindowsMasterKey } from './keys.win'

const GCM_NONCE_LENGTH = 12
const GCM_TAG_LENGTH = 16
const CBC_IV = new Uint8Array(16).fill(0x20) // 16 x ' ' (0x20) per Chromium's fixed-IV scheme.

type SupportedPrefix = 'v10' | 'v11'

function readVersionPrefix(bytes: Uint8Array): SupportedPrefix | null {
  if (bytes.length < 3) return null
  const ascii = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!)
  return ascii === 'v10' || ascii === 'v11' ? ascii : null
}

/** AES-256-GCM decrypt for the Windows path. Returns plaintext bytes or null. */
async function decryptAesGcm(
  key: Uint8Array,
  blobAfterPrefix: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    if (blobAfterPrefix.length < GCM_NONCE_LENGTH + GCM_TAG_LENGTH) return null

    const nonce = blobAfterPrefix.subarray(0, GCM_NONCE_LENGTH)
    // WebCrypto expects ciphertext with the tag appended at the end (which it already is here,
    // since we sliced off only the nonce) — pass the remainder through as-is.
    const cipherWithTag = blobAfterPrefix.subarray(GCM_NONCE_LENGTH)

    if (cipherWithTag.length < GCM_TAG_LENGTH) return null

    const cryptoKey = await crypto.subtle.importKey('raw', key.slice(), 'AES-GCM', false, [
      'decrypt',
    ])

    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce.slice(), tagLength: GCM_TAG_LENGTH * 8 },
      cryptoKey,
      cipherWithTag.slice(),
    )

    return new Uint8Array(plainBuf)
  } catch {
    // Tag mismatch / tamper / wrong key / malformed input all land here.
    return null
  }
}

/** AES-128-CBC decrypt (PKCS7) for the mac/linux path. Returns plaintext bytes or null. */
async function decryptAesCbc(key: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array | null> {
  try {
    if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) return null

    const cryptoKey = await crypto.subtle.importKey('raw', key.slice(), 'AES-CBC', false, [
      'decrypt',
    ])

    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: CBC_IV.slice() },
      cryptoKey,
      ciphertext.slice(),
    )

    return new Uint8Array(plainBuf)
  } catch {
    // WebCrypto's AES-CBC decrypt itself validates/strips PKCS7 padding and throws on bad
    // padding — that's an expected "wrong key" signal here, so we swallow it as null.
    return null
  }
}

function utf8DecodeOrNull(bytes: Uint8Array): string | null {
  try {
    // fatal:true rejects invalid UTF-8 sequences instead of silently replacing them, which we
    // want here — a bad decode key can produce garbage bytes that still "decrypt" without a
    // padding/tag error, so this is an extra correctness signal.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Decrypts an Electron `safeStorage` base64 blob to its plaintext UTF-8 string.
 *
 * @param base64Blob The base64-encoded safeStorage value (e.g. config.json's
 *   `oauth:tokenCacheV2`).
 * @param instanceDir Full path to the isolated instance's data dir — used to resolve/cache the
 *   platform-specific master key (Windows: reads `<instanceDir>/Local State`; mac/linux: not
 *   file-scoped, but still keyed for cache symmetry).
 * @returns the decoded UTF-8 plaintext, or `null` on ANY failure (missing/locked key source,
 *   bad base64, unsupported/missing version prefix, truncated blob, decrypt failure, bad
 *   UTF-8). Never throws.
 */
/** The win32 branch of decryptSafeStorage: v10 only, AES-GCM under DPAPI's key. */
async function decryptWin32(
  version: string,
  afterPrefix: Uint8Array,
  instanceDir: string,
): Promise<string | null> {
  if (version !== 'v10') return null // Windows only ever produces v10.
  const key = await getWindowsMasterKey(instanceDir)
  if (key?.length !== 32) return null
  const plain = await decryptAesGcm(key, afterPrefix)
  return plain ? utf8DecodeOrNull(plain) : null
}

/** The darwin branch of decryptSafeStorage: v10 only, AES-CBC under the Keychain-derived key. */
async function decryptDarwin(
  version: string,
  afterPrefix: Uint8Array,
  instanceDir: string,
): Promise<string | null> {
  if (version !== 'v10') return null // macOS only ever produces v10.
  const key = await getMacMasterKey(instanceDir)
  if (key?.length !== 16) return null
  const plain = await decryptAesCbc(key, afterPrefix)
  return plain ? utf8DecodeOrNull(plain) : null
}

/** The Linux (and other-platform) branch: v10 (peanuts-or-secret) or v11 (keyring secret), with a
 *  fallback retry against an empty-string-derived key for the historical v11 empty-key bug
 *  (PLAN.md §7) — also covers the case where the resolved secret was simply wrong. */
async function decryptLinux(afterPrefix: Uint8Array, instanceDir: string): Promise<string | null> {
  const key = await getLinuxMasterKey(instanceDir)
  if (key && key.length === 16) {
    const plain = await decryptAesCbc(key, afterPrefix)
    const decoded = plain ? utf8DecodeOrNull(plain) : null
    if (decoded) return decoded
  }
  const emptyKey = await getLinuxMasterKey(instanceDir, { forceEmptyPassword: true })
  if (emptyKey && emptyKey.length === 16) {
    const plain = await decryptAesCbc(emptyKey, afterPrefix)
    const decoded = plain ? utf8DecodeOrNull(plain) : null
    if (decoded) return decoded
  }
  return null
}

export async function decryptSafeStorage(
  base64Blob: string,
  instanceDir: string,
): Promise<string | null> {
  try {
    if (!base64Blob?.trim()) return null
    if (!instanceDir?.trim()) return null

    let raw: Uint8Array
    try {
      raw = new Uint8Array(Buffer.from(base64Blob, 'base64'))
    } catch {
      return null
    }

    const version = readVersionPrefix(raw)
    if (!version) return null

    const afterPrefix = raw.subarray(3)
    const platform = process.platform

    if (platform === 'win32') return decryptWin32(version, afterPrefix, instanceDir)
    if (platform === 'darwin') return decryptDarwin(version, afterPrefix, instanceDir)
    return decryptLinux(afterPrefix, instanceDir)
  } catch {
    return null
  }
}

// Re-exported for tests / callers that want direct access to the per-OS key derivation without
// going through the full decrypt pipeline (e.g. static KDF vector tests).
export {
  deriveLinuxKey,
  deriveMacKey,
  getLinuxMasterKey,
  getMacMasterKey,
  getWindowsMasterKey,
  linuxFallbackPassword,
}
