// Usage-check singleton: a reactive cache of the latest UsageSnapshot per server key
// (`acct:<id>`, `cli:<id>`; desktop instances use a client-side `desktop:<dir>` convention
// key since the server itself folds a matched desktop instance's check into its resolved
// dispatch account's `acct:<id>` cache entry, see server/src/index.ts's
// `/api/instances/:dir/usage` route). Mirrors useInstances.ts's module-singleton shape:
// module-level refs, a `guard` helper, and action wrappers.
//
// Checks are CHEAP now: the server reads the same quota endpoint the CLI's `/usage` screen reads
// (~300ms, no `claude` process, and reading quota does not consume quota). So the old "only ever on
// explicit user action" rule is gone — the server auto-refreshes in the background by default, and
// checking several instances at once is fine.
import { ref } from 'vue'
import type { UsageSnapshot } from '@/lib/api'
import * as api from '@/lib/api'
import { reconcileMap, sameData } from '@/lib/reconcile'
import { isNoDataSnap, type UsageReason } from '@/lib/usage'

const snapshots = ref<Map<string, UsageSnapshot>>(new Map())
/** A signed-out account's last reading (server usage-cache.ts lastKnownUsage), shown in its row
 *  dimmed until it signs in again (owner, 2026-10-01: "don't clear the last usage stats when they
 *  go yellow"). A live reading for the key always wins. */
const lastKnown = ref<Map<string, UsageSnapshot>>(new Map())
/** When each row's usage was cleared in this window (ms; see clearUsage). The server already stops
 *  serving those readings, but the maps above only ever merge: a poll in flight at the click, or a
 *  CLI list carrying the reading, would put it back until a reload. */
const clearedAt = ref<Map<string, number>>(new Map())
/** ISO time of the server's last background auto-refresh sweep, or null. */
const lastAutoRefreshAt = ref<string | null>(null)
// Why each cached snapshot has the value it does (esp. why a no-data one is empty), keyed the
// same way as `snapshots` above. See lib/usage.ts's UsageReason / usageReasonMessageKey.
const reasons = ref<Map<string, UsageReason>>(new Map())
const checking = ref<Set<string>>(new Set())
const hydrated = ref(false)
const lastError = ref<string | null>(null)
/** JSON text of the last usage cache hydrate() fetched; a poll tick that matches it writes nothing. */
let lastHydrateText: string | null = null

function guard<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch((e) => {
    lastError.value = e instanceof Error ? e.message : String(e)
    return undefined
  })
}

function setChecking(key: string, active: boolean) {
  const next = new Set(checking.value)
  if (active) next.add(key)
  else next.delete(key)
  checking.value = next
}

/** Push an already-fetched snapshot into the shared cache (e.g. from a CliInstance's own
 *  `lastUsageCheck` field, or another composable that performed the check itself). An equal
 *  snapshot changes nothing, so re-seeding on every poll redraws nothing. */
function setSnapshot(key: string, snap: UsageSnapshot) {
  if (sameData(snapshots.value.get(key), snap)) return
  const next = new Map(snapshots.value)
  next.set(key, snap)
  snapshots.value = next
}

/** Push a check's `reason` into the shared cache under the same key its snapshot landed under. */
function setReason(key: string, reason: UsageReason) {
  if (sameData(reasons.value.get(key), reason)) return
  const next = new Map(reasons.value)
  next.set(key, reason)
  reasons.value = next
}

/** Bulk-hydrate from the server's whole usage cache (a plain read of cached snapshots — it checks
 *  nothing). Safe to call more than once; a later call just re-syncs, and an unchanged cache
 *  assigns nothing. */
let hydrating: Promise<void> | null = null
/** One read at a time: the CLI and desktop kinds both refresh it, and share a running request.
 *  `skipSame` (the background refresh) writes nothing when the cache is the one already read. */
function hydrate(skipSame = false): Promise<void> {
  // The cli and desktop kinds load 1.5s apart at startup: the second one reuses the read just made.
  if (!hydrating && skipSame && Date.now() - hydratedAt < HYDRATE_REUSE_MS) return Promise.resolve()
  return (hydrating ??= hydrateOnce(skipSame).finally(() => {
    hydratedAt = Date.now()
    hydrating = null
  }))
}
const HYDRATE_REUSE_MS = 5_000
let hydratedAt = 0

