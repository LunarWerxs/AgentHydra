// Tests for the SDK-backed NETWORK paths in server/src/connections.ts that
// tests/connections.test.ts deliberately leaves uncovered: pushNow/pullNow, buildAuthorizeUrl,
// handleCallback, and the connected branches of enable/disable(forget). Modeled on RepoYeti's
// tests/connections-sync.test.ts (src/connections-sync.ts): same idea, adapted to ccmanagerui's
// SQLite-settings-row state store instead of a JSON file + OS keychain.
//
// NEVER reaches the real network: global.fetch is fully mocked to a fake in-memory Connections
// IdP + locker store. Any fetch the SDKs make that isn't one of the routes below throws loudly,
// so a real leak fails the test instead of silently reaching connections.icu.
//
// IMPORTANT fetch-mock wiring note: connections.ts's connect() memoizes ONE ConnectClient at
// module scope and never passes a `fetch` option to createConnect() (unlike RepoYeti's
// connections-sync.ts, which explicitly late-binds `fetch: (...args) => globalThis.fetch(...)`
// for exactly this reason), so @cnct/connect captures whatever globalThis.fetch happened to be
// AT FIRST CONSTRUCTION as a plain reference (dist/index.js: `this.fetchImpl = options.fetch ??
// fetch`). Reassigning globalThis.fetch to a brand-new function every beforeEach (the naive
// version of this pattern, as used in tests/mcp.test.ts) would leave the memoized client calling
// a STALE closure bound to an earlier test's fake server once the client has been built once in
// the process. Fixed test-side with no source change: install ONE stable delegating function as
// globalThis.fetch a single time at module load, and swap only the mutable `server` it forwards
// to in each beforeEach. This was confirmed by direct repro during development (see history);
// without the stable delegate, cross-test signIn/refresh calls silently reused a previous test's
// server instance and its (now stale) accepted codes/tokens.
//
// Seeding a "signed in" credential needs NO source change: connections.ts already exposes
// buildAuthorizeUrl() + handleCallback(), which are exactly the module's own seam for driving a
// full sign-in through the real (mocked) @cnct/connect SDK: PKCE record written to state.sdk by
// signIn(), then exchanged for tokens by handleCallback(). Running that flow against the fake IdP
// below seeds a real connected state AND exercises buildAuthorizeUrl/handleCallback for real.
//
// bun test shares ONE module instance (and one settings DB) across the whole run with no per-file
// reset, and connections.ts keeps its sync state in module-level `let`s with no exported reset.
// So beforeEach here re-establishes a clean baseline (disable(true) with the fetch mock active,
// so the remote-delete/revoke calls are harmless no-ops against the fake server) AND restores
// every settings row this file touches, exactly like tests/connections.test.ts does.
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  buildAuthorizeUrl,
  disable,
  enable,
  handleCallback,
  hasConnection,
  initConnections,
  pullNow,
  pushNow,
  syncStatus,
  updateAppearance,
} from '../server/src/connections'
import { getSetting, setSetting } from '../server/src/db'

