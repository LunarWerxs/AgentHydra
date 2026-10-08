// server/tests/desktop-cli-renew.test.ts — a closed desktop profile's Claude Code grant is refreshed in
// place, and only when that is safe: never while its app runs, never when the token endpoint refuses,
// and the rotated grant is what the profile's own key opens afterwards. A linked CLI login whose
// grant has run out says so by number in the waiting reason.
// Windows only: the profile key is DPAPI's.

import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliMayteAccount } from '../src/climayte-lib'
import { expiredLoginNote } from '../src/climayte-schedule'
import { encryptSafeStorage } from '../src/core/crypto'
import { ensureWindowsMasterKey } from '../src/core/crypto/keys.win'
import { NO_GRANT, NO_REFRESH, renewalSkip, renewDesktopGrant } from '../src/core/desktop-cli-renew'
import { readDesktopTokens } from '../src/core/desktop-login-sync'
import { instancesRoot, normalizePath } from '../src/core/paths'
import './no-chats'

const HOUR = 3_600_000
const CLAUDE_CODE_KEY = (uuid: string) =>
  `acct:${uuid}:${uuid}:https://api.anthropic.com:user:inference user:file_upload user:profile user:sessions:claude_code`

const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

async function closedProfile(expiresAt: number, refreshToken = 'old-refresh') {
  const uuid = randomUUID()
  const dir = join(instancesRoot(), `renew-test-${randomUUID()}`)
  made.push(dir)
  mkdirSync(dir, { recursive: true })
  await ensureWindowsMasterKey(dir)
  const grants = {
    [CLAUDE_CODE_KEY(uuid)]: {
      token: 'old-access',
      refreshToken,
      expiresAt,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
    },
  }
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      locale: 'en-US',
      lastKnownAccountUuid: uuid,
      'oauth:tokenCacheV2': await encryptSafeStorage(JSON.stringify(grants), dir),
    }),
  )
  return { dir, uuid }
}

function tokenEndpoint(status: number, body: unknown) {
  const calls: string[] = []
  const fetchFn = (async (url: string | URL | Request) => {
    calls.push(String(url))
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

const account = (num: number, loginExpired?: 'renewing' | 'open-once') =>
  ({ num, name: `acct${num}`, loginExpired }) as unknown as CliMayteAccount

describe.skipIf(process.platform !== 'win32')('renewing a closed desktop profile', () => {
  test('renews only a due grant with a refresh token while its app is closed', () => {
    const now = 1_000_000_000_000
    const due = { now, expiresAt: now + HOUR, hasRefresh: true, running: false }
    expect(renewalSkip({ ...due, expiresAt: null })).toBe(NO_GRANT)
    expect(renewalSkip({ ...due, hasRefresh: false })).toBe(NO_REFRESH)
    expect(renewalSkip({ ...due, running: true })).toBeString()
    expect(renewalSkip({ ...due, expiresAt: now + 10 * HOUR })).toBeString()
    expect(renewalSkip(due)).toBeNull()
    expect(renewalSkip({ ...due, expiresAt: now - HOUR })).toBeNull()
  })

  test('never writes under a running app and never calls the token endpoint', async () => {
    const now = Date.now()
    const { dir } = await closedProfile(now + HOUR)
    const before = readFileSync(join(dir, 'config.json'), 'utf8')
    const { calls, fetchFn } = tokenEndpoint(200, { access_token: 'x', expires_in: 28800 })
    const out = await renewDesktopGrant(dir, {
      now,
      fetchFn,
      running: async () => new Set([normalizePath(dir)]),
    })
    expect(out.state).toBe('skipped')
    expect(calls).toHaveLength(0)
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before)
  })

  test('writes nothing when the app state cannot be read', async () => {
    const now = Date.now()
    const { dir } = await closedProfile(now + HOUR)
    const before = readFileSync(join(dir, 'config.json'), 'utf8')
    const { calls, fetchFn } = tokenEndpoint(200, { access_token: 'x', expires_in: 28800 })
    const out = await renewDesktopGrant(dir, { now, fetchFn, running: async () => null })
    expect(out.state).toBe('skipped')
    expect(calls).toHaveLength(0)
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before)
  })

  test('a refused refresh leaves the stored grant byte-for-byte unchanged', async () => {
    const now = Date.now()
    const { dir } = await closedProfile(now + HOUR)
    const before = readFileSync(join(dir, 'config.json'), 'utf8')
    const { calls, fetchFn } = tokenEndpoint(400, { error: 'invalid_grant' })
    const out = await renewDesktopGrant(dir, { now, fetchFn, running: async () => new Set() })
    expect(out.state).toBe('refused')
    expect(calls).toHaveLength(1)
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before)
  })

  test('a successful refresh writes a grant the profile key opens, keeping its plan', async () => {
    const now = Date.now()
    const { dir, uuid } = await closedProfile(now + HOUR)
    const { fetchFn } = tokenEndpoint(200, {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 28800,
    })
    const out = await renewDesktopGrant(dir, { now, fetchFn, running: async () => new Set() })
    expect(out).toEqual({ state: 'renewed', expiresAt: now + 28800 * 1000 })
    const tokens = await readDesktopTokens(dir)
    expect(tokens?.uuid).toBe(uuid)
    const grants = JSON.parse(tokens?.v2 ?? '{}') as Record<string, Record<string, unknown>>
    const grant = grants[CLAUDE_CODE_KEY(uuid)]
    expect(grant?.token).toBe('new-access')
    expect(grant?.refreshToken).toBe('new-refresh')
    expect(grant?.expiresAt).toBe(now + 28800 * 1000)
    expect(grant?.subscriptionType).toBe('max')
  })

  test('names expired-login accounts by number in the waiting reason', () => {
    expect(
      expiredLoginNote([
        account(179, 'renewing'),
        account(5),
        account(182, 'renewing'),
        account(181, 'open-once'),
      ]),
    ).toBe(
      ' #179, #182: Claude Code login expired; renewing. #181: Claude Code login expired; open its desktop app once.',
    )
    expect(expiredLoginNote([account(5)])).toBe('')
  })
})
