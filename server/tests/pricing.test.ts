// server/tests/pricing.test.ts — the bundled price table and the cost math (server/src/pricing.ts).
//
// The properties worth pinning are the ones that make the difference between a real number and a
// decorative one: cache reads and the two cache-write TTLs priced separately, an unknown id priced
// at NOTHING rather than at a plausible-looking guess, and an introductory rate that follows the
// date the tokens were actually spent.

import { describe, expect, test } from 'bun:test'
import {
  CACHE_READ_RATIO,
  CACHE_WRITE_1H_RATIO,
  CACHE_WRITE_5M_RATIO,
  PRICES_AS_OF,
  type PriceableTokens,
  priceFor,
  priceTokens,
} from '../src/pricing'

const NOW = Date.parse('2026-08-13T00:00:00.000Z')

const tokens = (t: Partial<PriceableTokens>): PriceableTokens => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation5m: 0,
  cacheCreation1h: 0,
  ...t,
})

describe('priceFor', () => {
  test('resolves a current model id', () => {
    expect(priceFor('claude-opus-5', NOW)).toMatchObject({ input: 5, output: 25 })
  })

  test('strips the -YYYYMMDD snapshot suffix', () => {
    expect(priceFor('claude-haiku-4-5-20251001', NOW)?.model).toBe('claude-haiku-4-5')
    expect(priceFor('claude-haiku-4-5-20251001', NOW)?.input).toBe(1)
  })

  test('is case-insensitive', () => {
    expect(priceFor('CLAUDE-OPUS-5', NOW)?.input).toBe(5)
  })

  test('cache rates are the published multiples of the model input price', () => {
    const p = priceFor('claude-opus-5', NOW)
    if (!p) throw new Error('expected opus 5 to be priced')
    expect(p.cacheRead).toBeCloseTo(p.input * CACHE_READ_RATIO, 10)
    expect(p.cacheWrite5m).toBeCloseTo(p.input * CACHE_WRITE_5M_RATIO, 10)
    expect(p.cacheWrite1h).toBeCloseTo(p.input * CACHE_WRITE_1H_RATIO, 10)
    // The point of splitting them: a 1-hour write is twenty times a read, not the same thing.
    expect(p.cacheWrite1h / p.cacheRead).toBeCloseTo(20, 10)
  })

  test('an unknown id is unpriced, never guessed', () => {
    expect(priceFor('some-mystery-model', NOW)).toBeNull()
  })

  test('a bare family name is unpriced — the generation decides the price', () => {
    // Opus has been billed at both 15/75 and 5/25; "opus" alone cannot say which.
    expect(priceFor('opus', NOW)).toBeNull()
    expect(priceFor('sonnet', NOW)).toBeNull()
  })

  test('a Bedrock/Vertex id is unpriced — partner platforms bill their own rates', () => {
    expect(priceFor('us.anthropic.claude-sonnet-4-5-20250929-v1:0', NOW)).toBeNull()
    expect(priceFor('claude-3-7-sonnet@20250219', NOW)).toBeNull()
  })

  test('introductory rate applies before its expiry and the standard rate after', () => {
    const during = Date.parse('2026-08-13T00:00:00.000Z')
    const after = Date.parse('2026-09-02T00:00:00.000Z')
    expect(priceFor('claude-sonnet-5', during)).toMatchObject({ input: 2, output: 10 })
    expect(priceFor('claude-sonnet-5', after)).toMatchObject({ input: 3, output: 15 })
  })

  test('the bundled table is dated, so a stale figure can be shown as stale', () => {
    expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('priceTokens', () => {
  test('prices each token kind at its own rate', () => {
    const priced = priceTokens(
      {
        'claude-opus-5': tokens({
          input: 1_000_000,
          output: 1_000_000,
          cacheRead: 1_000_000,
          cacheCreation5m: 1_000_000,
          cacheCreation1h: 1_000_000,
        }),
      },
      NOW,
    )
    // 5 (input) + 25 (output) + 0.5 (cache read) + 6.25 (5m write) + 10 (1h write)
    expect(priced.costUsd).toBeCloseTo(46.75, 10)
    expect(priced.priced).toEqual(['claude-opus-5'])
    expect(priced.unpriced).toEqual([])
  })

  test('sums across models at each model own rate', () => {
    const priced = priceTokens(
      {
        'claude-opus-5': tokens({ output: 1_000_000 }), // $25
        'claude-haiku-4-5': tokens({ output: 1_000_000 }), // $5
      },
      NOW,
    )
    expect(priced.costUsd).toBeCloseTo(30, 10)
    expect(priced.priced).toEqual(['claude-haiku-4-5', 'claude-opus-5'])
  })

  test('an unpriced model contributes no dollars but is reported', () => {
    const priced = priceTokens(
      {
        'claude-opus-5': tokens({ output: 1_000_000 }),
        'mystery-model': tokens({ output: 1_000_000 }),
      },
      NOW,
    )
    expect(priced.costUsd).toBeCloseTo(25, 10)
    expect(priced.unpriced).toEqual(['mystery-model'])
  })

  test('no priced model at all yields a null cost, not a zero', () => {
    const priced = priceTokens({ 'mystery-model': tokens({ output: 500 }) }, NOW)
    expect(priced.costUsd).toBeNull()
    expect(priced.unpriced).toEqual(['mystery-model'])
  })

  test('a priced session with genuinely no tokens costs 0, which is not null', () => {
    expect(priceTokens({ 'claude-opus-5': tokens({}) }, NOW).costUsd).toBe(0)
  })

  test("a zero-token unknown model (Claude Code's <synthetic> turns) raises no warning", () => {
    const priced = priceTokens(
      { 'claude-opus-5': tokens({ output: 1000 }), '<synthetic>': tokens({}) },
      NOW,
    )
    expect(priced.unpriced).toEqual([])
    expect(priced.costUsd).toBeGreaterThan(0)
  })

  test('an empty breakdown is unpriced rather than free', () => {
    expect(priceTokens({}, NOW).costUsd).toBeNull()
  })

  test('two ids that canonicalize to the same model report it once', () => {
    const priced = priceTokens(
      {
        'claude-haiku-4-5': tokens({ output: 1_000_000 }),
        'claude-haiku-4-5-20251001': tokens({ output: 1_000_000 }),
      },
      NOW,
    )
    expect(priced.priced).toEqual(['claude-haiku-4-5'])
    expect(priced.costUsd).toBeCloseTo(10, 10)
  })
})
