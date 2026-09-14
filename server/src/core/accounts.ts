// server/src/core/accounts.ts — instance-account identity resolution (PLAN.md §2).
// Adapted from an internal LunarWerx tool's instance-account resolver: imports DTOs/tier/
// constants from ./shared (local, no cross-repo import) instead of ../../../shared/index;
// the identity cache resolves via paths.ts's accountsCacheFile()/appDataDir(), which are
// now wired to THIS app's CONFIG_DIR (~/.agenthydra/instances-cache.json).
//
// Resolves which Anthropic account an isolated Claude Desktop **instance** is logged into —
// distinct from this app's own sqlite `accounts` table (Anthropic auth secrets for queue
// dispatch, see server/src/db.ts). Referred to as "instance account" throughout to keep the
// two concepts unambiguous; this module never touches the sqlite accounts table.
//
//   1. Cheap pre-check: <instanceDir>/config.json -> lastKnownAccountUuid (logged in at all?).
//   2. Decrypt oauth:tokenCacheV2 (fallback oauth:tokenCache) via ../crypto, parse the grants
//      map (key "<acctUuid>:<orgUuid>:https://api.anthropic.com:<scopes>"), and order the grants
//      app-session-first, then by expiresAt (compareGrantPreference - NOT max expiry alone).
//   3. If noNetwork / expired / no token -> resolve from our own local identity cache
//      (instances-cache.json under appDataDir()), overlaid with anything we did manage to
//      decrypt locally (uuid/orgUuid/plan/tier) even without a network call.
//   4. Otherwise call the profile endpoint with each grant in turn until one is accepted, map the
//      response, write identity ONLY (never the token) back to the cache, and return 'live'.
//
// Nothing in this file throws for expected failure conditions (missing/corrupt config.json,
// locked files, decrypt failure, network/timeout/401, malformed profile JSON) — every path
// returns a CMAccount instead.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { decryptSafeStorage } from './crypto/index'
import { accountsCacheFile, appDataDir, normalizeInstancePath } from './paths'
import type { CMAccount, CMAccountCacheEntry } from './shared'
import { OAUTH_BETA_HEADER, PROFILE_API_URL, prettyTier, resolvePlanLabel } from './shared'

// ----------------------------------------------------------------------------
// Small internal helpers (all defensive — never throw out of this module)
// ----------------------------------------------------------------------------

function log(_level: 'info' | 'warn' | 'error', _message: string): void {
  // Placeholder for a future shared logger; kept as a no-op call site so call sites below
  // don't need to change when server/src wires up real logging. Never throws.
  try {
    // Intentionally silent by default — avoid noisy stdout in a desktop app daemon.
  } catch {
    /* logging must never break the caller */
  }
}

/** `planLabel` — NOT the raw pretty tier. Passing the tier here leaked the unmapped generic value
 *  into the Quick view's one-liner ("Michael <owner@example.com> · default_claude_ai") for every
 *  account whose tier is `default_claude_ai`; the label must show what the Plan column shows. */
function buildLabel(name: string | null, email: string | null, planLabel: string | null): string {
  let namePart: string | null = null
  if (name && email) namePart = `${name} <${email}>`
  else if (name) namePart = name
  else if (email) namePart = email

  if (namePart && planLabel) return `${namePart} · ${planLabel}`
  if (namePart) return namePart
  if (planLabel) return planLabel
  return '(unknown account)'
}

function newAccount(partial: Partial<CMAccount> & { status: CMAccount['status'] }): CMAccount {
  const plan = partial.plan ?? null
  const rateLimitTier = partial.rateLimitTier ?? null
  const orgType = partial.orgType ?? null
  return {
    status: partial.status,
    email: partial.email ?? null,
    name: partial.name ?? null,
    plan,
    rateLimitTier,
    orgType,
    // Derived here, at the single construction point, so every account (live/cache/offline)
    // carries the same display-ready value and no view has to reconcile the signals itself.
    planLabel: partial.planLabel ?? resolvePlanLabel(plan, rateLimitTier, orgType),
    accountUuid: partial.accountUuid ?? null,
    orgUuid: partial.orgUuid ?? null,
    orgName: partial.orgName ?? null,
    source: partial.source ?? partial.status,
    label: partial.label ?? '(unknown account)',
  }
}

// ----------------------------------------------------------------------------
// Identity cache (instances-cache.json under appDataDir()) — identity ONLY, never tokens.
// ----------------------------------------------------------------------------

type AccountsCacheFile = Record<string, CMAccountCacheEntry>

