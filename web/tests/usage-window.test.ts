// web/tests/usage-window.test.ts: the one quota-window rule in lib/usage.ts (window start from the
// reset time and kind, whether the reset has passed, the % to show once it has).
import { expect, test } from 'bun:test'
import { windowHasReset, windowStartMs, windowUsedPct } from '../src/lib/usage'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const HOUR = 3_600_000
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

const cases: Array<{
  name: string
  resetsAt: string | null | undefined
  kind: '5h' | 'week'
  start: number | null
  reset: boolean
  shown: number | null
}> = [
  {
    name: '5h, reset in future',
    resetsAt: iso(2 * HOUR),
    kind: '5h',
    start: NOW - 3 * HOUR,
    reset: false,
    shown: 40,
  },
  {
    name: 'week, reset in future',
    resetsAt: iso(24 * HOUR),
    kind: 'week',
    start: NOW - 6 * 24 * HOUR,
    reset: false,
    shown: 40,
  },
  {
    name: '5h, reset past',
    resetsAt: iso(-HOUR),
    kind: '5h',
    start: NOW - 6 * HOUR,
    reset: true,
    shown: 0,
  },
  {
    name: 'week, reset exactly now',
    resetsAt: iso(0),
    kind: 'week',
    start: NOW - 7 * 24 * HOUR,
    reset: true,
    shown: 0,
  },
  { name: '5h, reset missing', resetsAt: null, kind: '5h', start: null, reset: false, shown: 40 },
  {
    name: 'week, reset unparseable',
    resetsAt: 'soon',
    kind: 'week',
    start: null,
    reset: false,
    shown: 40,
  },
]

test.each(cases)('$name', ({ resetsAt, kind, start, reset, shown }) => {
  expect(windowStartMs(resetsAt, kind)).toBe(start)
  expect(windowHasReset(resetsAt, NOW)).toBe(reset)
  expect(windowUsedPct({ pct: 40, resetsAt }, NOW)).toBe(shown)
  expect(windowUsedPct(null, NOW)).toBeNull()
})
