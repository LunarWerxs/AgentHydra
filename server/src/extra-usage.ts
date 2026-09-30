// server/src/extra-usage.ts - never let work on this machine's Claude accounts bill paid extra usage.
//
// The owner's rule (2026-09-30): paid extra usage is never spent unless Settings -> "Allow paid extra
// usage" says so, and that is off by default. Some accounts have claude.ai "extra usage" switched on:
// past their 5-hour or weekly limit they keep answering and BILL, where every other account stops.
// His words on the fix: "just don't allow it to go over... I would forcibly terminate it."
//
//   1. Which accounts can bill: every usage reading carries `extraUsage` (the usage endpoint's
//      `extra_usage.is_enabled`, usage-api.ts); a desktop reading also has the app's usage credits.
//   2. The guard: on such an account, once it reaches the billing line (98% of the 5-hour window or
//      99% of the week, the same line Corch stops its own workers at), every Claude session running
//      on it is killed: desktop Code chats and CLI sessions alike, and again for any started after.
//      A chat is not lost - its transcript stays and it can carry on after the reset or on another
//      account (move_chat). Corch's workers are left to Corch, which stops and moves them itself.
//   3. Switching it off at the source: turnOffExtraUsage makes the call the CLI itself makes to
//      switch extra usage ON (PUT .../overage_spend_limit), with is_enabled false. Once it is off
//      the account simply stops at its limit, and the guard has nothing left to do there.
//
// ⛔ The one exception to the 30-minute ceiling on unattended usage checks (usage-refresh.ts): an
// account that CAN bill, with something running on it, is re-read more often as it nears the line
// (every 10 minutes, 5 from 60%, 1 from 85%). Otherwise a heavy chat could bill for most of half an
// hour before anyone looked. No other account is ever read for this.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { corchWorkerPids } from './corch'
import { BILL_GUARD_SESSION_PCT, BILL_GUARD_WEEK_PCT } from './corch-lib'
import { resolveAccount, resolveCliConfigDirToken, resolveInstanceTokens } from './core/accounts'
import { cliInstanceForDesktop, getCliInstance, listCliInstances } from './core/cli-instances'
import { listInstances } from './core/instances'
import { normalizeInstancePath } from './core/paths'
import { killProcessTree, listDesktopEngines } from './core/process'
import { deliverIncidentNotification, recordIncident } from './incidents'
import { readLiveRegistry } from './live-registry'
import { getProviderSettings } from './provider-settings'
import type { ExtraUsageOffResult, UsageLimit, UsageSnapshot } from './types'
import { getCachedUsage } from './usage'
import { claudeUserAgent } from './usage-api'
import { checkUsageForCliInstance, checkUsageForDesktop, cliKey, desktopKey } from './usage-service'

const TICK_MS = 30_000

/** Whether the owner allowed paid extra usage. Unreadable counts as not allowed. */
function allowed(): boolean {
  try {
    return getProviderSettings().allowExtraUsage === true
  } catch {
    return false
  }
}

/** Whether a reading says this account bills usage past its limits instead of stopping. */
export function billsPastLimit(snap: UsageSnapshot | null): boolean {
  return snap?.extraUsage === true || snap?.claudeApp?.usageCredits?.enabled === true
}

/** A window's percentage, with a window that has already reset counted as empty. */
function pctOf(limit: UsageLimit | null, now: number): number | null {
  if (!limit) return null
  const reset = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN
  return Number.isFinite(reset) && reset <= now ? 0 : limit.pct
}

/** Whether the next request could bill: the account is at 98% of its 5-hour window or 99% of its
 *  week (BILL_GUARD_*, the line Corch stops at). */
export function atBillingLine(snap: UsageSnapshot, now: number): boolean {
  const session = pctOf(snap.session, now)
  const week = pctOf(snap.weekAll, now)
  return (
    (session !== null && session >= BILL_GUARD_SESSION_PCT) ||
    (week !== null && week >= BILL_GUARD_WEEK_PCT)
  )
}

/** How old a reading of an account that can bill, with something running on it, may be before it
 *  is read again: the nearer either window is to its line, the sooner. */
export function recheckAfterMs(snap: UsageSnapshot, now: number): number {
  const gap = Math.min(
    BILL_GUARD_SESSION_PCT - (pctOf(snap.session, now) ?? 0),
    BILL_GUARD_WEEK_PCT - (pctOf(snap.weekAll, now) ?? 0),
  )
  if (gap <= 13) return 60_000
  if (gap <= 38) return 5 * 60_000
  return 10 * 60_000
}