function readAccountsCache(): AccountsCacheFile {
  try {
    const file = accountsCacheFile()
    if (!existsSync(file)) return {}
    const raw = readFileSync(file, 'utf8')
    if (!raw?.trim()) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as AccountsCacheFile
    return {}
  } catch (err) {
    log('warn', `readAccountsCache: failed to load instances-cache.json: ${String(err)}`)
    return {}
  }
}

function writeAccountsCacheEntry(instanceDir: string, entry: CMAccountCacheEntry): boolean {
  try {
    const dir = appDataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const cache = readAccountsCache()
    const key = normalizeInstancePath(instanceDir)

    // Defensively strip anything beyond the identity-only shape (never persist a token here).
    const safeEntry: CMAccountCacheEntry = {
      email: entry.email ?? null,
      name: entry.name ?? null,
      plan: entry.plan ?? null,
      rateLimitTier: entry.rateLimitTier ?? null,
      uuid: entry.uuid ?? null,
      orgUuid: entry.orgUuid ?? null,
      orgName: entry.orgName ?? null,
      orgType: entry.orgType ?? null,
      resolvedAt: entry.resolvedAt ?? new Date().toISOString(),
    }

    cache[key] = safeEntry

    const file = accountsCacheFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch (err) {
    log(
      'error',
      `writeAccountsCacheEntry: failed to write cache entry for '${instanceDir}': ${String(err)}`,
    )
    return false
  }
}

/** Drops one instance's cached identity (used when it turns out to describe a different account
 *  than the instance is signed into now). Best-effort — never throws. */
export function deleteAccountsCacheEntry(instanceDir: string): void {
  try {
    const cache = readAccountsCache()
    const key = normalizeInstancePath(instanceDir)
    if (!(key in cache)) return
    delete cache[key]
    const file = accountsCacheFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    log('warn', `deleteAccountsCacheEntry: failed for '${instanceDir}': ${String(err)}`)
  }
}

function accountFromCache(
  instanceDir: string,
  opts: {
    /** The account the instance is signed into RIGHT NOW (config.json's lastKnownAccountUuid).
     *  A cached identity carrying a DIFFERENT uuid is a previous login — see the guard below. */
    currentUuid?: string | null
    fallbackUuid?: string | null
    fallbackOrgUuid?: string | null
    fallbackPlan?: string | null
    fallbackTier?: string | null
  } = {},
): CMAccount {
  let entry: CMAccountCacheEntry | undefined
  try {
    const cache = readAccountsCache()
    const key = normalizeInstancePath(instanceDir)
    entry = cache[key]
  } catch (err) {
    log('warn', `accountFromCache: failed reading cache for '${instanceDir}': ${String(err)}`)
  }

  // Stale-login guard. The cache is keyed by instance DIR, but identity belongs to an ACCOUNT —
  // sign an instance out and back in as someone else and the dir is unchanged while everything
  // in the entry (email, name, plan, org) now describes the previous account. Without this check
  // that entry survives every offline/noNetwork/expired-token resolve, so the manager keeps
  // confidently displaying an email the instance hasn't been logged into for weeks. Showing no
  // identity until we can resolve the new one is strictly better than showing the wrong one.
  if (entry && opts.currentUuid && entry.uuid && entry.uuid !== opts.currentUuid) {
    log(
      'info',
      `accountFromCache: cached identity for '${instanceDir}' belongs to a different account — discarding.`,
    )
    deleteAccountsCacheEntry(instanceDir)
    entry = undefined
  }

  // "cache" only when we actually have a cached identity; otherwise "offline" — we resolved
  // nothing but (possibly) some locally-decrypted uuid/tier fragments.
  const status: CMAccount['status'] = entry ? 'cache' : 'offline'

  const email = entry?.email ?? null
  const name = entry?.name ?? null
  const plan = entry?.plan ?? opts.fallbackPlan ?? null
  const rawTier = entry?.rateLimitTier ?? opts.fallbackTier ?? null
  const accountUuid = entry?.uuid ?? opts.fallbackUuid ?? null
  const orgUuid = entry?.orgUuid ?? opts.fallbackOrgUuid ?? null
  const orgName = entry?.orgName ?? null
  // Only the cache can carry organization_type offline — the token cache's grants have no such
  // field. Its absence (never resolved live, or an entry written before 2026-08-07) is exactly
  // when resolvePlanLabel falls back to the older tier/plan evidence.
  const orgType = entry?.orgType ?? null

  const tier = prettyTier(rawTier)
  const planLabel = resolvePlanLabel(plan, tier, orgType)
  const label = buildLabel(name, email, planLabel)

  return newAccount({
    status,
    email,
    name,
    plan,
    rateLimitTier: tier,
    orgType,
    planLabel,
    accountUuid,
    orgUuid,
    orgName,
    source: status,
    label,
  })
}

// ----------------------------------------------------------------------------
// Token-cache grant parsing
// ----------------------------------------------------------------------------

interface Grant {
  token: string | null
  expiresAt: number
  /** The grant key's scope list ("user:inference user:profile …"). Decides preference - see
   *  compareGrantPreference. */
  scopes: string
  subscriptionType: string | null
  rateLimitTier: string | null
  /** First segment of the grant key. NOT the account uuid — it is the OAuth CLIENT id, and it is
   *  the same constant across every instance and every account (verified 2026-08-02 across 10
   *  local instances: the full/CLI client and the profile-only client). Kept only so the parse is
   *  self-documenting; identity must come from config.json's lastKnownAccountUuid or the profile
   *  API, never from here. */
  clientId: string | null
  orgUuid: string | null
}

interface RawGrantValue {
  expiresAt?: number | string
  subscriptionType?: string
  rateLimitTier?: string
  token?: string
  accessToken?: string
}

/** The scope only the desktop app's OWN sign-in carries. */
const APP_SESSION_SCOPE = 'user:sessions:claude_code'

/** The scope list packed into a grant key ("<acct>:<org>:https://api.anthropic.com:<scopes>"). */
function grantKeyScopes(grantKey: string): string {
  return grantKey.split('https://api.anthropic.com:')[1]?.trim() ?? ''
}

/**
 * Which of a profile's grants to present first: the app's own session grant, then the latest expiry.
 *
 * ⛔ THE LATEST EXPIRY IS NOT THE LIVE ONE. A signed-in profile holds up to three grants: the app's
 * session sign-in (`user:sessions:claude_code`, refreshed every time the app runs), a profile-only
 * grant, and a year-long `user:inference user:file_upload user:profile` token that is minted once
 * and never refreshed. Picking by expiry alone always lands on that year-long token, and nothing
 * stops it being revoked while its expiry still reads eleven months away.
 *
 * Measured 2026-09-14 on instance #3, a working account the owner had just opened: the year-long
 * token answered the profile endpoint 401 and the usage endpoint 429 ("retry in 59 min"), while
 * the session grant beside it answered 200 on both. So the row sat yellow on a
 * cached identity and its usage had not updated since 2026-09-07. Across ten profiles that day, no
 * session grant was dead where the year-long one lived; the reverse was the bug.
 *
 * Order, not filter: callers still fall through to the next grant when one is refused (see
 * resolveAccount and usage-service), so an inverted case on some other machine degrades to one extra
 * request rather than to a dead row.
 */
function compareGrantPreference(
  a: { scopes: string; expiresAt: number },
  b: { scopes: string; expiresAt: number },
): number {
  const rank = (g: { scopes: string }) => (g.scopes.includes(APP_SESSION_SCOPE) ? 0 : 1)
  return rank(a) - rank(b) || b.expiresAt - a.expiresAt
}

/** Every grant in the decrypted token-cache JSON's grants map, most preferred first (see
 *  compareGrantPreference). Never throws — malformed entries are skipped. */
function orderGrants(decryptedJson: string): Grant[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(decryptedJson)
  } catch {
    return []
  }

  if (!parsed || typeof parsed !== 'object') return []

  const grants: Grant[] = []
  for (const [grantKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    if (!rawValue || typeof rawValue !== 'object') continue
    const value = rawValue as RawGrantValue
    const expiresAt =
      typeof value.expiresAt === 'number'
        ? value.expiresAt
        : typeof value.expiresAt === 'string'
          ? Number.parseInt(value.expiresAt, 10) || 0
          : 0
    grants.push(buildGrant(grantKey, value, expiresAt))
  }
  return grants.sort(compareGrantPreference)
}

/** Builds a Grant from one decrypted grant-map entry. See grantKeyScopes for the grantKey shape. */
function buildGrant(grantKey: string, value: RawGrantValue, expiresAt: number): Grant {
  const parts = grantKey.split(':')
  // parts[0] = OAuth client id (NOT the account — see Grant.clientId), parts[1] = orgUuid,
  // remainder (rejoined) = "https://api...:<scopes>"
  const clientId = parts.length >= 1 ? (parts[0] ?? null) : null
  const orgUuid = parts.length >= 2 ? (parts[1] ?? null) : null

  let token: string | null = null
  try {
    token = typeof value.token === 'string' ? value.token : (value.accessToken ?? null)
  } catch {
    token = null
  }

  return {
    token,
    expiresAt,
    scopes: grantKeyScopes(grantKey),
    subscriptionType: typeof value.subscriptionType === 'string' ? value.subscriptionType : null,
    rateLimitTier: typeof value.rateLimitTier === 'string' ? value.rateLimitTier : null,
    clientId,
    orgUuid,
  }
}

// ----------------------------------------------------------------------------
// Profile API
// ----------------------------------------------------------------------------

interface ProfileResponse {
  account?: {
    email?: string
    full_name?: string
    uuid?: string
    has_claude_max?: boolean
    has_claude_pro?: boolean
  }
  organization?: {
    uuid?: string
    name?: string
    rate_limit_tier?: string
    /** "claude_free" | "claude_pro" | "claude_max" | "claude_team…" | "claude_enterprise…" —
     *  the authoritative, always-current plan family (see shared.ts resolvePlanLabel). */
    organization_type?: string
    /** "none" | "stripe_subscription" | "google_play_subscription" | … — corroborates
     *  organization_type; "none" only ever appeared alongside "claude_free" in the 11-account
     *  sample. Not used for the label; kept documented so the next reader doesn't re-derive it. */
    billing_type?: string
    /** NOT a paid/unpaid signal: an owner-confirmed active Pro account reports "canceled" here
     *  (cancelled but still inside its paid period, organization_type still "claude_pro"). */
    subscription_status?: string
  }
}

/** A profile, or why there is none. `refused` is true only when the server rejected THIS credential
 *  (401/403) - the one failure another grant of the same profile can still get past. */
type ProfileResult = { ok: true; profile: ProfileResponse } | { ok: false; refused: boolean }

async function fetchProfile(token: string): Promise<ProfileResult> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await fetch(PROFILE_API_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        },
        signal: controller.signal,
      })
      if (!res.ok) {
        log('warn', `fetchProfile: profile API responded ${res.status}`)
        return { ok: false, refused: res.status === 401 || res.status === 403 }
      }
      return { ok: true, profile: (await res.json()) as ProfileResponse }
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    // Covers network errors, DNS failure, timeout/abort, malformed JSON, etc.
    log('warn', `fetchProfile: request failed: ${String(err)}`)
    return { ok: false, refused: false }
  }
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export interface ResolveAccountOptions {
  /** If set, never calls the profile API — always resolves from local decryption + our own
   *  cache only (`?noNetwork=1`). */
  noNetwork?: boolean
}

