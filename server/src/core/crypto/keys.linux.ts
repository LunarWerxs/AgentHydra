// server/src/core/crypto/keys.linux.ts — Linux safeStorage master-key retrieval (PLAN.md §2).
//
// Chain: secret via `secret-tool lookup application Claude` (gnome-libsecret) or kwallet,
// else the literal fallback password "peanuts" (Chromium's documented `basic_text` fallback
// when no secret store is available) -> PBKDF2-HMAC-SHA1(pw, salt="saltysalt", 1 iter,
// 16-byte key) via WebCrypto -> AES-128 key.
//
// Blob-version note (handled by index.ts, documented here for context): `v10` blobs pair with
// the "peanuts" fallback path; `v11` blobs pair with a real keyring secret. Both use the same
// KDF params (1 iteration) — only the input password differs. PLAN.md §7 also flags a
// historical `v11` empty-key bug on some distros; index.ts/accounts.ts can retry with an
// empty-string password if the keyring-derived key fails to decrypt.
//
// Nothing here throws for expected failure conditions (no secret store, secret-tool/kwallet
// missing, empty result) — every path returns `null` or the "peanuts" fallback key, never
// throws.

const SALT = 'saltysalt'
const PBKDF2_ITERATIONS = 1 // Linux uses exactly 1 iteration (vs. 1003 on macOS).
const KEY_LENGTH_BYTES = 16 // AES-128
const PEANUTS_FALLBACK = 'peanuts'

const derivedKeyCache = new Map<string, Uint8Array>()

import { spawnCaptured } from '../process.ts'

/** A secret store answers in milliseconds or it is waiting on a human (an unlocked-keyring
 *  prompt). Five seconds tells those apart without ever cutting off a working lookup. */
const SECRET_STORE_TIMEOUT_MS = 5_000

// ⛔ BOUNDED, because a secret store can BLOCK (swept 2026-09-18). This awaited a stdout drain
// and proc.exited together with no deadline at all, so a `secret-tool` sitting on a locked-keyring
// prompt hung whatever asked for a credential - and, piping stderr without ever reading it, a
// child that filled that pipe could not exit either. spawnCaptured drains both and always returns.
async function runCommand(cmd: string[]): Promise<string | null> {
  const r = await spawnCaptured(cmd, { timeoutMs: SECRET_STORE_TIMEOUT_MS })
  if (r.timedOut || r.code !== 0) return null
  const trimmed = r.stdout.trim()
  return trimmed ? trimmed : null
}

/** Tries `secret-tool` (gnome-libsecret), the most common Linux secret store. */
async function readSecretTool(): Promise<string | null> {
  return runCommand(['secret-tool', 'lookup', 'application', 'Claude'])
}

/**
 * Tries kwallet via `kwallet-query` if present (KDE desktops). Best-effort: the exact wallet
 * folder/entry naming used by Electron's kwallet backend varies, so this is a soft attempt —
 * a miss here just falls through to the "peanuts" default, matching Chromium's own behavior
 * when no secret store answers.
 */
async function readKwallet(): Promise<string | null> {
  // kwallet-query -f <folder> <wallet> <key> ; Electron/Chromium historically stores under the
  // "Chromium Keys"/"Claude Keys" folder with entry "Claude Safe Storage". Best-effort only.
  const attempts: string[][] = [
    ['kwallet-query', '-f', 'Chromium Keys', '-r', 'Claude Safe Storage', 'kdewallet'],
    ['kwallet-query', '-f', 'Claude Keys', '-r', 'Claude Safe Storage', 'kdewallet'],
  ]
  for (const attempt of attempts) {
    const result = await runCommand(attempt)
    if (result) return result
  }
  return null
}

/** Derives the AES-128 key via PBKDF2-HMAC-SHA1 with 1 iteration (WebCrypto). */
export async function deriveLinuxKey(password: string): Promise<Uint8Array> {
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
 * Resolves the 16-byte AES-128 safeStorage key for Linux.
 *
 * @param instanceDir Full path to the isolated instance's data dir (used only for caching).
 * @param opts.forceEmptyPassword When true, skips secret-store lookup and derives directly
 *   from an empty-string password — used as a last-resort retry for the historical `v11`
 *   empty-key bug (PLAN.md §7) when the normally-resolved key fails to decrypt.
 * @returns the 16-byte derived key. Falls back to the "peanuts" default when no secret store
 *   answers (mirroring Chromium's own `basic_text` fallback) — this function does not return
 *   `null` in normal operation, only on unexpected internal errors.
 */
export async function getLinuxMasterKey(
  instanceDir: string,
  opts?: { forceEmptyPassword?: boolean },
): Promise<Uint8Array | null> {
  try {
    const cacheKey = `${(instanceDir || '').replace(/\/+$/, '').toLowerCase()}${
      opts?.forceEmptyPassword ? '#empty' : ''
    }`
    const cached = derivedKeyCache.get(cacheKey)
    if (cached) return cached

    let password: string
    if (opts?.forceEmptyPassword) {
      password = ''
    } else {
      const secret = (await readSecretTool()) ?? (await readKwallet())
      password = secret ?? PEANUTS_FALLBACK
    }

    const derived = await deriveLinuxKey(password)
    derivedKeyCache.set(cacheKey, derived)
    return derived
  } catch {
    return null
  }
}

/** Exposed for index.ts/accounts.ts to decide whether a v10 blob should skip secret-store
 *  lookup entirely and go straight to "peanuts" (PLAN.md §2 blob-prefix table). */
export function linuxFallbackPassword(): string {
  return PEANUTS_FALLBACK
}
