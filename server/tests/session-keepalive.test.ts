// server/tests/session-keepalive.test.ts — when the keepalive is allowed to spend quota.
//
// The spawn is the boring half. THE DECISION IS THE RISK: this feature exists to burn a turn on
// purpose, on the owner's own accounts, unattended. Every rule below is a reason NOT to, and each
// one is here because the failure it prevents is silent — a keepalive that pokes an account already
// running, or one nearly out of weekly quota, costs real money and reports nothing wrong.
//
// decideKeepalive is pure precisely so this can be pinned without spawning anything.

import { describe, expect, test } from 'bun:test'
import {
  decideKeepalive,
  type NudgeOutcome,
  type NudgeRecords,
  type NudgeStore,
  runKeepaliveSweep,
  windowRunning,
} from '../src/session-keepalive'
import type { UsageSnapshot } from '../src/types'

function snap(patch: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    account: 'a@b.com',
    session: { pct: 0, resets: '' },
    weekAll: { pct: 10, resets: 'Sep 9, 3:00am' },
    weekModel: null,
    capturedAt: '2024-09-06T12:00:00.000Z',
    ...patch,
  }
}

describe('windowRunning', () => {
  test('an empty reset string means the 5-hour window has not started', () => {
    // That empty string is the ONLY signal a snapshot carries for this.
    expect(windowRunning(snap({ session: { pct: 0, resets: '' } }))).toBe(false)
  })

  test('a reset time means it is running', () => {
    expect(windowRunning(snap({ session: { pct: 12, resets: 'Sep 6, 5:00pm' } }))).toBe(true)
    expect(
      windowRunning(
        snap({ session: { pct: 12, resets: '', resetsAt: '2024-09-06T17:00:00.000Z' } }),
        Date.parse('2024-09-06T12:00:00.000Z'),
      ),
    ).toBe(true)
  })

  test('a reset instant that has passed means the window is over', () => {
    // Owner, 2026-10-01: nudge when "the reset is in the past". A reading kept from before its
    // reset still carries the old instant, and it used to read as running until the next sweep.
    const after = Date.parse('2024-09-06T17:00:01.000Z')
    const stale = snap({
      session: { pct: 40, resets: 'Sep 6, 5:00pm', resetsAt: '2024-09-06T17:00:00.000Z' },
    })
    expect(windowRunning(stale, after)).toBe(false)
    expect(decideKeepalive(stale, 85, { now: after }).action).toBe('nudge')
  })

  test('no session figure at all is UNKNOWN, not "not running"', () => {
    // The difference matters: one is a reason to act, the other is a reason to leave it alone.
    expect(windowRunning(snap({ session: null }))).toBeNull()
    expect(windowRunning(null)).toBeNull()
  })
})

describe('decideKeepalive', () => {
  test('nudges an idle account with weekly quota to spare', () => {
    const d = decideKeepalive(snap(), 80)
    expect(d.action).toBe('nudge')
  })

  test('never pokes an account whose window is already running', () => {
    // The entire goal is a running window. Poking one that has it is pure waste.
    const d = decideKeepalive(snap({ session: { pct: 20, resets: 'Sep 6, 5:00pm' } }), 80)
    expect(d.action).toBe('skip')
    expect(d.reason).toContain('already running')
  })

  test('refuses at or above the weekly floor, boundary included', () => {
    // Burning the last of a WEEKLY cap to start a five-hour clock is exactly backwards: the
    // 5-hour window refills the same day, the weekly one does not.
    expect(decideKeepalive(snap({ weekAll: { pct: 80, resets: 'x' } }), 80).action).toBe('skip')
    expect(decideKeepalive(snap({ weekAll: { pct: 95, resets: 'x' } }), 80).action).toBe('skip')
    expect(decideKeepalive(snap({ weekAll: { pct: 79.9, resets: 'x' } }), 80).action).toBe('nudge')
  })

  test('an unreadable reading never spends — "I could not tell" is not permission', () => {
    expect(decideKeepalive(null, 80).action).toBe('skip')
    expect(decideKeepalive(undefined, 80).action).toBe('skip')
    expect(decideKeepalive(snap({ session: null }), 80).action).toBe('skip')
    expect(decideKeepalive(snap({ weekAll: null }), 80).action).toBe('skip')
    expect(decideKeepalive(snap({ weekAll: { pct: Number.NaN, resets: 'x' } }), 80).action).toBe(
      'skip',
    )
  })

  test('a floor of 0 stops everything, which is the honest reading of "never"', () => {
    // Not a special case in the code — it falls out of `>=`. Pinned so nobody "tidies" it into a
    // truthiness check that would make 0 mean "no floor" and quietly re-enable spending.
    expect(decideKeepalive(snap({ weekAll: { pct: 0, resets: 'x' } }), 0).action).toBe('skip')
  })

  test('never spends on a blocked account, nor twice on one whose nudged window still runs', () => {
    // A signed-out, walled or busy account is the caller's knowledge, not the reading's; and a
    // usage reading lags a nudge by up to a sweep, so without the record every sweep in between
    // would nudge again.
    const now = Date.parse('2024-09-06T12:00:00.000Z')
    const idle = snap()
    expect(decideKeepalive(idle, 85, { now, blocked: '1 Claude session running on it' })).toEqual({
      action: 'skip',
      reason: '1 Claude session running on it',
    })
    const nudged = {
      at: now - 60_000,
      ok: true,
      note: 'started',
      resetsAt: '2024-09-06T16:59:00.000Z',
      model: 'claude-haiku-4-5',
      costUsd: 0.001,
    }
    expect(decideKeepalive(idle, 85, { now, last: nudged }).action).toBe('skip')
    expect(
      decideKeepalive(idle, 85, { now: Date.parse('2024-09-06T17:00:00.000Z'), last: nudged })
        .action,
    ).toBe('nudge')
    const failed = { ...nudged, ok: false, note: 'claude exited 1', resetsAt: null }
    expect(decideKeepalive(idle, 85, { now, last: failed }).action).toBe('skip')
    expect(decideKeepalive(idle, 85, { now: now + 61 * 60_000, last: failed }).action).toBe('nudge')
  })

  test('every decision says why, including the ones that act', () => {
    // These end up in a log the owner reads to answer "why did it spend that?".
    for (const d of [
      decideKeepalive(snap(), 80),
      decideKeepalive(snap({ session: { pct: 1, resets: 'later' } }), 80),
      decideKeepalive(null, 80),
    ]) {
      expect(d.reason.length).toBeGreaterThan(0)
    }
  })
})