const SETTINGS_KEY = 'connections_sync'
const ISSUER = 'https://accounts.connections.icu'
const CLIENT_ID = '9ea648d3125f59743f7e1f651108bb42'
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`
const USERINFO_ENDPOINT = `${ISSUER}/oauth/userinfo`
const REVOKE_ENDPOINT = `${ISSUER}/oauth/revoke`
const STORE_BASE = 'https://studio.connections.icu'
const DOC_URL = `${STORE_BASE}/v1/app-data/${encodeURIComponent(CLIENT_ID)}`
const ORIGIN = 'http://127.0.0.1:7787'

/** In-memory fake of the Connections IdP (token + userinfo + revoke) and the locker app-data
 *  store, wired as the global fetch (via the stable delegate installed below). Anything not
 *  matched here throws; a real-network leak fails loudly instead of silently escaping the mock. */
class FakeConnectionsServer {
  version = 0
  settings: Record<string, unknown> = {}
  /** Authorization codes the fake token endpoint will accept, mapped to the user they mint. */
  validCodes = new Map<string, { sub: string; email: string; name: string }>()
  /** Refresh tokens the fake token endpoint will accept for a refresh_token grant. */
  validRefreshTokens = new Set<string>()
  tokenCalls = 0
  userinfoCalls = 0
  revokeCalls = 0
  docGetCalls = 0
  docPostCalls = 0
  docDeleteCalls = 0
  lastAuthHeader: string | null = null

  fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()

    if (url === TOKEN_ENDPOINT && method === 'POST') {
      this.tokenCalls += 1
      const body = new URLSearchParams(String(init?.body ?? ''))
      const grant = body.get('grant_type')
      if (grant === 'authorization_code') {
        const code = body.get('code') ?? ''
        const user = this.validCodes.get(code)
        if (!user) {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
        }
        this.validCodes.delete(code)
        const refreshToken = `refresh-for-${user.sub}`
        this.validRefreshTokens.add(refreshToken)
        return new Response(
          JSON.stringify({
            access_token: `access-for-${user.sub}`,
            refresh_token: refreshToken,
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (grant === 'refresh_token') {
        const rt = body.get('refresh_token')
        if (!rt || !this.validRefreshTokens.has(rt)) {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
        }
        return new Response(
          JSON.stringify({ access_token: `access-for-${rt}`, expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ error: 'unsupported_grant_type' }), { status: 400 })
    }

    if (url === USERINFO_ENDPOINT && method === 'GET') {
      this.userinfoCalls += 1
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? ''
      const sub = auth
        .replace('Bearer access-for-', '')
        .replace('Bearer access-for-refresh-for-', '')
      return new Response(
        JSON.stringify({ sub, email: `${sub}@example.test`, name: `Test ${sub}` }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    if (url === REVOKE_ENDPOINT && method === 'POST') {
      this.revokeCalls += 1
      return new Response(null, { status: 200 })
    }

    if (url === DOC_URL) {
      this.lastAuthHeader =
        (init?.headers as Record<string, string> | undefined)?.authorization ?? null
      if (method === 'GET') {
        this.docGetCalls += 1
        return new Response(
          JSON.stringify({
            app_id: CLIENT_ID,
            settings: this.settings,
            server_settings: {},
            version: this.version,
            updated_at: this.version ? new Date().toISOString() : null,
            bytes_used: 0,
            max_bytes: 65536,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (method === 'POST') {
        this.docPostCalls += 1
        const req = JSON.parse(String(init?.body ?? '{}')) as {
          settings: Record<string, unknown>
          baseVersion: number
          merge?: boolean
        }
        if (req.baseVersion !== this.version) {
          return new Response(
            JSON.stringify({
              error: 'version_conflict',
              current: { settings: this.settings, version: this.version },
            }),
            { status: 409 },
          )
        }
        if (req.merge) {
          this.settings = { ...this.settings, ...req.settings }
        } else {
          this.settings = req.settings
        }
        this.version += 1
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (method === 'DELETE') {
        this.docDeleteCalls += 1
        this.settings = {}
        this.version = 0
        return new Response(null, { status: 204 })
      }
    }

    throw new Error(`[test] unexpected fetch to ${method} ${url} (seam leak)`)
  }
}

let server: FakeConnectionsServer

// Install ONE stable delegating function as globalThis.fetch a single time (module load), and
// swap only the mutable `server` it forwards to in beforeEach; see the file-header note on why
// reassigning globalThis.fetch itself per-test would leave connections.ts's memoized ConnectClient
// calling a stale closure once it has been constructed once in this process.
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
  server.fetchImpl(input, init)) as unknown as typeof fetch

/** Drive a full sign-in through the REAL (mocked) SDK: buildAuthorizeUrl() writes the PKCE
 *  record into the module's state.sdk via signIn(), then handleCallback() exchanges a fake
 *  authorization code for tokens and fetches the fake userinfo. No source seam needed: this
 *  is the module's own public sign-in surface, exercised end-to-end against the fake IdP. */
async function signInAs(sub: string): Promise<boolean> {
  const authorizeUrl = await buildAuthorizeUrl(ORIGIN)
  const stateParam = new URL(authorizeUrl).searchParams.get('state')
  expect(stateParam).toBeTruthy()
  const code = `code-for-${sub}`
  server.validCodes.set(code, { sub, email: `${sub}@example.test`, name: `Test ${sub}` })
  return handleCallback(ORIGIN, code, stateParam as string)
}

beforeEach(async () => {
  server = new FakeConnectionsServer()
  initConnections()
  // Return to a clean baseline. The fetch mock is active, so disable(true)'s remote delete +
  // revoke calls land on the fake server (harmless no-ops when nothing was ever connected).
  await disable(true)
  // bun test shares one module instance (and settings DB) across every file in the run with no
  // per-test reset, so any row this file writes must be put back for sibling files.
  setSetting('portable_mode', '0')
  setSetting('hide_tray_icon', '0')
  setSetting('scheduler_enabled', '0')
  setSetting('spacing_seconds', '60')
  setSetting('poll_seconds', '5')
  setSetting('max_concurrent', '3')
})

afterEach(async () => {
  // Disconnect against the still-active mock so a leftover credential from a failed test never
  // causes a later file's disable() to hit real network (globalThis.fetch stays the stable
  // delegate until afterAll below; only `server` is swapped per-test).
  await disable(true)
})

afterAll(() => {
  // Restore the real fetch once this file's tests are done, so sibling files see a pristine
  // globalThis.fetch regardless of run order.
  globalThis.fetch = realFetch
})

// ── sign-in flow: buildAuthorizeUrl + handleCallback ───────────────────────────────────────
describe('sign-in flow (buildAuthorizeUrl + handleCallback)', () => {
  test('buildAuthorizeUrl returns a PKCE authorize URL for the configured issuer + client', async () => {
    const url = await buildAuthorizeUrl(ORIGIN)
    const parsed = new URL(url)
    expect(parsed.origin).toBe(ISSUER)
    expect(parsed.pathname).toBe('/oauth/authorize')
    expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(parsed.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/oauth/callback`)
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('state')).toBeTruthy()
    expect(server.tokenCalls).toBe(0) // no network beyond building the URL
  })

  test('handleCallback with a valid code+state signs in and hasConnection becomes true', async () => {
    expect(hasConnection()).toBe(false)
    const ok = await signInAs('user-1')
    expect(ok).toBe(true)
    expect(hasConnection()).toBe(true)
    expect(server.tokenCalls).toBe(1)
    expect(server.userinfoCalls).toBe(1)
  })

  test('handleCallback persists identity into the settings row', async () => {
    await signInAs('user-2')
    const persisted = JSON.parse(getSetting(SETTINGS_KEY)) as {
      identity?: { sub: string; email: string; name: string }
    }
    expect(persisted.identity?.sub).toBe('user-2')
    expect(persisted.identity?.email).toBe('user-2@example.test')
    expect(syncStatus().name).toBe('Test user-2')
    expect(syncStatus().email).toBe('user-2@example.test')
  })

  test('handleCallback with a bad state (CSRF mismatch) fails cleanly, no connection made', async () => {
    await buildAuthorizeUrl(ORIGIN) // writes a real PKCE record with its own state
    const ok = await handleCallback(ORIGIN, 'some-code', 'not-the-real-state')
    expect(ok).toBe(false)
    expect(hasConnection()).toBe(false)
  })

  test('handleCallback with an unknown code (IdP rejects) fails cleanly', async () => {
    const authorizeUrl = await buildAuthorizeUrl(ORIGIN)
    const stateParam = new URL(authorizeUrl).searchParams.get('state') as string
    const ok = await handleCallback(ORIGIN, 'never-issued-code', stateParam)
    expect(ok).toBe(false)
    expect(hasConnection()).toBe(false)
  })

  test('handleCallback without a prior buildAuthorizeUrl (no PKCE record) fails cleanly', async () => {
    const ok = await handleCallback(ORIGIN, 'some-code', 'some-state')
    expect(ok).toBe(false)
    expect(hasConnection()).toBe(false)
  })
})

