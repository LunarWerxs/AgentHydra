// web/src/lib/usage.ts — the usage chip's label and which window it reports.
import { expect, test } from 'bun:test'
import type { UsageSnapshot } from '../src/lib/api'
import { usageCellLabel, usagePctFor } from '../src/lib/usage'

const snap = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  account: '4claude',
  session: { pct: 13, resets: 'Aug 5, 4:59pm' },
  weekAll: { pct: 92, resets: 'Aug 6, 4:59am' },
  weekModel: { pct: 4, resets: 'Aug 6, 4:59am', label: 'Fable' },
  capturedAt: '2026-08-05T12:00:00.000Z',
  ...over,
})

test('the label is a bare percentage: the column heading already names the window', () => {
  expect(usageCellLabel(snap())).toBe('92%')
  expect(usageCellLabel(snap(), 'session')).toBe('13%')
})

test('withScope re-adds the suffix, for surfaces with no column headings', () => {
  // The quick-instances window is a flat list with no headers, so its chips must say which
  // window they mean.
  expect(usageCellLabel(snap(), 'week', true)).toBe('92% wk')
  expect(usageCellLabel(snap(), 'session', true)).toBe('13% 5h')
})

test('scope picks the window, and defaults to the binding weekly cap', () => {
  expect(usagePctFor(snap())).toBe(92)
  expect(usagePctFor(snap(), 'session')).toBe(13)
})

test('a window with no reading is "—", never "0%"', () => {
  expect(usageCellLabel(snap({ session: null }), 'session')).toBe('—')
  expect(usageCellLabel(snap({ weekAll: null }))).toBe('—')
  expect(usagePctFor(snap({ session: null }), 'session')).toBeNull()
})

test('a snapshot with nothing in it at all is "—" for either scope', () => {
  const empty = snap({ session: null, weekAll: null, weekModel: null })
  expect(usageCellLabel(empty)).toBe('—')
  expect(usageCellLabel(empty, 'session')).toBe('—')
  expect(usageCellLabel(null)).toBe('—')
  expect(usageCellLabel(undefined, 'session')).toBe('—')
})

// --- a window that has since reset --------------------------------------------
//
// Owner-reported 2026-08-07: an eleven-day-old cached snapshot kept asserting "100%" for an account
// whose weekly window had reset days earlier. That percentage measures a window that no longer
// exists, so it is not a stale reading of the current one — it is no reading of it at all.

const NOW = new Date(Date.UTC(2026, 7, 6, 12, 0, 0))
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

test('a superseded window reports "—", not its historical percentage', () => {
  const old = snap({
    session: { pct: 100, resets: 'Jul 26, 4am', resetsAt: ago(11 * 24 * 60 * 60_000) },
    weekAll: { pct: 100, resets: 'Jul 26, 4am', resetsAt: ago(11 * 24 * 60 * 60_000) },
  })
  expect(usagePctFor(old, 'week', NOW)).toBeNull()
  expect(usagePctFor(old, 'session', NOW)).toBeNull()
  expect(usageCellLabel(old, 'week', false, NOW)).toBe('—')
  expect(usageCellLabel(old, 'session', true, NOW)).toBe('—')
})

test('a window that reset seconds ago is still reported — only a real rollover blanks it', () => {
  const fresh = snap({
    weekAll: { pct: 92, resets: 'Aug 6, 4:59am', resetsAt: ago(5_000) },
  })
  expect(usagePctFor(fresh, 'week', NOW)).toBe(92)
  expect(usageCellLabel(fresh, 'week', false, NOW)).toBe('92%')
})

test('each window is judged on its own reset, not the snapshot as a whole', () => {
  const mixed = snap({
    session: {
      pct: 13,
      resets: 'Aug 6, 2pm',
      resetsAt: new Date(NOW.getTime() + 7_200_000).toISOString(),
    },
    weekAll: { pct: 100, resets: 'Jul 26, 4am', resetsAt: ago(11 * 24 * 60 * 60_000) },
  })
  expect(usagePctFor(mixed, 'session', NOW)).toBe(13)
  expect(usagePctFor(mixed, 'week', NOW)).toBeNull()
})
