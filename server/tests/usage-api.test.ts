// server/tests/usage-api.test.ts — the direct-API usage mapper (server/src/usage-api.ts).
//
// Fixture is a real `GET /api/oauth/usage` response captured 2026-07-14 (numbers only, no secrets).

import { describe, expect, test } from 'bun:test'
import { formatResetLocal, mapUsageApiResponse } from '../src/usage-api'

const FIXTURE = {
  five_hour: {
    utilization: 0.0,
    resets_at: null,
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day: {
    utilization: 98.0,
    resets_at: '2024-07-19T08:59:59.574959+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false },
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 0,
      severity: 'normal',
      resets_at: null,
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 98,
      severity: 'critical',
      resets_at: '2024-07-19T08:59:59.574959+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 100,
      severity: 'critical',
      resets_at: '2024-07-19T08:59:59.575426+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true,
    },
  ],
  spend: {},
  member_dashboard_available: false,
}

describe('mapUsageApiResponse', () => {
  test('maps a real captured response: session, weekAll, and per-model weekly from limits[]', () => {
    const snap = mapUsageApiResponse(
      FIXTURE,
      'lunarwerx@example.com',
      new Date('2024-07-14T02:00:00Z'),
    )

    expect(snap.session).toEqual({
      pct: 0,
      resets: '',
      resetsAt: null,
      severity: 'normal',
    })
    // `resets` is rendered in the LOCAL timezone of whatever machine runs the test, so it is
    // derived via formatResetLocal (already unit-tested below) rather than hardcoded from the
    // UTC fixture string — that would only pass in UTC.
    expect(snap.weekAll).toEqual({
      pct: 98,
      resets: formatResetLocal('2024-07-19T08:59:59.574959+00:00'),
      resetsAt: '2024-07-19T08:59:59.574959+00:00',
      severity: 'critical',
    })
    expect(snap.weekModel).toEqual({
      label: 'Fable',
      pct: 100,
      resets: formatResetLocal('2024-07-19T08:59:59.575426+00:00'),
      resetsAt: '2024-07-19T08:59:59.575426+00:00',
      severity: 'critical',
    })
    expect(snap.source).toBe('api')
    expect(snap.account).toBe('lunarwerx@example.com')
    expect(snap.capturedAt).toBe('2024-07-14T02:00:00.000Z')
  })

  test('stamps a null account label through unchanged', () => {
    const snap = mapUsageApiResponse(FIXTURE)
    expect(snap.account).toBeNull()
  })

  test('falls back to five_hour/seven_day utilization floats when limits[] is absent', () => {
    const raw = {
      five_hour: { utilization: 12.4, resets_at: '2024-07-14T10:00:00+00:00' },
      seven_day: { utilization: 55.6, resets_at: '2024-07-19T08:59:59+00:00' },
    }
    const snap = mapUsageApiResponse(raw, 'acct@example.com')
    expect(snap.session).toEqual({
      pct: 12,
      resets: formatResetLocal('2024-07-14T10:00:00+00:00'),
      resetsAt: '2024-07-14T10:00:00+00:00',
      severity: undefined,
    })
    expect(snap.weekAll).toEqual({
      pct: 56,
      resets: formatResetLocal('2024-07-19T08:59:59+00:00'),
      resetsAt: '2024-07-19T08:59:59+00:00',
      severity: undefined,
    })
    expect(snap.weekModel).toBeNull()
    expect(snap.source).toBe('api')
  })

  test('an empty object maps to an all-null snapshot', () => {
    const snap = mapUsageApiResponse({})
    expect(snap.session).toBeNull()
    expect(snap.weekAll).toBeNull()
    expect(snap.weekModel).toBeNull()
    expect(snap.account).toBeNull()
    expect(snap.source).toBe('api')
  })
})

describe('formatResetLocal', () => {
  // Timezone-independent: build the ISO input from a local Date (same construction the daemon's
  // own clock would produce), then assert against that SAME Date's local getters — never a
  // hardcoded clock time derived from the UTC string.
  test('formats month/day and drops ":00" when minutes are zero', () => {
    const d = new Date(2026, 6, 19, 3, 0) // Jul 19, 3:00am local
    const out = formatResetLocal(d.toISOString())
    const hour12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12
    const ampm = d.getHours() < 12 ? 'am' : 'pm'
    expect(out).toBe(`Jul 19, ${hour12}${ampm}`)
    expect(out).not.toContain(':00')
  })

  test('keeps non-zero minutes', () => {
    const d = new Date(2026, 6, 19, 15, 59) // 3:59pm local
    const out = formatResetLocal(d.toISOString())
    const hour12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12
    const ampm = d.getHours() < 12 ? 'am' : 'pm'
    expect(out).toBe(`Jul 19, ${hour12}:59${ampm}`)
  })

  test('matches the general shape for an arbitrary local date/time', () => {
    const d = new Date(2026, 11, 1, 0, 30) // Dec 1, 12:30am local
    const out = formatResetLocal(d.toISOString())
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}(:\d{2})?(am|pm)$/)
  })

  test("returns '' for null, undefined, and unparseable input", () => {
    expect(formatResetLocal(null)).toBe('')
    expect(formatResetLocal(undefined)).toBe('')
    expect(formatResetLocal('not-a-date')).toBe('')
    expect(formatResetLocal('')).toBe('')
  })
})
