// server/tests/codex-account.test.ts — Codex/ChatGPT instance-account identity + quota mapping.
//
// The pure, machine-independent halves of core/codex-account.ts: the plan label's evidence rules,
// the JWT claim decode, and the rate-limit mapping onto the shared UsageSnapshot. Everything here
// runs off synthetic auth files and hand-built responses, so none of it needs a real ChatGPT login.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  CODEX_USAGE_API_URL,
  codexPlanLabel,
  codexUsageSnapshot,
  decodeJwtClaims,
  formatCodexReset,
  localCodexAccount,
  readCodexAuth,
  redeemCodexResetCredit,
} from '../src/core/codex-account'

// --- helpers ------------------------------------------------------------------

const tmpDirs: string[] = []
function makeCodexHome(auth: unknown | null): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'agh-codex-'))
  tmpDirs.push(dir)
  if (auth !== null) writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth))
  return dir
}
function cleanup(): void {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
}

/** A JWT with the given payload. Unsigned — decodeJwtClaims never verifies, by design. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

const AUTH_NS = 'https://api.openai.com/auth'

function chatgptAuth(
  over: { planType?: string; email?: string; name?: string; accountId?: string; exp?: number } = {},
) {
  const accountId = over.accountId ?? 'acct-1'
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({
        email: over.email ?? 'user@example.com',
        name: over.name ?? 'Example User',
        [AUTH_NS]: {
          chatgpt_plan_type: over.planType ?? 'plus',
          chatgpt_account_id: accountId,
          chatgpt_user_id: 'user-1',
          chatgpt_subscription_active_until: '2026-09-01T00:00:00+00:00',
          organizations: [{ id: 'org-1', is_default: true, title: 'Personal' }],
        },
      }),
      // Far-future expiry so the token never reads as stale in these tests.
      access_token: jwt({ exp: 4_102_444_800 }),
      account_id: accountId,
    },
  }
}

// --- plan label ---------------------------------------------------------------

describe('codexPlanLabel', () => {
  test('maps the known ChatGPT tiers', () => {
    expect(codexPlanLabel('free')).toBe('Free')
    expect(codexPlanLabel('plus')).toBe('Plus')
    expect(codexPlanLabel('pro')).toBe('Pro')
    expect(codexPlanLabel('business')).toBe('Business')
    expect(codexPlanLabel('team')).toBe('Team')
    expect(codexPlanLabel('enterprise')).toBe('Enterprise')
  })

  test('is case- and whitespace-tolerant', () => {
    expect(codexPlanLabel('  PLUS ')).toBe('Plus')
  })

  test('title-cases an unknown tier rather than dropping it', () => {
    // A new plan name must render readably instead of vanishing from the column.
    expect(codexPlanLabel('startup')).toBe('Startup')
  })

  test('nothing to show stays null', () => {
    expect(codexPlanLabel(null)).toBeNull()
    expect(codexPlanLabel(undefined)).toBeNull()
    expect(codexPlanLabel('')).toBeNull()
    expect(codexPlanLabel('   ')).toBeNull()
  })
})

// --- JWT claims ---------------------------------------------------------------

describe('decodeJwtClaims', () => {
  test('reads the payload of a well-formed token', () => {
    expect(decodeJwtClaims(jwt({ email: 'a@b.c', exp: 123 }))).toEqual({ email: 'a@b.c', exp: 123 })
  })

  test('never throws on junk', () => {
    expect(decodeJwtClaims(null)).toBeNull()
    expect(decodeJwtClaims(undefined)).toBeNull()
    expect(decodeJwtClaims('')).toBeNull()
    expect(decodeJwtClaims('not-a-jwt')).toBeNull()
    expect(decodeJwtClaims('a.b')).toBeNull()
    expect(decodeJwtClaims('a.!!!not-base64!!!.c')).toBeNull()
    // Valid base64 that isn't JSON.
    expect(decodeJwtClaims(`a.${Buffer.from('hello').toString('base64url')}.c`)).toBeNull()
  })
})

// --- auth.json reading + local identity ---------------------------------------

describe('readCodexAuth / localCodexAccount', () => {
  test('a missing or corrupt auth.json is "logged out", never an exception', () => {
    try {
      expect(readCodexAuth(makeCodexHome(null))).toBeNull()
      expect(localCodexAccount(makeCodexHome(null)).status).toBe('loggedout')

      const corrupt = makeCodexHome(null)
      writeFileSync(join(corrupt, 'auth.json'), '{not json at all')
      expect(localCodexAccount(corrupt).status).toBe('loggedout')

      expect(localCodexAccount('').status).toBe('loggedout')
      expect(localCodexAccount('C:/no/such/codex/home').status).toBe('loggedout')
    } finally {
      cleanup()
    }
  })

  test('a ChatGPT login yields the full identity from the id_token claims', () => {
    try {
      const account = localCodexAccount(
        makeCodexHome(chatgptAuth({ planType: 'pro', email: 'me@example.com', name: 'Me' })),
      )
      expect(account.authMode).toBe('chatgpt')
      expect(account.email).toBe('me@example.com')
      expect(account.name).toBe('Me')
      expect(account.planType).toBe('pro')
      expect(account.planLabel).toBe('Pro')
      expect(account.accountId).toBe('acct-1')
      expect(account.userId).toBe('user-1')
      expect(account.orgTitle).toBe('Personal')
      expect(account.subscriptionActiveUntil).toBe('2026-09-01T00:00:00+00:00')
      expect(account.label).toBe('Me <me@example.com> · Pro')
    } finally {
      cleanup()
    }
  })

  test('an API-key login is reported as such, with no plan and no quota', () => {
    // A valid Codex auth that has no ChatGPT subscription behind it. Rendering it as a broken
    // ChatGPT login would send someone hunting for a problem that isn't there.
    try {
      const account = localCodexAccount(
        makeCodexHome({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test', tokens: null }),
      )
      expect(account.authMode).toBe('apikey')
      expect(account.planLabel).toBeNull()
      expect(account.label).toBe('API key')
    } finally {
      cleanup()
    }
  })

  test('never returns a token, whatever the auth file holds', () => {
    try {
      const account = localCodexAccount(makeCodexHome(chatgptAuth()))
      const serialized = JSON.stringify(account)
      expect(serialized).not.toContain('id_token')
      expect(serialized).not.toContain('access_token')
      expect(serialized).not.toContain('sk-test')
    } finally {
      cleanup()
    }
  })
})

// --- usage mapping ------------------------------------------------------------

describe('codexUsageSnapshot', () => {
  const win = (usedPercent: number, windowSeconds: number, resetAt: number) => ({
    used_percent: usedPercent,
    limit_window_seconds: windowSeconds,
    reset_after_seconds: 1,
    reset_at: resetAt,
  })
  const RESET_AT = 1_786_666_024

  test('assigns windows by DURATION, not by primary/secondary', () => {
    // The observed Plus shape: a single 7-day window arriving as PRIMARY. Keying off the position
    // would file it as a 5-hour session and mislabel the plan tier's only real cap.
    const snap = codexUsageSnapshot(
      { rate_limit: { primary_window: win(99, 604_800, RESET_AT), secondary_window: null } },
      'me',
    )
    expect(snap.session).toBeNull()
    expect(snap.weekAll?.pct).toBe(99)
    expect(snap.weekAll?.resetsAt).toBe(new Date(RESET_AT * 1000).toISOString())
  })

  test('a short primary window is the session, and a long secondary is still the week', () => {
    const snap = codexUsageSnapshot(
      {
        rate_limit: {
          primary_window: win(40, 5 * 60 * 60, RESET_AT),
          secondary_window: win(70, 604_800, RESET_AT),
        },
      },
      'me',
    )
    expect(snap.session?.pct).toBe(40)
    expect(snap.weekAll?.pct).toBe(70)
  })

  test('severity matches the chip colours the web app already uses', () => {
    const at = (pct: number) =>
      codexUsageSnapshot({ rate_limit: { primary_window: win(pct, 604_800, RESET_AT) } }, null)
        .weekAll?.severity
    expect(at(10)).toBe('normal')
    expect(at(70)).toBe('warning')
    expect(at(91)).toBe('critical')
  })

  test('no rate_limit at all is the all-null "checked, nothing to report" snapshot', () => {
    const snap = codexUsageSnapshot(null, 'me')
    expect(snap.session).toBeNull()
    expect(snap.weekAll).toBeNull()
    expect(snap.weekModel).toBeNull()
    expect(snap.account).toBe('me')
    expect(snap.source).toBe('api')
  })

  test('weekModel stays null — OpenAI publishes no per-model sub-limit', () => {
    const snap = codexUsageSnapshot(
      { rate_limit: { primary_window: win(50, 604_800, RESET_AT) } },
      null,
    )
    expect(snap.weekModel).toBeNull()
  })

  test('a window with no percentage is skipped rather than rendered as 0%', () => {
    const snap = codexUsageSnapshot(
      { rate_limit: { primary_window: { limit_window_seconds: 604_800 } } },
      null,
    )
    expect(snap.weekAll).toBeNull()
  })

  test('parses the banked reset-credit count off rate_limit_reset_credits', () => {
    const snap = codexUsageSnapshot(
      {
        rate_limit: { primary_window: win(50, 604_800, RESET_AT) },
        rate_limit_reset_credits: { available_count: 2 },
      },
      null,
    )
    expect(snap.resetCredits).toBe(2)
  })

  test('a live body reporting no reset credits is a known zero, not unknown', () => {
    const snap = codexUsageSnapshot(
      { rate_limit: { primary_window: win(50, 604_800, RESET_AT) } },
      null,
    )
    expect(snap.resetCredits).toBe(0)
  })

  test('no body at all leaves resetCredits null rather than a fabricated zero', () => {
    expect(codexUsageSnapshot(null, 'me').resetCredits).toBeNull()
  })
})

describe('formatCodexReset', () => {
  test('drops ":00" the way the CLI screen does, and passes junk through as empty', () => {
    const d = new Date(2026, 7, 13, 19, 7)
    expect(formatCodexReset(d.toISOString())).toBe('Aug 13, 7:07pm')
    expect(formatCodexReset(new Date(2026, 7, 13, 15, 0).toISOString())).toBe('Aug 13, 3pm')
    expect(formatCodexReset(null)).toBe('')
    expect(formatCodexReset('garbage')).toBe('')
  })
})

// --- redeemCodexResetCredit -----------------------------------------------------
//
// Mocks globalThis.fetch (the same pattern instances-crypto.test.ts and github-updater.test.ts
// use) rather than hitting the real Codex backend, so every scenario runs offline and
// deterministically. Each test restores the original fetch in a `finally`.

describe('redeemCodexResetCredit', () => {
  // Rides in the JWT's "signature" segment — decodeJwtClaims never reads past the payload, so
  // this is a realistic stand-in for the opaque bytes a real token's signature would be.
  const TOKEN_MARKER = 'SECRET-ACCESS-TOKEN-MUST-NEVER-LEAK'

  function makeToken(exp = 4_102_444_800): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    return `${b64({ alg: 'none' })}.${b64({ exp })}.${TOKEN_MARKER}`
  }

  function homeWithToken(token: string | null, accountId = 'acct-1'): string {
    return makeCodexHome(
      token === null
        ? { auth_mode: 'chatgpt', tokens: null }
        : {
            auth_mode: 'chatgpt',
            tokens: { access_token: token, id_token: null, account_id: accountId },
          },
    )
  }

  function usageBody(
    opts: { available?: number; primaryPct?: number | null; secondaryPct?: number | null } = {},
  ) {
    const rl: Record<string, unknown> = {}
    if (opts.primaryPct != null) rl.primary_window = { used_percent: opts.primaryPct }
    if (opts.secondaryPct != null) rl.secondary_window = { used_percent: opts.secondaryPct }
    return { rate_limit: rl, rate_limit_reset_credits: { available_count: opts.available ?? 0 } }
  }

  /** Routes a GET to the usage payload and a POST-to-.../consume to the consume payload, by URL —
   *  the same input/init shape github-updater.test.ts's fetch mocks use (the server tsconfig has
   *  no DOM lib, so `input`/`init` are typed loosely rather than as RequestInfo/RequestInit). */
  function mockFetch(
    usage: unknown,
    consume: unknown = { code: 'reset', windows_reset: 2 },
    opts: { usageStatus?: number; consumeStatus?: number; calls?: string[] } = {},
  ): typeof fetch {
    return (async (input: unknown, init?: { method?: string }) => {
      const url =
        typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
      opts.calls?.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('/rate-limit-reset-credits/consume'))
        return new Response(JSON.stringify(consume), { status: opts.consumeStatus ?? 200 })
      return new Response(JSON.stringify(usage), { status: opts.usageStatus ?? 200 })
    }) as unknown as typeof fetch
  }

  test('no credentials -> unavailable, and never touches the network', async () => {
    const home = homeWithToken(null)
    const originalFetch = globalThis.fetch
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as typeof fetch
    try {
      const result = await redeemCodexResetCredit(home)
      expect(result.ok).toBe(false)
      expect(result.status).toBe('unavailable')
      expect(called).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })

  test('reuses the already-verified fixed CODEX_USAGE_API_URL rather than a re-derived one', async () => {
    const home = homeWithToken(makeToken())
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch(usageBody({ available: 0 }), undefined, { calls })
    try {
      await redeemCodexResetCredit(home)
      expect(calls[0]).toBe(`GET ${CODEX_USAGE_API_URL}`)
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })

  test('no banked credits refuses before any redeem is attempted', async () => {
    const home = homeWithToken(makeToken())
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch(usageBody({ available: 0, primaryPct: 100 }), undefined, { calls })
    try {
      const result = await redeemCodexResetCredit(home)
      expect(result.ok).toBe(false)
      expect(result.status).toBe('no_credits_banked')
      expect(calls.some((c) => c.includes('consume'))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })

  test('busiest window under the exhausted threshold refuses without force, reporting the pct', async () => {
    const home = homeWithToken(makeToken())
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch(
      usageBody({ available: 3, primaryPct: 40, secondaryPct: 61 }),
      undefined,
      { calls },
    )
    try {
      const result = await redeemCodexResetCredit(home)
      expect(result.ok).toBe(false)
      expect(result.status).toBe('not_exhausted')
      expect(result.busiestWindowPct).toBe(61)
      expect(result.availableCount).toBe(3)
      expect(calls.some((c) => c.includes('consume'))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })

  test('force redeems even with headroom left in both windows', async () => {
    const home = homeWithToken(makeToken())
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch(
      usageBody({ available: 3, primaryPct: 10, secondaryPct: 5 }),
      { code: 'reset', windows_reset: 2 },
      { calls },
    )
    try {
      const result = await redeemCodexResetCredit(home, { force: true })
      expect(result.ok).toBe(true)
      expect(result.status).toBe('reset')
      expect(result.availableCount).toBe(2)
      expect(result.windowsReset).toBe(2)
      expect(calls.some((c) => c.startsWith('POST') && c.includes('consume'))).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })

  test('a fully-used window redeems without force', async () => {
    const home = homeWithToken(makeToken())
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch(usageBody({ available: 1, primaryPct: 100, secondaryPct: 12 }), {
      code: 'reset',
      windows_reset: 2,
    })
    try {
      const result = await redeemCodexResetCredit(home)
      expect(result.ok).toBe(true)
      expect(result.status).toBe('reset')
      expect(result.availableCount).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })

  test("nothing_to_reset doesn't spend the credit", async () => {
    const home = homeWithToken(makeToken())
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch(usageBody({ available: 2, primaryPct: 100 }), {
      code: 'nothing_to_reset',
    })
    try {
      const result = await redeemCodexResetCredit(home)
      expect(result.ok).toBe(false)
      expect(result.status).toBe('nothing_to_reset')
      expect(result.availableCount).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })

  test('an HTTP error on the usage read is a structured refusal, not a throw', async () => {
    const home = homeWithToken(makeToken())
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch(usageBody(), undefined, { usageStatus: 500 })
    try {
      const result = await redeemCodexResetCredit(home)
      expect(result.ok).toBe(false)
      expect(result.status).toBe('unavailable')
      expect(result.message).toContain('500')
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })

  test('an HTTP 401 on consume names the ChatGPT sign-in requirement', async () => {
    const home = homeWithToken(makeToken())
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch(usageBody({ available: 1, primaryPct: 100 }), undefined, {
      consumeStatus: 401,
    })
    try {
      const result = await redeemCodexResetCredit(home)
      expect(result.ok).toBe(false)
      expect(result.status).toBe('unavailable')
      expect(result.message).toContain('ChatGPT-account')
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })

  test('a network failure returns a structured refusal instead of throwing', async () => {
    const home = homeWithToken(makeToken())
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('getaddrinfo ENOTFOUND chatgpt.com')
    }) as unknown as typeof fetch
    try {
      const result = await redeemCodexResetCredit(home)
      expect(result.ok).toBe(false)
      expect(result.status).toBe('unavailable')
      expect(result.message).toContain('Could not reach')
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })

  test('the access token never appears in any result, across success and every failure path', async () => {
    const token = makeToken()
    const home = homeWithToken(token)
    const originalFetch = globalThis.fetch
    const scenarios: Array<() => typeof fetch> = [
      () =>
        mockFetch(usageBody({ available: 1, primaryPct: 100 }), {
          code: 'reset',
          windows_reset: 1,
        }),
      () => mockFetch(usageBody({ available: 2, primaryPct: 30 })), // not_exhausted refusal
      () => mockFetch(usageBody(), undefined, { usageStatus: 403 }), // HTTP error
      // A genuine network failure's own error text has no reason to contain the token (it never
      // reaches the request layer that would echo it) — this scenario checks our code doesn't
      // manufacture one that does, not that we can scrub an adversarial message.
      () =>
        (async () => {
          throw new Error('getaddrinfo ENOTFOUND chatgpt.com')
        }) as unknown as typeof fetch,
    ]
    try {
      for (const build of scenarios) {
        globalThis.fetch = build()
        const result = await redeemCodexResetCredit(home)
        const serialized = JSON.stringify(result)
        expect(serialized).not.toContain(TOKEN_MARKER)
        expect(serialized).not.toContain(token)
      }
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })
})
