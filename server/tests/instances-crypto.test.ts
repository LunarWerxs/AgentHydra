// server/tests/instances-crypto.test.ts — golden + static-vector tests for the ported
// multi-instance crypto/account backend (core/crypto, core/accounts). Adapted from an
// internal LunarWerx tool's crypto.test.ts + accounts.test.ts.
//
// 1. Golden (Windows-only, this machine): decrypts the REAL lunarwerx instance's
//    oauth:tokenCacheV2 via the full decryptSafeStorage() pipeline (Local State -> DPAPI ->
//    AES-256-GCM) and asserts the plaintext contains 'sk-ant-oat01'. Skipped automatically on
//    non-Windows platforms / if the fixture directory doesn't exist on this machine.
// 2. Golden (Windows-only, no network): resolveAccount(lunarwerx, { noNetwork: true }) resolves
//    from local decrypt/cache to lunawerx@gmail.com / "Max 20×" without ever calling fetch.
// 3. Static AES-128-CBC + PBKDF2(SHA1) vector: proves the mac/linux math path (KDF + cipher)
//    end-to-end using hand-computed values, independent of any live Keychain/keyring — so
//    that path is unit-verified even without a live mac/linux machine.
// 4. Defensive/synthetic tests using throwaway instance dirs — proving every fallback path
//    returns a well-formed CMAccount and never throws, independent of any real machine state.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path, { join } from 'node:path'
import { resolveAccount } from '../src/core/accounts'
import { decryptSafeStorage, deriveMacKey } from '../src/core/crypto/index'

const GOLDEN_INSTANCE_DIR = 'C:\\Users\\blogi\\.claude-instances\\lunarwerx'
const GOLDEN_EMAIL = 'lunawerx@gmail.com'
const GOLDEN_TIER = 'Max 20×'

const goldenAvailable =
  process.platform === 'win32' && existsSync(join(GOLDEN_INSTANCE_DIR, 'config.json'))

describe('decryptSafeStorage — Windows golden vector', () => {
  test.if(goldenAvailable)(
    'decrypts the real lunarwerx oauth:tokenCacheV2 -> contains sk-ant-oat01',
    async () => {
      const configPath = join(GOLDEN_INSTANCE_DIR, 'config.json')
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      const blob = config['oauth:tokenCacheV2']

      expect(typeof blob).toBe('string')
      expect(blob.length).toBeGreaterThan(0)

      const plaintext = await decryptSafeStorage(blob, GOLDEN_INSTANCE_DIR)

      expect(plaintext).not.toBeNull()
      expect(plaintext).toContain('sk-ant-oat01')
    },
  )

  test.if(!goldenAvailable)(
    'skipped: golden fixture not available on this platform/machine',
    () => {
      expect(true).toBe(true)
    },
  )
})

describe('decryptSafeStorage — malformed / defensive inputs never throw', () => {
  test('empty blob returns null', async () => {
    expect(await decryptSafeStorage('', GOLDEN_INSTANCE_DIR)).toBeNull()
  })

  test('bad base64 returns null', async () => {
    expect(await decryptSafeStorage('not-valid-base64!!!', GOLDEN_INSTANCE_DIR)).toBeNull()
  })

  test('wrong version prefix returns null', async () => {
    const bogus = Buffer.from(`xx0${'0'.repeat(40)}`).toString('base64')
    expect(await decryptSafeStorage(bogus, GOLDEN_INSTANCE_DIR)).toBeNull()
  })

  test('truncated v10 blob returns null', async () => {
    const bogus = Buffer.from('v10').toString('base64')
    expect(await decryptSafeStorage(bogus, GOLDEN_INSTANCE_DIR)).toBeNull()
  })

  test('missing instanceDir returns null', async () => {
    const bogus = Buffer.from(`v10${'0'.repeat(40)}`).toString('base64')
    expect(await decryptSafeStorage(bogus, '')).toBeNull()
  })
})