/** A usage-capable credential decrypted out of a desktop profile. In-process only - see
 *  resolveInstanceTokens. */
export interface InstanceGrantToken {
  token: string
  /** Must ride along as CLAUDE_CODE_OAUTH_SCOPES or `/usage` silently degrades (see
   *  DEFAULT_OAUTH_SCOPES in usage.ts). */
  scopes: string
}

/**
 * Of a decrypted token-cache's grants map, every unexpired grant carrying `user:inference`, most
 * preferred first (compareGrantPreference), one entry per distinct token.
 *
 * Scope decides eligibility: the profile-only grant's token runs `claude -p "/usage"` with exit 0
 * and returns NO percentage block (identity scope can't fetch usage; verified 2026-07-14). Among the
 * eligible, preference decides the order and the caller falls through on a refusal. Exported so the
 * choice is testable without a DPAPI-encrypted fixture.
 */
export function orderInferenceGrants(
  parsed: Record<string, unknown>,
  nowMs = Date.now(),
): InstanceGrantToken[] {
  const candidates: { token: string; expiresAt: number; scopes: string }[] = []
  for (const [key, rawValue] of Object.entries(parsed)) {
    if (!/user:inference/.test(key)) continue // only the usage-capable grants
    if (!rawValue || typeof rawValue !== 'object') continue
    const v = rawValue as RawGrantValue
    const token = typeof v.token === 'string' ? v.token : (v.accessToken ?? null)
    if (typeof token !== 'string' || !token.trim()) continue
    const expiresAt = typeof v.expiresAt === 'number' ? v.expiresAt : Number(v.expiresAt) || 0
    // Skip an expired token rather than fire a doomed probe (expiresAt is epoch ms).
    if (expiresAt > 0 && expiresAt < nowMs) continue
    candidates.push({ token, expiresAt, scopes: grantKeyScopes(key) })
  }
  const seen = new Set<string>()
  return candidates
    .sort(compareGrantPreference)
    .filter((c) => !seen.has(c.token) && seen.add(c.token))
    .map(({ token, scopes }) => ({ token, scopes }))
}