async function hydrateOnce(skipSame: boolean): Promise<void> {
  const res = await guard(api.getUsageCache())
  if (res) {
    const text = JSON.stringify(res)
    if (skipSame && text === lastHydrateText) {
      hydrated.value = true
      return
    }
    lastHydrateText = text
    snapshots.value = reconcileMap(snapshots.value, Object.entries(res.cache))
    lastKnown.value = reconcileMap(lastKnown.value, Object.entries(res.lastKnown ?? {}))
    if (lastAutoRefreshAt.value !== res.lastAutoRefreshAt)
      lastAutoRefreshAt.value = res.lastAutoRefreshAt
  }
  hydrated.value = true
}

// --- keeping the numbers current -----------------------------------------------------------------
// hydrate() is a read of the server's cache (no probe, no `claude`, no quota). It is refreshed by
// lib/warm-data.ts (the cli and desktop kinds, about every 2 minutes) and when a page opens.

/** `snap`, unless its row's usage was cleared after it was taken. */
function shown(key: string, snap: UsageSnapshot | undefined): UsageSnapshot | undefined {
  const at = clearedAt.value.get(key)
  return snap && at !== undefined && Date.parse(snap.capturedAt) <= at ? undefined : snap
}

function snapshotFor(key: string): UsageSnapshot | undefined {
  const live = shown(key, snapshots.value.get(key))
  // A signed-out check answers an empty snapshot, which must not hide the kept reading.
  if (live && !isNoDataSnap(live)) return live
  return shown(key, lastKnown.value.get(key)) ?? live
}

/** Clear rows' usage from the tables (owner, 2026-10-02): each shows a dash until its next reading.
 *  Nothing is deleted; the server keeps every number for whatever ranks accounts. */
async function clearUsage(keys: string[]): Promise<boolean> {
  const res = await guard(api.clearUsage(keys))
  if (!res?.ok) return false
  const at = Date.parse(res.clearedAt)
  const next = new Map(clearedAt.value)
  for (const key of keys) next.set(key, at)
  clearedAt.value = next
  return true
}

function reasonFor(key: string): UsageReason | undefined {
  return reasons.value.get(key)
}

function isChecking(key: string): boolean {
  return checking.value.has(key)
}

/** Check a registered dispatch account's usage (by id or label). Always forces a fresh probe. */
async function checkAccount(account: string, key: string): Promise<boolean> {
  setChecking(key, true)
  try {
    const result = await guard(api.checkAccountUsage(account, true))
    if (result) {
      setSnapshot(result.key, result.snapshot)
      setReason(result.key, result.reason ?? 'unknown')
    }
    return !!result
  } finally {
    setChecking(key, false)
  }
}

/** Check a desktop instance's usage. Stored under a client-side `desktop:<dir>` key
 *  regardless of what the server's response echoes back (it resolves to the matched
 *  dispatch account's `acct:<id>` cache entry server-side); the table looks up by dir,
 *  so this keeps the lookup deterministic from the frontend's point of view. */
async function checkDesktop(dir: string): Promise<boolean> {
  const key = `desktop:${dir}`
  setChecking(key, true)
  try {
    const result = await guard(api.checkDesktopInstanceUsage(dir, true))
    if (result) {
      setSnapshot(key, result.snapshot)
      setReason(key, result.reason ?? 'unknown')
    }
    return !!result
  } finally {
    setChecking(key, false)
  }
}

/** Check a CLI instance's usage (server key is genuinely `cli:<id>`). */
async function checkCli(id: string): Promise<boolean> {
  const key = `cli:${id}`
  setChecking(key, true)
  try {
    const result = await guard(api.checkCliInstanceUsage(id, true))
    if (result) {
      setSnapshot(result.key, result.snapshot)
      setReason(result.key, result.reason ?? 'unknown')
    }
    return !!result
  } finally {
    setChecking(key, false)
  }
}

/** Check a Codex instance's usage (server key is `codex:<id>`). One call on the server resolves the
 *  account AND its quota, so unlike the Claude paths there is no separate identity request. */
async function checkCodex(id: string): Promise<boolean> {
  const key = `codex:${id}`
  setChecking(key, true)
  try {
    const result = await guard(api.checkCodexInstanceUsage(id, true))
    if (result) {
      setSnapshot(result.key, result.snapshot)
      setReason(result.key, result.reason ?? 'unknown')
    }
    return !!result
  } finally {
    setChecking(key, false)
  }
}

export function useUsage() {
  return {
    snapshots,
    reasons,
    checking,
    hydrated,
    lastError,
    lastAutoRefreshAt,
    hydrate,
    snapshotFor,
    clearUsage,
    reasonFor,
    isChecking,
    setSnapshot,
    checkAccount,
    checkDesktop,
    checkCli,
    checkCodex,
  }
}
