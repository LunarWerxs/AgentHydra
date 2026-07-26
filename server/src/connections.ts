// ---------------------------------------------------------------------------
// "Sync my settings with Connections" — the daemon-side Backend-for-Frontend.
//
// CC Manager UI is a single-user local daemon, so the daemon IS the BFF: it runs the
// OIDC login (Authorization Code + PKCE, public client — no secret), holds the
// owner's refresh token server-side, mints access tokens, and calls the Connections
// settings-sync store (studio.connections.icu/v1/app-data/{clientId}). The browser
// never holds a token.
//
// Mirrors DevWebUI's server/src/connections.ts (the family-standard shape) adapted to
// ccmanagerui's SQLite settings table (server/src/db.ts) instead of a separate JSON
// state file — the sync state (SDK session + sync prefs) rides one settings row,
// serialized as JSON, alongside every other ccmanagerui setting.
//
// The OAuth/refresh/identity machinery is the official SDK — @cnct/connect (the data
// locker store ships from the same package now): single-flight rotation-safe refresh,
// per-attempt redirect_uri, server-side revoke on forget, and id_token identity all come
// from the shared package. This module keeps only the ccmanagerui-specific parts: the
// settings-row persistence seam, the settings allowlist, and the sync orchestration.
//
// Because ccmanagerui is loopback-only (no tunnel / remote mode), there is NO auth gate
// and NO session cookie: "signed in" simply means the daemon holds a refresh token.
//
// Off by default: with sync disabled (the default), nothing here runs. What syncs is a
// small ALLOWLIST of portable scheduler prefs (PREF_KEYS) + the web's appearance blob
// (theme). Never machine-specific settings (portable_mode, hide_tray_icon) and never secrets.
//
// @cnct/connect is a regular dependency here (server/package.json) — dynamically imported
// below anyway, so a boot with sync untouched never pays for the SDK.
// ---------------------------------------------------------------------------
import type { ConnectClient, ConnectStore, LockerClient, TokenSet } from '@cnct/connect'
import { getSetting, setSetting } from './db'
import { unseal, wrapTokenStore } from './dpapi-seal.mjs'
import type { SyncStatus } from './types'

/** CC Manager UI's own public "Sign in with Connections" OAuth client (PKCE — no secret).
 *  Its client_id doubles as the settings-sync store `appId`, so ccmanagerui's synced data
 *  is namespaced to itself. Self-registered once via @cnct/connect's registerApp() (RFC 7591
 *  dynamic client registration — no console needed); safe to embed (public client). */
const OAUTH = {
  issuer: 'https://accounts.connections.icu',
  clientId: '9ea648d3125f59743f7e1f651108bb42',
  scopes: ['openid', 'profile', 'email'],
}

/** The ONLY settings keys that sync — portable scheduler prefs. Deliberately excludes
 *  machine-specific state (portable_mode, hide_tray_icon) and every secret (accounts). */
const PREF_KEYS = [
  'scheduler_enabled',
  'spacing_seconds',
  'poll_seconds',
  'max_concurrent',
] as const

// ── persisted state (db.ts settings table, key = 'connections_sync', JSON-serialized) ──────────
const SETTINGS_KEY = 'connections_sync'

interface ConnState {
  enabled?: boolean
  lastSyncedAt?: string
  version?: number
  appearance?: Record<string, unknown>
  identity?: { sub: string; email: string; name?: string; picture?: string }
  /** The @cnct/connect session entries (token set + in-flight PKCE), keyed by the SDK. */
  sdk?: Record<string, string>
}

let state: ConnState = {}
let loaded = false

function persist(): void {
  setSetting(SETTINGS_KEY, JSON.stringify(state))
}

// The SDK's persistence rides THIS module's state blob (one settings row for everything), via a
// ConnectStore adapter over the in-memory `state` — every set/remove goes through persist().
const stateStore: ConnectStore = {
  get: (key) => state.sdk?.[key] ?? null,
  set: (key, value) => {
    state.sdk ??= {}
    state.sdk[key] = value
    persist()
  },
  remove: (key) => {
    if (state.sdk && key in state.sdk) {
      delete state.sdk[key]
      persist()
    }
  },
}

/** Thrown when a sync/sign-in op is attempted but @cnct/connect never resolved. Surfaces
 *  as a normal guardSync error, not a boot crash. */