/** Load and decrypt an instance's stored token cache blob, or null on any failure along the way
 *  (missing config, unreadable/malformed JSON, no cache field, decrypt failure). Pulled out of
 *  resolveInstanceToken so the file-read/parse/decrypt chain isn't inline in the main function. */
async function loadDecryptedTokenCache(instanceDir: string): Promise<string | null> {
  const configPath = path.join(instanceDir, 'config.json')
  if (!existsSync(configPath)) return null

  let config: Record<string, unknown> | null = null
  try {
    const raw = readFileSync(configPath, 'utf8')
    if (raw?.trim()) config = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!config) return null

  const b64 =
    typeof config['oauth:tokenCacheV2'] === 'string' && config['oauth:tokenCacheV2']
      ? (config['oauth:tokenCacheV2'] as string)
      : typeof config['oauth:tokenCache'] === 'string' && config['oauth:tokenCache']
        ? (config['oauth:tokenCache'] as string)
        : null
  if (!b64) return null

  try {
    return await decryptSafeStorage(b64, instanceDir)
  } catch {
    return null
  }
}

/**
 * Decrypt an isolated desktop instance's OWN OAuth access tokens from its safeStorage token cache,
 * every usage-capable one, most preferred first (orderInferenceGrants).
 *
 * IN-PROCESS ONLY: the tokens are handed straight to the immediate caller (to call the usage API or
 * inject into a `claude -p "/usage"` probe) and are NEVER persisted, cached, logged, or sent to the
 * browser — same value-blind discipline resolveAccount keeps. Empty when the instance is logged out,
 * the cache can't be decrypted, or no unexpired usage-capable token is present; the caller then
 * treats usage as "not available", never "0%". Never throws.
 *
 * This is what lets a usage check work for ANY logged-in desktop instance with NO separate dispatch
 * account and NO CLI login: the desktop app's `sk-ant-oat…` OAuth token is a valid
 * CLAUDE_CODE_OAUTH_TOKEN (verified 2026-07-14 — it drives `claude -p "/usage"` directly).
 */
