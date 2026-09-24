// server/src/core/crypto/keys.mac.ts — macOS safeStorage master-key retrieval (PLAN.md §2).
//
// Chain: `security find-generic-password -s "Claude Safe Storage" -a "Claude" -w` -> base64
// Keychain password -> PBKDF2-HMAC-SHA1(pw, salt="saltysalt", 1003 iters, 16-byte key) via
// WebCrypto -> AES-128 key. Falls back to the legacy Chromium service/account name
// ("Chromium Safe Storage" / "Chromium") per Electron bug #45328, which some Claude Desktop
// builds are affected by.
//
// Nothing here throws for expected failure conditions (Keychain item missing, access denied /
// user cancelled the prompt, `security` binary missing) — every path returns `null`.

import { spawnCaptured } from '../process.ts'

/** A keychain read answers instantly or it is waiting on a human at an access prompt. Five
 *  seconds tells those apart without ever cutting off a working lookup. */
const KEYCHAIN_TIMEOUT_MS = 5_000

const SALT = 'saltysalt'
const PBKDF2_ITERATIONS = 1003
const KEY_LENGTH_BYTES = 16 // AES-128

/** Per-instanceDir cache of the derived 16-byte AES key (currently keychain password is
 *  machine-wide, not per-instance, but we key by instanceDir for symmetry with win/linux and
 *  in case a future Claude build scopes the Keychain item differently). */
const derivedKeyCache = new Map<string, Uint8Array>()

interface KeychainCandidate {
  service: string
  account: string
}

const KEYCHAIN_CANDIDATES: KeychainCandidate[] = [
  { service: 'Claude Safe Storage', account: 'Claude' },
  // Electron bug #45328: some Claude Desktop builds register under the Chromium defaults.
  { service: 'Chromium Safe Storage', account: 'Chromium' },
]

// ⛔ BOUNDED (swept 2026-09-18): `security find-generic-password` prompts for keychain access,
// and this awaited its stdout drain plus proc.exited with no deadline - so an unanswered prompt
// hung the caller forever. It also piped stderr and never read it, which deadlocks a child that
// fills that pipe. spawnCaptured drains both streams and always settles.
async function readKeychainPassword(service: string, account: string): Promise<string | null> {
  try {
    const r = await spawnCaptured(
      ['security', 'find-generic-password', '-s', service, '-a', account, '-w'],
      { timeoutMs: KEYCHAIN_TIMEOUT_MS },
    )

    if (r.timedOut || r.code !== 0) return null

    const trimmed = r.stdout.trim()
    return trimmed ? trimmed : null
  } catch {
    // `security` missing, spawn failure, etc.
    return null
  }
}

/** Derives the AES-128 key from a Keychain password via PBKDF2-HMAC-SHA1 (WebCrypto). */
export async function deriveMacKey(password: string): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-1',
      salt: enc.encode(SALT),
      iterations: PBKDF2_ITERATIONS,
    },
    baseKey,
    KEY_LENGTH_BYTES * 8,
  )

  return new Uint8Array(bits)
}

/**
 * Resolves the 16-byte AES-128 safeStorage key for macOS.
 *
 * @param instanceDir Full path to the isolated instance's data dir (used only for caching;
 *   the Keychain item itself is not per-instance).
 * @returns the 16-byte derived key, or `null` if no Keychain candidate resolves (item missing,
 *   access denied, `security` unavailable). Never throws.
 */
export async function getMacMasterKey(instanceDir: string): Promise<Uint8Array | null> {
  try {
    const cacheKey = (instanceDir || '').replace(/\/+$/, '').toLowerCase()
    const cached = derivedKeyCache.get(cacheKey)
    if (cached) return cached

    let password: string | null = null
    for (const candidate of KEYCHAIN_CANDIDATES) {
      password = await readKeychainPassword(candidate.service, candidate.account)
      if (password) break
    }

    if (!password) return null

    const derived = await deriveMacKey(password)
    if (cacheKey) derivedKeyCache.set(cacheKey, derived)
    return derived
  } catch {
    return null
  }
}
