// server/src/core/codex-account.ts — instance-account identity + quota for Codex / ChatGPT,
// the OpenAI-side counterpart to core/accounts.ts.
//
// Resolves which ChatGPT account a Codex instance (a CODEX_HOME) is logged into, and how much of
// that account's quota is spent. Before this existed the Codex table carried exactly one identity
// signal — `loggedIn`, i.e. "does auth.json exist" — so every Codex row looked alike no matter which
// account or plan was behind it.
//
//   1. Read <codexHome>/auth.json. Unlike Claude Desktop's safeStorage blob this is PLAIN JSON, so
//      there is no decryption step and no platform-specific key derivation.
//   2. `auth_mode` splits the two login shapes: "chatgpt" (an OAuth token trio) and an API-key
//      login (OPENAI_API_KEY set), which has no subscription and no quota to report.
//   3. Decode the id_token's claims for a LOCAL identity (email, name, plan, account id). This is a
//      plain base64url payload read — never a signature verification, and never trusted over a live
//      answer; see the evidence note on codexPlanLabel.
//   4. Unless noNetwork (or the access token has expired), GET the usage endpoint, which returns the
//      CURRENT email/plan_type AND the rate-limit windows in one call.
//   5. Cache identity ONLY (never a token) under ~/.agenthydra/codex-accounts-cache.json, with the
//      same stale-login guard accounts.ts uses: an entry describing a different account than the one
//      auth.json is signed into now is discarded rather than displayed.
//
// Value-blind, exactly as accounts.ts and usage-api.ts are: tokens are read into a local binding,
// handed to fetch, and never persisted, logged, or returned to the browser.
//
// Nothing here throws for expected failure conditions (missing/corrupt auth.json, an unparseable
// JWT, network/timeout/401, malformed JSON) — every path returns a CodexAccount instead.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { UsageLimit, UsageSnapshot } from '../types'
import { appDataDir, normalizeInstancePath } from './paths'

/** The endpoint the Codex CLI's own status screen reads. Verified live 2026-08-07: returns
 *  `user_id`, `account_id`, `email`, `plan_type`, and a `rate_limit` with up to two windows. */
export const CODEX_USAGE_API_URL = 'https://chatgpt.com/backend-api/codex/usage'

/** A window at or under this length is the short rolling "session" window; anything longer is the
 *  weekly cap. The endpoint does NOT label its windows — it returns `primary_window` and
 *  `secondary_window`, and which one is the 5-hour bucket varies by plan (a Plus account reports a
 *  single 604800s window as PRIMARY). Mapping on the duration it actually reports is therefore the
 *  only stable rule; keying off primary/secondary would mislabel entire plan tiers. */
const SESSION_WINDOW_MAX_SECONDS = 6 * 60 * 60

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/** How this CODEX_HOME is authenticated. */
export type CodexAuthMode = 'chatgpt' | 'apikey' | 'none'

export type CodexAccountStatus = 'live' | 'cache' | 'offline' | 'loggedout' | 'unknown'

/** Resolved identity for one Codex instance. Never carries a token. */
export interface CodexAccount {
  status: CodexAccountStatus
  authMode: CodexAuthMode
  email: string | null
  name: string | null
  /** Raw `plan_type` ("plus" | "pro" | "free" | "business" | …), as reported. */
  planType: string | null
  /** Display-ready plan ("Plus" | "Pro" | "Free" | …). Null when it can't be determined. */
  planLabel: string | null
  accountId: string | null
  userId: string | null
  /** The default organization's title ("Personal", or a workspace name). */
  orgTitle: string | null
  /** ISO-8601 end of the current paid period, from the id_token claims. Informational: an active
   *  subscription that auto-renews reports a date in the near future every cycle. */
  subscriptionActiveUntil: string | null
  /** Where this came from: 'live' (network), 'cache', 'offline', … */
  source: string | null
  /** One-line display label, e.g. "Oluwaferanmi Olotu <styceplug@gmail.com> · Plus". */
  label: string
}

/** Cached Codex identity — NEVER a token. Keyed by normalized CODEX_HOME. */
export interface CodexAccountCacheEntry {
  email: string | null
  name: string | null
  planType: string | null
  accountId: string | null
  userId: string | null
  orgTitle: string | null
  subscriptionActiveUntil: string | null
  resolvedAt: string
}

// ----------------------------------------------------------------------------
// Plan label
// ----------------------------------------------------------------------------

