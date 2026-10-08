// server/src/core/desktop-cli-renew.ts — a linked desktop profile that stays closed keeps its Claude
// Code grant alive. When the grant is near its end, it is refreshed in place with the refresh token
// the profile already holds, and the rotated grant is written back under that profile's own key, so
// the linked CLI login (desktop-cli-feed.ts) can be fed again.
//
// WHY (owner, 2026-10-08): a closed desktop profile's grant runs out after a few hours; the linked CLI
// login then expires and CliMayte walls the account as signed out until someone opens the app.
//
// THE RULES
// - Only a profile whose app is closed is written: a running app owns its token cache. A process scan
//   that fails counts as running, so nothing is written.
// - Only a grant within RENEW_WITHIN_MS of its end, or past it, is refreshed.
// - A refused or unreachable refresh writes nothing: the stored grant stays exactly as it was.
// - The write is atomic and goes through the same config key the desktop login sync reads, so the
//   sync sees the renewed grant as the newer copy.
//
// ⛔ SECRETS: tokens go only to the desktop app's own token endpoint and back into the profile,
// encrypted. Nothing here logs a token.

import { listCliInstances } from './cli-instances'
import { credPath } from './cli-login-move'
import { encryptSafeStorage } from './crypto'
import { hasOwnCliLogin, readCredentials } from './desktop-cli-feed'
import {
  readDesktopTokens,
  replaceDesktopTokenCacheV2,
  runningDesktopDirs,
} from './desktop-login-sync'
import { normalizePath } from './paths'

export const RENEW_WITHIN_MS = 2 * 3_600_000
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_CODE_SCOPE = 'user:sessions:claude_code'
const RETRY_AFTER_REFUSAL_MS = 30 * 60_000

export const NO_GRANT = 'no Claude Code grant'
export const NO_REFRESH = 'no refresh token'
const APP_OPEN = 'its app is open'
const APP_UNKNOWN = 'could not tell whether its app is open'
const NOT_DUE = 'not due'
const COOLING_DOWN = 'refused recently; trying again later'

export interface RenewDeps {
  now?: number
  fetchFn?: typeof fetch
  running?: () => Promise<Set<string> | null>
  withinMs?: number
}

export type RenewOutcome =
  | { state: 'renewed'; expiresAt: number }
  | { state: 'skipped'; why: string }
  | { state: 'refused'; why: string }

/** Why a profile's grant is not refreshed now; null when it is due and may be. */
export function renewalSkip(g: {
  expiresAt: number | null
  hasRefresh: boolean
  running: boolean
  now: number
  withinMs?: number
}): string | null {
  if (g.expiresAt === null) return NO_GRANT
  if (g.running) return APP_OPEN
  if (!g.hasRefresh) return NO_REFRESH
  if (g.expiresAt - g.now > (g.withinMs ?? RENEW_WITHIN_MS)) return NOT_DUE
  return null
}

type Grants = Record<string, Record<string, unknown>>

function parseGrants(cache: string | null): Grants {
  if (!cache) return {}
  try {
    return JSON.parse(cache) as Grants
  } catch {
    return {}
  }
}

function claudeCodeKey(grants: Grants): string | null {
  return Object.keys(grants).find((k) => k.includes(CLAUDE_CODE_SCOPE)) ?? null
}

/** The refreshed grant, or why the token endpoint would not give one. */
export async function refreshGrant(
  refreshToken: string,
  now: number,
  fetchFn: typeof fetch = fetch,
): Promise<
  | { ok: true; accessToken: string; refreshToken: string; expiresAt: number }
  | { ok: false; why: string }
> {
  let res: Response
  try {
    res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    return { ok: false, why: 'the token endpoint could not be reached' }
  }
  if (!res.ok) return { ok: false, why: `the token endpoint refused it (HTTP ${res.status})` }
  const body = (await res.json().catch(() => null)) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  } | null
  if (
    typeof body?.access_token !== 'string' ||
    !body.access_token ||
    typeof body.expires_in !== 'number'
  )
    return { ok: false, why: 'the token endpoint replied with no grant' }
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === 'string' && body.refresh_token
        ? body.refresh_token
        : refreshToken,
    expiresAt: now + body.expires_in * 1000,
  }
}

const lastOutcome = new Map<string, { at: number; outcome: RenewOutcome }>()

