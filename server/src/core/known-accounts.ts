// server/src/core/known-accounts.ts — who each Anthropic account uuid is, remembered for good.
//
// WHY THIS EXISTS BESIDE instances-cache.json. That cache is keyed by instance DIR and is deleted
// on purpose whenever the profile's login changes (the stale-login guard, a logout): an identity
// must never be shown against a profile it no longer describes. Correct for the row, but it meant
// the ONLY record of "account <uuid> is someone@example.com" vanished the moment the profile moved on, so
// nothing could say which account an instance had been signed into before (#75, 2026-09-28: the
// profile switched accounts and the row read "(unknown account)" with no trace of either).
//
// Keyed by ACCOUNT uuid instead, this store has nothing to go stale: a uuid names the same person
// whichever profile it is signed into. Nothing prunes it. Identity only — never a token.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { appDataDir, knownAccountsFile } from './paths'
import type { CMAccountCacheEntry } from './shared'

type KnownAccountsFile = Record<string, CMAccountCacheEntry>

/** The whole store, keyed by account uuid. Empty on any read failure; never throws. */
export function readKnownAccounts(): KnownAccountsFile {
  try {
    const file = knownAccountsFile()
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as KnownAccountsFile) : {}
  } catch {
    return {}
  }
}

const sameIdentity = (a: CMAccountCacheEntry, b: CMAccountCacheEntry) =>
  a.email === b.email &&
  a.name === b.name &&
  a.plan === b.plan &&
  a.rateLimitTier === b.rateLimitTier &&
  a.orgUuid === b.orgUuid &&
  a.orgName === b.orgName &&
  (a.orgType ?? null) === (b.orgType ?? null)

/**
 * Remember one resolved identity under its account uuid. Skips the write when nothing but the
 * timestamp changed, so the every-resolve call site costs a read, not a write. An entry older than
 * the stored one never overwrites it. Best-effort — never throws.
 */
export function rememberAccount(entry: CMAccountCacheEntry): void {
  try {
    if (!entry.uuid || !(entry.email || entry.name)) return
    const store = readKnownAccounts()
    const prev = store[entry.uuid]
    if (prev && (sameIdentity(prev, entry) || prev.resolvedAt > entry.resolvedAt)) return
    store[entry.uuid] = {
      email: entry.email ?? null,
      name: entry.name ?? null,
      plan: entry.plan ?? null,
      rateLimitTier: entry.rateLimitTier ?? null,
      uuid: entry.uuid,
      orgUuid: entry.orgUuid ?? null,
      orgName: entry.orgName ?? null,
      orgType: entry.orgType ?? null,
      resolvedAt: entry.resolvedAt,
    }
    const dir = appDataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = knownAccountsFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // A lost write heals on the next resolve of the same account.
  }
}
