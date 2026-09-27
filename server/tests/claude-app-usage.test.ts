// What claude.ai's own usage body says, folded into the snapshot's facts. The shapes are the live
// ones read from seven running apps on 2026-09-25 (see server/src/claude-app-usage.ts); the
// unclaimed and held-back credit cases are fixtures because no live account was in either state.
import { describe, expect, test } from 'bun:test'
import { summarizeClaudeAppUsage } from '../src/claude-app-usage'

// Every instant is an offset from a fixed far-past `now`: the fold reads only the `now` it is
// handed, so which side of it each date falls on can never drift with the wall clock.
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const now = Date.parse('2001-01-01T00:00:00Z')
const CREDIT_ENDS = now + 41 * DAY + 7 * HOUR + 59 * 60 * 1000
const GRANT_ENDS = now + 27 * DAY + 16 * HOUR
const ENDED = now - 24 * DAY
const LATER = now + 6 * DAY
/** The normalised form the fold returns. */
const iso = (at: number) => new Date(at).toISOString()
/** The two wire forms claude.ai sends: an explicit offset, or a bare Z without milliseconds. */
const wire = (at: number) => iso(at).replace('.000Z', '+00:00')
const wireZ = (at: number) => iso(at).replace('.000Z', 'Z')
const credit = (over: Record<string, unknown> = {}) => ({
  limit_dollars: 250,
  remaining_dollars: 246.108598,
  resets_at: wire(CREDIT_ENDS),
  locked_reason: null,
  ...over,
})

describe('summarizeClaudeAppUsage', () => {
  test('reads resets, the credit, usage credits and the weekly split as claude.ai reports them', () => {
    const reading = summarizeClaudeAppUsage(
      {
        grants: [
          { resets_left: 1, ends_at: wire(GRANT_ENDS) },
          { resets_left: 2, ends_at: wire(ENDED) }, // ended: never counts
          { resets_left: 0, ends_at: wire(LATER) }, // spent
        ],
        credit: credit(),
        promo: { claimed: true, eligible: false, expires_at: wireZ(CREDIT_ENDS) },
        spend: {
          enabled: true,
          disabled_reason: null,
          used: { amount_minor: 389, currency: 'USD', exponent: 2 },
          limit: { amount_minor: 10000, currency: 'USD', exponent: 2 },
        },
        split: [
          { key: 'claude_code', label: 'Claude Code', pct: 97 },
          { key: 'chat', label: 'Chats', pct: 3 },
        ],
      },
      now,
    )
    expect(reading?.resets).toEqual({ resetsLeft: 1, expiresAt: iso(GRANT_ENDS) })
    expect(reading?.app.codeCredit).toEqual({
      state: 'active',
      limitUsd: 250,
      remainingUsd: 246.108598,
      expiresAt: iso(CREDIT_ENDS),
      lockedReason: null,
    })
    expect(reading?.app.usageCredits).toEqual({
      enabled: true,
      disabledReason: null,
      used: 3.89,
      limit: 100,
      currency: 'USD',
    })
    expect(reading?.app.weeklySplit?.map((r) => `${r.label} ${r.pct}`)).toEqual([
      'Claude Code 97',
      'Chats 3',
    ])
  })

  test('only a claim claude.ai confirms reads as money left', () => {
    const offered = summarizeClaudeAppUsage(
      { credit: credit(), promo: { claimed: false, eligible: true, expires_at: null } },
      now,
    )
    expect(offered?.app.codeCredit?.state).toBe('unclaimed')
    // The claim request failed: claude.ai's own page shows no balance then, and neither does this.
    expect(
      summarizeClaudeAppUsage({ credit: credit(), promo: null }, now)?.app.codeCredit,
    ).toBeNull()
  })

  test('a credit held back reads as held back, and an expired one is gone', () => {
    const promo = { claimed: true, eligible: false, expires_at: wireZ(CREDIT_ENDS) }
    const held = summarizeClaudeAppUsage(
      { credit: credit({ locked_reason: 'review' }), promo },
      now,
    )
    expect(held?.app.codeCredit).toMatchObject({ state: 'locked', lockedReason: 'review' })
    const expired = summarizeClaudeAppUsage(
      { credit: credit({ resets_at: wire(ENDED) }), promo },
      now,
    )
    expect(expired?.app.codeCredit).toBeNull()
  })
})