export async function resolveInstanceTokens(instanceDir: string): Promise<InstanceGrantToken[]> {
  try {
    if (!instanceDir?.trim()) return []
    const decrypted = await loadDecryptedTokenCache(instanceDir)
    if (!decrypted) return []
    const parsed = JSON.parse(decrypted) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return []
    return orderInferenceGrants(parsed)
  } catch {
    return []
  }
}

/** The single most preferred usage-capable grant, for a caller that hands one token to a spawned
 *  process and so cannot fall through (dispatch runs, terminal sessions). Everything that makes its
 *  own request should take resolveInstanceTokens and try each. */
export async function resolveInstanceToken(
  instanceDir: string,
): Promise<InstanceGrantToken | null> {
  return (await resolveInstanceTokens(instanceDir))[0] ?? null
}

/**
 * Read the OAuth access token a CLI login stored in its `CLAUDE_CONFIG_DIR`.
 *
 * The CLI side of the world is much simpler than the desktop side: `claude` writes
 * `<configDir>/.credentials.json` as PLAIN JSON — `{ claudeAiOauth: { accessToken, scopes, expiresAt,
 * … } }` — with no safeStorage/DPAPI layer to unwrap (verified 2026-07-14). So a CLI instance that
 * the user has `/login`'d once gives us a usage-capable token for free.
 *
 * Same value-blind, IN-PROCESS-ONLY discipline as resolveInstanceToken above: the token goes
 * straight to the immediate caller and is never persisted, cached, logged, or sent to the browser.
 * Returns null when the dir was never logged in, the file is unreadable/corrupt, no token is
 * present, or the token has expired. Never throws.
 *
 * We do NOT attempt a refresh with the stored refresh token: rotating it would invalidate the
 * user's real CLI login out from under them. An expired token simply falls back to the CLI spawn,
 * which refreshes its own credentials properly.
 */
/**
 * Can a `claude -p "/usage"` spawn against this config dir POSSIBLY authenticate?
 *
 * The comment above says an expired token "simply falls back to the CLI spawn, which refreshes its
 * own credentials properly" - true, but only while the REFRESH token is still alive. When both are
 * dead the spawn cannot succeed by any route, and firing it anyway costs ~9s and a process every
 * time the caller asks.
 *
 * ⛔ THIS IS NOT HYPOTHETICAL, AND IT IS WHY THIS FUNCTION EXISTS. On MPC-HELL the ambient dir
 * (`~/.claude`) held a leftover CLI login with `expiresAt: 0` and a refresh token that expired
 * 2026-08-06. The monitor asks for an ambient reading every 30 SECONDS, so the daemon had been
 * booting a Claude CLI twice a minute, for weeks, to run a probe whose cached result was `null`
 * every single time. The owner is desktop-only: his real accounts read fine over the API (their
 * tokens are decrypted out of the desktop app's own store), so this probe was pure waste with no
 * signal behind it at all.
 *
 * Deliberately conservative - it answers `false` ONLY on proof of futility:
 *   'usable'      - a live, usage-capable token; the API path will take it and never spawn.
 *   'refreshable' - expired access token but a live refresh token; the CLI can still fix itself.
 *   'absent'      - no credentials file; the spawn may still authenticate from inherited env.
 *   'dead'        - the file is there and BOTH tokens are expired. Nothing can save this one.
 * Anything unreadable answers 'absent', never 'dead': a parse failure is ignorance, not proof.
 */
