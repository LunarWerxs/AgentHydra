// server/tests/usage-tokens.test.ts — token counting + weighting (server/src/usage-tokens.ts).
//
// Fixture is a small hand-written JSONL transcript (no secrets, no real session data).

import { describe, expect, test } from 'bun:test'
import { sumTranscriptTokens, tokensPerPercent, weighTurn } from '../src/usage-tokens'

describe('weighTurn', () => {
  // weight = input*1 + cache_creation*1.25 + cache_read*0.1 + output*5, then * model multiplier.
  test('sonnet (unrecognized/default multiplier 1): exact arithmetic', () => {
    const usage = {
      input_tokens: 100,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 1000,
      output_tokens: 20,
    }
    const raw = 100 * 1 + 40 * 1.25 + 1000 * 0.1 + 20 * 5
    expect(raw).toBe(350)
    expect(weighTurn(usage, 'claude-sonnet-4-20260101')).toBe(350)
  })

  test('opus: multiplier 5', () => {
    const usage = {
      input_tokens: 100,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 1000,
      output_tokens: 20,
    }
    expect(weighTurn(usage, 'claude-opus-4-20260101')).toBe(350 * 5)
  })

  test('fable: also multiplier 5', () => {
    const usage = { input_tokens: 10, output_tokens: 0 }
    expect(weighTurn(usage, 'fable-5-mythos')).toBe(10 * 5)
  })

  test('haiku: multiplier 0.27', () => {
    const usage = { input_tokens: 10, output_tokens: 0 }
    expect(weighTurn(usage, 'claude-haiku-4-20260101')).toBeCloseTo(10 * 0.27, 10)
  })

  test('unknown model name: multiplier 1 (safe middle)', () => {
    const usage = { input_tokens: 10, output_tokens: 0 }
    expect(weighTurn(usage, 'some-mystery-model')).toBe(10)
  })

  test('case-insensitive model matching', () => {
    const usage = { input_tokens: 10, output_tokens: 0 }
    expect(weighTurn(usage, 'CLAUDE-OPUS-4')).toBe(50)
    expect(weighTurn(usage, 'Claude-Haiku-4')).toBeCloseTo(2.7, 10)
    expect(weighTurn(usage, 'FABLE')).toBe(50)
  })

  test('missing/undefined counts are treated as zero', () => {
    expect(weighTurn({}, 'sonnet')).toBe(0)
  })
})

