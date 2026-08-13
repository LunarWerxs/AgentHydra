// server/src/usage-foreign.ts — reading Codex and OpenCode spend.
//
// Both were reporting zero, which read as "you have not used them". Each has one trap that a
// plausible implementation falls straight into, and each has a test here:
//
//   * Codex emits a RUNNING total and a per-turn delta. Summing the deltas is the obvious move and
//     overcounts, because the same turn is emitted more than once — measured 5% high on a real
//     3,476-event rollout. Deltas of the cumulative are exact by construction.
//   * Codex counts cached input INSIDE input_tokens where Anthropic reports it alongside. Taken at
//     face value that double-counts the cached part, which on a real session is 98% of the input.

import { describe, expect, test } from 'bun:test'
import { addTurn, CodexUsageReader, openCodeModelName, openCodeSpend } from '../src/usage-foreign'

const tokenCount = (
  at: string,
  total: Partial<Record<string, number>>,
  last?: Partial<Record<string, number>>,
) => ({
  type: 'event_msg',
  timestamp: at,
  payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
})

describe('Codex: a running total, read as deltas', () => {
  test('the first event is its own delta', () => {
    const r = new CodexUsageReader()
    const t = r.push(
      tokenCount('2026-08-10T10:00:00.000Z', {
        input_tokens: 1000,
        cached_input_tokens: 800,
        output_tokens: 50,
      }),
    )
    expect(t).not.toBeNull()
    expect(t?.input).toBe(200) // 1000 total input MINUS the 800 that were cached
    expect(t?.cacheRead).toBe(800)
    expect(t?.output).toBe(50)
  })

  test('later events report only what CHANGED, so the deltas sum to the final total', () => {
    const r = new CodexUsageReader()
    const events = [
      tokenCount('2026-08-10T10:00:00.000Z', {
        input_tokens: 1000,
        cached_input_tokens: 800,
        output_tokens: 50,
      }),
      tokenCount('2026-08-10T10:01:00.000Z', {
        input_tokens: 3000,
        cached_input_tokens: 2500,
        output_tokens: 120,
      }),
      tokenCount('2026-08-10T10:02:00.000Z', {
        input_tokens: 9000,
        cached_input_tokens: 8000,
        output_tokens: 300,
      }),
    ]
    const turns = events.map((e) => r.push(e)).filter((t) => t !== null)
    expect(turns).toHaveLength(3)
    const sum = turns.reduce(
      (a, t) => ({
        input: a.input + t.input,
        cacheRead: a.cacheRead + t.cacheRead,
        output: a.output + t.output,
      }),
      { input: 0, cacheRead: 0, output: 0 },
    )
    // Exactly the final cumulative, uncached input separated out: 9000 - 8000 = 1000.
    expect(sum).toEqual({ input: 1000, cacheRead: 8000, output: 300 })
  })

  test('a repeated event contributes nothing, which is what stops the 5% overcount', () => {
    const r = new CodexUsageReader()
    const ev = tokenCount('2026-08-10T10:00:00.000Z', {
      input_tokens: 1000,
      cached_input_tokens: 0,
      output_tokens: 50,
    })
    expect(r.push(ev)?.input).toBe(1000)
    expect(r.push(ev)).toBeNull() // same totals again: no new spend
  })

  test('a total that goes DOWN is a reset, not a negative turn', () => {
    const r = new CodexUsageReader()
    r.push(tokenCount('2026-08-10T10:00:00.000Z', { input_tokens: 9000, output_tokens: 500 }))
    // A fresh context after compaction restarts the count.
    const t = r.push(
      tokenCount('2026-08-10T10:05:00.000Z', { input_tokens: 200, output_tokens: 10 }),
    )
    expect(t?.input).toBe(200)
    expect(t?.output).toBe(10)
  })

  test('a turn before any turn_context reports NO model rather than a placeholder', () => {
    // 2,067 of 4,860 real rollouts spend tokens before naming a model. A placeholder id here put
    // 331B tokens under a fake model called "codex"; null lets the caller attribute them to the
    // model the file names a few lines later.
    const r = new CodexUsageReader()
    const t = r.push(tokenCount('2026-08-10T10:00:00.000Z', { input_tokens: 10, output_tokens: 1 }))
    expect(t?.model).toBeNull()
  })

  test('the model comes from turn_context and follows a mid-session switch', () => {
    const r = new CodexUsageReader()
    r.push({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } })
    expect(
      r.push(tokenCount('2026-08-10T10:00:00.000Z', { input_tokens: 10, output_tokens: 1 }))?.model,
    ).toBe('gpt-5.6-sol')
    r.push({ type: 'turn_context', payload: { model: 'gpt-5.3-codex' } })
    expect(
      r.push(tokenCount('2026-08-10T10:01:00.000Z', { input_tokens: 20, output_tokens: 2 }))?.model,
    ).toBe('gpt-5.3-codex')
  })

  test('a line with no usage in it is ignored rather than counted as an empty turn', () => {
    const r = new CodexUsageReader()
    expect(r.push({ type: 'response_item', payload: { type: 'message' } })).toBeNull()
    expect(r.push(null)).toBeNull()
    expect(r.push({ type: 'event_msg' })).toBeNull()
  })
})

describe('OpenCode: totals it already computed', () => {
  const row = {
    model: '{"id":"glm-5.2","providerID":"dashscope2","variant":"default"}',
    tokens_input: 1000,
    tokens_output: 200,
    tokens_reasoning: 60,
    tokens_cache_read: 5000,
    tokens_cache_write: 300,
    cost: 1.25,
    turns: 42,
  }

  test('the stored JSON model becomes something readable', () => {
    expect(openCodeModelName(row.model)).toBe('dashscope2/glm-5.2')
    expect(openCodeModelName('plain-model')).toBe('plain-model')
    expect(openCodeModelName(null)).toBe('opencode')
    expect(openCodeModelName('{not json')).toBe('{not json')
  })

  test('the four categories come straight off the row', () => {
    const s = openCodeSpend(row)
    const m = s.byModel['dashscope2/glm-5.2']
    expect(m?.input).toBe(1000)
    expect(m?.cacheRead).toBe(5000)
    expect(m?.cacheCreation5m).toBe(300)
    expect(m?.output).toBe(200)
  })

  test('reasoning is NOT added to output — the provider already counted it there', () => {
    const s = openCodeSpend(row)
    expect(s.byModel['dashscope2/glm-5.2']?.output).toBe(200)
    expect(s.reasoning).toBe(60)
  })

  test("the provider's own cost is passed through, not recomputed", () => {
    expect(openCodeSpend(row).costUsd).toBe(1.25)
    expect(openCodeSpend({ ...row, cost: null }).costUsd).toBeNull()
  })

  test('the reply count is the session’s, not one per session', () => {
    expect(openCodeSpend(row).byModel['dashscope2/glm-5.2']?.turns).toBe(42)
  })

  test('a session with no usage yields no model at all, rather than a row of zeros', () => {
    const empty = openCodeSpend({
      ...row,
      tokens_input: 0,
      tokens_output: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
    })
    expect(Object.keys(empty.byModel)).toHaveLength(0)
  })
})

describe('the shared weighting', () => {
  test('a cache read is worth a tenth of fresh input, output five times it', () => {
    const byModel = {}
    addTurn(byModel, 'm', { input: 100, cacheRead: 100, cacheWrite: 100, output: 100 })
    // 100*1 + 100*0.1 + 100*1.25 + 100*5
    expect((byModel as Record<string, { weighted: number }>).m?.weighted).toBeCloseTo(735, 6)
  })
})