export function cliConfigDirCredentialState(
  configDir: string,
): 'usable' | 'refreshable' | 'absent' | 'dead' {
  try {
    if (!configDir?.trim()) return 'absent'
    const credPath = path.join(configDir, '.credentials.json')
    if (!existsSync(credPath)) return 'absent'
    const raw = readFileSync(credPath, 'utf8')
    if (!raw?.trim()) return 'absent'
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> })?.claudeAiOauth
    if (!oauth || typeof oauth !== 'object') return 'absent'
    if (typeof oauth.accessToken !== 'string' || !oauth.accessToken.trim()) return 'absent'

    const now = Date.now()
    const access = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0
    const refresh =
      typeof oauth.refreshTokenExpiresAt === 'number' ? oauth.refreshTokenExpiresAt : 0
    // An access token with expiresAt 0 is not "never expires" - it is a token whose expiry was
    // never written, and every observed one of those has been dead. Treat 0 as expired.
    if (access > now) return 'usable'
    if (refresh > now) return 'refreshable'
    // Unknown refresh expiry (0/absent) is not proof of death - only a past date is.
    return refresh > 0 ? 'dead' : 'refreshable'
  } catch {
    return 'absent'
  }
}

export function resolveCliConfigDirToken(
  configDir: string,
): { token: string; scopes: string } | null {
  try {
    if (!configDir?.trim()) return null
    const credPath = path.join(configDir, '.credentials.json')
    if (!existsSync(credPath)) return null
    const raw = readFileSync(credPath, 'utf8')
    if (!raw?.trim()) return null
    const parsed = JSON.parse(raw) as { claudeAiOauth?: RawGrantValue & { scopes?: unknown } }
    const oauth = parsed?.claudeAiOauth
    if (!oauth || typeof oauth !== 'object') return null

    const token = typeof oauth.accessToken === 'string' ? oauth.accessToken : null
    if (!token?.trim()) return null

    const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0
    if (expiresAt > 0 && expiresAt < Date.now()) return null

    // `scopes` is an array here (the desktop grant key packs them into a string); normalize to the
    // space-separated form CLAUDE_CODE_OAUTH_SCOPES wants.
    const scopes = Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((s): s is string => typeof s === 'string').join(' ')
      : typeof oauth.scopes === 'string'
        ? oauth.scopes
        : ''
    // A profile-only login cannot read usage (same trap as the desktop profile grant) — refuse it
    // here rather than fire a probe that returns exit 0 and no numbers.
    if (!scopes.includes('user:inference')) return null
    return { token, scopes }
  } catch {
    return null
  }
}

// Shared fallback path for resolveAccount's Step 3 (no usable token) and Step 4 (the profile
// call itself failed) — both resolve identity from the cache/config, never from a live call.
function fallbackAccountFromCache(
  instanceDir: string,
  lastKnownAccountUuid: string,
  bestGrant: Grant | null,
) {
  return accountFromCache(instanceDir, {
    currentUuid: lastKnownAccountUuid,
    fallbackUuid: lastKnownAccountUuid,
    fallbackOrgUuid: bestGrant?.orgUuid ?? null,
    fallbackPlan: bestGrant?.subscriptionType ?? null,
    fallbackTier: bestGrant?.rateLimitTier ?? null,
  })
}

// resolveAccount's Step 1: the cheap pre-check. Pulled out so its try/catch scores against
// this small function instead of resolveAccount's — see fallbackAccountFromCache above.
function loadAccountConfig(instanceDir: string): {
  config: Record<string, unknown> | null
  lastKnownAccountUuid: string | null
} {
  const configPath = path.join(instanceDir, 'config.json')
  let config: Record<string, unknown> | null = null
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8')
      if (raw?.trim()) config = JSON.parse(raw) as Record<string, unknown>
    } catch (err) {
      log(
        'warn',
        `resolveAccount: failed to read/parse config.json at '${configPath}': ${String(err)}`,
      )
      config = null
    }
  }
  const lastKnownAccountUuid =
    config && typeof config.lastKnownAccountUuid === 'string' ? config.lastKnownAccountUuid : null
  return { config, lastKnownAccountUuid }
}