function remember(dir: string, outcome: RenewOutcome, now: number): RenewOutcome {
  lastOutcome.set(dir, { at: now, outcome })
  return outcome
}

/** Whether the last outcome for a profile leaves its linked CLI login for the owner to fix by
 *  opening the desktop app once. */
function needsOpen(outcome: RenewOutcome): boolean {
  if (outcome.state === 'refused') return true
  return outcome.state === 'skipped' && (outcome.why === NO_GRANT || outcome.why === NO_REFRESH)
}

/** Refresh one closed profile's Claude Code grant in place, or leave it untouched. */
export async function renewDesktopGrant(dir: string, deps: RenewDeps = {}): Promise<RenewOutcome> {
  const now = deps.now ?? Date.now()
  const running = await (deps.running ?? runningDesktopDirs)()
  const key = normalizePath(dir)
  if (!running) return remember(dir, { state: 'skipped', why: APP_UNKNOWN }, now)
  const tokens = await readDesktopTokens(dir)
  const grants = parseGrants(tokens?.v2 ?? null)
  const grantKey = claudeCodeKey(grants)
  const grant = grantKey ? grants[grantKey] : undefined
  const refreshToken = typeof grant?.refreshToken === 'string' ? grant.refreshToken : ''
  const expiresAt = grant ? Number(grant.expiresAt) || 0 : null
  const skip = renewalSkip({
    expiresAt,
    hasRefresh: refreshToken.length > 0,
    running: running.has(key),
    now,
    withinMs: deps.withinMs,
  })
  if (skip) return remember(dir, { state: 'skipped', why: skip }, now)
  const last = lastOutcome.get(dir)
  if (last?.outcome.state === 'refused' && now - last.at < RETRY_AFTER_REFUSAL_MS)
    return { state: 'skipped', why: COOLING_DOWN }
  const fresh = await refreshGrant(refreshToken, now, deps.fetchFn)
  if (!fresh.ok) return remember(dir, { state: 'refused', why: fresh.why }, now)
  // The app may have opened during the refresh; a running app is never written.
  const again = await (deps.running ?? runningDesktopDirs)()
  if (!again || again.has(key))
    return remember(
      dir,
      { state: 'skipped', why: 'its app opened during the refresh; nothing written' },
      now,
    )
  const sealed = await encryptSafeStorage(
    JSON.stringify({
      ...grants,
      [grantKey as string]: {
        ...grant,
        token: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
      },
    }),
    dir,
  )
  if (!sealed || !replaceDesktopTokenCacheV2(dir, sealed))
    return remember(
      dir,
      { state: 'refused', why: 'the renewed login could not be written here' },
      now,
    )
  return remember(dir, { state: 'renewed', expiresAt: fresh.expiresAt }, now)
}

/** The renewal pass over every linked desktop profile; one profile's failure never stops the rest. */
export async function renewClosedCliLogins(
  deps: RenewDeps = {},
): Promise<Map<string, RenewOutcome>> {
  const results = new Map<string, RenewOutcome>()
  const dirs = [
    ...new Set(
      listCliInstances()
        .map((c) => c.associatedDesktopDir)
        .filter((d): d is string => !!d),
    ),
  ]
  for (const dir of dirs) {
    try {
      results.set(dir, await renewDesktopGrant(dir, deps))
    } catch {
      results.set(dir, { state: 'skipped', why: 'could not read its login' })
    }
  }
  return results
}

/** Whether a linked CLI login has expired and how it gets back: `renewing` while the desktop side can
 *  still refresh it, `open-once` when only opening its desktop app will. Null when it is not expired
 *  (or is its own sign-in, which the desktop feed does not touch). */
export function loginExpiryState(
  configDir: string,
  desktopDir: string,
  now = Date.now(),
): 'renewing' | 'open-once' | null {
  if (hasOwnCliLogin(configDir)) return null
  const oauth = readCredentials(credPath(configDir))?.claudeAiOauth as
    | { expiresAt?: unknown }
    | undefined
  const expiresAt = Number(oauth?.expiresAt) || 0
  if (!expiresAt || expiresAt > now) return null
  const last = lastOutcome.get(desktopDir)
  return last && needsOpen(last.outcome) ? 'open-once' : 'renewing'
}
