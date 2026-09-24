// server/tests/accounts-grant-preference.test.ts — which of a desktop profile's grants is asked first.
//
// THE INCIDENT (instance #3, 2026-09-14). The profile held three grants, and the reader always took
// the one with the LATEST expiry: a year-long `user:inference user:file_upload user:profile` token.
// It had been revoked. Profile endpoint 401, usage endpoint 429, so the row sat yellow on a cached
// identity with usage frozen since 2026-09-07, while the app's own session grant beside it answered
// 200 on both. The fixture below is that profile's shape, with made-up tokens.

import { describe, expect, test } from 'bun:test'
import { orderInferenceGrants } from '../src/core/accounts'

const NOW = Date.UTC(2026, 8, 14, 5, 0, 0)
const DAY = 24 * 60 * 60_000
const ACCT = '00000000-0000-4000-8000-000000000001'
const ORG = '00000000-0000-4000-8000-000000000002'
const key = (scopes: string) => `${ACCT}:${ORG}:https://api.anthropic.com:${scopes}`

const SESSION = 'user:inference user:file_upload user:profile user:sessions:claude_code'
const PROFILE_ONLY = 'user:profile'
const YEAR_LONG = 'user:inference user:file_upload user:profile'

describe('orderInferenceGrants', () => {
  test("the app's session grant comes before a later-expiring year-long grant", () => {
    const parsed = {
      [key(SESSION)]: { token: 'tok-session', expiresAt: NOW + 30 * DAY },
      [key(PROFILE_ONLY)]: { token: 'tok-profile', expiresAt: NOW + 30 * DAY },
      [key(YEAR_LONG)]: { token: 'tok-year', expiresAt: NOW + 355 * DAY },
    }
    expect(orderInferenceGrants(parsed, NOW).map((g) => g.token)).toEqual([
      'tok-session',
      'tok-year',
    ])
  })

  test('the year-long grant is still offered, second, so a refused session grant falls through', () => {
    const parsed = {
      [key(YEAR_LONG)]: { token: 'tok-year', expiresAt: NOW + 355 * DAY },
      [key(SESSION)]: { token: 'tok-session', expiresAt: NOW + 30 * DAY },
    }
    const ordered = orderInferenceGrants(parsed, NOW)
    expect(ordered[1]?.token).toBe('tok-year')
    expect(ordered[1]?.scopes).toBe(YEAR_LONG)
  })

  test('a profile-only grant is never offered: its token reads no usage numbers', () => {
    const parsed = { [key(PROFILE_ONLY)]: { token: 'tok-profile', expiresAt: NOW + DAY } }
    expect(orderInferenceGrants(parsed, NOW)).toEqual([])
  })

  test('an expired session grant drops out and the unexpired grant answers alone', () => {
    const parsed = {
      [key(SESSION)]: { token: 'tok-session', expiresAt: NOW - DAY },
      [key(YEAR_LONG)]: { token: 'tok-year', expiresAt: NOW + 355 * DAY },
    }
    expect(orderInferenceGrants(parsed, NOW).map((g) => g.token)).toEqual(['tok-year'])
  })

  test('scopes ride along with each token, and a token shared by two grants is offered once', () => {
    const parsed = {
      [key(SESSION)]: { token: 'tok-same', expiresAt: NOW + 30 * DAY },
      [key(YEAR_LONG)]: { accessToken: 'tok-same', expiresAt: NOW + 355 * DAY },
    }
    expect(orderInferenceGrants(parsed, NOW)).toEqual([{ token: 'tok-same', scopes: SESSION }])
  })

  test('within the same rank the later expiry wins', () => {
    const parsed = {
      [key(`${YEAR_LONG} a`)]: { token: 'tok-sooner', expiresAt: NOW + 10 * DAY },
      [key(`${YEAR_LONG} b`)]: { token: 'tok-later', expiresAt: NOW + 20 * DAY },
    }
    expect(orderInferenceGrants(parsed, NOW).map((g) => g.token)).toEqual([
      'tok-later',
      'tok-sooner',
    ])
  })
})