/** One place a Claude account's sessions run: a desktop profile or a CLI login. */
interface Store {
  kind: 'desktop' | 'cli'
  /** Desktop profile dir, or CLI instance id. */
  id: string
  /** '#90 name', for the log and the incident. */
  label: string
  /** The usage cache key its readings are kept under. */
  key: string
  /** Desktop: whether the app is open (a closed app runs no chats). CLI: its config dir. */
  running: boolean
  configDir: string | null
}

async function stores(): Promise<Store[]> {
  const out: Store[] = []
  for (const inst of await listInstances()) {
    out.push({
      kind: 'desktop',
      id: inst.dir,
      label: `#${inst.num} ${inst.name}`,
      key: desktopKey(inst.dir),
      running: inst.pid !== null,
      configDir: null,
    })
  }
  for (const cli of listCliInstances()) {
    out.push({
      kind: 'cli',
      id: cli.id,
      label: `#${cli.num} ${cli.name}`,
      key: cliKey(cli.id),
      running: true,
      configDir: cli.configDir,
    })
  }
  return out
}

/** The sessions running on a store now, Corch's workers left out. Null when they could not be
 *  listed (never read as "none"). */
async function sessionsOn(store: Store, skip: Set<number>): Promise<number[] | null> {
  if (store.kind === 'cli') {
    if (!store.configDir) return []
    return readLiveRegistry(store.configDir)
      .map((s) => s.pid)
      .filter((pid) => !skip.has(pid))
  }
  if (!store.running) return []
  const engines = await listDesktopEngines()
  if (!engines) return null
  const dir = normalizeInstancePath(store.id)
  return engines
    .filter((e) => normalizeInstancePath(e.instanceDir) === dir && !skip.has(e.pid))
    .map((e) => e.pid)
}

async function reread(store: Store): Promise<UsageSnapshot | null> {
  const result =
    store.kind === 'desktop'
      ? await checkUsageForDesktop(store.id)
      : await checkUsageForCliInstance(store.id)
  return result?.reason === 'ok' ? result.snapshot : null
}

/** When each store was last read by the guard, so a failing read is not retried every tick. */
const lastRead = new Map<string, number>()

/** One pass: stop every session on an account that can bill and is at its line. Returns what it
 *  stopped. Cheap when nothing can bill: cached readings and no network. */
export async function guardExtraUsage(
  now = Date.now(),
): Promise<{ store: string; pids: number[] }[]> {
  if (allowed()) return []
  const stopped: { store: string; pids: number[] }[] = []
  const corch = corchWorkerPids()
  for (const store of await stores()) {
    try {
      let snap = getCachedUsage(store.key)
      if (!snap || !billsPastLimit(snap) || !store.running) continue
      let pids = await sessionsOn(store, corch)
      if (!pids?.length) continue
      const age = now - (Date.parse(snap.capturedAt) || 0)
      const wait = recheckAfterMs(snap, now)
      if (age > wait && now - (lastRead.get(store.key) ?? 0) > wait) {
        lastRead.set(store.key, now)
        const fresh = await reread(store)
        if (fresh) snap = fresh
        if (!billsPastLimit(snap)) continue
      }
      if (!atBillingLine(snap, Date.now())) continue
      // Listed again right before the kill: the reading may have taken a while.
      pids = await sessionsOn(store, corchWorkerPids())
      if (!pids?.length) continue
      for (const pid of pids) killProcessTree(pid)
      stopped.push({ store: store.label, pids })
      report(store, snap, pids.length)
    } catch (err) {
      console.error(`[extra-usage] guard failed on ${store.label}:`, err)
    }
  }
  return stopped
}

function report(store: Store, snap: UsageSnapshot, count: number): void {
  const session = pctOf(snap.session, Date.now())
  const week = pctOf(snap.weekAll, Date.now())
  const where =
    session !== null && session >= BILL_GUARD_SESSION_PCT
      ? `${session}% of its 5-hour window${snap.session?.resets ? ` (resets ${snap.session.resets})` : ''}`
      : `${week}% of its week${snap.weekAll?.resets ? ` (resets ${snap.weekAll.resets})` : ''}`
  const error =
    `Stopped ${count} Claude session${count === 1 ? '' : 's'} on ${store.label}: the account has ` +
    `paid extra usage switched on and reached ${where}, so its next request could have billed. ` +
    'The chats are kept: carry them on after the reset or move them to another account. ' +
    'To stop this for good, turn extra usage off for this account in AgentHydra.'
  console.log(`[extra-usage] ${error}`)
  void (async () => {
    try {
      const key = store.label
      const result = await recordIncident({ scope: 'extra-usage', key, error })
      await deliverIncidentNotification(result, { scope: 'extra-usage', key, error })
    } catch (err) {
      console.error('[extra-usage] incident recording failed:', err)
    }
  })()
}

let timer: ReturnType<typeof setInterval> | null = null
let guarding = false