// resolveAccount's Step 2: decrypt the token cache (v2, falling back to v1) and order its grants,
// most preferred first. Pulled out, see loadAccountConfig above.
async function resolveGrants(
  config: Record<string, unknown>,
  instanceDir: string,
): Promise<Grant[]> {
  let tokenCacheB64: string | null = null
  let usedV1 = false
  if (typeof config['oauth:tokenCacheV2'] === 'string' && config['oauth:tokenCacheV2']) {
    tokenCacheB64 = config['oauth:tokenCacheV2'] as string
  } else if (typeof config['oauth:tokenCache'] === 'string' && config['oauth:tokenCache']) {
    tokenCacheB64 = config['oauth:tokenCache'] as string
    usedV1 = true
  }
  if (!tokenCacheB64) {
    log(
      'info',
      `resolveAccount: no oauth token cache (v1 or v2) present in config.json for '${instanceDir}'.`,
    )
    return []
  }
  try {
    const decrypted = await decryptSafeStorage(tokenCacheB64, instanceDir)
    if (!decrypted) {
      log(
        'warn',
        `resolveAccount: could not decrypt token cache (${usedV1 ? 'v1' : 'v2'}) for '${instanceDir}'.`,
      )
      return []
    }
    return orderGrants(decrypted)
  } catch (err) {
    log('warn', `resolveAccount: decryptSafeStorage threw for '${instanceDir}': ${String(err)}`)
    return []
  }
}

// resolveAccount's Step 4 field derivation: plan/tier/label from a successful profile call.
// Pulled out, see loadAccountConfig above.
function deriveAccountFields(
  profile: ProfileResponse,
  bestGrant: Grant | null,
  lastKnownAccountUuid: string,
) {
  const email = profile.account?.email ?? null
  const fullName = profile.account?.full_name ?? null
  const accountUuid = profile.account?.uuid ?? lastKnownAccountUuid
  const orgUuid = profile.organization?.uuid ?? bestGrant?.orgUuid ?? null
  const orgName = profile.organization?.name ?? null
  // The plan family, and the only signal that is actually current: Anthropic recomputes
  // organization_type on every profile call. Everything else here is either a mint-time snapshot
  // (the grant) or entitlement history (has_claude_max/pro).
  const orgType = profile.organization?.organization_type ?? null

  // Tier: the ORGANIZATION's rate_limit_tier — same freshness as organization_type. The grant's
  // copy is only a gap-filler now, because it is demonstrably stale in both directions: a free
  // account still carrying `default_claude_max_20x` grants is what produced the "Max 20×" row
  // this replaces, and two paid accounts carry `max_5x` grants while their org says `max_20x`
  // (measured 2026-08-07 across 11 accounts; see resolvePlanLabel). The tier now only refines a
  // Max family into 5×/20×, so a generic `default_claude_ai` here is harmless.
  const rawTier = profile.organization?.rate_limit_tier ?? bestGrant?.rateLimitTier ?? null

  // arkitect-allow: no-bandaids the grant's subscriptionType is the only field available when
  // profile.organization is absent (offline/stale reads); it's the necessary fallback path, not
  // dead legacy code, and stays permanent alongside the org-derived fields above.
  // Plan: the GRANT's subscriptionType. Kept as the offline/legacy fallback and as a DTO field,
  // but it no longer decides the label whenever orgType is known. has_claude_max/pro are
  // entitlement HISTORY — they stay true for an account that lapsed back to free (owner-confirmed
  // 2026-07-22) — so they are consulted only when there is no grant to ask.
  let plan = bestGrant?.subscriptionType ?? null
  if (!plan) {
    if (profile.account?.has_claude_max) plan = 'max'
    else if (profile.account?.has_claude_pro) plan = 'pro'
  }

  const tier = prettyTier(rawTier)
  const planLabel = resolvePlanLabel(plan, tier, orgType)
  const label = buildLabel(fullName, email, planLabel)
  return {
    email,
    fullName,
    accountUuid,
    orgUuid,
    orgName,
    orgType,
    rawTier,
    plan,
    tier,
    planLabel,
    label,
  }
}

// Write identity ONLY (never the token) to the cache — and only when the identity we just
// resolved is the account config.json says this instance is signed into. Caching an identity
// that contradicts lastKnownAccountUuid would be immediately discarded by the stale-login guard
// in accountFromCache on the next offline read, so the entry would only ever churn. Pulled out,
// see loadAccountConfig above.
function maybeCacheAccountIdentity(
  instanceDir: string,
  lastKnownAccountUuid: string,
  fields: ReturnType<typeof deriveAccountFields>,
): void {
  const { accountUuid, email, fullName, plan, rawTier, orgUuid, orgName, orgType } = fields
  if (!accountUuid || !lastKnownAccountUuid || accountUuid === lastKnownAccountUuid) {
    writeAccountsCacheEntry(instanceDir, {
      email,
      name: fullName,
      plan,
      rateLimitTier: rawTier,
      uuid: accountUuid,
      orgUuid,
      orgName,
      orgType,
      resolvedAt: new Date().toISOString(),
    })
  } else {
    log(
      'warn',
      `resolveAccount: profile identity (${accountUuid}) disagrees with config.json's lastKnownAccountUuid (${lastKnownAccountUuid}) for '${instanceDir}' — not caching.`,
    )
  }
}

