// server/tests/accounts-stale-login.test.ts — the identity cache must never outlive the login it
// describes.
//
// instances-cache.json is keyed by instance DIR, but the identity inside it belongs to an ACCOUNT.
// Sign an instance out and back in as someone else and the dir is unchanged while every field in
// the entry (email, name, plan, org) now describes the previous account. Every offline path —
// noNetwork, expired token, undecryptable cache, profile API down — reads that entry, so without a
// guard the manager keeps displaying an email the instance has not been logged into for weeks.
// This was not hypothetical: on the machine this was written against, one instance's cache said
// kumjude09@gmail.com while its config.json had been re-signed into a different account uuid.
//
// The guard compares the cached `uuid` against config.json's `lastKnownAccountUuid` and, on a
// mismatch, discards AND purges the entry — no identity beats the wrong identity.
//
// CCMANAGERUI_HOME is redirected to a temp dir by tests/setup.ts, so writing the real cache file
// here is safe; every test still writes its own entries and asserts on its own dirs.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { resolveAccount } from '../src/core/accounts'
import { readLoginUuid } from '../src/core/instances'
import { accountsCacheFile, normalizeInstancePath } from '../src/core/paths'
import type { CMAccountCacheEntry } from '../src/core/shared'

const ACCOUNT_A = '11111111-aaaa-4aaa-8aaa-111111111111'
const ACCOUNT_B = '22222222-bbbb-4bbb-8bbb-222222222222'

let tmpDirs: string[] = []

/** A throwaway instance dir whose config.json is signed into `uuid` (or signed out when null).
 *  No token cache, so resolveAccount always takes the cache/offline path — exactly the path the
 *  guard protects, and one that never touches the network. */
function makeInstanceDir(uuid: string | null): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'cmui-stale-login-'))
  tmpDirs.push(dir)
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(uuid ? { lastKnownAccountUuid: uuid } : {}, null, 2),
  )
  return dir
}

function readCache(): Record<string, CMAccountCacheEntry> {
  const file = accountsCacheFile()
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, CMAccountCacheEntry>
}

/** Seed a resolved identity for `dir`, as a prior live resolve would have. */
function seedCache(dir: string, entry: Partial<CMAccountCacheEntry> & { uuid: string | null }) {
  const file = accountsCacheFile()
  const cache = readCache()
  cache[normalizeInstancePath(dir)] = {
    email: entry.email ?? 'seeded@example.com',
    name: entry.name ?? 'Seeded User',
    plan: entry.plan ?? 'max',
    rateLimitTier: entry.rateLimitTier ?? 'default_claude_max_20x',
    uuid: entry.uuid,
    orgUuid: entry.orgUuid ?? 'org-seeded',
    orgName: entry.orgName ?? 'Seeded Org',
    resolvedAt: entry.resolvedAt ?? new Date().toISOString(),
  }
  writeFileSync(file, JSON.stringify(cache, null, 2))
}

beforeEach(() => {
  tmpDirs = []
})

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup; a locked temp dir must not fail the suite.
    }
  }
})

