// web/src/lib/usage-reset.ts — the countdown the usage-mode columns render.
import { expect, test } from 'bun:test'
import {
  formatCountdown,
  msUntilReset,
  resetLabel,
  SESSION_WINDOW_MS,
  WEEK_WINDOW_MS,
  waitSeverity,
  windowRemainingPct,
} from '../src/lib/usage-reset'

const T0 = Date.UTC(2026, 7, 5, 12, 0, 0)
const now = new Date(T0)
const at = (ms: number) => ({
  pct: 50,
  resets: 'Aug 5, 4:59pm',
  resetsAt: new Date(T0 + ms).toISOString(),
})

test('formatCountdown is coarse above an hour and precise below a minute', () => {
  expect(formatCountdown(31_000)).toBe('31s')
  expect(formatCountdown(9 * 60_000)).toBe('9m')
  expect(formatCountdown(2 * 60 * 60_000 + 14 * 60_000)).toBe('2h 14m')
  expect(formatCountdown(3 * 24 * 60 * 60_000 + 4 * 60 * 60_000)).toBe('3d 4h')
  expect(formatCountdown(3 * 24 * 60 * 60_000)).toBe('3d')
})

test('formatCountdown says "now" once the instant has passed', () => {
  expect(formatCountdown(0)).toBe('now')
  expect(formatCountdown(-5_000)).toBe('now')
})

test('msUntilReset needs a real ISO instant', () => {
  expect(msUntilReset(at(60_000), now)).toBe(60_000)
  expect(msUntilReset({ pct: 0, resets: '' }, now)).toBeNull()
  expect(msUntilReset({ pct: 0, resets: '', resetsAt: 'garbage' }, now)).toBeNull()
  expect(msUntilReset(null, now)).toBeNull()
})

test('resetLabel falls back to the human string rather than guessing a year', () => {
  // The `claude -p "/usage"` path prints a YEARLESS date. Parsing it client-side would sometimes
  // produce a countdown that is a year out, which is worse than showing the string it gave us.
  expect(resetLabel({ pct: 50, resets: 'Aug 6, 4:59am' }, now)).toBe('Aug 6, 4:59am')
})

test('resetLabel is null when there is no reset at all', () => {
  // A 0% window has not started, so it prints no reset time. "—" is the honest cell, not "0s".
  expect(resetLabel({ pct: 0, resets: '' }, now)).toBeNull()
  expect(resetLabel(null, now)).toBeNull()
  expect(resetLabel(undefined, now)).toBeNull()
})

test('resetLabel prefers the ISO instant when both are present', () => {
  expect(resetLabel(at(2 * 60 * 60_000), now)).toBe('2h 0m')
})

// --- the bar's LENGTH: how much of the wait is left ---------------------------

test('windowRemainingPct: a shorter wait is a shorter bar', () => {
  // The endpoint never reports a window START; the remaining fraction is what's left over the
  // window's fixed length.
  expect(windowRemainingPct(at(SESSION_WINDOW_MS), SESSION_WINDOW_MS, now)).toBe(100)
  expect(windowRemainingPct(at(SESSION_WINDOW_MS / 2), SESSION_WINDOW_MS, now)).toBe(50)
  expect(windowRemainingPct(at(60_000), SESSION_WINDOW_MS, now)).toBe(0)
  // 1d 9h left of a 7-day week is a low bar, which is the whole point.
  expect(windowRemainingPct(at(33 * 60 * 60_000), WEEK_WINDOW_MS, now)).toBe(20)
})

test('windowRemainingPct is clamped at both ends', () => {
  // A reset already past must read 0, not go negative…
  expect(windowRemainingPct(at(-60 * 60_000), SESSION_WINDOW_MS, now)).toBe(0)
  // …and a reset further out than one window length (an unstarted window quotes the next
  // boundary) must read 100, not overflow.
  expect(windowRemainingPct(at(3 * SESSION_WINDOW_MS), SESSION_WINDOW_MS, now)).toBe(100)
})

test('windowRemainingPct is null without a reset instant, so the cell can render "—"', () => {
  expect(windowRemainingPct({ pct: 0, resets: '' }, SESSION_WINDOW_MS, now)).toBeNull()
  expect(windowRemainingPct(null, SESSION_WINDOW_MS, now)).toBeNull()
})

// --- the bar's COLOUR: how long the wait is -----------------------------------

/** The colour is banded off the SAME fraction that sizes the bar, so this is how a cell derives it. */
const waitFor = (limit: Parameters<typeof windowRemainingPct>[0], windowMs: number) =>
  waitSeverity(windowRemainingPct(limit, windowMs, now))

test('waitSeverity on the WEEKLY window reads in days: <1 green, 1-2 amber, >2 red', () => {
  expect(waitFor(at(20 * 60_000), WEEK_WINDOW_MS)).toBe('success')
  expect(waitFor(at(23 * 60 * 60_000), WEEK_WINDOW_MS)).toBe('success')
  expect(waitFor(at(33 * 60 * 60_000), WEEK_WINDOW_MS)).toBe('warning') // 1d 9h
  expect(waitFor(at(47 * 60 * 60_000), WEEK_WINDOW_MS)).toBe('warning')
  expect(waitFor(at(53 * 60 * 60_000), WEEK_WINDOW_MS)).toBe('destructive') // 2d 5h
  expect(waitFor(at(5 * 24 * 60 * 60_000), WEEK_WINDOW_MS)).toBe('destructive')
})

test('the SAME bands scale to the 5-hour session window', () => {
  // Absolute day thresholds would paint this whole column green — a five-hour window can never make
  // you wait a day — and it would stop carrying any signal. Banded as a fraction of its OWN window,
  // "3h 25m left of five hours" is the same kind of long wait as "5d 13h left of a week".
  expect(waitFor(at(15 * 60_000), SESSION_WINDOW_MS)).toBe('success') // 5% in
  expect(waitFor(at(50 * 60_000), SESSION_WINDOW_MS)).toBe('warning') // ~17%
  expect(waitFor(at(3 * 60 * 60_000 + 25 * 60_000), SESSION_WINDOW_MS)).toBe('destructive') // 68%
})

test('the bands sit at one and two sevenths, wherever they are applied', () => {
  expect(waitSeverity(14)).toBe('success')
  expect(waitSeverity(15)).toBe('warning')
  expect(waitSeverity(28)).toBe('warning')
  expect(waitSeverity(29)).toBe('destructive')
})

test('waitSeverity: no reset instant, and a reset already passed, are both "no wait"', () => {
  expect(waitSeverity(null)).toBe('success')
  expect(waitFor({ pct: 0, resets: '' }, SESSION_WINDOW_MS)).toBe('success')
  expect(waitFor(at(-60_000), SESSION_WINDOW_MS)).toBe('success')
})
