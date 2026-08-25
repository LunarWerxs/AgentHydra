// server/tests/monitor-migrate.test.ts — the 5-hour migrate-on-limit path, pinned.
//
// The behavior under test (owner directive 2026-08-25): a run stopped by its 5-HOUR limit whose
// weekly is fine, with the toggle on, resumes IMMEDIATELY on another running account instead of
// parking until the reset. With the toggle off (the default), the old schedule-at-reset behavior
// must be byte-for-byte what it was — this feature rides the monitor, it must not change it.
import { expect, test } from 'bun:test'
import { db, getSetting } from '../src/db'
import { baseTitle, runMonitorOnce, setMonitorSettings } from '../src/monitor'
import { setOrchestratorSettings } from '../src/orchestrator'
import type { UsageSnapshot } from '../src/types'

function insertRateLimitedRun(id: string, sessionId: string, title = 'Limited run'): void {
  db.query(
    `insert into queue_items
       (id, session_id, title, cwd, prompt, model, effort, permission_mode, account_id, instance_ref, new_chat, fork, status, position, not_before, created_at)
     values (?, ?, ?, 'D:\\demo', 'work', null, null, null, null, 'desktop:c:\\i\\limited', 0, 0, 'rate_limited', 1, null, ?)`,
  ).run(id, sessionId, title, Date.now())
}

interface ResumeRow {
  title: string
  instance_ref: string
  not_before: string | null
  account_id: string | null
  import_to: string | null
  import_title: string | null
}

function queuedResume(sessionId: string): ResumeRow | null {
  return db
    .query<ResumeRow, [string]>(
      'select title, instance_ref, not_before, account_id, import_to, import_title ' +
        "from queue_items where session_id = ? and status = 'queued'",
    )
    .get(sessionId)
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
  // Recorded and asserted AFTER the run, never inside the callback: monitor.ts wraps
  // pickMigrationTarget in a try/catch (a picker that throws must fall back to the scheduled
  // resume, not take the tick down), so an expect() thrown in here is swallowed and the test
  // passes no matter what it was handed.
  const excludes: (string | null)[] = []
  await runMonitorOnce({
    readUsage: async () => fiveHourLimited,
    discoverStops: async () => [],
    pickMigrationTarget: async (excludeRef) => {
      excludes.push(excludeRef)
      return { ref: 'desktop:c:\\i\\fresh', name: 'fresh' }
    },
  })
  // `contains`, not `toEqual`: rows left behind by other test files share this suite's database,
  // so the picker legitimately sees their stops too.
  expect(excludes).toContain('desktop:c:\\i\\limited')
  const resume = queuedResume('mig-sess-1')
  expect(resume).toBeTruthy()
  expect(resume?.title).toStartWith('Migrated resume:')
  expect(resume?.instance_ref).toBe('desktop:c:\\i\\fresh')
  expect(resume?.account_id).toBe(null)
  // The whole point of the import fields: when this borrowed-account run completes, finalize()
  // lands it in the target instance's desktop app as a visible chat under the thread's own name.
  // Without them a migrated run finishes headless and the owner never sees it anywhere.
  expect(resume?.import_to).toBe('desktop:c:\\i\\fresh')
  expect(resume?.import_title).toBe('Limited run')
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
  const resume = queuedResume('mig-sess-2')
  expect(resume?.title).toStartWith('Auto-resume:')
  expect(resume?.instance_ref).toBe('desktop:c:\\i\\limited')
  // A SAME-account resume imports nothing: that chat is already in the app it belongs to, so an
  // import would only add a duplicate sidebar entry pointing at the same shared transcript.
  expect(resume?.import_to).toBe(null)
  expect(resume?.import_title).toBe(null)
})

test('toggle OFF (default): the original schedule-at-reset behavior, untouched', async () => {
  setOrchestratorSettings({ migrateOnLimit: false })
  expect(getSetting('orch_migrate_on_limit')).toBe('0')
  insertRateLimitedRun('mig-item-3', 'mig-sess-3')
  // Counted, not thrown from: monitor.ts catches anything the picker raises, so a throw in here
  // proves nothing. The toggle gates the call for the whole tick, so zero is the honest bar even
  // with other test files' stops sharing the database.
  let picks = 0
  await runMonitorOnce({
    readUsage: async () => fiveHourLimited,
    discoverStops: async () => [],
    pickMigrationTarget: async () => {
      picks++
      return null
    },
  })
  expect(picks).toBe(0)
  const resume = queuedResume('mig-sess-3')
  expect(resume?.title).toStartWith('Auto-resume:')
  expect(resume?.instance_ref).toBe('desktop:c:\\i\\limited')
  expect(resume?.import_to).toBe(null)
  expect(resume?.import_title).toBe(null)
})

test('a re-migrated run imports under the thread name, not the stacked prefixes', async () => {
  setMonitorSettings({ enabled: true })
  setOrchestratorSettings({ migrateOnLimit: true })
  // What the queue really looks like on the third stop of a long thread: each pass staples its own
  // prefix on. The desktop chat must still be called "Ship the parser".
  insertRateLimitedRun('mig-item-4', 'mig-sess-4', 'Migrated resume: Auto-resume: Ship the parser')
  await runMonitorOnce({
    readUsage: async () => fiveHourLimited,
    discoverStops: async () => [],
    pickMigrationTarget: async () => ({ ref: 'desktop:c:\\i\\third', name: 'third' }),
  })
  const resume = queuedResume('mig-sess-4')
  expect(resume?.import_to).toBe('desktop:c:\\i\\third')
  expect(resume?.import_title).toBe('Ship the parser')
  // And the queue row itself stops growing a prefix chain.
  expect(resume?.title).toBe('Migrated resume: Ship the parser')
})

test('baseTitle peels every prefix, is idempotent, and never returns empty', () => {
  expect(baseTitle('Ship the parser')).toBe('Ship the parser')
  expect(baseTitle('Auto-resume: Ship the parser')).toBe('Ship the parser')
  expect(baseTitle('Migrate: Migrated resume: Auto-resume: Ship it')).toBe('Ship it')
  expect(baseTitle(baseTitle('Migrated resume: Ship it'))).toBe('Ship it')
  // Prefix-only titles keep their text rather than becoming an "Untitled" desktop chat.
  expect(baseTitle('Auto-resume:')).toBe('Auto-resume:')
  // A colon that is part of the thread's own name is not a prefix.
  expect(baseTitle('Auto-resume of the nightly: phase 2')).toBe(
    'Auto-resume of the nightly: phase 2',
  )
})
