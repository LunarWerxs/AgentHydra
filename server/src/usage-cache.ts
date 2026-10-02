// Lightweight on-disk access to the last known usage readings.
//
// Kept separate from usage.ts so Quick Instances can read colored usage chips without importing
// the live quota probe, token resolution, transcript helpers, or any database-backed services.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config'
import type { UsageSnapshot } from './types'

const USAGE_CACHE_PATH = join(DATA_DIR, 'usage-cache.json')
/** The readings of accounts that signed out, kept for the tables only (see dropCachedUsage). A file
 *  of its own so nothing that ranks accounts by room (fan_out's balance, CliMayte, the survey, all
 *  reading usage-cache.json) can mistake one for a live reading. */
const LAST_KNOWN_PATH = join(DATA_DIR, 'usage-last-known.json')
/** When each row's usage was last cleared from the tables (key -> ISO time; see clearUsageFromTables). */
const CLEARED_PATH = join(DATA_DIR, 'usage-cleared.json')
type UsageCache = Record<string, UsageSnapshot>

function readUsageCache(): UsageCache {
  try {
    const parsed = JSON.parse(readFileSync(USAGE_CACHE_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as UsageCache) : {}
  } catch {
    return {}
  }
}

/** The whole cache, keyed by caller key — used to bulk-hydrate instance lists on load. */
export function allCachedUsage(): UsageCache {
  return readUsageCache()
}

/** The last cached snapshot for `key`, or null if never checked. */
export function getCachedUsage(key: string): UsageSnapshot | null {
  return readUsageCache()[key] ?? null
}

function readLastKnown(): UsageCache {
  try {
    const parsed = JSON.parse(readFileSync(LAST_KNOWN_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as UsageCache) : {}
  } catch {
    return {}
  }
}

function writeLastKnown(all: UsageCache): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(LAST_KNOWN_PATH, JSON.stringify(all, null, 2))
}

/** Every kept reading of a signed-out account, each marked `signedOutAt`. For the tables only. */
export function lastKnownUsage(): UsageCache {
  return readLastKnown()
}

/**
 * Forget `key`'s reading — for when the thing it describes is gone (a deleted dispatch account) or
 * no longer signed in, so nothing ranks a dead account by a reading it no longer has.
 *
 * `keepLastKnown` (a sign-out): the reading moves to the last-known file instead of vanishing, so
 * the tables keep showing it, dimmed (owner, 2026-10-01: "don't clear the last usage stats when
 * they go yellow"; his 2026-09-07 rule cleared them, because a number we no longer know read as a
 * current one). Best-effort, like the write: an unremovable entry is stale data, never a wrong
 * live check.
 */
export function dropCachedUsage(key: string, opts: { keepLastKnown?: boolean } = {}): void {
  try {
    const cache = readUsageCache()
    if (!(key in cache)) return
    if (opts.keepLastKnown) {
      const kept = readLastKnown()
      kept[key] = { ...cache[key]!, signedOutAt: new Date().toISOString() }
      writeLastKnown(kept)
    }
    delete cache[key]
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(USAGE_CACHE_PATH, JSON.stringify(cache, null, 2))
  } catch {
    // Best-effort: a surviving entry is only ever read for a key nothing asks about anymore.
  }
}

/** Keep `snap` as `key`'s last-known reading when it has none: the history's last reading of an
 *  account that signed out before readings were kept (usage-history.ts lastSampleSnapshot). */
export function keepLastKnownIfMissing(key: string, snap: UsageSnapshot): void {
  try {
    const kept = readLastKnown()
    if (key in kept || key in readUsageCache()) return
    kept[key] = snap
    writeLastKnown(kept)
  } catch {
    // Best-effort: the row just keeps its dash.
  }
}

/** Every row whose usage was cleared from the tables, with when. */
export function usageClearedAt(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(CLEARED_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/**
 * Clear `keys`' usage from the tables (owner, 2026-10-02: "clear the like old 5hour and usage stats
 * in the ui", "not like delete the stats"). Nothing is deleted: the cache, the kept readings and the
 * history keep every number, and everything that ranks accounts (CliMayte, fan_out, the survey)
 * still reads them. The tables are served only readings taken after the clear, so the row shows a
 * dash until its next check. Returns the time the clear took effect.
 */
export function clearUsageFromTables(keys: readonly string[], at: Date = new Date()): string {
  const iso = at.toISOString()
  const cleared = usageClearedAt()
  for (const key of keys) cleared[key] = iso
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(CLEARED_PATH, JSON.stringify(cleared, null, 2))
  return iso
}

/** `snap`, unless its row's usage was cleared from the tables after it was taken. */
export function shownUsage(
  key: string,
  snap: UsageSnapshot | null,
  cleared: Record<string, string> = usageClearedAt(),
): UsageSnapshot | null {
  const at = cleared[key]
  if (!snap || !at) return snap
  return Date.parse(snap.capturedAt) > Date.parse(at) ? snap : null
}

/** The readings of `all` the tables may show (see shownUsage). */
export function shownUsageMap(
  all: UsageCache,
  cleared: Record<string, string> = usageClearedAt(),
): UsageCache {
  const shown: UsageCache = {}
  for (const [key, snap] of Object.entries(all))
    if (shownUsage(key, snap, cleared)) shown[key] = snap
  return shown
}

/** Store the latest snapshot for `key` (best-effort; a cache write must never fail a live check).
 *  A live reading supersedes a kept one: the account is signed in again. */
export function setCachedUsage(key: string, snap: UsageSnapshot): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const cache = readUsageCache()
    cache[key] = snap
    writeFileSync(USAGE_CACHE_PATH, JSON.stringify(cache, null, 2))
    const kept = readLastKnown()
    if (key in kept) {
      delete kept[key]
      writeLastKnown(kept)
    }
  } catch {
    // Best-effort: losing a cache write only means the next UI load lacks this snapshot's age.
  }
}
