// web/src/lib/kit.ts: the shared ref-counted poll. Two components asking the same question share
// one request and one timer; the timer stops with the last unsubscribe.
import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { effectScope } from 'vue'
import { formatUsd, KIT_POLL_MS, kitQueryString, NO_EXACT_PRICE, useKit } from '../src/lib/kit'

const realFetch = globalThis.fetch
let calls: string[] = []

beforeEach(() => {
  jest.useFakeTimers()
  calls = []
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    return {
      ok: true,
      json: async () => ({ rows: [], totals: { tokens: 7 }, coverage: { sources: {} } }),
    } as Response
  }) as unknown as typeof fetch
})
afterEach(() => {
  jest.useRealTimers()
  globalThis.fetch = realFetch
})

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('two subscribers of one query share one request and one timer; the last unsubscribe stops it', async () => {
  const a = effectScope()
  const b = effectScope()
  const first = a.run(() => useKit({ source: 'hswarm', last: '7d' }))
  // same question, keys given in another order: still the same poll
  const second = b.run(() => useKit({ last: '7d', source: 'hswarm' }))
  const other = effectScope().run(() => useKit({ source: 'climayte', last: '7d' }))
  await flush()
  expect(calls).toHaveLength(2) // hswarm once, climayte once
  expect(first?.data.value?.totals.tokens).toBe(7)
  expect(second?.data.value).toBe(first?.data.value ?? null)

  jest.advanceTimersByTime(KIT_POLL_MS)
  await flush()
  expect(calls).toHaveLength(4)

  a.stop()
  jest.advanceTimersByTime(KIT_POLL_MS)
  await flush()
  expect(calls).toHaveLength(6) // b still holds the hswarm poll

  b.stop()
  other?.stop()
  jest.advanceTimersByTime(KIT_POLL_MS * 3)
  await flush()
  expect(calls).toHaveLength(6)
})

test('the query string is canonical', () => {
  expect(kitQueryString({ b: 1, a: ['x', 'y'], c: undefined })).toBe('a=x%2Cy&b=1')
})

test('a missing price is the marker and an inexact one says so, never $0.00', () => {
  expect(formatUsd(null)).toBe('—')
  expect(formatUsd(3.2, { exact: false })).toBe(NO_EXACT_PRICE)
})
