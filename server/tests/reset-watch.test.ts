// Reset-detection logic (server/src/reset-watch.ts), driven purely through the exported decisions.
//
// These cover the four ways the watcher can be WRONG, which are more interesting than the way it
// can be right: firing twice for one rollover, firing for a rollover from last week, refusing to
// fire because a percentage happened not to move, and repeating forever in persistent mode.
import { expect, test } from 'bun:test'
import {
  dueForRepeat,
  eventMessage,
  nextArm,
  nextWindowState,
  pruneEvents,
  resetDue,
  type WindowState,
} from '../src/reset-watch'
import type { ResetEvent } from '../src/types'

const iso = (ms: number) => new Date(ms).toISOString()
const T0 = Date.UTC(2026, 7, 5, 12, 0, 0)

const win = (over: Partial<WindowState> = {}): WindowState => ({
  resetsAt: iso(T0 + 60_000),
  pct: 90,
  notifiedFor: null,
  ...over,
})

// --- resetDue -----------------------------------------------------------------

test('resetDue: nothing to announce before the recorded instant', () => {
  expect(resetDue(win(), new Date(T0))).toBeNull()
})

test('resetDue: fires once the recorded instant has passed', () => {
  const prev = win()
  expect(resetDue(prev, new Date(T0 + 61_000))).toBe(prev.resetsAt)
})

test('resetDue fires on the TIMESTAMP, not on a percentage that moved', () => {
  // The percentage is an integer and can sit still across a rollover (a fresh window used
  // immediately reads the same 90%). A delta-based detector misses this; a timestamp cannot.
  const prev = win({ pct: 90 })
  expect(resetDue(prev, new Date(T0 + 120_000))).toBe(prev.resetsAt)
})

test('resetDue: one rollover is announced exactly once', () => {
  const at = iso(T0 + 60_000)
  const prev = win({ resetsAt: at, notifiedFor: at })
  expect(resetDue(prev, new Date(T0 + 120_000))).toBeNull()
})

test('resetDue: a rollover older than the grace window is not archaeology worth reporting', () => {
  const prev = win()
  // Daemon was off for a week; every recorded instant is in the past.
  expect(resetDue(prev, new Date(T0 + 8 * 24 * 60 * 60_000))).toBeNull()
})

test('resetDue: no recorded reset instant means nothing to compare against', () => {
  expect(resetDue(undefined, new Date(T0))).toBeNull()
  expect(resetDue(win({ resetsAt: null }), new Date(T0))).toBeNull()
})

test('resetDue: a corrupt stored timestamp is ignored, not thrown on', () => {
  expect(resetDue(win({ resetsAt: 'not-a-date' }), new Date(T0 + 60_000))).toBeNull()
})

// --- nextWindowState ----------------------------------------------------------

test('nextWindowState carries notifiedFor forward so a repeated reading cannot re-open it', () => {
  const at = iso(T0 + 60_000)
  const prev = win({ resetsAt: at, notifiedFor: at })
  const next = nextWindowState({ pct: 3, resets: '', resetsAt: at }, prev, null, new Date(T0))
  expect(next.notifiedFor).toBe(at)
  expect(resetDue(next, new Date(T0 + 120_000))).toBeNull()
})

test('nextWindowState: a NEW reset instant becomes eligible again', () => {
  const first = iso(T0 + 60_000)
  const second = iso(T0 + 5 * 60 * 60_000)
  const prev = win({ resetsAt: first, notifiedFor: first })
  const next = nextWindowState({ pct: 2, resets: '', resetsAt: second }, prev, null, new Date(T0))
  expect(next.resetsAt).toBe(new Date(second).toISOString())
  // Still carries the OLD notifiedFor, which no longer matches — so the next rollover can fire.
  expect(resetDue(next, new Date(T0 + 5 * 60 * 60_000 + 60_000))).toBe(next.resetsAt)
})