const KNOWN_PLANS: Record<string, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  business: 'Business',
  team: 'Team',
  enterprise: 'Enterprise',
  edu: 'Edu',
}

/**
 * `plan_type` as a display label ("plus" → "Plus"), or null when there is nothing to show.
 *
 * EVIDENCE ORDER, and why it is worth stating (see the 2026-08-07 Claude-side regression this
 * deliberately does not repeat): the live usage endpoint's `plan_type` is computed server-side per
 * call and is the authority. The id_token's `chatgpt_plan_type` claim is a SNAPSHOT taken when that
 * token was minted, so it is only consulted offline — the exact mistake that labelled a free Claude
 * account "Max 20×" was trusting the equivalent token-embedded value over the live one.
 *
 * Unrecognized values are title-cased rather than dropped: `plan_type` is a short lowercase word, so
 * a new tier renders readably instead of vanishing, and nothing raw or internal-looking leaks.
 */
export function codexPlanLabel(planType: string | null | undefined): string | null {
  if (planType == null) return null
  const key = planType.trim().toLowerCase()
  if (!key) return null
  const known = KNOWN_PLANS[key]
  if (known) return known
  return key.charAt(0).toUpperCase() + key.slice(1)
}

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

function newCodexAccount(
  partial: Partial<CodexAccount> & { status: CodexAccountStatus },
): CodexAccount {
  const planType = partial.planType ?? null
  return {
    status: partial.status,
    authMode: partial.authMode ?? 'none',
    email: partial.email ?? null,
    name: partial.name ?? null,
    planType,
    // Derived at the single construction point, so every path (live/cache/offline) agrees.
    planLabel: partial.planLabel ?? codexPlanLabel(planType),
    accountId: partial.accountId ?? null,
    userId: partial.userId ?? null,
    orgTitle: partial.orgTitle ?? null,
    subscriptionActiveUntil: partial.subscriptionActiveUntil ?? null,
    source: partial.source ?? partial.status,
    label: partial.label ?? '(unknown account)',
  }
}

// ----------------------------------------------------------------------------
// auth.json + JWT claims
// ----------------------------------------------------------------------------

interface CodexAuthFile {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  } | null
  last_refresh?: string
}

/** Read and parse `<codexHome>/auth.json`, or null when absent/unreadable/corrupt. */
export function readCodexAuth(codexHome: string): CodexAuthFile | null {
  try {
    if (!codexHome?.trim()) return null
    const file = path.join(codexHome, 'auth.json')
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    if (!raw?.trim()) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as CodexAuthFile) : null
  } catch {
    return null
  }
}

/**
 * The PAYLOAD of a JWT, decoded — not verified.
 *
 * Verification would need OpenAI's signing keys and would prove nothing useful here: this token was
 * written to disk by the user's own authenticated Codex login, so the threat model is "is this file
 * corrupt", not "is this token forged". Everything read from it is display metadata, and the live
 * endpoint overrides it whenever the network is reachable.
 */