describe('sumTranscriptTokens', () => {
  const sinceMs = Date.parse('2026-07-14T00:00:00.000Z')

  // (a) inside the window, assistant, sonnet-ish model
  const inWindow = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-14T01:00:00.000Z',
    message: {
      model: 'claude-sonnet-4',
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  })
  // (b) before sinceMs — must be excluded
  const beforeWindow = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-13T23:00:00.000Z',
    message: {
      model: 'claude-sonnet-4',
      usage: { input_tokens: 9999, output_tokens: 9999 },
    },
  })
  // (c) a user turn carrying a usage echo — must be excluded (double-count guard)
  const userWithUsage = JSON.stringify({
    type: 'user',
    timestamp: '2026-07-14T01:30:00.000Z',
    message: {
      model: 'claude-sonnet-4',
      usage: { input_tokens: 5000, output_tokens: 5000 },
    },
  })
  // (d) malformed/garbage line — must be skipped, not throw
  const garbage = '{not valid json at all'
  // (e) a line with no usage at all
  const noUsage = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-14T01:45:00.000Z',
    message: { model: 'claude-sonnet-4' },
  })
  // (f) a queue-operation line
  const queueOp = JSON.stringify({ type: 'queue-operation', op: 'dequeue' })
  // second in-window turn, opus, cache-heavy (to make raw vs weighted diverge clearly)
  const opusCacheHeavy = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-14T02:00:00.000Z',
    message: {
      model: 'claude-opus-4',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100000,
        cache_creation_input_tokens: 0,
      },
    },
  })

  const jsonl = [
    inWindow,
    beforeWindow,
    userWithUsage,
    garbage,
    noUsage,
    queueOp,
    opusCacheHeavy,
    '', // trailing blank line (as real transcripts have)
  ].join('\n')

  test('counts only in-window assistant turns with a usage block', () => {
    const spend = sumTranscriptTokens(jsonl, sinceMs)
    expect(spend.turns).toBe(2) // inWindow + opusCacheHeavy only
  })

  test('excludes the before-window turn', () => {
    const spend = sumTranscriptTokens(jsonl, sinceMs)
    // If it were included, input would be >= 9999.
    expect(spend.input).toBeLessThan(9999)
  })

  test('raw is the plain sum of the four counts; weighted differs for a cache-heavy turn', () => {
    const spend = sumTranscriptTokens(jsonl, sinceMs)

    const expectedInput = 100 + 10
    const expectedOutput = 10 + 5
    const expectedCacheRead = 0 + 100000
    const expectedCacheCreation = 0

    expect(spend.input).toBe(expectedInput)
    expect(spend.output).toBe(expectedOutput)
    expect(spend.cacheRead).toBe(expectedCacheRead)
    expect(spend.cacheCreation).toBe(expectedCacheCreation)

    const expectedRaw = expectedInput + expectedOutput + expectedCacheRead + expectedCacheCreation
    expect(spend.raw).toBe(expectedRaw)

    // weighted: turn1 (sonnet, x1) = 100*1 + 10*5 = 150
    // turn2 (opus, x5) = (10*1 + 5*5 + 100000*0.1) * 5 = (10 + 25 + 10000) * 5 = 50175
    const expectedWeighted = (100 * 1 + 10 * 5) * 1 + (10 * 1 + 5 * 5 + 100000 * 0.1) * 5
    expect(spend.weighted).toBe(expectedWeighted)

    // raw sum is dominated by the giant cache-read count; weighted discounts it 10x. They must differ.
    expect(spend.weighted).not.toBe(spend.raw)
    expect(spend.raw).toBeGreaterThan(spend.weighted) // cache-read-heavy raw sum dwarfs its weighted cost
  })

  test('byModel breaks the counts down per model', () => {
    const spend = sumTranscriptTokens(jsonl, sinceMs)
    expect(Object.keys(spend.byModel).sort()).toEqual(['claude-opus-4', 'claude-sonnet-4'])
    expect(spend.byModel['claude-sonnet-4']).toEqual({
      weighted: 100 * 1 + 10 * 5,
      output: 10,
      turns: 1,
      input: 100,
      cacheRead: 0,
      cacheCreation5m: 0,
      cacheCreation1h: 0,
    })
    expect(spend.byModel['claude-opus-4']).toEqual({
      weighted: (10 * 1 + 5 * 5 + 100000 * 0.1) * 5,
      output: 5,
      turns: 1,
      input: 10,
      cacheRead: 100000,
      cacheCreation5m: 0,
      cacheCreation1h: 0,
    })
  })

  // The per-TTL split is the whole reason byModel carries raw counts: a 1-hour cache write costs
  // 2x base input where a 5-minute one costs 1.25x, so a combined figure cannot be priced.
  describe('cache-write TTL split', () => {
    const withSplit = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-14T03:00:00.000Z',
      message: {
        model: 'claude-sonnet-4',
        usage: {
          cache_creation_input_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
        },
      },
    })
    const withoutSplit = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-14T03:00:00.000Z',
      message: { model: 'claude-sonnet-4', usage: { cache_creation_input_tokens: 1000 } },
    })

    test('uses the per-TTL buckets when the transcript carries them', () => {
      const m = sumTranscriptTokens(withSplit, sinceMs).byModel['claude-sonnet-4']
      expect(m.cacheCreation5m).toBe(400)
      expect(m.cacheCreation1h).toBe(600)
    })

    test('an older transcript without the split attributes the write to 5m (the default TTL)', () => {
      const m = sumTranscriptTokens(withoutSplit, sinceMs).byModel['claude-sonnet-4']
      expect(m.cacheCreation5m).toBe(1000)
      expect(m.cacheCreation1h).toBe(0)
    })

    test('the split always sums to the reported cacheCreation total', () => {
      for (const line of [withSplit, withoutSplit]) {
        const spend = sumTranscriptTokens(line, sinceMs)
        const m = spend.byModel['claude-sonnet-4']
        expect(m.cacheCreation5m + m.cacheCreation1h).toBe(spend.cacheCreation)
      }
    })
  })

  // sinceMs <= 0 means "the whole file" — the mode session-usage.ts runs in.
  test('no cutoff (sinceMs 0) counts every turn, including one with no timestamp', () => {
    const undated = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-sonnet-4', usage: { input_tokens: 7, output_tokens: 3 } },
    })
    const spend = sumTranscriptTokens([jsonl, undated].join('\n'), 0)
    expect(spend.turns).toBe(4) // both in-window turns + the before-window one + the undated one
    expect(spend.input).toBe(100 + 10 + 9999 + 7)
  })

  test('malformed line, no-usage line, and queue-operation are silently skipped (no throw)', () => {
    expect(() => sumTranscriptTokens(jsonl, sinceMs)).not.toThrow()
  })

  test('empty text yields an all-zero spend', () => {
    const spend = sumTranscriptTokens('', sinceMs)
    expect(spend.turns).toBe(0)
    expect(spend.raw).toBe(0)
    expect(spend.weighted).toBe(0)
    expect(spend.byModel).toEqual({})
  })
})

