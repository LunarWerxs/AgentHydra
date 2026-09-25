// What claude.ai's own usage body says, folded into the snapshot's facts. The shapes are the live
// ones read from seven running apps on 2026-09-25 (see server/src/claude-app-usage.ts); the
// unclaimed and held-back credit cases are fixtures because no live account was in either state.
import { describe, expect, test } from 'bun:test'
import { summarizeClaudeAppUsage } from '../src/claude-app-usage'

const now = Date.parse('2026-09-25T00:00:00Z')
const credit = (over: Record<string, unknown> = {}) => ({
  limit_dollars: 250,
  remaining_dollars: 246.108598,
  resets_at: '2026-11-05T07:59:00+00:00',
  locked_reason: null,
  ...over,
})

describe('summarizeClaudeAppUsage', () => {
  test('reads resets, the credit, usage credits and the weekly split as claude.ai reports them', () => {
    const reading = summarizeClaudeAppUsage(
      {
        grants: [
          { resets_left: 1, ends_at: '2026-10-22T16:00:00+00:00' },
          { resets_left: 2, ends_at: '2026-09-01T00:00:00+00:00' }, // ended: never counts
          { resets_left: 0, ends_at: '2026-10-01T00:00:00+00:00' }, // spent
        ],
        credit: credit(),
        promo: { claimed: true, eligible: false, expires_at: '2026-11-05T07:59:00Z' },
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
    expect(reading?.resets).toEqual({ resetsLeft: 1, expiresAt: '2026-10-22T16:00:00.000Z' })
    expect(reading?.app.codeCredit).toEqual({
      state: 'active',
      limitUsd: 250,
      remainingUsd: 246.108598,
      expiresAt: '2026-11-05T07:59:00.000Z',
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

  test('a credit that was offered but never claimed is never read as money left', () => {
    const reading = summarizeClaudeAppUsage(
      { credit: credit(), promo: { claimed: false, eligible: true, expires_at: null } },
      now,
    )
    expect(reading?.app.codeCredit?.state).toBe('unclaimed')
  })

  test('a credit held back reads as held back, and an expired one is gone', () => {
    const held = summarizeClaudeAppUsage({ credit: credit({ locked_reason: 'review' }) }, now)
    expect(held?.app.codeCredit).toMatchObject({ state: 'locked', lockedReason: 'review' })
    const expired = summarizeClaudeAppUsage(
      { credit: credit({ resets_at: '2026-09-01T00:00:00+00:00' }) },
      now,
    )
    expect(expired?.app.codeCredit).toBeNull()
  })
})
