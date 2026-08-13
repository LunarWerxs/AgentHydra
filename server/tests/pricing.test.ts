// server/tests/pricing.test.ts — the bundled price table and the cost math (server/src/pricing.ts).
//
// The properties worth pinning are the ones that make the difference between a real number and a
// decorative one: cache reads and the two cache-write TTLs priced separately, an unknown id priced
// at NOTHING rather than at a plausible-looking guess, and an introductory rate that follows the
// date the tokens were actually spent.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  CACHE_READ_RATIO,
  CACHE_WRITE_1H_RATIO,
  CACHE_WRITE_5M_RATIO,
  clearFetchedPrices,
  PRICES_AS_OF,
  type PriceableTokens,
  priceFor,
  priceSource,
  pricesAsOf,
  priceTokens,
  setFetchedPrices,
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

describe('OpenAI models, which Codex writes as bare ids', () => {
  test('the GPT-5.6 family prices, so Codex spend is not reported as unpriced', () => {
    expect(priceFor('gpt-5.6-sol', NOW)).toMatchObject({ input: 5, output: 30 })
    expect(priceFor('gpt-5.6-terra', NOW)).toMatchObject({ input: 2, output: 12 })
    expect(priceFor('gpt-5.3-codex', NOW)).toMatchObject({ input: 1.75, output: 14 })
  })

  test('a cached input token is a tenth, the same shape Anthropic publishes', () => {
    expect(priceFor('gpt-5.6-sol', NOW)?.cacheRead).toBeCloseTo(0.5, 10)
  })

  test('pre-5.6 models create cache entries for FREE, which is zero and not the 1.25x premium', () => {
    // The distinction matters: `|| ` instead of `?? ` in the resolver would silently bill a free
    // cache write at 1.25x the input rate.
    expect(priceFor('gpt-5.3-codex', NOW)?.cacheWrite5m).toBe(0)
    expect(priceFor('gpt-5.3-codex', NOW)?.cacheWrite1h).toBe(0)
    // 5.6 and later DO charge for the write, at the standard multiple.
    expect(priceFor('gpt-5.6-sol', NOW)?.cacheWrite5m).toBeCloseTo(6.25, 10)
  })
})

describe('a downloaded catalog takes precedence over the bundled table', () => {
  afterEach(() => clearFetchedPrices())

  test('the bundled table answers when no catalog is in force', () => {
    expect(priceSource()).toBe('bundled')
    expect(pricesAsOf()).toBe(PRICES_AS_OF)
  })

  test('a fetched price overrides a bundled one, and reports its own date', () => {
    setFetchedPrices(
      { 'claude-opus-5': { input: 4, output: 20 } },
      Date.parse('2026-08-12T09:30:00.000Z'),
    )
    expect(priceFor('claude-opus-5', NOW)).toMatchObject({ input: 4, output: 20 })
    expect(priceSource()).toBe('catalog')
    expect(pricesAsOf()).toBe('2026-08-12')
  })

  test('a model the catalog does not carry still prices from the bundled table', () => {
    // Adopting a catalog can only ever price MORE models, never fewer — otherwise a catalog that
    // dropped one id would turn a previously-priced session into an unpriced one.
    setFetchedPrices({ 'gpt-5.6-sol': { input: 4, output: 20 } }, Date.parse('2026-08-12'))
    expect(priceFor('claude-opus-5', NOW)).toMatchObject({ input: 5, output: 25 })
  })

  test('clearing it falls back, so an install can refuse downloaded prices', () => {
    setFetchedPrices({ 'claude-opus-5': { input: 4, output: 20 } }, Date.parse('2026-08-12'))
    clearFetchedPrices()
    expect(priceFor('claude-opus-5', NOW)).toMatchObject({ input: 5, output: 25 })
    expect(priceSource()).toBe('bundled')
  })

  test('an absolute cache rate is used verbatim, not re-derived from the input rate', () => {
    // DeepSeek's cache read is under a hundredth of its input rate, not Anthropic's tenth.
    setFetchedPrices(
      { 'deepseek-v4-pro': { input: 0.435, output: 0.87, cacheReadUsd: 0.003625 } },
      Date.parse('2026-08-12'),
    )
    expect(priceFor('deepseek-v4-pro', NOW)?.cacheRead).toBeCloseTo(0.003625, 10)
  })
})

describe('a router’s provider/model id', () => {
  test('falls back to the model behind it, so OpenCode spend is not all unpriced', () => {
    // OpenCode records what it routed to, e.g. `openai/gpt-5.5`. Both sides plainly agree on the
    // model; only the spelling differs.
    expect(priceFor('openai/gpt-5.5', NOW)).toMatchObject({ input: 5, output: 30 })
  })

  test('the exact key still wins when the table carries one', () => {
    setFetchedPrices(
      {
        'someproxy/gpt-5': { input: 9, output: 9 },
        'gpt-5': { input: 1.25, output: 10 },
      },
      Date.parse('2026-08-12'),
    )
    expect(priceFor('someproxy/gpt-5', NOW)).toMatchObject({ input: 9 })
    clearFetchedPrices()
  })

  test('Bedrock and Vertex ids stay unpriced — they are partner-operated with their own rates', () => {
    // The fallback splits on `/` only. These use dots and at-signs, so they still miss, which is
    // the right answer rather than a bug to paper over.
    expect(priceFor('us.anthropic.claude-opus-5-v1:0', NOW)).toBeNull()
    expect(priceFor('claude-opus-5@20260101', NOW)).toBeNull()
  })
})
