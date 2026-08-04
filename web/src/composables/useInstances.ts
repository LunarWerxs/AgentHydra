// Instance data + actions, mirroring useData.ts's shape (module-scope singleton refs +
// a `guard` helper that swallows failures into `lastError` instead of throwing across a
// component boundary). "Instance account" = which Anthropic account a Claude Desktop
// *instance* is logged into — resolved lazily, never the sqlite `accounts` table.
import { ref } from 'vue'
import type { CMInstance } from '@/lib/api'
import * as api from '@/lib/api'
import { loginChanged } from '@/lib/instance-appearance'

const instances = ref<CMInstance[]>([])
const loading = ref(false)
const resolvingAccounts = ref(false)
const busyDirs = ref<Set<string>>(new Set())
const lastError = ref<string | null>(null)
// When each dir was last auto-resolved, so a poll tick doesn't re-hit one every 4 seconds.
// See autoResolveAccounts() for what actually gets retried and why.
const lastAutoResolveAt = new Map<string, number>()
/** How long before an instance with NO identity yet (logged out, offline, unreadable) is retried.
 *  Short, because the thing that changes it — signing the profile in — is something the user does
 *  in the next minute and then looks straight at this table to confirm. A retry is a local file
 *  read that finds no token and gives up, so this is close to free. */
const UNRESOLVED_RETRY_MS = 60_000
/** How long a RESOLVED identity is trusted before a background re-check. An account's email, name
 *  or plan can change without anything on disk changing (the user edits it at claude.ai), so the
 *  only way to notice is to ask again on a timer. Slow, because it costs one profile call per
 *  instance and the answer rarely changes. */
const RESOLVED_REFRESH_MS = 15 * 60_000
/** A re-login IS visible on disk — config.json's `lastKnownAccountUuid` stops matching the
 *  identity on screen (see CMInstance.loginUuid) — so that case doesn't wait for the slow timer.
 *  Still throttled, so a mismatch that somehow persists can't turn the 4s poll into a profile-API
 *  hammer. */
const LOGIN_CHANGED_RETRY_MS = 30_000

function guard<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch((e) => {
    lastError.value = e instanceof Error ? e.message : String(e)
    return undefined
  })
}

function setBusy(dir: string, busy: boolean) {
  const next = new Set(busyDirs.value)
  if (busy) next.add(dir)
  else next.delete(dir)
  busyDirs.value = next
}

function upsert(next: CMInstance) {
  const idx = instances.value.findIndex((i) => i.dir === next.dir)
  if (idx === -1) {
    instances.value = [...instances.value, next]
  } else {
    const copy = instances.value.slice()
    copy[idx] = { ...copy[idx], ...next }
    instances.value = copy
  }
}

/** Reload the instance list. `silent` (used by the 4s background poll) skips the `loading`
 *  toggle so the toolbar Refresh icon only spins on a first load or a user-initiated refresh —
 *  not every poll tick, which reads as a distracting constant spinner. `force` re-resolves every
 *  account from scratch (the toolbar Refresh button), rather than only the ones still unknown. */
async function refreshInstances(opts: { silent?: boolean; force?: boolean } = {}) {
  if (!opts.silent) loading.value = true
  const r = await guard(api.listInstances())
  if (r) {
    // Preserve any account identity we've already resolved: the /api/instances list omits it
    // (account is null there), so a naive replace would wipe resolved emails on every poll.
    // Exception: an identity that no longer matches the instance's current login is dropped
    // instead of carried — a blank cell for the tick it takes to re-resolve beats the previous
    // account's email.
    const prev = new Map(instances.value.map((i) => [i.dir, i.account]))
    instances.value = r.map((i) => {
      if (i.account != null) return i
      const carried = prev.get(i.dir) ?? null
      if (!carried) return i
      const next = { ...i, account: carried }
      return loginChanged(next) ? i : next
    })
  }
  if (!opts.silent) loading.value = false
  void autoResolveAccounts({ force: opts.force })
}

/**
 * Resolve the account identity of every instance that doesn't have one yet. Silent (no toasts,
 * and no busy flag — see resolveAccount), driven off every list load and poll tick.
 *
 * There is no manual "Resolve" action anymore, and nothing here is limited to RUNNING instances:
 * resolving reads config.json and the token cache straight off disk (see core/accounts.ts), so a
 * stopped instance resolves exactly as well as a running one. Gating it on `isRunning` only meant
 * a stopped instance sat there showing a button that resolved it on the first click, every time —
 * which is a chore, not a choice.
 *
 * What gets retried: an instance with NO identity (logged out / offline / unreadable) is re-tried
 * every UNRESOLVED_RETRY_MS, so signing one in shows up on its own. A RESOLVED identity is not
 * final either — the account behind an instance can change under us, so it is re-checked every
 * RESOLVED_REFRESH_MS, and much sooner (LOGIN_CHANGED_RETRY_MS) when the instance's on-disk login
 * uuid stops matching the identity on screen. Refresh (`force`) still re-resolves everything now.
 */
