// web/src/lib/kit.ts: the shared ref-counted poll. Two components asking the same question share
// one request and one timer; the timer stops with the last unsubscribe.
import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { effectScope } from 'vue'
import { t } from '../src/i18n'
import {
  formatUsd,
  KIT_POLL_MS,
  kitQueryString,
  localDaysList,
  NO_EXACT_PRICE_KEY,
  useKit,
} from '../src/lib/kit'

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
  expect(formatUsd(3.2, { exact: false })).toBe(t(NO_EXACT_PRICE_KEY))
  expect(formatUsd(0, { exact: false })).not.toContain('$0.00')
})

test('the day list steps calendar dates, so a daylight-saving change skips no day', () => {
  // 8 March 2026 is a spring-forward day in the US zones (23 h long): stepping 24 h would skip it.
  expect(localDaysList(4, new Date(2026, 2, 9, 0, 30))).toEqual([
    '2026-03-06',
    '2026-03-07',
    '2026-03-08',
    '2026-03-09',
  ])
})

test('the axis style reads at a glance across four orders of magnitude', () => {
  const axis = (n: number) => formatUsd(n, { style: 'axis' })
  expect(axis(0)).toBe('$0')
  expect(axis(0.004)).toBe('<$0.01')
  expect(axis(1.5)).toBe('$1.50')
  expect(axis(42)).toBe('$42')
  expect(axis(2500)).toBe('$2.5k')
  expect(axis(135000)).toBe('$135k')
  expect(axis(Number.NaN)).toBe('—')
})