test('nextWindowState: a window that has not started records no reset instant', () => {
  const next = nextWindowState(null, undefined, null, new Date(T0))
  expect(next.resetsAt).toBeNull()
  expect(next.pct).toBeNull()
})

// --- nextArm ------------------------------------------------------------------

test('nextArm picks the soonest FUTURE reset across every tracked window', () => {
  const windows = {
    'desktop:a': {
      session: win({ resetsAt: iso(T0 + 3 * 60_000) }),
      weekAll: win({ resetsAt: iso(T0 + 90 * 60_000) }),
    },
    'cli:b': { session: win({ resetsAt: iso(T0 + 60_000) }) },
  }
  expect(nextArm(windows, new Date(T0))).toEqual({ key: 'cli:b', at: T0 + 60_000 })
})

test('nextArm ignores instants already in the past', () => {
  const windows = { 'desktop:a': { session: win({ resetsAt: iso(T0 - 60_000) }) } }
  expect(nextArm(windows, new Date(T0))).toBeNull()
})

// --- persistent mode ----------------------------------------------------------

const ev = (over: Partial<ResetEvent> = {}): ResetEvent => ({
  id: 'e1',
  key: 'desktop:a',
  label: '4claude',
  kind: 'session',
  resetAt: iso(T0),
  detectedAt: iso(T0),
  previousPct: 97,
  currentPct: 0,
  acknowledged: false,
  repeats: 0,
  lastNotifiedAt: iso(T0),
  ...over,
})

const persistent = {
  notifyEnabled: true,
  notifyPersistent: true,
  notifyPersistentIntervalMin: 10,
  notifyPersistentMaxRepeats: 3,
}

test('dueForRepeat: nothing repeats until the interval has elapsed', () => {
  expect(dueForRepeat([ev()], persistent, new Date(T0 + 9 * 60_000))).toHaveLength(0)
  expect(dueForRepeat([ev()], persistent, new Date(T0 + 10 * 60_000))).toHaveLength(1)
})

test('dueForRepeat: acknowledging stops the repeats', () => {
  const list = [ev({ acknowledged: true })]
  expect(dueForRepeat(list, persistent, new Date(T0 + 60 * 60_000))).toHaveLength(0)
})

test('dueForRepeat: the repeat cap is honoured', () => {
  const list = [ev({ repeats: 3 })]
  expect(dueForRepeat(list, persistent, new Date(T0 + 60 * 60_000))).toHaveLength(0)
})

test('dueForRepeat: max 0 means "until acknowledged", not "never"', () => {
  const list = [ev({ repeats: 50 })]
  const settings = { ...persistent, notifyPersistentMaxRepeats: 0 }
  expect(dueForRepeat(list, settings, new Date(T0 + 60 * 60_000))).toHaveLength(1)
})

test('dueForRepeat: persistent mode off means no repeats at all', () => {
  const settings = { ...persistent, notifyPersistent: false }
  expect(dueForRepeat([ev()], settings, new Date(T0 + 60 * 60_000))).toHaveLength(0)
})

test('pruneEvents drops an event that has outlived its usefulness', () => {
  const fresh = ev({ id: 'fresh' })
  const old = ev({ id: 'old', detectedAt: iso(T0 - 72 * 60 * 60_000) })
  const kept = pruneEvents([fresh, old], new Date(T0))
  expect(kept.map((e) => e.id)).toEqual(['fresh'])
})

// --- copy ---------------------------------------------------------------------

test('eventMessage names the instance, the window, and where you were', () => {
  const { title, body } = eventMessage(ev())
  expect(title).toBe('4claude: 5-hour session limit reset')
  expect(body).toContain('You were at 97%.')
  expect(body).toContain('Now at 0%.')
})

test('eventMessage omits the percentages it does not have', () => {
  const { body } = eventMessage(ev({ previousPct: null, currentPct: null }))
  expect(body).not.toContain('%')
})
