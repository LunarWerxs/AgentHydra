// server/src/usage-service.ts — the db↔usage bridge AND the single place the fallback chains live.
//
// usage.ts stays db-free (pure probe + parse, so the web app's type-only import path never pulls
// bun:sqlite). This layer knows about the three credential stores and decides which to try:
//
//   dispatch account   sqlite `accounts` table          (a token the user pasted in)
//   desktop instance   Electron safeStorage config.json  (core/accounts resolveInstanceToken)
//   CLI instance       <CLAUDE_CONFIG_DIR>/.credentials.json (core/accounts resolveCliConfigDirToken)
//
// The KEY IDEA behind the fallbacks: a desktop instance and a CLI instance that the user has LINKED
// (CliInstance.associatedDesktopDir) are the same Anthropic account with two logins. So either one's
// credential can answer "what is this account's quota?" — if the desktop token is expired or
// unreadable, the linked CLI login is a perfectly good backup, and vice versa. That is what makes a
// "—" much rarer than it used to be.
//
// Every check goes through checkUsage, which itself prefers the fast direct-API read and only falls
// back to spawning `claude` (see usage.ts). Callers get a snapshot plus a `reason` explaining a
// no-data result, so the UI never has to render a bare "—" with no explanation.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAccount, resolveCliConfigDirToken, resolveInstanceToken } from './core/accounts'
import { cliInstanceForDesktop, getCliInstance, listCliInstances } from './core/cli-instances'
import { listInstances } from './core/instances'
import { normalizeInstancePath } from './core/paths'
import { db } from './db'
import { noteUsageSnapshot } from './reset-watch'
import type { AuthType, UsageCheckResult, UsageReason, UsageSnapshot } from './types'
import {
  checkUsage,
  isNoData,
  parseUsageOutput,
  setCachedUsage,
  type UsageAuth,
  usageAdvice,
} from './usage'
import { recordUsageSample } from './usage-history'

/** The credential + label for a dispatch account, or null if the id is unknown. */
export function accountAuth(accountId: string): { auth: UsageAuth; label: string } | null {
  const row = db
    .query<{ label: string; auth_type: string; secret: string }, [string]>(
      'select label, auth_type, secret from accounts where id = ?',
    )
    .get(accountId)
  if (!row) return null
  return { auth: { authType: row.auth_type as AuthType, secret: row.secret }, label: row.label }
}

/** Desktop instances authenticate via safeStorage (not the dispatch `accounts` table); match on the
 *  resolved email appearing in a dispatch account's free-text label (e.g. "Michael <x@y.com>"). */
export function findDispatchAccountByEmail(email: string): { id: string; label: string } | null {
  const needle = email.toLowerCase()
  const rows = db.query<{ id: string; label: string }, []>('select id, label from accounts').all()
  return rows.find((r) => r.label.toLowerCase().includes(needle)) ?? null
}

/**
 * Check one registered dispatch account's usage (env-token injection — no CLI login needed) and
 * cache the snapshot under `acct:<id>`. Returns an all-null snapshot if the account is unknown
 * (callers treat that as "no data", never "0%").
 */
export async function checkUsageForAccount(accountId: string): Promise<UsageSnapshot> {
  const resolved = accountAuth(accountId)
  const snap = await checkUsage({
    account: resolved?.label ?? null,
    auth: resolved?.auth,
  })
  setCachedUsage(`acct:${accountId}`, snap)
  return snap
}

/** Where a plain `claude` login (no CLAUDE_CONFIG_DIR override) keeps its credentials. */
const ambientConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

/**
 * Check the AMBIENT login's usage — the credential a run with no dispatch account uses.
 *
 * "Ambient" is the default for every run (the `accounts` table is empty until someone deliberately
 * pastes a token in), and it is a perfectly ordinary readable credential: the CLI keeps its token in
 * plain JSON at <config dir>/.credentials.json, which is the same source `check_my_usage` already
 * reads (mcp.ts). Nothing about a null account_id means "unknowable quota" — it only meant that to
 * anything routing through checkUsageForAccount, whose `where id = ?` can never match a null id.
 */
export async function checkUsageAmbient(): Promise<UsageSnapshot> {
  const configDir = ambientConfigDir()
  const snap = await checkUsage({ configDir, account: configDir })
  setCachedUsage(`dir:${configDir}`, snap)
  return snap
}

// --- desktop instances --------------------------------------------------------

