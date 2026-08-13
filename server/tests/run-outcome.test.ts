// server/tests/run-outcome.test.ts — how a queued run ended (server/src/db.ts runOutcome).
//
// The daemon has ground truth here: the detached runner reports the child's exit code and the
// status is finalized from it, so nothing about a run's fate is inferred from a transcript. What
// these tests pin is the one derived field, `died`, because it is the question actually being
// asked of twenty overnight runs: which of these did not do the work?

import { describe, expect, test } from 'bun:test'
import { runOutcome } from '../src/db'
import type { QueueItem, QueueStatus } from '../src/types'

const item = (over: Partial<QueueItem> = {}): QueueItem =>
  ({
    id: 'run-1',
    session_id: 's1',
    title: 'nightly',
    cwd: 'C:/proj',
    prompt: 'do the thing',
    model: null,
    effort: null,
    permission_mode: null,
    account_id: null,
    instance_ref: null,
    new_chat: false,
    fork: false,
    status: 'completed',
    pid: null,
    position: 0,
    not_before: null,
    retry_attempts: 0,
    started_at: null,
    finished_at: null,
    exit_code: null,
    created_at: 0,
    ...over,
  }) as QueueItem

describe('runOutcome', () => {
  test('a completed run did not die', () => {
    expect(runOutcome(item({ status: 'completed', exit_code: 0 })).died).toBe(false)
  })

  // Everything terminal that is not `completed` counts, not just `failed`: from "did the work
  // happen?", a canceled run and a rate-limited one are the same answer.
  test('every terminal status other than completed counts as died', () => {
    for (const status of ['failed', 'canceled', 'rate_limited', 'overloaded'] as QueueStatus[])
      expect(runOutcome(item({ status })).died).toBe(true)
  })

  test('a run still queued or running has not died', () => {
    for (const status of ['queued', 'running'] as QueueStatus[])
      expect(runOutcome(item({ status })).died).toBe(false)
  })

  test('carries the exit code through, including the lost-runner sentinel', () => {
    expect(runOutcome(item({ status: 'failed', exit_code: -1 })).exit_code).toBe(-1)
    expect(runOutcome(item({ status: 'failed', exit_code: 137 })).exit_code).toBe(137)
    expect(runOutcome(item({ status: 'running' })).exit_code).toBeNull()
  })

  test('duration is only reported when both ends are known', () => {
    expect(
      runOutcome(
        item({
          started_at: '2026-08-13T10:00:00.000Z',
          finished_at: '2026-08-13T10:02:30.000Z',
        }),
      ).duration_ms,
    ).toBe(150_000)
    expect(runOutcome(item({ started_at: '2026-08-13T10:00:00.000Z' })).duration_ms).toBeNull()
    expect(runOutcome(item()).duration_ms).toBeNull()
  })

  test('a clock that went backwards reports zero rather than a negative duration', () => {
    const o = runOutcome(
      item({ started_at: '2026-08-13T10:02:00.000Z', finished_at: '2026-08-13T10:00:00.000Z' }),
    )
    expect(o.duration_ms).toBe(0)
  })

  test('an unparseable timestamp degrades to no duration, not NaN', () => {
    expect(
      runOutcome(item({ started_at: 'not a date', finished_at: '2026-08-13T10:00:00.000Z' }))
        .duration_ms,
    ).toBeNull()
  })
})
