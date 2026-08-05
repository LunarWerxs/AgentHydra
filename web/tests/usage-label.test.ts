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