describe('tokensPerPercent', () => {
  test('null when tokensPerHour is null', () => {
    expect(tokensPerPercent(null, 1)).toBeNull()
  })

  test('null when burnPctPerHour is null', () => {
    expect(tokensPerPercent(1000, null)).toBeNull()
  })

  test('null when burnPctPerHour is zero', () => {
    expect(tokensPerPercent(1000, 0)).toBeNull()
  })

  test('null when burnPctPerHour is negative', () => {
    expect(tokensPerPercent(1000, -1)).toBeNull()
  })

  test('null when tokensPerHour is zero', () => {
    expect(tokensPerPercent(0, 1)).toBeNull()
  })

  test('null when tokensPerHour is negative', () => {
    expect(tokensPerPercent(-5, 1)).toBeNull()
  })

  test('happy path: plain division', () => {
    expect(tokensPerPercent(10000, 2)).toBe(5000)
  })
})

describe('one API response is charged once, however many records it was split across', () => {
  // THE BUG THIS PINS, measured on a real store before it was fixed. Claude Code writes one
  // transcript record PER CONTENT BLOCK and stamps the same complete usage object on every one, so
  // a reply that says something and then makes two tool calls is three records each claiming the
  // full input, cache-read and output of the single request behind them. Summing records reported
  // 148.8 BILLION tokens across 1,230 transcripts where the real figure is 64.6 billion.
  const record = (
    id: string,
    req: string,
    usage: Record<string, number>,
    at = '2026-08-09T07:24:13.537Z',
  ) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: at,
      requestId: req,
      message: { id, model: 'claude-sonnet-4-6', usage },
    })

  const USAGE = { input_tokens: 2, output_tokens: 290, cache_read_input_tokens: 33693 }

  test('three records for one request count as one', () => {
    // Exactly the shape observed: same message id, same requestId, identical usage, three records
    // because the reply carried text and two tool calls.
    const text = [
      record('msg_1', 'req_1', USAGE),
      record('msg_1', 'req_1', USAGE, '2026-08-09T07:24:14.275Z'),
      record('msg_1', 'req_1', USAGE, '2026-08-09T07:24:15.595Z'),
    ].join('\n')
    const spend = sumTranscriptTokens(text, 0)
    expect(spend.output).toBe(290)
    expect(spend.cacheRead).toBe(33693)
    expect(spend.turns).toBe(1)
  })

  test('two DIFFERENT requests are still two charges', () => {
    const text = [record('msg_1', 'req_1', USAGE), record('msg_2', 'req_2', USAGE)].join('\n')
    const spend = sumTranscriptTokens(text, 0)
    expect(spend.output).toBe(580)
    expect(spend.turns).toBe(2)
  })

  test('a streaming turn whose output GROWS contributes only the difference', () => {
    // The rarer case (3 of a 5,000-group sample): an early record carries a partial output count
    // and the final one the billed count. Charging the larger figure twice, or keeping only the
    // partial, are both wrong; the input side is charged once either way.
    const text = [
      record('msg_1', 'req_1', { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 900 }),
      record('msg_1', 'req_1', {
        input_tokens: 2,
        output_tokens: 631,
        cache_read_input_tokens: 900,
      }),
    ].join('\n')
    const spend = sumTranscriptTokens(text, 0)
    expect(spend.output).toBe(631)
    expect(spend.input).toBe(2)
    expect(spend.cacheRead).toBe(900)
  })

  test('a record with no requestId is counted, not dropped', () => {
    // Older transcripts have no requestId. Deduping on an empty key would collapse every one of
    // them into a single turn, which is a far worse error than the duplicate it would prevent.
    const bare = (out: number) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-09T07:24:13.537Z',
        message: { model: 'claude-sonnet-4-6', usage: { output_tokens: out } },
      })
    const spend = sumTranscriptTokens([bare(10), bare(20)].join('\n'), 0)
    expect(spend.output).toBe(30)
    expect(spend.turns).toBe(2)
  })
})
