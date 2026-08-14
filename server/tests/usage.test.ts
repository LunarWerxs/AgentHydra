// server/tests/usage.test.ts — the /usage text parser (server/src/usage.ts).
//
// Fixture is a real `claude -p "/usage"` block captured 2026-07-14 (numbers only, no secrets).

import { describe, expect, test } from 'bun:test'
import type { UsageAdvice, UsageSnapshot } from '../src/types'
import {
  bindingWeeklyPct,
  isNoData,
  nextStep,
  parseResetTime,
  parseUsageOutput,
  resetTimeIso,
  usageAdvice,
} from '../src/usage'

const FIXTURE = [
  'Warning: no stdin data received in 3s, proceeding without it.',
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 0% used · resets Jul 13, 11:49pm (America/Chicago)',
  'Current week (all models): 97% used · resets Jul 14, 2:59am (America/Chicago)',
  'Current week (Fable): 89% used · resets Jul 14, 3am (America/Chicago)',
  '',
  'Last 24h · 13748 requests · 51 sessions',
].join('\n')

describe('parseUsageOutput', () => {
  test('extracts session, weekAll, and per-model weekly from a real block', () => {
    const snap = parseUsageOutput(
      FIXTURE,
      'lunarwerx@example.com',
      new Date('2026-07-14T02:00:00Z'),
    )
    expect(snap.account).toBe('lunarwerx@example.com')
    expect(snap.session).toEqual({ pct: 0, resets: 'Jul 13, 11:49pm' })
    expect(snap.weekAll).toEqual({ pct: 97, resets: 'Jul 14, 2:59am' })
    expect(snap.weekModel).toEqual({ label: 'Fable', pct: 89, resets: 'Jul 14, 3am' })
    expect(snap.capturedAt).toBe('2026-07-14T02:00:00.000Z')
  })

  test('the all-models weekly is the binding cap', () => {
    const snap = parseUsageOutput(FIXTURE)
    expect(bindingWeeklyPct(snap)).toBe(97)
    expect(isNoData(snap)).toBe(false)
  })

  test('empty / unauthenticated output yields all-null and reports no-data (never 0%)', () => {
    const snap = parseUsageOutput('Total cost: $0.00\nUsage: 0 input, 0 output')
    expect(snap.session).toBeNull()
    expect(snap.weekAll).toBeNull()
    expect(snap.weekModel).toBeNull()
    expect(bindingWeeklyPct(snap)).toBeNull()
    expect(isNoData(snap)).toBe(true)
  })

  test('parses a real 0%-session block where the session line has NO "· resets" clause', () => {
    // Captured live 2026-07-14: at 0% the session window has not started, so the CLI omits the
    // reset time on that line (the weekly lines still carry theirs). The parser must still read
    // session 0% and both weekly numbers.
    const raw = [
      'You are currently using your subscription to power your Claude Code usage',
      '',
      'Current session: 0% used',
      'Current week (all models): 98% used · resets Jul 19, 3:59am (America/Chicago)',
      'Current week (Fable): 100% used · resets Jul 19, 3:59am (America/Chicago)',
      '',
      "What's contributing to your limits usage?",
      'Last 24h · 11477 requests · 47 sessions',
    ].join('\n')
    const snap = parseUsageOutput(raw, 'desktop@example.com')
    expect(snap.session).toEqual({ pct: 0, resets: '' })
    expect(snap.weekAll).toEqual({ pct: 98, resets: 'Jul 19, 3:59am' })
    expect(snap.weekModel).toEqual({ label: 'Fable', pct: 100, resets: 'Jul 19, 3:59am' })
    expect(bindingWeeklyPct(snap)).toBe(98)
    expect(isNoData(snap)).toBe(false)
  })

  test('tolerates a hyphen separator and missing per-model line', () => {
    const raw =
      'Current session: 12% used - resets Tomorrow 9am\nCurrent week (all models): 40% used - resets Mon 3am'
    const snap = parseUsageOutput(raw)
    expect(snap.session?.pct).toBe(12)
    expect(snap.weekAll).toEqual({ pct: 40, resets: 'Mon 3am' })
    expect(snap.weekModel).toBeNull()
  })
})