/**
 * Resolves the real account identity (email/name/plan/rate-limit tier) that an isolated
 * Claude Desktop instance is logged into, with graceful offline/cache fallback. Never throws.
 */
export async function resolveAccount(
  instanceDir: string,
  options: ResolveAccountOptions = {},
): Promise<CMAccount> {
  try {
    if (!instanceDir?.trim()) {
      log('warn', 'resolveAccount: instanceDir is null/empty.')
      return newAccount({ status: 'unknown', label: '(not logged in / unreadable)' })
    }

    const { config, lastKnownAccountUuid } = loadAccountConfig(instanceDir)
    if (!config || !lastKnownAccountUuid) {
      log(
        'info',
        `resolveAccount: no config.json / lastKnownAccountUuid for '${instanceDir}' — logged out.`,
      )
      return newAccount({ status: 'loggedout', label: '(not logged in)' })
    }

    // noNetwork resolves BEFORE any token-cache decrypt: an observation read (the fleet polls
    // this once per instance) must not pay an OS-level safeStorage decrypt per call - found by
    // adversarial review of the first fleet-identity cut, where 18 instances paid it on every
    // /api/fleet read. The grant only feeds last-resort fallback fields (org/plan/tier) that
    // the identity cache normally supplies; a never-cached instance shows nulls until a live
    // resolve fills the cache, which is honest rather than expensive.
    if (options.noNetwork) {
      log(
        'info',
        `resolveAccount: resolving '${instanceDir}' from cache/offline (noNetwork requested).`,
      )
      return fallbackAccountFromCache(instanceDir, lastKnownAccountUuid, null)
    }

    const grants = await resolveGrants(config, instanceDir)

    // ---- decide whether to go live or fall back ----------------------------------
    const nowMs = Date.now()
    const usable = grants.filter((g) => g.token?.trim() && g.expiresAt > 0 && g.expiresAt >= nowMs)

    if (usable.length === 0) {
      const reason = grants.some((g) => g.token?.trim())
        ? 'access token expired'
        : 'no usable access token decrypted'
      log('info', `resolveAccount: resolving '${instanceDir}' from cache/offline (${reason}).`)
      return fallbackAccountFromCache(instanceDir, lastKnownAccountUuid, grants[0] ?? null)
    }

    // ---- live profile call --------------------------------------------------------
    // Preferred grant first; the next one only when the server refused THIS credential. A network
    // or server failure would fail every grant the same way, so it ends the attempt instead of
    // multiplying a 10-second timeout by the number of grants. See compareGrantPreference for the
    // account that sat yellow because the only grant ever tried was the revoked one.
    // Tokens are only ever held in these local bindings; nothing persists them.
    let answered: { grant: Grant; profile: ProfileResponse } | null = null
    const tried = new Set<string>()
    for (const grant of usable) {
      const token = grant.token as string
      if (tried.has(token)) continue
      tried.add(token)
      const result = await fetchProfile(token)
      if (result.ok) {
        answered = { grant, profile: result.profile }
        break
      }
      if (!result.refused) break
    }

    if (!answered) {
      log('warn', `resolveAccount: profile API call failed for '${instanceDir}'.`)
      return fallbackAccountFromCache(instanceDir, lastKnownAccountUuid, usable[0] ?? null)
    }

    const fields = deriveAccountFields(answered.profile, answered.grant, lastKnownAccountUuid)
    maybeCacheAccountIdentity(instanceDir, lastKnownAccountUuid, fields)
    log('info', `resolveAccount: resolved '${instanceDir}' live -> ${fields.label}`)

    return newAccount({
      status: 'live',
      email: fields.email,
      name: fields.fullName,
      plan: fields.plan,
      rateLimitTier: fields.tier,
      orgType: fields.orgType,
      planLabel: fields.planLabel,
      accountUuid: fields.accountUuid,
      orgUuid: fields.orgUuid,
      orgName: fields.orgName,
      source: 'live',
      label: fields.label,
    })
  } catch (err) {
    log('error', `resolveAccount: unexpected error for '${instanceDir}': ${String(err)}`)
    return newAccount({ status: 'unknown', label: '(not logged in / unreadable)' })
  }
}
