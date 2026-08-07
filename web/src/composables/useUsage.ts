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
import type { UsageReason } from '@/lib/usage'

const snapshots = ref<Map<string, UsageSnapshot>>(new Map())
/** ISO time of the server's last background auto-refresh sweep, or null. */
const lastAutoRefreshAt = ref<string | null>(null)
// Why each cached snapshot has the value it does (esp. why a no-data one is empty), keyed the
// same way as `snapshots` above. See lib/usage.ts's UsageReason / usageReasonMessageKey.
const reasons = ref<Map<string, UsageReason>>(new Map())
const checking = ref<Set<string>>(new Set())
const hydrated = ref(false)
const lastError = ref<string | null>(null)

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
 *  `lastUsageCheck` field, or another composable that performed the check itself). */
function setSnapshot(key: string, snap: UsageSnapshot) {
  const next = new Map(snapshots.value)
  next.set(key, snap)
  snapshots.value = next
}

/** Push a check's `reason` into the shared cache under the same key its snapshot landed under. */
function setReason(key: string, reason: UsageReason) {
  const next = new Map(reasons.value)
  next.set(key, reason)
  reasons.value = next
}

/** Bulk-hydrate from the server's whole usage cache (a plain read of cached snapshots — it checks
 *  nothing). Safe to call more than once; a later call just re-syncs. */
async function hydrate(): Promise<void> {
  const res = await guard(api.getUsageCache())
  if (res) {
    const next = new Map(snapshots.value)
    for (const [key, snap] of Object.entries(res.cache)) next.set(key, snap)
    snapshots.value = next
    lastAutoRefreshAt.value = res.lastAutoRefreshAt
  }
  hydrated.value = true
}

// --- keeping the numbers current -----------------------------------------------------------------
// The server re-checks quota on its own schedule (usage-refresh.ts, every 15 min by default), but
// that only writes to ITS cache — until something pulls, an open Instances tab keeps showing
// whatever it hydrated on mount and quietly goes stale for as long as you leave it open.
//
// So pull on the same cycle the instances table already refreshes on. hydrate() is a read of the
// server's cache: no probe, no `claude`, no request to Anthropic, no quota — one localhost GET of a
// small JSON file. It costs nothing, so there is no reason to do it only once and hope.

/** Matches useInstances.ts's list poll — the Instances screen refreshes as one thing. */
const HYDRATE_INTERVAL_MS = 4000

let pollTimer: number | null = null

function startPolling(): void {
  if (pollTimer !== null) return
  void hydrate()
  pollTimer = window.setInterval(() => void hydrate(), HYDRATE_INTERVAL_MS)
}

function stopPolling(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer)
  pollTimer = null
}

function snapshotFor(key: string): UsageSnapshot | undefined {
  return snapshots.value.get(key)
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
    startPolling,
    stopPolling,
    snapshotFor,
    reasonFor,
    isChecking,
    setSnapshot,
    checkAccount,
    checkDesktop,
    checkCli,
    checkCodex,
  }
}