describe('resolveAccount — stale-login guard on the identity cache', () => {
  test('a cached identity for the SAME account is still used', async () => {
    const dir = makeInstanceDir(ACCOUNT_A)
    seedCache(dir, { uuid: ACCOUNT_A, email: 'a@example.com', name: 'Account A' })

    const account = await resolveAccount(dir, { noNetwork: true })

    expect(account.email).toBe('a@example.com')
    expect(account.name).toBe('Account A')
    expect(account.status).toBe('cache')
    // Untouched — a matching entry must survive the read.
    expect(readCache()[normalizeInstancePath(dir)]?.email).toBe('a@example.com')
  })

  test('a cached identity for a DIFFERENT account is discarded, not displayed', async () => {
    const dir = makeInstanceDir(ACCOUNT_B) // re-signed into B...
    seedCache(dir, { uuid: ACCOUNT_A, email: 'a@example.com', name: 'Account A' }) // ...cache says A

    const account = await resolveAccount(dir, { noNetwork: true })

    expect(account.email).toBeNull()
    expect(account.name).toBeNull()
    // Nothing resolved rather than something wrong, and the uuid reported is the CURRENT login.
    expect(account.status).toBe('offline')
    expect(account.accountUuid).toBe(ACCOUNT_B)
    expect(account.label).not.toContain('a@example.com')
  })

  test('the stale entry is purged from disk, so it cannot come back', async () => {
    const dir = makeInstanceDir(ACCOUNT_B)
    seedCache(dir, { uuid: ACCOUNT_A, email: 'a@example.com' })

    await resolveAccount(dir, { noNetwork: true })

    expect(readCache()[normalizeInstancePath(dir)]).toBeUndefined()
  })

  test('purging one instance leaves every other instance’s identity intact', async () => {
    const staleDir = makeInstanceDir(ACCOUNT_B)
    const goodDir = makeInstanceDir(ACCOUNT_A)
    seedCache(staleDir, { uuid: ACCOUNT_A, email: 'a@example.com' })
    seedCache(goodDir, { uuid: ACCOUNT_A, email: 'a@example.com' })

    await resolveAccount(staleDir, { noNetwork: true })

    expect(readCache()[normalizeInstancePath(staleDir)]).toBeUndefined()
    expect(readCache()[normalizeInstancePath(goodDir)]?.email).toBe('a@example.com')
    // And the untouched instance still resolves from it.
    expect((await resolveAccount(goodDir, { noNetwork: true })).email).toBe('a@example.com')
  })

  test('a cache entry with no uuid is kept — unknown is not the same as mismatched', async () => {
    // Entries written before the uuid was recorded (or by a profile response missing it) must not
    // be thrown away wholesale; the guard fires only on a positive disagreement.
    const dir = makeInstanceDir(ACCOUNT_A)
    seedCache(dir, { uuid: null, email: 'legacy@example.com' })

    const account = await resolveAccount(dir, { noNetwork: true })

    expect(account.email).toBe('legacy@example.com')
    expect(readCache()[normalizeInstancePath(dir)]).toBeDefined()
  })

  test('a signed-out instance never consults the cache at all', async () => {
    const dir = makeInstanceDir(null) // config.json without lastKnownAccountUuid
    seedCache(dir, { uuid: ACCOUNT_A, email: 'a@example.com' })

    const account = await resolveAccount(dir, { noNetwork: true })

    expect(account.status).toBe('loggedout')
    expect(account.email).toBeNull()
  })
})

describe('readLoginUuid — which account an instance is signed into right now', () => {
  test('returns config.json’s lastKnownAccountUuid', () => {
    expect(readLoginUuid(makeInstanceDir(ACCOUNT_A))).toBe(ACCOUNT_A)
  })

  test('sees a re-login immediately (no caching between reads)', () => {
    const dir = makeInstanceDir(ACCOUNT_A)
    expect(readLoginUuid(dir)).toBe(ACCOUNT_A)
    // Same file, same byte length — a stat-keyed memo would miss this, which is why there isn't one.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ACCOUNT_B }))
    expect(readLoginUuid(dir)).toBe(ACCOUNT_B)
  })

  test('returns null for signed-out, missing, malformed and empty dirs (never throws)', () => {
    const signedOut = makeInstanceDir(null)
    expect(readLoginUuid(signedOut)).toBeNull()

    const malformed = mkdtempSync(join(os.tmpdir(), 'cmui-stale-login-'))
    tmpDirs.push(malformed)
    writeFileSync(join(malformed, 'config.json'), '{ not json')
    expect(readLoginUuid(malformed)).toBeNull()

    expect(readLoginUuid(join(os.tmpdir(), 'cmui-does-not-exist-zzz'))).toBeNull()
    expect(readLoginUuid('')).toBeNull()
    expect(readLoginUuid('   ')).toBeNull()
  })

  test('ignores a non-string lastKnownAccountUuid', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'cmui-stale-login-'))
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 12345 }))
    expect(readLoginUuid(dir)).toBeNull()
  })
})