async function autoResolveAccounts(opts: { force?: boolean } = {}): Promise<void> {
  if (resolvingAccounts.value) return
  const now = Date.now()
  const stale = instances.value.filter((i) => {
    if (opts.force) return true
    const last = lastAutoResolveAt.get(i.dir)
    const age = last === undefined ? Number.POSITIVE_INFINITY : now - last
    // No identity yet (signed out / offline / unreadable) — retry on the short timer.
    if (!i.account?.email && !i.account?.name) return age >= UNRESOLVED_RETRY_MS
    // Signed into a different account than the one on screen — re-resolve promptly.
    if (loginChanged(i)) return age >= LOGIN_CHANGED_RETRY_MS
    // Known identity, same account: re-check occasionally in case the email/name/plan changed.
    return age >= RESOLVED_REFRESH_MS
  })
  if (stale.length === 0) return

  resolvingAccounts.value = true
  try {
    for (const inst of stale) {
      lastAutoResolveAt.set(inst.dir, Date.now())
      await resolveAccount(inst.dir)
    }
  } finally {
    resolvingAccounts.value = false
  }
}

let pollTimer: number | null = null

function startPolling() {
  if (pollTimer !== null) return
  refreshInstances()
  // Background ticks are silent (no `loading` toggle) — see refreshInstances().
  pollTimer = window.setInterval(() => refreshInstances({ silent: true }), 4000)
}

function stopPolling() {
  if (pollTimer !== null) window.clearInterval(pollTimer)
  pollTimer = null
}

/** Launch (open) an instance. Returns the action result (or undefined on hard failure) so
 *  the caller can surface the server's failure message (e.g. the MSIX-only explanation). */
async function open(dir: string): Promise<api.CMActionResult | undefined> {
  setBusy(dir, true)
  try {
    const result = await guard(api.openInstance(dir))
    if (result?.ok) await refreshInstances()
    return result
  } finally {
    setBusy(dir, false)
  }
}

/** Quit a running instance. Returns true on success. Quitting the External (default, non-isolated)
 *  Claude Desktop needs `confirmExternal: true` — the server refuses it otherwise, and the UI only
 *  passes it from an explicit confirmation dialog. */
async function quit(dir: string, opts: { confirmExternal?: boolean } = {}): Promise<boolean> {
  setBusy(dir, true)
  try {
    const result = await guard(api.quitInstance(dir, opts))
    if (result?.ok) await refreshInstances()
    return result?.ok ?? false
  } finally {
    setBusy(dir, false)
  }
}

/** Bring a running instance's window to the foreground (Windows only). Returns the action
 *  result (or undefined on hard failure) so the caller can surface the server's failure
 *  message (e.g. "not running", "no window found"). No instance state changes, so this
 *  doesn't trigger a refresh. */
async function focus(dir: string): Promise<api.CMActionResult | undefined> {
  setBusy(dir, true)
  try {
    return await guard(api.focusInstance(dir))
  } finally {
    setBusy(dir, false)
  }
}

/** Reveal an instance's profile folder in the OS file browser. */
async function revealFolder(dir: string): Promise<api.CMActionResult | undefined> {
  return await guard(api.revealInstanceFolder(dir))
}

/** Create a desktop launcher that opens this instance directly. Returns the action result (or
 *  undefined on hard failure) so the caller can surface the server's message (e.g. the MSIX-only
 *  explanation, or the path it landed at). No instance state changes, so no refresh. */
async function createShortcut(dir: string): Promise<api.CMActionResult | undefined> {
  setBusy(dir, true)
  try {
    return await guard(api.createInstanceShortcut(dir))
  } finally {
    setBusy(dir, false)
  }
}

/** Create a new isolated instance. Returns the action result (or null on hard failure)
 *  so the caller can surface `needsBrowserDance`. */
async function create(name: string): Promise<api.CMActionResult | undefined> {
  const result = await guard(api.createInstance(name))
  if (result?.ok) await refreshInstances()
  return result
}

/** Delete an instance (guarded server-side; confirmName must match exactly). */
async function remove(dir: string, confirmName: string): Promise<api.CMActionResult | undefined> {
  setBusy(dir, true)
  try {
    const result = await guard(api.deleteInstance(dir, confirmName))
    if (result?.ok) await refreshInstances()
    return result
  } finally {
    setBusy(dir, false)
  }
}

/** Update an instance's UI metadata: display label (a pure relabel that never touches the
 *  on-disk folder, so it works while the instance is running), icon glyph, and icon color.
 *  The dir is unchanged, so the row re-keys in place on refresh. */
async function setAppearance(
  dir: string,
  patch: {
    label?: string | null
    icon?: api.InstanceIconKey | null
    color?: api.InstanceColorKey | null
  },
): Promise<api.CMActionResult | undefined> {
  setBusy(dir, true)
  try {
    const result = await guard(api.setInstanceMeta(dir, patch))
    if (result?.ok) await refreshInstances()
    return result
  } finally {
    setBusy(dir, false)
  }
}

/** Resolve (or re-resolve) the account identity for one instance and merge it in.
 *
 *  Deliberately does NOT set the row busy: this runs unattended now (see autoResolveAccounts),
 *  and busy disables the row's buttons — so flagging it would make Open/Focus flicker
 *  un-clickable every time a background resolve happened to be in flight. Resolving reads a file
 *  and asks Anthropic who this token belongs to; it changes nothing about the instance, so there
 *  is nothing for a busy flag to protect. */
async function resolveAccount(dir: string, noNetwork = false): Promise<boolean> {
  const account = await guard(api.getInstanceAccount(dir, { noNetwork }))
  if (account === undefined) return false
  const existing = instances.value.find((i) => i.dir === dir)
  if (existing) upsert({ ...existing, account })
  return true
}

export function useInstances() {
  return {
    instances,
    loading,
    resolvingAccounts,
    busyDirs,
    lastError,
    refreshInstances,
    startPolling,
    stopPolling,
    open,
    quit,
    focus,
    revealFolder,
    createShortcut,
    create,
    remove,
    setAppearance,
    resolveAccount,
  }
}