describe('parseResetTime', () => {
  // Asserted via the round-tripped LOCAL components (not an exact ISO string), so the tests are
  // timezone-independent: parseResetTime builds a local Date, toISOString stores UTC, and the
  // Date getters convert back to the same local wall-clock components we passed in.
  test('parses an am reset into the right local wall-clock time', () => {
    const iso = parseResetTime('Jul 14, 2:59am', new Date(2026, 6, 14, 1, 0))
    expect(iso).not.toBeNull()
    const d = new Date(iso!)
    expect(d.getMonth()).toBe(6) // Jul
    expect(d.getDate()).toBe(14)
    expect(d.getHours()).toBe(2)
    expect(d.getMinutes()).toBe(59)
  })

  test('handles pm and the 12am/12pm edges', () => {
    expect(
      new Date(parseResetTime('Jul 13, 11:49pm', new Date(2026, 6, 13, 10, 0))!).getHours(),
    ).toBe(23)
    expect(new Date(parseResetTime('Jan 1, 12:00am', new Date(2026, 0, 1, 0, 0))!).getHours()).toBe(
      0,
    )
    expect(new Date(parseResetTime('Jan 1, 12:30pm', new Date(2026, 0, 1, 0, 0))!).getHours()).toBe(
      12,
    )
  })

  test('rolls a Dec→Jan reset forward to next year', () => {
    const now = new Date(2026, 11, 31, 23, 0) // Dec 31, 2026 11pm local
    const d = new Date(parseResetTime('Jan 1, 3:00am', now)!)
    expect(d.getFullYear()).toBe(2027)
    expect(d.getMonth()).toBe(0)
    expect(d.getDate()).toBe(1)
  })

  test('returns null for an unparseable string (no month/time)', () => {
    expect(parseResetTime('Tomorrow 9am')).toBeNull()
    expect(parseResetTime('')).toBeNull()
    expect(parseResetTime('Jul 14, 3am')).toBeNull() // no minutes → not schedulable
  })
})

describe('resetTimeIso', () => {
  test('returns null for a null/undefined limit', () => {
    expect(resetTimeIso(null)).toBeNull()
    expect(resetTimeIso(undefined)).toBeNull()
  })

  test('prefers a present resetsAt, normalized to ISO', () => {
    const iso = resetTimeIso({ resetsAt: '2026-07-19T08:59:59.574959+00:00', resets: 'ignored' })
    expect(iso).toBe(new Date('2026-07-19T08:59:59.574959+00:00').toISOString())
  })

  test('falls back to parsing the human `resets` string when resetsAt is absent', () => {
    const now = new Date(2026, 6, 14, 1, 0)
    const iso = resetTimeIso({ resets: 'Jul 14, 2:59am' }, now)
    expect(iso).toBe(parseResetTime('Jul 14, 2:59am', now))
  })

  test('falls back to parseResetTime when resetsAt is present but unparseable', () => {
    const now = new Date(2026, 6, 14, 1, 0)
    const iso = resetTimeIso({ resetsAt: 'not-a-date', resets: 'Jul 14, 2:59am' }, now)
    expect(iso).toBe(parseResetTime('Jul 14, 2:59am', now))
  })

  test('returns null when neither resetsAt nor a parseable resets string is present', () => {
    expect(resetTimeIso({})).toBeNull()
    expect(resetTimeIso({ resets: 'Tomorrow 9am' })).toBeNull()
  })
})