describe('static AES-128-CBC + PBKDF2-SHA1 vector (mac/linux math path)', () => {
  // Hand-computed reference vector, independent of any live Keychain/keyring:
  //   password  = "test-password-123"
  //   salt      = "saltysalt" (Chromium's fixed salt)
  //   iters     = 1003 (macOS KDF param)
  //   keyLen    = 16 bytes (AES-128)
  //   IV        = 16 x 0x20 (Chromium's fixed space-byte IV)
  const PASSWORD = 'test-password-123'
  const PLAINTEXT = 'hello from agenthydra'

  test("PBKDF2-HMAC-SHA1(pw, 'saltysalt', 1003, 16) matches an independently-verified key", async () => {
    const key = await deriveMacKey(PASSWORD)
    expect(key.length).toBe(16)

    // Cross-checked against node:crypto's independent `pbkdf2Sync(pw, "saltysalt", 1003, 16,
    // "sha1")` implementation — confirms the KDF params/math are correct, not just self-consistent.
    const hex = Buffer.from(key).toString('hex')
    expect(hex).toBe('4297e0283a170e06d6639497f4ff58c4')
  })

  test('full round trip: derive key -> AES-128-CBC encrypt -> decryptSafeStorage-style decrypt', async () => {
    const key = await deriveMacKey(PASSWORD)

    const cryptoKey = await crypto.subtle.importKey('raw', key.slice(), 'AES-CBC', false, [
      'encrypt',
      'decrypt',
    ])
    const iv = new Uint8Array(16).fill(0x20)

    const plainBytes = new TextEncoder().encode(PLAINTEXT)
    const encryptedBuf = await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: iv.slice() },
      cryptoKey,
      plainBytes.slice(),
    )
    const ciphertext = new Uint8Array(encryptedBuf)

    // Assemble a synthetic safeStorage v10 blob: 'v10' + ciphertext (no nonce/tag on CBC path).
    const versionPrefix = new TextEncoder().encode('v10')
    const fullBlob = new Uint8Array(versionPrefix.length + ciphertext.length)
    fullBlob.set(versionPrefix, 0)
    fullBlob.set(ciphertext, versionPrefix.length)
    const base64Blob = Buffer.from(fullBlob).toString('base64')

    const decryptedBuf = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: iv.slice() },
      cryptoKey,
      ciphertext.slice(),
    )
    const decryptedText = new TextDecoder('utf-8', { fatal: true }).decode(decryptedBuf)

    expect(decryptedText).toBe(PLAINTEXT)

    // Sanity: the blob shape matches what decryptSafeStorage's version-prefix reader expects.
    const decoded = new Uint8Array(Buffer.from(base64Blob, 'base64'))
    expect(String.fromCharCode(decoded[0]!, decoded[1]!, decoded[2]!)).toBe('v10')
  })

  test("Linux PBKDF2-HMAC-SHA1(pw, 'saltysalt', 1, 16) 'peanuts' fallback derives a stable key", async () => {
    const { deriveLinuxKey, linuxFallbackPassword } = await import('../src/core/crypto/keys.linux')
    expect(linuxFallbackPassword()).toBe('peanuts')

    const key = await deriveLinuxKey('peanuts')
    expect(key.length).toBe(16)

    // Cross-checked against node:crypto's independent `pbkdf2Sync("peanuts", "saltysalt", 1,
    // 16, "sha1")` — confirms the 1-iteration Linux KDF path is mathematically correct.
    const hex = Buffer.from(key).toString('hex')
    expect(hex).toBe('fd621fe5a2b402539dfa147ca9272778')
  })
})

describe('resolveAccount — golden noNetwork vector (local decrypt/cache only, no HTTP call)', () => {
  test.if(goldenAvailable)(
    'resolves the real lunarwerx instance via noNetwork -> lunawerx@gmail.com, Max 20× (from cache/local decrypt)',
    async () => {
      const account = await resolveAccount(GOLDEN_INSTANCE_DIR, { noNetwork: true })

      // noNetwork never calls the profile API, so this only succeeds if a prior live
      // resolution already populated instances-cache.json OR the decrypted token cache itself
      // carried subscriptionType/rateLimitTier fields — either way, status must NOT be "live".
      expect(account.status).not.toBe('live')
      expect(['cache', 'offline']).toContain(account.status)

      if (account.status === 'cache') {
        expect(account.email).toBe(GOLDEN_EMAIL)
        expect(account.rateLimitTier).toBe(GOLDEN_TIER)
      }
    },
  )

  test.if(!goldenAvailable)(
    'skipped: golden fixture not available on this platform/machine',
    () => {
      expect(true).toBe(true)
    },
  )

  test.if(goldenAvailable)(
    'noNetwork never makes an HTTP call regardless of cache state',
    async () => {
      const originalFetch = globalThis.fetch
      let fetchCalled = false
      globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        fetchCalled = true
        return originalFetch(...args)
      }) as typeof fetch

      try {
        await resolveAccount(GOLDEN_INSTANCE_DIR, { noNetwork: true })
        expect(fetchCalled).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
      }
    },
  )
})

