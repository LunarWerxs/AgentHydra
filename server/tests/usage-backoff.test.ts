// server/tests/usage-backoff.test.ts — the fix for "usage never reads for the active accounts".
//
// `/api/oauth/usage` rate-limits per account and, when it 429s, hands back a Retry-After of tens of
// minutes. The fleet has several pollers (sweep, reset-watch, resume monitor, open web app), so a
// tripped account was re-hit every ~30s and could never recover — its usage read as a permanent
// "rate limited". checkUsage now records the server's Retry-After and SKIPS the endpoint until the
// window lifts. These tests pin that behaviour with a mocked fetch, never a live call or a spawn.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  checkUsage,
  isNoData,
  lastUsageApiFailure,
  resetUsageApiBackoff,
  usageApiBackoffMsRemaining,
} from '../src/usage'

const AUTH = { authType: 'oauth_token', secret: 'sk-ant-oat-test-not-a-real-token' } as const

const res429 = (retryAfter?: string): Response =>
  new Response(
    JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited. Try later.' } }),
    { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} },
  )

const res200 = (): Response =>
  new Response(
    JSON.stringify({
      limits: [
        { kind: 'weekly_all', percent: 42, severity: 'normal', resets_at: '2026-09-18T15:00:00Z' },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

const realFetch = globalThis.fetch

beforeEach(() => {
  resetUsageApiBackoff()
})
afterEach(() => {
  globalThis.fetch = realFetch
  resetUsageApiBackoff()
})

describe('usage API 429 backoff', () => {
  test('a 429 arms a per-label backoff, and the next check does NOT re-hit the endpoint', async () => {
    const fetchSpy = mock(async () => res429('1800'))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const first = await checkUsage({ auth: AUTH, account: 'acct-a' })
    expect(isNoData(first)).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(usageApiBackoffMsRemaining('acct-a')).toBeGreaterThan(0)

    // The whole point: a second poll inside the window must not call the endpoint again.
    const second = await checkUsage({ auth: AUTH, account: 'acct-a' })
    expect(isNoData(second)).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // …and it still reports rate_limited with a live countdown, so the UI reads "retry in N min".
    const fail = lastUsageApiFailure('acct-a')
    expect(fail?.status).toBe(429)
    expect(fail?.retryAfterSec).toBeGreaterThan(0)
    expect(fail?.retryAfterSec).toBeLessThanOrEqual(1800)
  })

  test('the backoff is per label — one rate-limited account never silences another', async () => {
    const fetchSpy = mock(async () => res429('1800'))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await checkUsage({ auth: AUTH, account: 'acct-a' })
    expect(usageApiBackoffMsRemaining('acct-a')).toBeGreaterThan(0)
    // A different label has no backoff, so it is still free to try (and here also 429s).
    expect(usageApiBackoffMsRemaining('acct-b')).toBe(0)
    await checkUsage({ auth: AUTH, account: 'acct-b' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test('a 429 with no Retry-After still arms a conservative default backoff (no 30s knocking)', async () => {
    const fetchSpy = mock(async () => res429())
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await checkUsage({ auth: AUTH, account: 'acct-c' })
    const remaining = usageApiBackoffMsRemaining('acct-c')
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(60_000)
  })

  test('once the window lifts, a good read goes through and clears the backoff', async () => {
    const fetchSpy = mock(async () => res429('1')) // 1-second window
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    await checkUsage({ auth: AUTH, account: 'acct-d' })
    expect(usageApiBackoffMsRemaining('acct-d')).toBeGreaterThan(0)

    await new Promise((r) => setTimeout(r, 1100))
    expect(usageApiBackoffMsRemaining('acct-d')).toBe(0)

    const okSpy = mock(async () => res200())
    globalThis.fetch = okSpy as unknown as typeof fetch
    const snap = await checkUsage({ auth: AUTH, account: 'acct-d' })
    expect(okSpy).toHaveBeenCalledTimes(1)
    expect(snap.weekAll?.pct).toBe(42)
    expect(usageApiBackoffMsRemaining('acct-d')).toBe(0)
    expect(lastUsageApiFailure('acct-d')).toBeNull()
  })

  test('usageApiBackoffMsRemaining reports 0 from a vantage point past the window', async () => {
    const fetchSpy = mock(async () => res429('1800'))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    await checkUsage({ auth: AUTH, account: 'acct-e' })
    // Same instant: still waiting. Two hours later: clear.
    expect(usageApiBackoffMsRemaining('acct-e')).toBeGreaterThan(0)
    expect(usageApiBackoffMsRemaining('acct-e', Date.now() + 2 * 60 * 60 * 1000)).toBe(0)
  })
})