/**
 * Cache key for a desktop instance's usage snapshot.
 *
 * Normalized, because the same instance reaches this from several call sites spelling its directory
 * differently — `C:\Users\…`, `c:\users\…`, `C:/Users/…` all name one folder on Windows. Keyed raw,
 * each spelling opened its OWN cache entry: the live cache held three separate rows for 3claude,
 * two for 5claude, and readings taken under one spelling were invisible to a lookup using another,
 * so a perfectly warm cache still missed and re-ran the check.
 *
 * Purely internal: the web client keys its own reactive map off the dir it already has and never
 * reads this string, so normalizing here cannot desync the UI. Pre-existing rows under the old
 * spellings are simply never read again.
 */
export const desktopKey = (dir: string): string => `desktop:${normalizeInstancePath(dir)}`
/** Cache key for a CLI instance's usage snapshot. */
export const cliKey = (id: string): string => `cli:${id}`
/** Cache key for a Codex instance's usage snapshot. Keyed by the instance id, like cliKey — a
 *  CODEX_HOME is created by this app and never renamed, so there is no path-spelling problem to
 *  normalize away here. */
export const codexKey = (id: string): string => `codex:${id}`

/**
 * Check a DESKTOP instance's usage, trying every credential that could speak for this account:
 *
 *   1. the instance's OWN safeStorage token          (the common case — no extra setup at all)
 *   2. the LINKED CLI instance's login               (the backup: same account, second auth store)
 *   3. a dispatch account whose label carries its email
 *
 * Falls through on a no-data result, not just on a missing credential — a token that exists but is
 * rejected (expired, wrong grant) should still let the backup answer. Returns an honest no-data
 * snapshot with a `reason` if nothing works; never fabricates "0% used".
 */
export async function checkUsageForDesktop(dir: string): Promise<UsageCheckResult> {
  const key = desktopKey(dir)
  const account = await resolveAccount(dir, { noNetwork: true })
  const label = account?.label ?? account?.email ?? null

  const finish = (snapshot: UsageSnapshot): UsageCheckResult => {
    setCachedUsage(key, snapshot)
    // Every real reading feeds the time series. This is what lets a later call differentiate the
    // percentage into a burn rate (see usage-history.ts) — without it, "98%" stays uninterpretable.
    recordUsageSample(key, snapshot)
    // …and the reset watcher, which compares this reading's window against the last one and raises
    // a notification when one has rolled over. Fire-and-forget: a notification must never delay (or
    // fail) the usage check that produced it.
    void noteUsageSnapshot(key, label ?? dir, snapshot).catch((err) =>
      console.error('[usage-service] reset-watch note failed:', err),
    )
    return { snapshot, cached: false, key, reason: 'ok', advice: usageAdvice(snapshot) }
  }

  // 1) The instance's own token. The grant's SCOPES ride along: if we end up on the CLI-spawn
  //    fallback, `claude` needs CLAUDE_CODE_OAUTH_SCOPES beside the token or `/usage` silently
  //    returns no numbers (see DEFAULT_OAUTH_SCOPES in usage.ts).
  const grant = await resolveInstanceToken(dir)
  if (grant) {
    const snap = await checkUsage({
      account: label,
      auth: { authType: 'oauth_token', secret: grant.token, scopes: grant.scopes },
    })
    if (!isNoData(snap)) return finish(snap)
  }

  // 2) The linked CLI instance — same account, an independent login that may still be valid.
  const linkedCli = cliInstanceForDesktop(dir)
  if (linkedCli?.loggedIn) {
    const snap = await checkUsage({ configDir: linkedCli.configDir, account: label })
    if (!isNoData(snap)) return finish(snap)
  }

  // 3) A registered dispatch account whose label carries this instance's email.
  const email = account?.email ?? null
  const match = email ? findDispatchAccountByEmail(email) : null
  if (match) {
    const snap = await checkUsageForAccount(match.id)
    if (!isNoData(snap)) return finish(snap)
  }

  // Nothing worked → honest no-data with an actionable reason. NEVER cached: a "—" is the absence of
  // a reading, not a reading, and caching it would hide a later successful check behind it.
  const reason: UsageReason =
    account?.status === 'loggedout' ? 'logged_out' : grant ? 'check_failed' : 'no_token'
  const snapshot = parseUsageOutput('', label)
  return { snapshot, cached: false, key, reason, advice: usageAdvice(snapshot) }
}

// --- CLI instances ------------------------------------------------------------

