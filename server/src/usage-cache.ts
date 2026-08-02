// Lightweight on-disk access to the last known usage readings.
//
// Kept separate from usage.ts so Quick Instances can read colored usage chips without importing
// the live quota probe, token resolution, transcript helpers, or any database-backed services.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config'
import type { UsageSnapshot } from './types'

const USAGE_CACHE_PATH = join(DATA_DIR, 'usage-cache.json')
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

/** Forget `key` entirely — for when the thing it describes is gone (a deleted dispatch account),
 *  so the cache can't serve a reading for something that no longer exists. Best-effort, like the
 *  write: an unremovable entry is stale data, never a wrong live check. */
export function dropCachedUsage(key: string): void {
  try {
    const cache = readUsageCache()
    if (!(key in cache)) return
    delete cache[key]
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(USAGE_CACHE_PATH, JSON.stringify(cache, null, 2))
  } catch {
    // Best-effort: a surviving entry is only ever read for a key nothing asks about anymore.
  }
}

/** Store the latest snapshot for `key` (best-effort; a cache write must never fail a live check). */
export function setCachedUsage(key: string, snap: UsageSnapshot): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const cache = readUsageCache()
    cache[key] = snap
    writeFileSync(USAGE_CACHE_PATH, JSON.stringify(cache, null, 2))
  } catch {
    // Best-effort: losing a cache write only means the next UI load lacks this snapshot's age.
  }
}
