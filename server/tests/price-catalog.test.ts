// server/tests/price-catalog.test.ts — turning LiteLLM's catalog into prices (price-catalog.ts).
//
// The catalog is a 3,000-entry file maintained by someone else, so the properties worth pinning are
// the defensive ones: a half-priced entry must not become a confident dollar figure, service-tier
// companions must not be mistaken for the standard rate, and a truncated or wrong-shaped download
// must not be able to replace the bundled table with rubbish.

import { describe, expect, test } from 'bun:test'
import { entryToPrice, indexCatalog } from '../src/price-catalog'

describe('one catalog entry', () => {
  test('per-token rates become per-million ones', () => {
    expect(
      entryToPrice({ input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 }),
    ).toMatchObject({ input: 5, output: 25 })
  })

  test('cache rates are read as ABSOLUTE per-million prices', () => {
    const p = entryToPrice({
      input_cost_per_token: 0.000005,
      output_cost_per_token: 0.000025,
      cache_read_input_token_cost: 5e-7,
      cache_creation_input_token_cost: 0.00000625,
      cache_creation_input_token_cost_above_1hr: 0.00001,
    })
    expect(p).toMatchObject({ cacheReadUsd: 0.5, cacheWrite5mUsd: 6.25, cacheWrite1hUsd: 10 })
  })

  test('a provider with one cache-write rate does not get billed for a 1-hour TTL it never sold', () => {
    const p = entryToPrice({
      input_cost_per_token: 0.000005,
      output_cost_per_token: 0.000025,
      cache_creation_input_token_cost: 0.00000625,
    })
    expect(p?.cacheWrite1hUsd).toBe(6.25)
  })

  test('no cache rates at all leaves them undefined, so the derived ratios apply', () => {
    const p = entryToPrice({ input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 })
    expect(p?.cacheReadUsd).toBeUndefined()
    expect(p?.cacheWrite5mUsd).toBeUndefined()
  })

  test('an entry with only an input rate is rejected — half a price is worse than none', () => {
    // Embedding and rerank models look like this. Pricing one would produce a confident figure
    // missing its largest term.
    expect(entryToPrice({ input_cost_per_token: 0.0000001 })).toBeNull()
    expect(entryToPrice({ output_cost_per_token: 0.0000001 })).toBeNull()
  })

  test('a free model is priced at zero, which is not the same as unpriced', () => {
    expect(entryToPrice({ input_cost_per_token: 0, output_cost_per_token: 0 })).toMatchObject({
      input: 0,
      output: 0,
    })
  })

  test('nonsense rates are rejected rather than propagated', () => {
    expect(entryToPrice({ input_cost_per_token: 'free', output_cost_per_token: 1 })).toBeNull()
    expect(entryToPrice({ input_cost_per_token: -1, output_cost_per_token: 1 })).toBeNull()
    expect(entryToPrice({ input_cost_per_token: Number.NaN, output_cost_per_token: 1 })).toBeNull()
    expect(entryToPrice(null)).toBeNull()
  })

  test('service-tier companions are ignored: a transcript never says which tier it used', () => {
    const p = entryToPrice({
      input_cost_per_token: 0.000005,
      input_cost_per_token_flex: 0.0000025,
      input_cost_per_token_priority: 0.00001,
      input_cost_per_token_batches: 0.0000025,
      output_cost_per_token: 0.00003,
    })
    expect(p?.input).toBe(5)
  })
})

describe('the whole catalog, indexed the way transcripts spell a model', () => {
  const payload = {
    sample_spec: { input_cost_per_token: 1, output_cost_per_token: 1 },
    'gpt-5.6-sol': { input_cost_per_token: 0.000005, output_cost_per_token: 0.00003 },
    'deepseek/deepseek-v4-pro': {
      input_cost_per_token: 4.35e-7,
      output_cost_per_token: 8.7e-7,
      cache_read_input_token_cost: 3.625e-9,
    },
    'text-embedding-3-small': { input_cost_per_token: 2e-8 },
  }

  test('a provider-qualified id is reachable both ways', () => {
    // OpenCode writes `provider/id`; another tool may write the bare id for the same model.
    const idx = indexCatalog(payload)
    expect(idx['deepseek/deepseek-v4-pro']).toMatchObject({ input: 0.435 })
    expect(idx['deepseek-v4-pro']).toMatchObject({ input: 0.435 })
  })

  test("LiteLLM's own metadata row is not a model", () => {
    expect(indexCatalog(payload).sample_spec).toBeUndefined()
  })

  test('unpriceable entries are dropped rather than making the whole catalog unusable', () => {
    const idx = indexCatalog(payload)
    expect(idx['text-embedding-3-small']).toBeUndefined()
    expect(Object.keys(idx)).toContain('gpt-5.6-sol')
  })

  test('a real key outranks another entry’s trailing segment', () => {
    const idx = indexCatalog({
      'gpt-5': { input_cost_per_token: 0.00000125, output_cost_per_token: 0.00001 },
      'someproxy/gpt-5': { input_cost_per_token: 0.000009, output_cost_per_token: 0.000009 },
    })
    expect(idx['gpt-5']).toMatchObject({ input: 1.25 })
  })

  test('a payload that is not a catalog yields nothing rather than throwing', () => {
    expect(indexCatalog(null)).toEqual({})
    expect(indexCatalog('<html>404</html>')).toEqual({})
    expect(Object.keys(indexCatalog({ nope: 1 }))).toHaveLength(0)
  })
})