/**
 * Check a CLI instance's usage, mirroring the desktop chain in reverse:
 *
 *   1. its OWN `/login` in the config dir      (its actual identity — try this first)
 *   2. an associated dispatch account
 *   3. the LINKED desktop instance's token     (the backup: same account, second auth store)
 */
export async function checkUsageForCliInstance(id: string): Promise<UsageCheckResult | null> {
  const inst = getCliInstance(id)
  if (!inst) return null
  const key = cliKey(id)

  const finish = (snapshot: UsageSnapshot): UsageCheckResult => {
    setCachedUsage(key, snapshot)
    // Every real reading feeds the time series. This is what lets a later call differentiate the
    // percentage into a burn rate (see usage-history.ts) — without it, "98%" stays uninterpretable.
    recordUsageSample(key, snapshot)
    void noteUsageSnapshot(key, inst.name, snapshot).catch((err) =>
      console.error('[usage-service] reset-watch note failed:', err),
    )
    return { snapshot, cached: false, key, reason: 'ok', advice: usageAdvice(snapshot) }
  }

  // 1) Its own login: `.credentials.json` gives a usage-capable token directly (fast API path).
  if (inst.loggedIn) {
    const snap = await checkUsage({ configDir: inst.configDir, account: inst.name })
    if (!isNoData(snap)) return finish(snap)
  }

  // 2) An explicitly associated dispatch account.
  if (inst.associatedAccountId) {
    const snap = await checkUsageForAccount(inst.associatedAccountId)
    if (!isNoData(snap)) return finish(snap)
  }

  // 3) The linked desktop instance's token — same account, second auth store.
  if (inst.associatedDesktopDir) {
    const grant = await resolveInstanceToken(inst.associatedDesktopDir)
    if (grant) {
      const snap = await checkUsage({
        account: inst.name,
        auth: { authType: 'oauth_token', secret: grant.token, scopes: grant.scopes },
      })
      if (!isNoData(snap)) return finish(snap)
    }
  }

  const hasAnyCredential =
    inst.loggedIn || !!inst.associatedAccountId || !!inst.associatedDesktopDir
  const snapshot = parseUsageOutput('', inst.name)
  return {
    snapshot,
    cached: false,
    key,
    reason: hasAnyCredential ? 'check_failed' : 'not_logged_in',
    advice: usageAdvice(snapshot),
  }
}

// --- survey every instance ----------------------------------------------------

/** One row of the whole-fleet usage survey. */
export interface UsageSurveyRow {
  kind: 'desktop' | 'cli'
  /** Desktop dir or CLI instance id — the handle to re-check this one. */
  id: string
  label: string
  result: UsageCheckResult
}

/**
 * Whether an instance can be checked at all, WITHOUT spawning anything. The auto-refresh sweep uses
 * this to skip logged-out instances instead of firing doomed probes at them every interval.
 */
export async function desktopIsCheckable(dir: string): Promise<boolean> {
  if (await resolveInstanceToken(dir)) return true
  const linked = cliInstanceForDesktop(dir)
  if (linked?.loggedIn && resolveCliConfigDirToken(linked.configDir)) return true
  const account = await resolveAccount(dir, { noNetwork: true })
  return !!(account?.email && findDispatchAccountByEmail(account.email))
}

/**
 * Check every desktop + CLI instance that has a usable credential, concurrently.
 *
 * Concurrent is right here, not reckless: on the fast path each check is a single ~300ms HTTPS GET
 * against a quota endpoint that is NOT rate-limited and consumes NO inference quota. (Before the
 * direct-API path existed this would have spawned N copies of a 250 MB binary, which is exactly why
 * the old code refused to do it.)
 */
export async function surveyUsage(): Promise<UsageSurveyRow[]> {
  const desktops = await listInstances()
  const clis = listCliInstances()

  const desktopRows = desktops.map(async (inst): Promise<UsageSurveyRow | null> => {
    if (!(await desktopIsCheckable(inst.dir))) return null
    return {
      kind: 'desktop',
      id: inst.dir,
      label: inst.label ?? inst.name,
      result: await checkUsageForDesktop(inst.dir),
    }
  })

  const cliRows = clis.map(async (inst): Promise<UsageSurveyRow | null> => {
    if (!inst.loggedIn && !inst.associatedAccountId && !inst.associatedDesktopDir) return null
    const result = await checkUsageForCliInstance(inst.id)
    return result ? { kind: 'cli', id: inst.id, label: inst.name, result } : null
  })

  const rows = await Promise.all([...desktopRows, ...cliRows])
  return rows.filter((r): r is UsageSurveyRow => r !== null)
}