// ── pushNow / pullNow against the mocked locker store ──────────────────────────────────────
describe('pushNow / pullNow', () => {
  test('pushNow sends only PREF_KEYS-allowlisted settings, never machine-local ones', async () => {
    await signInAs('pusher')
    setSetting('scheduler_enabled', '1')
    setSetting('spacing_seconds', '120')
    setSetting('poll_seconds', '10')
    setSetting('max_concurrent', '7')
    setSetting('portable_mode', '1') // deliberately excluded from PREF_KEYS
    setSetting('hide_tray_icon', '1') // deliberately excluded from PREF_KEYS

    await pushNow()

    expect(server.docPostCalls).toBe(1)
    expect(server.settings.prefs).toEqual({
      scheduler_enabled: '1',
      spacing_seconds: '120',
      poll_seconds: '10',
      max_concurrent: '7',
    })
    const raw = JSON.stringify(server.settings)
    expect(raw).not.toContain('portable_mode')
    expect(raw).not.toContain('hide_tray_icon')
  })

  test('pushNow includes the locally-held appearance blob alongside prefs', async () => {
    await signInAs('pusher2')
    await updateAppearance({ theme: 'dark' }) // enabled=false here, so this alone doesn't push
    await pushNow()
    expect(server.settings.appearance).toEqual({ theme: 'dark' })
  })

  test('pushNow advances version and lastSyncedAt, persisted to the settings row', async () => {
    await signInAs('pusher3')
    await pushNow()
    const persisted = JSON.parse(getSetting(SETTINGS_KEY)) as {
      version?: number
      lastSyncedAt?: string
    }
    expect(persisted.version).toBe(1)
    expect(typeof persisted.lastSyncedAt).toBe('string')
    expect(syncStatus().version).toBe(1)
  })

  test('pullNow applies only PREF_KEYS-allowlisted keys from the remote doc; extras are ignored', async () => {
    await signInAs('puller')
    server.version = 1
    server.settings = {
      prefs: {
        scheduler_enabled: '1',
        spacing_seconds: '999',
        // Not on the allowlist; must be ignored even though the remote doc carries it.
        portable_mode: '1',
        hide_tray_icon: '1',
        some_future_key: 'x',
      },
    }

    const result = await pullNow()

    expect(result.applied).toBe(true)
    expect(result.version).toBe(1)
    expect(getSetting('scheduler_enabled')).toBe('1')
    expect(getSetting('spacing_seconds')).toBe('999')
    // Non-allowlisted fields are untouched (still at the beforeEach baseline).
    expect(getSetting('portable_mode')).toBe('0')
    expect(getSetting('hide_tray_icon')).toBe('0')
  })

  test('pullNow against a never-written remote doc (version 0) applies nothing', async () => {
    await signInAs('puller2')
    const result = await pullNow()
    expect(result.applied).toBe(false)
    expect(result.version).toBe(0)
    expect(getSetting('scheduler_enabled')).toBe('0') // unchanged baseline
  })

  test('pullNow adopts a remote appearance blob (object) into state.appearance', async () => {
    await signInAs('puller3')
    server.version = 1
    server.settings = { prefs: {}, appearance: { theme: 'light' } }
    await pullNow()
    expect(syncStatus().appearance).toEqual({ theme: 'light' })
  })

  test('pullNow ignores a malformed (non-object) remote appearance value', async () => {
    await signInAs('puller4')
    await updateAppearance({ theme: 'dark' }) // enabled=false here, no push, just records locally
    server.version = 1
    server.settings = {
      prefs: {},
      appearance: 'not-an-object' as unknown as Record<string, unknown>,
    }
    await pullNow()
    expect(syncStatus().appearance).toEqual({ theme: 'dark' }) // left untouched
  })

  test('pushNow/pullNow use a Bearer access token derived from the signed-in session', async () => {
    await signInAs('bearer-check')
    await pushNow()
    expect(server.lastAuthHeader).toBe('Bearer access-for-bearer-check')
  })
})

