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
  codexPlanLabel,
  codexUsageSnapshot,
  decodeJwtClaims,
  formatCodexReset,
  localCodexAccount,
  readCodexAuth,
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
