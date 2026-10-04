// The re-wake cooldown (server/src/rewake-cooldown.ts): auto-resumes that keep adding no real turn
// are held back by a doubling delay, and a real turn resets it. Pinned at two seams: the pure rules
// (curve, streak, what counts as a turn) and the monitor's scheduling step, which is where a missing
// wire would silently let an empty loop re-wake at full speed.

import { afterEach, describe, expect, test } from 'bun:test'
import { db, setSetting } from '../src/db'
import { type MonitorDeps, runMonitorOnce } from '../src/monitor'
import {
  countProgressTurns,
  nextEmptyStreak,
  REWAKE_COOLDOWN_BASE_MS,
  REWAKE_COOLDOWN_CAP_MS,
  rewakeCooldownMs,
} from '../src/rewake-cooldown'
import type { UsageSnapshot } from '../src/types'

describe('rewakeCooldownMs', () => {
  test('two empty resumes are free, then 2 min doubling per further one, capped at 30 min', () => {
    expect(rewakeCooldownMs(0)).toBe(0)
    expect(rewakeCooldownMs(1)).toBe(0)
    expect(rewakeCooldownMs(2)).toBe(REWAKE_COOLDOWN_BASE_MS)
    expect(rewakeCooldownMs(3)).toBe(2 * REWAKE_COOLDOWN_BASE_MS)
    expect(rewakeCooldownMs(4)).toBe(4 * REWAKE_COOLDOWN_BASE_MS)
    expect(rewakeCooldownMs(6)).toBe(REWAKE_COOLDOWN_CAP_MS)
    expect(rewakeCooldownMs(1000)).toBe(REWAKE_COOLDOWN_CAP_MS)
  })
})

describe('nextEmptyStreak', () => {
  test('no new real turn since the last resume grows the streak; any new turn resets it', () => {
    expect(nextEmptyStreak({ mark: 5, streak: 1 }, 5)).toBe(2)
    expect(nextEmptyStreak({ mark: 5, streak: 3 }, 6)).toBe(0)
  })

  test('an unread mark is no proof of an empty resume, so it never builds a hold', () => {
    expect(nextEmptyStreak(null, 5)).toBe(0)
    expect(nextEmptyStreak({ mark: null, streak: 4 }, 5)).toBe(0)
    expect(nextEmptyStreak({ mark: 5, streak: 4 }, null)).toBe(0)
  })
})

describe('countProgressTurns', () => {
  const line = (o: unknown) => JSON.stringify(o)
  test('counts model turns and typed messages, not bookkeeping, walls, tool results or the nudge', () => {
    const jsonl = [
      line({ type: 'user', message: { role: 'user', content: 'ship the parser' } }),
      line({ type: 'assistant', message: { role: 'assistant', model: 'claude', content: [] } }),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
      }),
      line({
        type: 'assistant',
        isApiErrorMessage: true,
        message: { role: 'assistant', model: '<synthetic>', content: [] },
      }),
      line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Continue' } }),
      line({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>' } }),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'resume' }] },
      }),
      '{"type":"assistant","mess',
    ].join('\n')
    expect(countProgressTurns(jsonl, 'resume')).toBe(2)
  })
})

describe('the monitor holds a resume after empty ones', () => {
  const SESSION = 'rewake-session'
  const FIVE_HOURS = 5 * 3600 * 1000

  const TOUCHED = ['monitor_enabled', 'monitor_max_attempts', 'monitor_resume_buffer_min']

  afterEach(() => {
    db.query('delete from monitor_state where session_id = ?').run(SESSION)
    db.query('delete from queue_items where session_id = ?').run(SESSION)
    // Back to the defaults, so no other test file inherits an enabled monitor.
    for (const key of TOUCHED) db.query('delete from settings where key = ?').run(key)
  })

  // One earlier resume already came back empty (streak 1) at mark 5; now the session is stopped
  // at the wall again and the monitor schedules the next resume.
  async function scheduleAfterPriorResume(currentMark: number): Promise<number> {
    setSetting('monitor_enabled', '1')
    setSetting('monitor_max_attempts', '10')
    setSetting('monitor_resume_buffer_min', '0')
    db.query(
      `insert into monitor_state (item_id, session_id, resume_attempts, state, resume_item_id, updated_at, progress_mark, empty_streak)
       values ('rewake-prior', ?, 2, 'done', 'rewake-prior-resume', ?, 5, 1)`,
    ).run(SESSION, new Date().toISOString())
    db.query(
      `insert into queue_items (id, session_id, title, cwd, prompt, status, created_at)
       values ('rewake-stop', ?, 'Ship the parser', '/tmp', 'go', 'rate_limited', ?)`,
    ).run(SESSION, Date.now())
    const usage: UsageSnapshot = {
      account: null,
      session: null,
      weekAll: { pct: 10, resets: '' },
      weekModel: null,
      capturedAt: new Date().toISOString(),
    }
    const deps: MonitorDeps = {
      readUsage: async () => usage,
      discoverStops: async () => [],
      progressMark: async () => currentMark,
    }
    const before = Date.now()
    await runMonitorOnce(deps)
    const row = db
      .query<{ resume_item_id: string | null; empty_streak: number }, []>(
        "select resume_item_id, empty_streak from monitor_state where item_id = 'rewake-stop'",
      )
      .get()
    expect(row?.resume_item_id).toBeTruthy()
    const q = db
      .query<{ not_before: string }, [string]>('select not_before from queue_items where id = ?')
      .get(row?.resume_item_id ?? '')
    // With no parsable 5h reset the monitor waits the whole window; the hold rides on top.
    return new Date(q?.not_before ?? 0).getTime() - before - FIVE_HOURS
  }

  test('a second empty resume in a row waits the first 2-minute hold', async () => {
    const extra = await scheduleAfterPriorResume(5)
    expect(extra).toBeGreaterThanOrEqual(REWAKE_COOLDOWN_BASE_MS)
    expect(extra).toBeLessThan(REWAKE_COOLDOWN_BASE_MS + 60_000)
  })

  test('a real turn since the last resume schedules it with no hold', async () => {
    const extra = await scheduleAfterPriorResume(6)
    expect(extra).toBeGreaterThanOrEqual(0)
    expect(extra).toBeLessThan(60_000)
  })
})
