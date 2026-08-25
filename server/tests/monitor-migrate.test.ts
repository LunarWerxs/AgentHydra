// server/tests/monitor-migrate.test.ts — the 5-hour migrate-on-limit path, pinned.
//
// The behavior under test (owner directive 2026-08-25): a run stopped by its 5-HOUR limit whose
// weekly is fine, with the toggle on, resumes IMMEDIATELY on another running account instead of
// parking until the reset. With the toggle off (the default), the old schedule-at-reset behavior
// must be byte-for-byte what it was — this feature rides the monitor, it must not change it.
import { expect, test } from 'bun:test'
import { db, getSetting } from '../src/db'
import { runMonitorOnce, setMonitorSettings } from '../src/monitor'
import { setOrchestratorSettings } from '../src/orchestrator'
import type { UsageSnapshot } from '../src/types'

function insertRateLimitedRun(id: string, sessionId: string): void {
  db.query(
    `insert into queue_items
       (id, session_id, title, cwd, prompt, model, effort, permission_mode, account_id, instance_ref, new_chat, fork, status, position, not_before, created_at)
     values (?, ?, 'Limited run', 'D:\\demo', 'work', null, null, null, null, 'desktop:c:\\i\\limited', 0, 0, 'rate_limited', 1, null, ?)`,
  ).run(id, sessionId, Date.now())
}

/** 5-hour window maxed, weekly fine — the exact shape migrate-on-limit exists for. */
const fiveHourLimited: UsageSnapshot = {
  account: 'limited <l@x> · Max 20×',
  session: { pct: 100, resets: 'Aug 25, 9:59pm' },
  weekAll: { pct: 40, resets: 'Aug 29, 12am' },
  weekModel: null,
  capturedAt: new Date().toISOString(),
}

test('toggle ON: the resume runs NOW on the picked account, not at the reset', async () => {
  setMonitorSettings({ enabled: true })
  setOrchestratorSettings({ migrateOnLimit: true })
  insertRateLimitedRun('mig-item-1', 'mig-sess-1')
  await runMonitorOnce({
    readUsage: async () => fiveHourLimited,
    discoverStops: async () => [],
    pickMigrationTarget: async (excludeRef) => {
      expect(excludeRef).toBe('desktop:c:\\i\\limited')
      return { ref: 'desktop:c:\\i\\fresh', name: 'fresh' }
    },
  })
  const resume = db
    .query<
      { title: string; instance_ref: string; not_before: string; account_id: string | null },
      [string]
    >(
      "select title, instance_ref, not_before, account_id from queue_items where session_id = ? and status = 'queued'",
    )
    .get('mig-sess-1')
  expect(resume).toBeTruthy()
  expect(resume?.title).toStartWith('Migrated resume:')
  expect(resume?.instance_ref).toBe('desktop:c:\\i\\fresh')
  expect(resume?.account_id).toBe(null)
  // Immediate: not_before is now-ish, hours before any 5h reset could be.
  expect(Date.parse(resume?.not_before ?? '')).toBeLessThan(Date.now() + 60_000)
  const state = db
    .query<{ message: string }, [string]>('select message from monitor_state where session_id = ?')
    .get('mig-sess-1')
  expect(state?.message).toContain('migrated to fresh')
})

test('toggle ON but no viable target: falls back to the scheduled resume', async () => {
  setOrchestratorSettings({ migrateOnLimit: true })
  insertRateLimitedRun('mig-item-2', 'mig-sess-2')
  await runMonitorOnce({
    readUsage: async () => fiveHourLimited,
    discoverStops: async () => [],
    pickMigrationTarget: async () => null,
  })
  const resume = db
    .query<{ title: string; instance_ref: string }, [string]>(
      "select title, instance_ref from queue_items where session_id = ? and status = 'queued'",
    )
    .get('mig-sess-2')
  expect(resume?.title).toStartWith('Auto-resume:')
  expect(resume?.instance_ref).toBe('desktop:c:\\i\\limited')
})

test('toggle OFF (default): the original schedule-at-reset behavior, untouched', async () => {
  setOrchestratorSettings({ migrateOnLimit: false })
  expect(getSetting('orch_migrate_on_limit')).toBe('0')
  insertRateLimitedRun('mig-item-3', 'mig-sess-3')
  await runMonitorOnce({
    readUsage: async () => fiveHourLimited,
    discoverStops: async () => [],
    pickMigrationTarget: async () => {
      throw new Error('must not be consulted while the toggle is off')
    },
  })
  const resume = db
    .query<{ title: string; instance_ref: string }, [string]>(
      "select title, instance_ref from queue_items where session_id = ? and status = 'queued'",
    )
    .get('mig-sess-3')
  expect(resume?.title).toStartWith('Auto-resume:')
  expect(resume?.instance_ref).toBe('desktop:c:\\i\\limited')
})