// --- the sweep: what it does, and what it refuses to do -------------------------------------------
describe('runKeepaliveSweep', () => {
  const target = (label: string, usageKey: string) => ({
    id: label,
    label,
    configDir: '',
    usageKey,
  })
  const targets = [
    target('idle-1', 'desktop:a'),
    target('running-1', 'desktop:b'),
    target('spent-1', 'desktop:c'),
    // Weekly at 10%, at its owner's cap of 10 (AccountPlacement.maxWeekPct), under the floor.
    { ...target('capped-1', 'desktop:a'), weekCapPct: 10 },
  ]
  /** A fresh in-memory record store per sweep, so one test's nudge never holds off another's. */
  const memory = (): NudgeStore => {
    const all: NudgeRecords = {}
    return {
      read: () => ({ ...all }),
      write: (id, rec) => {
        all[id] = rec
      },
    }
  }
  const started = async (): Promise<NudgeOutcome> => ({
    started: true,
    note: 'started',
    resetsAt: null,
    model: null,
    costUsd: null,
  })
  const readings: Record<string, UsageSnapshot> = {
    'desktop:a': snap(),
    'desktop:b': snap({ session: { pct: 5, resets: 'Sep 6, 5:00pm' } }),
    'desktop:c': snap({ weekAll: { pct: 92, resets: 'x' } }),
  }
  const reading = (k: string) => readings[k] ?? null

  test('disabled means it does not even look, let alone spend', async () => {
    let called = 0
    const r = await runKeepaliveSweep({
      enabled: false,
      weeklyFloorPct: 80,
      targets,
      reading,
      store: memory(),
      nudge: async () => {
        called++
        return started()
      },
    })
    expect(called).toBe(0)
    expect(r.considered).toBe(0)
    expect(r.nudged).toEqual([])
  })

  test('nudges only the idle account, and says why it left the others', async () => {
    const poked: string[] = []
    const r = await runKeepaliveSweep({
      enabled: true,
      weeklyFloorPct: 80,
      targets,
      reading,
      store: memory(),
      nudge: async (t) => {
        poked.push(t.label)
        return started()
      },
    })
    expect(poked).toEqual(['idle-1'])
    expect(r.nudged).toEqual(['idle-1'])
    expect(r.skipped['running-1']).toContain('already running')
    expect(r.skipped['spent-1']).toContain('floor')
    expect(r.skipped['capped-1']).toContain('at or above the 10% floor')
  })

  test('a nudge that did not start the window is NOT reported as a success', async () => {
    // The turn was spent either way. Calling it a win is how you spend it again every tick.
    const r = await runKeepaliveSweep({
      enabled: true,
      weeklyFloorPct: 80,
      targets: [targets[0]!],
      reading,
      store: memory(),
      nudge: async () => ({ ...(await started()), started: false, note: 'claude exited 1' }),
    })
    expect(r.nudged).toEqual([])
    expect(r.skipped['idle-1']).toBe('claude exited 1')
  })

  test('one account throwing does not stop the sweep, and the reason is kept', async () => {
    const r = await runKeepaliveSweep({
      enabled: true,
      weeklyFloorPct: 80,
      targets: [target('boom', 'desktop:a'), target('fine', 'desktop:a')],
      reading,
      store: memory(),
      nudge: async (t) => {
        if (t.label === 'boom') throw new Error('spawn refused')
        return started()
      },
    })
    expect(r.skipped.boom).toContain('spawn refused')
    expect(r.nudged).toEqual(['fine'])
  })
})