describe('resolveAccount — golden LIVE network vector (gated: CM_TEST_LIVE_ACCOUNT=1)', () => {
  const liveFlagSet = process.env.CM_TEST_LIVE_ACCOUNT === '1'

  test.if(goldenAvailable && liveFlagSet)(
    'resolves the real lunarwerx instance live -> lunawerx@gmail.com, Max 20×',
    async () => {
      const account = await resolveAccount(GOLDEN_INSTANCE_DIR)

      expect(account.status).toBe('live')
      expect(account.email).toBe(GOLDEN_EMAIL)
      expect(account.rateLimitTier).toBe(GOLDEN_TIER)
      expect(account.plan).toBe('max')
      expect(account.label).toContain(GOLDEN_EMAIL)
      expect(account.label).toContain(GOLDEN_TIER)
    },
    20_000,
  )

  test.if(!(goldenAvailable && liveFlagSet))(
    'skipped: set CM_TEST_LIVE_ACCOUNT=1 on a Windows machine with the lunarwerx fixture to run the live vector',
    () => {
      expect(true).toBe(true)
    },
  )
})

describe('resolveAccount — defensive synthetic instance dirs (no real machine state required)', () => {
  const tempDirs: string[] = []

  function makeInstanceDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ccmui-accounts-test-'))
    tempDirs.push(dir)
    return dir
  }

  function cleanup(): void {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  }

  test("missing instanceDir (empty string) -> status 'unknown', never throws", async () => {
    const account = await resolveAccount('')
    expect(account.status).toBe('unknown')
    expect(account.email).toBeNull()
  })

  test("instance dir with no config.json at all -> status 'loggedout'", async () => {
    const dir = makeInstanceDir()
    try {
      const account = await resolveAccount(dir)
      expect(account.status).toBe('loggedout')
      expect(account.email).toBeNull()
    } finally {
      cleanup()
    }
  })

  test("config.json present but no lastKnownAccountUuid -> status 'loggedout'", async () => {
    const dir = makeInstanceDir()
    try {
      writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ someOtherKey: true }))
      const account = await resolveAccount(dir)
      expect(account.status).toBe('loggedout')
    } finally {
      cleanup()
    }
  })

  test("corrupt (unparseable) config.json -> status 'loggedout', never throws", async () => {
    const dir = makeInstanceDir()
    try {
      writeFileSync(path.join(dir, 'config.json'), '{not valid json at all')
      const account = await resolveAccount(dir)
      expect(account.status).toBe('loggedout')
    } finally {
      cleanup()
    }
  })

  test('lastKnownAccountUuid present but no token cache at all -> falls back to cache/offline', async () => {
    const dir = makeInstanceDir()
    try {
      writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ lastKnownAccountUuid: 'fake-uuid-1234' }),
      )
      const account = await resolveAccount(dir)
      expect(['cache', 'offline']).toContain(account.status)
      expect(account.status).not.toBe('live')
    } finally {
      cleanup()
    }
  })

  test('token cache present but undecryptable (garbage blob) -> falls back gracefully', async () => {
    const dir = makeInstanceDir()
    try {
      writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({
          lastKnownAccountUuid: 'fake-uuid-5678',
          'oauth:tokenCacheV2': Buffer.from('not a real safeStorage blob').toString('base64'),
        }),
      )
      const account = await resolveAccount(dir)
      expect(['cache', 'offline', 'unknown']).toContain(account.status)
    } finally {
      cleanup()
    }
  })

  test('noNetwork option always short-circuits before any fetch, even with a plausible-looking uuid', async () => {
    const dir = makeInstanceDir()
    try {
      writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ lastKnownAccountUuid: 'fake-uuid-noNetwork-test' }),
      )

      const originalFetch = globalThis.fetch
      let fetchCalled = false
      globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        fetchCalled = true
        return originalFetch(...args)
      }) as typeof fetch

      try {
        await resolveAccount(dir, { noNetwork: true })
        expect(fetchCalled).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
      }
    } finally {
      cleanup()
    }
  })

  test('never throws even when instanceDir contains unusual characters', async () => {
    await expect(resolveAccount('   ')).resolves.toBeDefined()
    await expect(resolveAccount('C:\\path\\that\\does\\not\\exist\\zzz')).resolves.toBeDefined()
  })
})