/** Start the guard (daemon boot). Every 30 s; a pass never overlaps the last one. */
export function startExtraUsageGuard(): void {
  if (timer) return
  timer = setInterval(() => {
    if (guarding) return
    guarding = true
    void guardExtraUsage()
      .catch((err) => console.error('[extra-usage] guard pass failed:', err))
      .finally(() => {
        guarding = false
      })
  }, TICK_MS)
  timer.unref?.()
}

/** The org an OAuth login belongs to, from a CLI config dir's `.claude.json`. */
function cliOrgUuid(configDir: string): string | null {
  try {
    const path = join(configDir, '.claude.json')
    if (!existsSync(path)) return null
    const org = JSON.parse(readFileSync(path, 'utf8'))?.oauthAccount?.organizationUuid
    return typeof org === 'string' && org.trim() ? org.trim() : null
  } catch {
    return null
  }
}

/** A token and its org for one instance ref. A desktop profile prefers its linked CLI login: that
 *  is the kind of credential the CLI makes this same call with. Value-blind: the token goes
 *  straight into the request and nowhere else. */
async function credentialFor(ref: string): Promise<{ token: string; orgUuid: string } | null> {
  const fromCli = (configDir: string) => {
    const token = resolveCliConfigDirToken(configDir)?.token
    const orgUuid = cliOrgUuid(configDir)
    return token && orgUuid ? { token, orgUuid } : null
  }
  if (ref.startsWith('cli:')) {
    const inst = getCliInstance(ref.slice(4))
    if (!inst) return null
    return (
      (inst.loggedIn ? fromCli(inst.configDir) : null) ??
      (inst.associatedDesktopDir ? await fromDesktop(inst.associatedDesktopDir) : null)
    )
  }
  if (ref.startsWith('desktop:')) {
    const dir = ref.slice(8)
    const linked = cliInstanceForDesktop(dir)
    return (linked?.loggedIn ? fromCli(linked.configDir) : null) ?? (await fromDesktop(dir))
  }
  return null
}

async function fromDesktop(dir: string): Promise<{ token: string; orgUuid: string } | null> {
  const token = (await resolveInstanceTokens(dir))[0]?.token
  const orgUuid = (await resolveAccount(dir, { noNetwork: true }))?.orgUuid ?? null
  return token && orgUuid ? { token, orgUuid } : null
}

/**
 * Switch claude.ai extra usage OFF for one account ('desktop:<dir>' or 'cli:<id>'), so it stops at
 * its limits instead of billing. The same endpoint the CLI calls to switch it on (PUT
 * /api/oauth/organizations/<org>/overage_spend_limit, found in CLI 2.1.284), with is_enabled false.
 * The result is read back from a fresh usage reading, never assumed from the 200.
 */
export async function turnOffExtraUsage(ref: string): Promise<ExtraUsageOffResult> {
  const cred = await credentialFor(ref)
  if (!cred)
    return {
      ok: false,
      extraUsage: null,
      detail: 'no signed-in login with a known organization for this account',
    }
  let res: Response
  try {
    res = await fetch(
      `https://api.anthropic.com/api/oauth/organizations/${encodeURIComponent(cred.orgUuid)}/overage_spend_limit`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${cred.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          'x-organization-uuid': cred.orgUuid,
          'user-agent': claudeUserAgent(),
        },
        body: JSON.stringify({ is_enabled: false }),
        signal: AbortSignal.timeout(15_000),
      },
    )
  } catch (err) {
    return { ok: false, extraUsage: null, detail: err instanceof Error ? err.message : String(err) }
  }
  if (!res.ok) {
    let said = ''
    try {
      said = (await res.text()).trim().slice(0, 300)
    } catch {
      // The status still says enough.
    }
    return {
      ok: false,
      extraUsage: null,
      detail: `claude.ai refused: HTTP ${res.status}${said ? ` - ${said}` : ''}`,
    }
  }
  const store: Store | null = ref.startsWith('cli:')
    ? {
        kind: 'cli',
        id: ref.slice(4),
        label: ref,
        key: cliKey(ref.slice(4)),
        running: true,
        configDir: null,
      }
    : ref.startsWith('desktop:')
      ? {
          kind: 'desktop',
          id: ref.slice(8),
          label: ref,
          key: desktopKey(ref.slice(8)),
          running: true,
          configDir: null,
        }
      : null
  const after = store ? await reread(store) : null
  const extraUsage = after?.extraUsage ?? null
  return {
    ok: extraUsage === false,
    extraUsage,
    detail:
      extraUsage === false
        ? 'extra usage is off: this account now stops at its limits'
        : extraUsage === true
          ? 'claude.ai accepted the change but the account still reports extra usage on'
          : 'claude.ai accepted the change; the account could not be read back to confirm it',
  }
}