describe('usageAdvice', () => {
  const baseSnap: UsageSnapshot = {
    account: null,
    session: null,
    weekAll: null,
    weekModel: null,
    capturedAt: '2026-07-14T00:00:00.000Z',
    source: 'cli',
  }

  test('no weekAll -> unknown, and unknown is NOT "plenty left"', () => {
    const advice = usageAdvice(baseSnap)
    expect(advice.severity).toBe('unknown')
    expect(advice.bindingPct).toBeNull()
    expect(advice.shouldOffload).toBe(false)
    expect(advice.safeToFanOut).toBe(false)
  })

  test('derived severity: >=95 is critical -> offload, not safe to fan out', () => {
    const snap: UsageSnapshot = { ...baseSnap, weekAll: { pct: 95, resets: '' } }
    const advice = usageAdvice(snap)
    expect(advice.severity).toBe('critical')
    expect(advice.bindingPct).toBe(95)
    expect(advice.shouldOffload).toBe(true)
    expect(advice.safeToFanOut).toBe(false)
  })

  test('derived severity: >=80 and <95 is warning -> wind down, not safe to fan out', () => {
    const snap: UsageSnapshot = { ...baseSnap, weekAll: { pct: 80, resets: '' } }
    const advice = usageAdvice(snap)
    expect(advice.severity).toBe('warning')
    expect(advice.bindingPct).toBe(80)
    expect(advice.shouldOffload).toBe(false)
    expect(advice.safeToFanOut).toBe(false)
  })

  test('derived severity: <80 is normal -> safe to fan out', () => {
    const snap: UsageSnapshot = { ...baseSnap, weekAll: { pct: 50, resets: '' } }
    const advice = usageAdvice(snap)
    expect(advice.severity).toBe('normal')
    expect(advice.bindingPct).toBe(50)
    expect(advice.shouldOffload).toBe(false)
    expect(advice.safeToFanOut).toBe(true)
  })

  test('an explicit server severity is TRUSTED and overrides the derived threshold', () => {
    // pct 50 would derive to 'normal', but the server says 'critical' — trust the server.
    const snap: UsageSnapshot = {
      ...baseSnap,
      weekAll: { pct: 50, resets: '', severity: 'critical' },
    }
    const advice = usageAdvice(snap)
    expect(advice.severity).toBe('critical')
    expect(advice.bindingPct).toBe(50)
    expect(advice.shouldOffload).toBe(true)
    expect(advice.safeToFanOut).toBe(false)
  })

  test('an explicit server severity of warning overrides a low derived pct', () => {
    const snap: UsageSnapshot = {
      ...baseSnap,
      weekAll: { pct: 10, resets: '', severity: 'warning' },
    }
    const advice = usageAdvice(snap)
    expect(advice.severity).toBe('warning')
    expect(advice.shouldOffload).toBe(false)
    expect(advice.safeToFanOut).toBe(false)
  })

  test('an explicit server severity of normal overrides a high derived pct', () => {
    const snap: UsageSnapshot = {
      ...baseSnap,
      weekAll: { pct: 99, resets: '', severity: 'normal' },
    }
    const advice = usageAdvice(snap)
    expect(advice.severity).toBe('normal')
    expect(advice.shouldOffload).toBe(false)
    expect(advice.safeToFanOut).toBe(true)
  })
})

describe('nextStep — the one-line instruction attached to every usage result', () => {
  const advice = (over: Partial<UsageAdvice> = {}): UsageAdvice => ({
    severity: 'normal',
    bindingPct: 10,
    shouldOffload: false,
    safeToFanOut: true,
    advice: '',
    ...over,
  })

  test('offloading outranks everything: save the work before any other consideration', () => {
    const step = nextStep(
      advice({ severity: 'critical', shouldOffload: true, safeToFanOut: false }),
    )
    expect(step).toContain('SAVE YOUR WORK NOW')
    expect(step).toContain('Do not start a fan-out')
  })

  test('an unreadable check says UNKNOWN, and explicitly denies that it means headroom', () => {
    const step = nextStep(advice({ severity: 'unknown', safeToFanOut: false, bindingPct: null }))
    expect(step).toContain('UNKNOWN')
    expect(step).toContain('not "plenty left"')
  })

  test('a warning winds down rather than stopping', () => {
    expect(nextStep(advice({ severity: 'warning', safeToFanOut: false }))).toContain('Wind down')
  })

  test('normal still gates a fan-out on projected cost, not just current', () => {
    const step = nextStep(advice())
    expect(step).toContain('CURRENT + PROJECTED')
    expect(step).toContain('cannot be recalled')
  })

  test('a known account is named, so a percentage is never reported bare', () => {
    expect(nextStep(advice(), { instanceLabel: 'instance #11 (Pro)' })).toContain(
      'Report this as instance #11 (Pro)',
    )
  })

  test('an unconfirmed identity suppresses the account name entirely', () => {
    // Naming the wrong account is worse than naming none: a confident wrong number gets acted on.
    const step = nextStep(advice(), {
      instanceLabel: 'instance #11 (Pro)',
      identityUncertain: true,
    })
    expect(step).not.toContain('instance #11')
    expect(step).toContain('could not be confirmed')
  })

  test('every branch is one line, because guidance that runs long stops being read', () => {
    for (const a of [
      advice({ shouldOffload: true }),
      advice({ severity: 'unknown', safeToFanOut: false }),
      advice({ severity: 'warning', safeToFanOut: false }),
      advice(),
    ]) {
      expect(nextStep(a, { instanceLabel: 'instance #1' })).not.toContain('\n')
    }
  })
})