class SdkUnavailableError extends Error {
  code = 'sdk_unavailable'
  constructor(pkg: string, cause: unknown) {
    super(`${pkg} is not installed — Connections cloud sync is unavailable`)
    this.name = 'SdkUnavailableError'
    this.cause = cause
  }
}

let connectClient: ConnectClient | null = null
/** The lazily-built SDK client (after initConnections loads the persisted state). Dynamically
 *  imports @cnct/connect — never pulled in on a boot where sync is untouched. The constructor
 *  redirectUri is a placeholder — every real sign-in passes the live origin per attempt. */
async function connect(): Promise<ConnectClient> {
  if (connectClient) return connectClient
  let createConnect: typeof import('@cnct/connect').createConnect
  try {
    ;({ createConnect } = await import('@cnct/connect'))
  } catch (e) {
    throw new SdkUnavailableError('@cnct/connect', e)
  }
  connectClient = createConnect({
    clientId: OAUTH.clientId,
    issuer: OAUTH.issuer,
    scopes: OAUTH.scopes,
    redirectUri: 'http://127.0.0.1/oauth/callback',
    // Wrap the store so the persisted TokenSet (the durable refresh token) is DPAPI-sealed at
    // rest on Windows; the transient PKCE record and non-Windows hosts pass through unchanged.
    store: wrapTokenStore(stateStore, TOKEN_KEY),
    // Late-bound so a test harness's globalThis.fetch stub is honored even though the
    // client is memoized across calls (the SDK captures `fetch` at construction). Cast:
    // the SDK only CALLS it; Bun's `typeof fetch` also declares a `preconnect` member.
    fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
  })
  return connectClient
}

const TOKEN_KEY = `cnx.connect.tokens.${OAUTH.clientId}`

/** Load persisted sync state (incl. the credential) into memory. Call once at daemon boot. */
export function initConnections(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = getSetting(SETTINGS_KEY)
    state = raw ? (JSON.parse(raw) as ConnState) : {}
  } catch {
    state = {}
  }
}

/** True when the daemon holds a Connections credential (the owner has signed in). Synchronous —
 *  reads the SDK's token entry straight from the in-memory state. */
export function hasConnection(): boolean {
  const raw = state.sdk?.[TOKEN_KEY]
  if (!raw) return false
  const plain = unseal(raw) // DPAPI-sealed at rest → decrypt; legacy plaintext passes through
  if (!plain) return false
  try {
    const tokens = JSON.parse(plain) as TokenSet
    return Boolean(tokens.refreshToken || tokens.accessToken)
  } catch {
    return false
  }
}

/** Build the authorize URL for a sign-in that redirects back to `${origin}/oauth/callback`.
 *  The live loopback origin rides the SDK's per-attempt redirectUri override (the daemon may be
 *  reached as localhost, 127.0.0.1, or ::1). */
export async function buildAuthorizeUrl(origin: string): Promise<string> {
  const client = await connect()
  return client.signIn({ redirect: false, redirectUri: `${origin}/oauth/callback` })
}

/** Complete the OIDC callback: exchange the code, persist the session, capture identity. */
export async function handleCallback(
  origin: string,
  code: string,
  stateTok: string,
): Promise<boolean> {
  try {
    const callbackUrl = `${origin}/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateTok)}`
    const client = await connect()
    const user = await client.handleCallback(callbackUrl)
    state.identity = {
      sub: user.sub,
      email: user.email ?? '',
      name: user.name ?? '',
      picture: user.picture ?? '',
    }
    persist()
    return true
  } catch {
    return false
  }
}

/** Backfill display identity (name/picture) for sessions created before those fields existed —
 *  best-effort, only when something is missing, piggybacking on calls that already network. */
async function backfillIdentity(): Promise<void> {
  if (state.identity?.name && state.identity?.picture) return
  try {
    const client = await connect()
    const user = await client.getUser()
    state.identity = {
      sub: user.sub,
      email: user.email ?? '',
      name: user.name ?? '',
      picture: user.picture ?? '',
    }
    persist()
  } catch {
    /* identity is best-effort; syncing works without it */
  }
}

/** Dynamically imports @cnct/connect — never pulled in on a boot where sync is untouched. */
async function locker(): Promise<LockerClient> {
  let createLocker: typeof import('@cnct/connect').createLocker
  try {
    ;({ createLocker } = await import('@cnct/connect'))
  } catch (e) {
    throw new SdkUnavailableError('@cnct/connect', e)
  }
  return createLocker({
    appId: OAUTH.clientId,
    getToken: async () => (await connect()).getAccessToken(),
  })
}