// ── enable()/disable() connected branches ───────────────────────────────────────────────────
describe('enable() connected branches', () => {
  test('enable() with an empty remote doc seeds the store from local settings (push, not pull-applied)', async () => {
    await signInAs('enabler')
    setSetting('scheduler_enabled', '1')
    setSetting('max_concurrent', '9')

    const { status, applied } = await enable()

    expect(status.enabled).toBe(true)
    expect(status.connected).toBe(true)
    expect(applied).toBe(false) // remote was empty, so pulled.applied is false
    expect(server.docPostCalls).toBe(1) // seeded via push
    expect(server.settings.prefs).toMatchObject({ scheduler_enabled: '1', max_concurrent: '9' })
  })

  test('enable() with a populated remote doc pulls and applies it locally instead of pushing', async () => {
    await signInAs('enabler2')
    server.settings = { prefs: { scheduler_enabled: '1', spacing_seconds: '42' } }
    server.version = 1

    const { status, applied } = await enable()

    expect(status.enabled).toBe(true)
    expect(applied).toBe(true)
    expect(server.docPostCalls).toBe(0) // never pushed, only pulled
    expect(getSetting('scheduler_enabled')).toBe('1')
    expect(getSetting('spacing_seconds')).toBe('42')
  })

  test('enable() passes an appearance blob through to the seeded push', async () => {
    await signInAs('enabler3')
    const { status } = await enable({ theme: 'dark' })
    expect(status.appearance).toEqual({ theme: 'dark' })
    expect(server.settings.appearance).toEqual({ theme: 'dark' })
  })
})

