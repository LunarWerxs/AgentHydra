// server/tests/plan-label.test.ts — resolvePlanLabel: how CMAccount.planLabel (the "Plan" column)
// is derived.
//
// Evidence order: `organization.organization_type` from the live profile (authoritative and always
// current), then the rate-limit tier for 5×/20× granularity, then the OAuth grant's
// subscriptionType (which accounts.ts puts in `plan`), then nothing. The grant is a mint-time
// snapshot and is stale in BOTH directions — see the 2026-08-07 cases below. The
// has_claude_max/pro booleans remain distrusted; accounts.ts consults them only as a last resort.

import { describe, expect, test } from 'bun:test'
import { prettyTier, resolvePlanLabel } from '../src/core/shared'

describe('resolvePlanLabel', () => {
  describe('organization_type is authoritative', () => {
    test('a claude_free org is Free even when every other signal shouts Max 20×', () => {
      // REGRESSION, owner-reported 2026-08-07. lunawerx@gmail.com: the live profile says
      // organization_type "claude_free", billing_type "none", has_claude_max false — while all
      // THREE unexpired grants in its token cache still say subscriptionType "max" /
      // rateLimitTier "default_claude_max_20x". The row rendered "Max 20×" for a free account.
      expect(resolvePlanLabel('max', prettyTier('default_claude_max_20x'), 'claude_free')).toBe(
        'Free',
      )
      expect(resolvePlanLabel('max', prettyTier('default_claude_ai'), 'claude_free')).toBe('Free')
      expect(resolvePlanLabel(null, null, 'claude_free')).toBe('Free')
    })

    test('a claude_pro org is Pro even though its tier is the generic default_claude_ai', () => {
      // The 2026-08-06 case, now settled by orgType instead of by falling through to the grant:
      // an actively-paid Pro account genuinely reports rate_limit_tier "default_claude_ai".
      expect(resolvePlanLabel('pro', prettyTier('default_claude_ai'), 'claude_pro')).toBe('Pro')
      expect(resolvePlanLabel(null, null, 'claude_pro')).toBe('Pro')
    })

    test('a claude_max org takes its 5×/20× from the tier, and plain Max without one', () => {
      expect(resolvePlanLabel('max', prettyTier('default_claude_max_20x'), 'claude_max')).toBe(
        'Max 20×',
      )
      expect(resolvePlanLabel('max', prettyTier('default_claude_max_5x'), 'claude_max')).toBe(
        'Max 5×',
      )
      expect(resolvePlanLabel('max', prettyTier('default_claude_ai'), 'claude_max')).toBe('Max')
      expect(resolvePlanLabel('max', null, 'claude_max')).toBe('Max')
    })

    test('a stale grant tier cannot downgrade the org tier on a Max account', () => {
      // 2claude / temp1, measured 2026-08-07: org reports max_20x while the grant still carries
      // max_5x. accounts.ts now passes the ORG's tier, so this is what reaches here.
      expect(resolvePlanLabel('max', prettyTier('default_claude_max_20x'), 'claude_max')).toBe(
        'Max 20×',
      )
    })

    test('a non-Max tier never refines a Max family (family wins, tier only adds granularity)', () => {
      expect(resolvePlanLabel('pro', prettyTier('default_claude_pro'), 'claude_max')).toBe('Max')
    })

    test('team and enterprise families', () => {
      expect(resolvePlanLabel(null, null, 'claude_team')).toBe('Team')
      expect(resolvePlanLabel(null, null, 'claude_enterprise')).toBe('Enterprise')
    })

    test('an unrecognized organization_type falls through instead of guessing', () => {
      expect(resolvePlanLabel('max', prettyTier('default_claude_max_20x'), 'claude_startup')).toBe(
        'Max 20×',
      )
      // ...and never leaks the raw claude_* string.
      expect(resolvePlanLabel(null, null, 'claude_startup')).toBeNull()
    })
  })

  describe('without organization_type (offline / pre-2026-08-07 cache entries)', () => {
    test('a specific, recognized tier is used, keeping its 5×/20× granularity', () => {
      expect(resolvePlanLabel('max', prettyTier('default_claude_max_20x'))).toBe('Max 20×')
      expect(resolvePlanLabel('max', prettyTier('default_claude_max_5x'))).toBe('Max 5×')
      expect(resolvePlanLabel('pro', prettyTier('default_claude_pro'))).toBe('Pro')
      expect(resolvePlanLabel('free', prettyTier('default_claude_free'))).toBe('Free')
      expect(resolvePlanLabel(null, prettyTier('default_claude_team_x'))).toBe('Team')
      expect(resolvePlanLabel(null, prettyTier('default_claude_enterprise_x'))).toBe('Enterprise')
    })

    test('a generic default_claude_ai tier falls through to the grant, it is not proof of Free', () => {
      expect(resolvePlanLabel('pro', 'default_claude_ai')).toBe('Pro')
      expect(resolvePlanLabel('max', 'default_claude_ai')).toBe('Max')
      expect(resolvePlanLabel('claude_max', 'default_claude_ai')).toBe('Max')
      expect(resolvePlanLabel('free', 'default_claude_ai')).toBe('Free')
    })

    test('a generic tier with no subscription evidence behind it is Free', () => {
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
  })

  test('never leaks a raw default_* or claude_* string', () => {
    for (const tier of ['default_claude_ai', 'default_claude_unknown_future']) {
      for (const plan of [null, 'max', 'pro', 'free']) {
        for (const orgType of [null, 'claude_free', 'claude_max', 'claude_unknown_future']) {
          const out = resolvePlanLabel(plan, tier, orgType)
          expect(out === null || (!out.startsWith('default_') && !out.startsWith('claude_'))).toBe(
            true,
          )
        }
      }
    }
  })
})