// ── settings mapping (the allowlist) ─────────────────────────────────────────────
interface SyncDoc {
  prefs?: Record<string, unknown>
  appearance?: Record<string, unknown>
}

function collectPrefs(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of PREF_KEYS) out[k] = getSetting(k)
  return out
}

/** Apply an allowlisted prefs blob onto the settings table. Ignores any key not on the
 *  allowlist, so a doc written by a newer/older app version can never inject arbitrary settings. */
function applyPrefs(prefs: Record<string, unknown> | undefined): boolean {
  if (!prefs || typeof prefs !== 'object') return false
  let applied = false
  for (const k of PREF_KEYS) {
    if (k in prefs && typeof prefs[k] === 'string') {
      setSetting(k, prefs[k] as string)
      applied = true
    }
  }
  return applied
}

// ── public sync API ───────────────────────────────────────────────────────────────
// SyncStatus (the status DTO every settings-sync endpoint returns) lives in ./types.ts so
// the web app can import it without pulling this Bun-only module into vue-tsc.

export function syncStatus(): SyncStatus {
  return {
    ok: true,
    enabled: state.enabled === true,
    connected: hasConnection(),
    name: state.identity?.name || null,
    email: state.identity?.email || null,
    picture: state.identity?.picture || null,
    lastSyncedAt: state.lastSyncedAt ?? null,
    version: state.version ?? 0,
    appearance: state.appearance ?? null,
  }
}

/** Push the current allowlisted settings to the store (deep-merge — race-free per key). */
export async function pushNow(): Promise<void> {
  const doc: SyncDoc = { prefs: collectPrefs() }
  if (state.appearance) doc.appearance = state.appearance
  const store = await locker()
  const res = await store.merge(doc as Record<string, unknown>)
  state.version = res.version
  state.lastSyncedAt = new Date().toISOString()
  persist()
  await backfillIdentity()
}

/** Pull remote settings and apply the allowlisted subset. Returns whether anything was applied. */
export async function pullNow(): Promise<{ applied: boolean; version: number }> {
  const store = await locker()
  const remote = await store.get()
  state.version = remote.version
  let applied = false
  if (remote.version > 0) {
    const data = (remote.settings ?? {}) as SyncDoc
    applied = applyPrefs(data.prefs)
    if (data.appearance && typeof data.appearance === 'object') state.appearance = data.appearance
    state.lastSyncedAt = new Date().toISOString()
  }
  persist()
  await backfillIdentity()
  return { applied, version: remote.version }
}

/** Turn sync on: pull the remote doc (applying it) or seed the store from local if it's empty. */
export async function enable(
  appearance?: Record<string, unknown>,
): Promise<{ status: SyncStatus; applied: boolean }> {
  state.enabled = true
  if (appearance) state.appearance = appearance
  persist()
  let applied = false
  if (hasConnection()) {
    const pulled = await pullNow()
    applied = pulled.applied
    if (pulled.version === 0) await pushNow() // remote empty → seed with our current settings
  }
  return { status: syncStatus(), applied }
}

/** Turn sync off. `forget` also disconnects — deletes the remote document, REVOKES the grant
 *  server-side (RFC 7009, so the refresh-token family is dead everywhere), and clears the session. */
export async function disable(forget = false): Promise<SyncStatus> {
  state.enabled = false
  if (forget) {
    if (hasConnection()) {
      try {
        const store = await locker()
        await store.delete()
      } catch {
        /* best-effort remote wipe */
      }
      try {
        const client = await connect()
        await client.signOut({ revoke: true })
      } catch {
        /* best-effort revoke — the local credential is cleared below regardless */
      }
    }
    state.identity = undefined
    state.appearance = undefined
    state.version = 0
    state.lastSyncedAt = undefined
    state.sdk = undefined
  }
  persist()
  return syncStatus()
}

/** The web changed appearance (theme) while synced — record it and push (if enabled). */
export async function updateAppearance(appearance: Record<string, unknown>): Promise<void> {
  state.appearance = appearance
  persist()
  if (state.enabled && hasConnection()) await pushNow()
}

/** Sign out / disconnect fully (used by the logout route). */
export async function logout(): Promise<void> {
  await disable(true)
}
