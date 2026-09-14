// server/tests/usage-grant-fallthrough.test.ts — a desktop profile's grants are tried in order.
//
// Instance #3, 2026-09-14: the only grant ever tried was a revoked one (usage 429, profile 401), so
// a working account read as rate-limited for a week while its live grant sat unused. These pin that
// a credential-specific failure moves on to the next grant, a shared one (no network) does not
// multiply, and the reported failure is the PREFERRED grant's. Mocked fetch only: no live call, no
// spawn (an injected token never spawns - see usage-backoff.test.ts).

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resetUsageApiBackoff } from '../src/usage'
import { checkUsageWithGrants } from '../src/usage-service'

const SESSION = {
  token: 'sk-ant-oat-test-session',
  scopes: 'user:inference user:sessions:claude_code',
}
const YEAR = {
  token: 'sk-ant-oat-test-year',
  scopes: 'user:inference user:file_upload user:profile',
}

const ok = () =>
  new Response(
    JSON.stringify({
      limits: [
        { kind: 'weekly_all', percent: 7, severity: 'normal', resets_at: '2026-09-18T15:00:00Z' },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
const status = (code: number) =>
  new Response('{}', { status: code, headers: { 'retry-after': '3600' } })

/** A fetch whose answer depends on which token presented itself; counts calls per token. */
function fetchBy(answers: Record<string, () => Response>) {
  const calls: string[] = []
  const fn = mock(async (_url: unknown, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
    const token = Object.keys(answers).find((t) => auth.endsWith(t)) ?? '?'
    calls.push(token)
    const answer = answers[token]
    if (!answer) throw new TypeError('fetch failed')
    return answer()
  })
  globalThis.fetch = fn as unknown as typeof fetch
  return calls
}

const realFetch = globalThis.fetch
beforeEach(() => resetUsageApiBackoff())
afterEach(() => {
  globalThis.fetch = realFetch
  resetUsageApiBackoff()
})

describe('checkUsageWithGrants', () => {
  test('the preferred grant reads, and the next one is never asked', async () => {
    const calls = fetchBy({ [SESSION.token]: ok, [YEAR.token]: () => status(429) })
    const r = await checkUsageWithGrants([SESSION, YEAR], 'acct-1')
    expect(r.snapshot?.weekAll?.pct).toBe(7)
    expect(calls).toEqual([SESSION.token])
  })

  test.each([401, 403, 429])('a %i on one grant moves on to the next', async (code) => {
    const calls = fetchBy({ [YEAR.token]: () => status(code), [SESSION.token]: ok })
    const r = await checkUsageWithGrants([YEAR, SESSION], 'acct-2')
    expect(r.snapshot?.weekAll?.pct).toBe(7)
    expect(calls).toEqual([YEAR.token, SESSION.token])
  })

  test('a failure every grant would share (no network) is not repeated per grant', async () => {
    const calls = fetchBy({})
    const r = await checkUsageWithGrants([SESSION, YEAR], 'acct-3')
    expect(r.snapshot).toBeNull()
    expect(calls).toHaveLength(1)
    expect(r.failure?.status).toBe(0)
  })

  test("the reported failure is the preferred grant's, not a leftover's 429", async () => {
    // The shape of a profile whose session grant is signed out and whose year-long token is revoked:
    // calling that "rate limited" would send the owner to wait out a limit instead of opening the app.
    fetchBy({ [SESSION.token]: () => status(401), [YEAR.token]: () => status(429) })
    const r = await checkUsageWithGrants([SESSION, YEAR], 'acct-4')
    expect(r.snapshot).toBeNull()
    expect(r.failure?.status).toBe(401)
  })

  test('no grants: nothing asked, nothing reported', async () => {
    const calls = fetchBy({})
    expect(await checkUsageWithGrants([], 'acct-5')).toEqual({ snapshot: null, failure: null })
    expect(calls).toHaveLength(0)
  })
})
