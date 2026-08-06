// server/tests/plan-label.test.ts — resolvePlanLabel: how CMAccount.planLabel (the "Plan" column)
// is derived.
//
// Evidence order: a SPECIFIC rate-limit tier, then the OAuth grant's subscriptionType (which
// accounts.ts puts in `plan`), then nothing. A GENERIC `default_claude_ai` tier is not evidence of
// anything and must not override the grant — see the 2026-08-06 case below. The separate
// has_claude_max/pro booleans remain distrusted; accounts.ts no longer lets them overwrite a grant.

import { describe, expect, test } from 'bun:test'
import { prettyTier, resolvePlanLabel } from '../src/core/shared'

describe('resolvePlanLabel', () => {
  test('trusts a specific, recognized tier and keeps its 5×/20× granularity', () => {
    expect(resolvePlanLabel('max', prettyTier('default_claude_max_20x'))).toBe('Max 20×')
    expect(resolvePlanLabel('max', prettyTier('default_claude_max_5x'))).toBe('Max 5×')
    expect(resolvePlanLabel('pro', prettyTier('default_claude_pro'))).toBe('Pro')
    expect(resolvePlanLabel('free', prettyTier('default_claude_free'))).toBe('Free')
    expect(resolvePlanLabel(null, prettyTier('default_claude_team_x'))).toBe('Team')
    expect(resolvePlanLabel(null, prettyTier('default_claude_enterprise_x'))).toBe('Enterprise')
  })

  test('a specific tier still wins over a disagreeing plan', () => {
    // The tier is the only signal with 5×/20× granularity, so it is never overridden by the
    // coarser subscriptionType.
    expect(resolvePlanLabel('pro', prettyTier('default_claude_max_20x'))).toBe('Max 20×')
    expect(resolvePlanLabel('max', prettyTier('default_claude_pro'))).toBe('Pro')
  })

  test('a generic default_claude_ai tier falls through to the grant, it is not proof of Free', () => {
    // REGRESSION, owner-reported 2026-08-06: an actively-paid Pro account reports
    // `rateLimitTier: "default_claude_ai"` on its own grant (verified by decrypting the token
    // cache: sub=pro, tier=default_claude_ai, unexpired). Treating the generic tier as "this
    // account is free" labelled a live Pro account Free. The generic value means the tier signal
    // knows nothing; the grant's subscriptionType is what answers.
    expect(resolvePlanLabel('pro', 'default_claude_ai')).toBe('Pro')
    expect(resolvePlanLabel('max', 'default_claude_ai')).toBe('Max')
    expect(resolvePlanLabel('claude_max', 'default_claude_ai')).toBe('Max')
    expect(resolvePlanLabel('free', 'default_claude_ai')).toBe('Free')
  })

  test('a generic tier with no subscription evidence behind it is Free', () => {
    // The genuine free/default account: Anthropic reports the generic tier and there is no
    // subscription type to describe.
    expect(resolvePlanLabel(null, 'default_claude_ai')).toBe('Free')
    expect(resolvePlanLabel('', 'default_claude_ai')).toBe('Free')
  })

  test('with no tier at all, falls back to the plan (best-effort)', () => {
    expect(resolvePlanLabel('max', null)).toBe('Max')
    expect(resolvePlanLabel('claude_pro', null)).toBe('Pro')
    // An unrecognized non-default plan passes through as-is rather than being dropped.
    expect(resolvePlanLabel('startup', null)).toBe('startup')
    expect(resolvePlanLabel(null, null)).toBeNull()
    expect(resolvePlanLabel(null, '')).toBeNull()
  })

  test('never leaks a raw default_* string', () => {
    for (const tier of ['default_claude_ai', 'default_claude_unknown_future']) {
      for (const plan of [null, 'max', 'pro', 'free']) {
        const out = resolvePlanLabel(plan, tier)
        expect(out === null || !out.startsWith('default_')).toBe(true)
      }
    }
  })
})