describe('disable({ forget: true }) connected branches', () => {
  test('disable(true) while connected deletes the remote doc and revokes server-side', async () => {
    await signInAs('forgetter')
    await enable()
    expect(hasConnection()).toBe(true)

    const status = await disable(true)

    expect(status.enabled).toBe(false)
    expect(server.docDeleteCalls).toBe(1)
    expect(server.revokeCalls).toBe(1)
    expect(hasConnection()).toBe(false)
    expect(status.version).toBe(0)
    expect(status.appearance).toBeNull()
    expect(status.name).toBeNull()
  })

  test('disable(true) clears the sdk/identity state from the persisted settings row', async () => {
    await signInAs('forgetter2')
    await enable()
    await disable(true)
    const persisted = JSON.parse(getSetting(SETTINGS_KEY)) as Record<string, unknown>
    expect(persisted.sdk).toBeUndefined()
    expect(persisted.identity).toBeUndefined()
    expect(persisted.appearance).toBeUndefined()
  })

  test('disable(true) still clears the local connection even if the remote delete fails', async () => {
    await signInAs('forgetter3')
    await enable()
    const realImpl = server.fetchImpl
    server.fetchImpl = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === DOC_URL && (init?.method ?? 'GET').toUpperCase() === 'DELETE') {
        return new Response(JSON.stringify({ error: 'server_error' }), { status: 500 })
      }
      return realImpl(input, init)
    }

    const status = await disable(true)
    expect(status.enabled).toBe(false)
    expect(hasConnection()).toBe(false) // local disconnect proceeds regardless of remote failure
  })

  test('disable(true) still clears the local connection even if the revoke call fails', async () => {
    await signInAs('forgetter4')
    await enable()
    const realImpl = server.fetchImpl
    server.fetchImpl = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === REVOKE_ENDPOINT) {
        return new Response(JSON.stringify({ error: 'server_error' }), { status: 500 })
      }
      return realImpl(input, init)
    }

    const status = await disable(true)
    expect(status.enabled).toBe(false)
    expect(hasConnection()).toBe(false)
  })

  test('disable(false) while connected keeps the connection and remote doc untouched', async () => {
    await signInAs('keeper')
    await enable()
    server.docDeleteCalls = 0
    server.revokeCalls = 0

    const status = await disable(false)

    expect(status.enabled).toBe(false)
    expect(hasConnection()).toBe(true) // still connected
    expect(server.docDeleteCalls).toBe(0)
    expect(server.revokeCalls).toBe(0)
  })
})

// ── updateAppearance connected branch (pushes over the network) ────────────────────────────
describe('updateAppearance while enabled + connected', () => {
  test('pushes the new appearance to the remote doc', async () => {
    await signInAs('appearance-pusher')
    await enable()
    server.docPostCalls = 0

    await updateAppearance({ theme: 'system' })
    expect(server.docPostCalls).toBe(0)
    await pushNow()

    expect(syncStatus().appearance).toEqual({ theme: 'system' })
    expect(server.docPostCalls).toBe(1)
    expect(server.settings.appearance).toEqual({ theme: 'system' })
  })
})

// ── token refresh-on-expiry across the locker call ──────────────────────────────────────────
describe('access token refresh', () => {
  test('an access token that has since expired triggers a refresh before pushNow reaches the locker', async () => {
    await signInAs('refresher') // healthy token from sign-in, no refresh yet
    expect(server.tokenCalls).toBe(1)

    // Advance the clock past the access token's expiry (@cnct/connect refreshes 30s before the
    // real expiry; see getAccessToken()'s `expiresAt - Date.now() > 30_000` check) so the next
    // getAccessToken() call is forced to refresh, without reaching into the module's private
    // token-set state from the test side.
    const realNow = Date.now
    Date.now = () => realNow() + 3600 * 1000 + 60_000
    try {
      await pushNow() // forces getAccessToken() -> sees the expired token -> refreshes
    } finally {
      Date.now = realNow
    }

    expect(server.tokenCalls).toBe(2) // refresh_token grant fired
    expect(server.lastAuthHeader).toBe('Bearer access-for-refresh-for-refresher')
  })

  test('a healthy (non-expired) access token is reused with no extra refresh call', async () => {
    await signInAs('no-refresh-needed') // default expires_in from the fake IdP (3600s), healthy
    expect(server.tokenCalls).toBe(1)

    await pushNow()
    expect(server.tokenCalls).toBe(1) // no refresh; the access token from sign-in was reused
    expect(server.lastAuthHeader).toBe('Bearer access-for-no-refresh-needed')
  })
})