export function decodeJwtClaims(jwt: string | null | undefined): Record<string, unknown> | null {
  try {
    if (!jwt) return null
    const parts = jwt.split('.')
    if (parts.length !== 3 || !parts[1]) return null
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** OpenAI namespaces its custom claims under this key in both the id and access tokens. */
const AUTH_CLAIM = 'https://api.openai.com/auth'

interface LocalIdentity {
  email: string | null
  name: string | null
  planType: string | null
  accountId: string | null
  userId: string | null
  orgTitle: string | null
  subscriptionActiveUntil: string | null
}

/** Identity as the on-disk id_token claims describe it. Snapshot data — see codexPlanLabel. */
function identityFromClaims(claims: Record<string, unknown> | null): LocalIdentity {
  const empty: LocalIdentity = {
    email: null,
    name: null,
    planType: null,
    accountId: null,
    userId: null,
    orgTitle: null,
    subscriptionActiveUntil: null,
  }
  if (!claims) return empty

  const auth = (claims[AUTH_CLAIM] ?? null) as Record<string, unknown> | null
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

  let orgTitle: string | null = null
  const orgs = auth?.organizations
  if (Array.isArray(orgs)) {
    const org = (orgs.find((o) => (o as { is_default?: boolean })?.is_default) ?? orgs[0]) as
      | { title?: unknown }
      | undefined
    orgTitle = str(org?.title)
  }

  return {
    email: str(claims.email),
    name: str(claims.name),
    planType: str(auth?.chatgpt_plan_type),
    accountId: str(auth?.chatgpt_account_id),
    userId: str(auth?.chatgpt_user_id),
    orgTitle,
    subscriptionActiveUntil: str(auth?.chatgpt_subscription_active_until),
  }
}

/** Epoch-ms expiry from a JWT's `exp` claim (seconds), or 0 when unknown. */
function jwtExpiryMs(claims: Record<string, unknown> | null): number {
  const exp = claims?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : 0
}

// ----------------------------------------------------------------------------
// Identity cache (codex-accounts-cache.json under appDataDir()) — identity ONLY
// ----------------------------------------------------------------------------

type CodexCacheFile = Record<string, CodexAccountCacheEntry>

export function codexAccountsCacheFile(): string {
  return path.join(appDataDir(), 'codex-accounts-cache.json')
}

function readCodexCache(): CodexCacheFile {
  try {
    const file = codexAccountsCacheFile()
    if (!existsSync(file)) return {}
    const raw = readFileSync(file, 'utf8')
    if (!raw?.trim()) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as CodexCacheFile) : {}
  } catch {
    return {}
  }
}

function writeCodexCacheEntry(codexHome: string, entry: CodexAccountCacheEntry): boolean {
  try {
    const dir = appDataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const cache = readCodexCache()
    // Identity-only by construction: every field is copied explicitly, so a token can never ride
    // along even if the caller hands over a wider object.
    cache[normalizeInstancePath(codexHome)] = {
      email: entry.email ?? null,
      name: entry.name ?? null,
      planType: entry.planType ?? null,
      accountId: entry.accountId ?? null,
      userId: entry.userId ?? null,
      orgTitle: entry.orgTitle ?? null,
      subscriptionActiveUntil: entry.subscriptionActiveUntil ?? null,
      resolvedAt: entry.resolvedAt ?? new Date().toISOString(),
    }

    const file = codexAccountsCacheFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function deleteCodexCacheEntry(codexHome: string): void {
  try {
    const cache = readCodexCache()
    const key = normalizeInstancePath(codexHome)
    if (!(key in cache)) return
    delete cache[key]
    const file = codexAccountsCacheFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // best-effort
  }
}

// ----------------------------------------------------------------------------
// Live usage endpoint
// ----------------------------------------------------------------------------

interface CodexUsageWindow {
  used_percent?: number
  limit_window_seconds?: number
  reset_after_seconds?: number
  reset_at?: number
}

interface CodexUsageResponse {
  user_id?: string
  account_id?: string
  email?: string
  plan_type?: string
  rate_limit?: {
    allowed?: boolean
    limit_reached?: boolean
    primary_window?: CodexUsageWindow | null
    secondary_window?: CodexUsageWindow | null
  } | null
}

async function fetchCodexUsage(
  token: string,
  accountId: string | null,
): Promise<CodexUsageResponse | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        // The backend selects the workspace from this header; without it a multi-workspace login
        // is answered for whichever account the token defaults to.
        ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
      }
      const res = await fetch(CODEX_USAGE_API_URL, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
      if (!res.ok) return null
      return (await res.json()) as CodexUsageResponse
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    // network error / DNS / timeout / abort / malformed JSON
    return null
  }
}

// ----------------------------------------------------------------------------
// Usage mapping
// ----------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Render a reset instant the way usage-api.ts's formatResetLocal does, so both providers' rows
 *  print the same shape. Kept local rather than imported to avoid core/* depending on server/src. */
export function formatCodexReset(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hours24 = d.getHours()
  const ampm = hours24 < 12 ? 'am' : 'pm'
  const hour12 = hours24 % 12 === 0 ? 12 : hours24 % 12
  const min = d.getMinutes()
  const time = min === 0 ? `${hour12}${ampm}` : `${hour12}:${String(min).padStart(2, '0')}${ampm}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`
}

/** Severity bands. The Codex endpoint reports `limit_reached`/`allowed` but no severity string, so
 *  it is derived here — using the SAME thresholds the web chip colours on (lib/usage.ts
 *  usageBadgeVariant: >90 destructive, >=70 warning), so the badge and the severity never disagree. */
function severityFor(pct: number): UsageLimit['severity'] {
  if (pct > 90) return 'critical'
  if (pct >= 70) return 'warning'
  return 'normal'
}

function toLimit(window: CodexUsageWindow): UsageLimit | null {
  const pct = window.used_percent
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null
  const resetAtIso =
    typeof window.reset_at === 'number' && Number.isFinite(window.reset_at)
      ? new Date(window.reset_at * 1000).toISOString()
      : null
  return {
    pct: Math.round(pct),
    resets: formatCodexReset(resetAtIso),
    resetsAt: resetAtIso,
    severity: severityFor(pct),
  }
}

/**
 * Map a Codex usage response onto the SHARED UsageSnapshot, so Codex rows reuse the whole existing
 * quota surface (the chip, the countdown columns, the usage filter, the superseded-window rule)
 * rather than growing a parallel one.
 *
 * Windows are assigned by their reported LENGTH, never by primary/secondary — see
 * SESSION_WINDOW_MAX_SECONDS. `weekModel` stays null: OpenAI publishes no per-model sub-limit.
 */
export function codexUsageSnapshot(
  body: CodexUsageResponse | null,
  accountLabel: string | null,
): UsageSnapshot {
  const snap: UsageSnapshot = {
    account: accountLabel,
    session: null,
    weekAll: null,
    weekModel: null,
    capturedAt: new Date().toISOString(),
    source: 'api',
  }
  const rl = body?.rate_limit
  if (!rl) return snap

  for (const window of [rl.primary_window, rl.secondary_window]) {
    if (!window) continue
    const limit = toLimit(window)
    if (!limit) continue
    const seconds = window.limit_window_seconds
    const isSession =
      typeof seconds === 'number' && seconds > 0 && seconds <= SESSION_WINDOW_MAX_SECONDS
    if (isSession) snap.session ??= limit
    else snap.weekAll ??= limit
  }
  return snap
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export interface ResolveCodexAccountOptions {
  /** Never call the usage endpoint — resolve from auth.json claims + our own cache only. */
  noNetwork?: boolean
}

export interface CodexAccountResult {
  account: CodexAccount
  /** Present only on a successful live read; null on every cache/offline/logged-out path. */
  usage: UsageSnapshot | null
}

/**
 * Identity from LOCAL FILES ONLY — auth.json's token claims overlaid on our identity cache. No
 * network, no decryption, synchronous.
 *
 * This is cheap enough to run for every row on every list, which is why the Codex table attaches an
 * identity eagerly where the Claude table has to resolve one lazily: Claude Desktop's token cache is
 * a safeStorage blob needing a DPAPI/Keychain round trip, while a CODEX_HOME's auth.json is plain
 * JSON and a base64 payload decode.
 *
 * The plan here comes from a token claim, so it is snapshot data — resolveCodexAccount replaces it
 * with the live value whenever the network answers. See codexPlanLabel.
 */
/** The identity fields that fall back to the cache when the live claims don't carry them —
 *  factored out of localCodexAccount so the cache-or-claims choice is made in one place per
 *  field instead of six parallel ternaries inline. */
function mergeCachedCodexIdentity(
  local: LocalIdentity,
  cached: CodexCacheFile[string] | undefined,
  usable: boolean,
): Pick<
  LocalIdentity,
  'email' | 'name' | 'planType' | 'userId' | 'orgTitle' | 'subscriptionActiveUntil'
> {
  return {
    email: local.email ?? (usable ? cached?.email : null) ?? null,
    name: local.name ?? (usable ? cached?.name : null) ?? null,
    planType: local.planType ?? (usable ? cached?.planType : null) ?? null,
    userId: local.userId ?? (usable ? (cached?.userId ?? null) : null),
    orgTitle: local.orgTitle ?? (usable ? (cached?.orgTitle ?? null) : null),
    subscriptionActiveUntil:
      local.subscriptionActiveUntil ?? (usable ? (cached?.subscriptionActiveUntil ?? null) : null),
  }
}

export function localCodexAccount(codexHome: string, source = 'offline'): CodexAccount {
  try {
    const auth = readCodexAuth(codexHome)
    if (!auth) return newCodexAccount({ status: 'loggedout', label: '(not logged in)' })

    // An API-key login has no ChatGPT subscription behind it, so there is no plan and no quota to
    // report. Saying so plainly beats rendering it as a broken ChatGPT login.
    if (!auth.tokens?.access_token && !auth.tokens?.id_token) {
      if (auth.OPENAI_API_KEY)
        return newCodexAccount({
          status: 'live',
          authMode: 'apikey',
          source: 'auth.json',
          label: 'API key',
        })
      return newCodexAccount({ status: 'loggedout', label: '(not logged in)' })
    }

    const local = identityFromClaims(
      decodeJwtClaims(auth.tokens?.id_token) ?? decodeJwtClaims(auth.tokens?.access_token),
    )
    // auth.json's own account_id is the one the CLI sends as `chatgpt-account-id`; prefer it.
    const accountId = auth.tokens?.account_id ?? local.accountId

    const cached = readCodexCache()[normalizeInstancePath(codexHome)]
    // Stale-login guard, same rule as accounts.ts: a cached identity for a DIFFERENT account is a
    // previous login, and showing the wrong email is worse than showing none.
    const usable = Boolean(
      cached && (!accountId || !cached.accountId || cached.accountId === accountId),
    )
    if (cached && !usable) deleteCodexCacheEntry(codexHome)

    const fields = mergeCachedCodexIdentity(local, cached, usable)
    const planLabel = codexPlanLabel(fields.planType)
    return newCodexAccount({
      status: usable ? 'cache' : 'offline',
      authMode: 'chatgpt',
      email: fields.email,
      name: fields.name,
      planType: fields.planType,
      planLabel,
      accountId,
      userId: fields.userId,
      orgTitle: fields.orgTitle,
      subscriptionActiveUntil: fields.subscriptionActiveUntil,
      source,
      label: buildLabel(fields.name, fields.email, planLabel),
    })
  } catch {
    return newCodexAccount({ status: 'unknown', label: '(not logged in / unreadable)' })
  }
}

/**
 * Resolve one Codex instance's account, and its quota when the network answers.
 *
 * Identity and usage arrive TOGETHER because the endpoint returns both in one call — unlike the
 * Claude side, where the profile and usage endpoints are separate reads.
 */
export async function resolveCodexAccount(
  codexHome: string,
  options: ResolveCodexAccountOptions = {},
): Promise<CodexAccountResult> {
  try {
    const auth = readCodexAuth(codexHome)
    if (!auth?.tokens?.access_token) {
      return { account: localCodexAccount(codexHome), usage: null }
    }

    const accessClaims = decodeJwtClaims(auth.tokens.access_token)
    const local = identityFromClaims(decodeJwtClaims(auth.tokens.id_token) ?? accessClaims)
    const accountId = auth.tokens.account_id ?? local.accountId

    const expiresAt = jwtExpiryMs(accessClaims)
    const expired = expiresAt > 0 && expiresAt < Date.now()
    if (options.noNetwork || expired) {
      return {
        account: localCodexAccount(codexHome, options.noNetwork ? 'noNetwork' : 'expired'),
        usage: null,
      }
    }

    const body = await fetchCodexUsage(auth.tokens.access_token, accountId)
    // Token was only ever held in this local binding; nothing persists it.
    if (!body) return { account: localCodexAccount(codexHome), usage: null }

    // The live answer is authoritative for everything it reports; the token claims fill the gaps it
    // does not (name and org title are not in the usage response).
    const email = body.email ?? local.email ?? null
    const planType = body.plan_type ?? local.planType ?? null
    const planLabel = codexPlanLabel(planType)
    const resolvedAccountId = body.account_id ?? accountId
    const userId = body.user_id ?? local.userId
    const label = buildLabel(local.name, email, planLabel)

    if (!resolvedAccountId || !accountId || resolvedAccountId === accountId) {
      writeCodexCacheEntry(codexHome, {
        email,
        name: local.name,
        planType,
        accountId: resolvedAccountId,
        userId,
        orgTitle: local.orgTitle,
        subscriptionActiveUntil: local.subscriptionActiveUntil,
        resolvedAt: new Date().toISOString(),
      })
    }

    return {
      account: newCodexAccount({
        status: 'live',
        authMode: 'chatgpt',
        email,
        name: local.name,
        planType,
        planLabel,
        accountId: resolvedAccountId,
        userId,
        orgTitle: local.orgTitle,
        subscriptionActiveUntil: local.subscriptionActiveUntil,
        source: 'live',
        label,
      }),
      usage: codexUsageSnapshot(body, label),
    }
  } catch {
    return {
      account: newCodexAccount({ status: 'unknown', label: '(not logged in / unreadable)' }),
      usage: null,
    }
  }
}
