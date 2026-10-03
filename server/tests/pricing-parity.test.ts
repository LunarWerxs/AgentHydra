// server/tests/pricing-parity.test.ts — the TypeScript reader of hswarm/data/prices.json prices the same
// token mixes as the Python reader (hswarm/tests/test_prices.py runs the same fixture), to the cent.

import { describe, expect, test } from 'bun:test'
import fixture from '../../hswarm/tests/fixtures/price_parity.json'
import { priceTokens } from '../src/pricing'

interface Case {
  model: string
  tokens: { input: number; cache_read: number; cache_5m: number; cache_1h: number; output: number }
  usd: number | null
}

describe('price parity with hswarm/prices.py', () => {
  for (const c of fixture.cases as Case[]) {
    test(c.model, () => {
      const r = priceTokens({
        [c.model]: {
          input: c.tokens.input,
          output: c.tokens.output,
          cacheRead: c.tokens.cache_read,
          cacheCreation5m: c.tokens.cache_5m,
          cacheCreation1h: c.tokens.cache_1h,
        },
      })
      if (c.usd === null) expect(r.costUsd).toBeNull()
      else expect(Math.round((r.costUsd ?? NaN) * 100)).toBe(Math.round(c.usd * 100))
    })
  }
})
