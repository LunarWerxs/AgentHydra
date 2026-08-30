// server/tests/sweep-loop.test.ts - the standing sweep pinned: off-by-default, the settings
// clamps, the unattended-safe cap translation (-1 -> unlimited, surface 0 default), the
// re-entrancy guard, and the recorded last run.
import { expect, test } from 'bun:test'
import { db } from '../src/db'
import type { SweepReport } from '../src/gate-sweep'
import {
  getSweepLoopSettings,
  parseSweepLoopPatch,
  runSweepLoopOnce,
  setSweepLoopSettings,
  sweepLoopStatus,
} from '../src/sweep-loop'

const emptyReport = (): SweepReport => ({
  scanned: 0,
  leftAlone: 0,
  acted: { archived: 0, surfaced: 0 },
  caps: { maxArchive: 0, maxSurface: 0 },
  archiveRows: [],
  crashedRows: [],
  waitForReset: [],
  needsJudgment: [],
  stalled: [],
  ungated: [],
  unswept: [],
  deadlineHit: false,
})

test('ABSENT settings read as the true defaults - never as zero (caught live)', () => {
  // Number('') === 0 is finite, so an unregistered key once read the unlimited -1 archive cap
  // as 0. Deleting the rows must yield the documented defaults.
  db.query("delete from settings where key like 'sweep_%'").run()
  const s = getSweepLoopSettings()
  expect(s).toEqual({
    enabled: false,
    courierEnabled: true,
    intervalMin: 15,
    maxArchive: -1,
    maxSurface: 0,
  })
})

test('off by default, with the unattended-safe caps', () => {
  setSweepLoopSettings({ enabled: false, intervalMin: 15, maxArchive: -1, maxSurface: 0 })
  const s = getSweepLoopSettings()
  expect(s.enabled).toBe(false)
  expect(s.maxArchive).toBe(-1) // unlimited sentinel
  expect(s.maxSurface).toBe(0) // no deliverer, no dormant parking
})

test('settings clamp: interval floors at 5 minutes, caps stay in range', () => {
  const s = setSweepLoopSettings({ intervalMin: 1, maxArchive: -99, maxSurface: 5000 })
  expect(s.intervalMin).toBe(5)
  expect(s.maxArchive).toBe(-1)
  expect(s.maxSurface).toBe(100)
  setSweepLoopSettings({ intervalMin: 15, maxArchive: -1, maxSurface: 0 })
})

test('before the FIRST tick, nextDueAt reads as imminent - never as a 1970 epoch date', () => {
  // Must run before any test that ticks (module state): lastTickAt is still 0 here.
  setSweepLoopSettings({ enabled: true, intervalMin: 15 })
  const due = Date.parse(sweepLoopStatus().nextDueAt ?? '')
  expect(Math.abs(due - Date.now())).toBeLessThan(5_000)
  setSweepLoopSettings({ enabled: false })
})

test('parseSweepLoopPatch: out-of-range and mistyped fields error, never silently clamp', () => {
  expect(parseSweepLoopPatch({ enabled: 'yes' }).ok).toBe(false)
  expect(parseSweepLoopPatch({ maxArchive: -50 }).ok).toBe(false) // NOT the unlimited sentinel
  expect(parseSweepLoopPatch({ maxSurface: 101 }).ok).toBe(false)
  expect(parseSweepLoopPatch({ intervalMin: 1 }).ok).toBe(false)
  const good = parseSweepLoopPatch({ enabled: true, maxArchive: -1, maxSurface: 2.9 })
  expect(good.ok && good.patch).toEqual({ enabled: true, maxArchive: -1, maxSurface: 2 })
})

test('a disabled loop does not tick; force runs it anyway and records the run', async () => {
  setSweepLoopSettings({ enabled: false })
  let calls = 0
  const sweep = async () => {
    calls++
    return emptyReport()
  }
  expect(await runSweepLoopOnce({ sweep })).toBe(null)
  expect(calls).toBe(0)
  const report = await runSweepLoopOnce({ sweep, force: true })
  expect(report).not.toBe(null)
  expect(calls).toBe(1)
  const status = sweepLoopStatus()
  expect(status.lastRun?.report.scanned).toBe(0)
  expect(status.nextDueAt).toBe(null) // disabled -> no next tick
})

test('the -1 sentinel reaches the sweep as UNLIMITED (undefined), surface cap verbatim', async () => {
  setSweepLoopSettings({ enabled: false, maxArchive: -1, maxSurface: 2 })
  const seen: Array<{ maxArchive?: number; maxSurface?: number }> = []
  await runSweepLoopOnce({
    force: true,
    sweep: async (opts = {}) => {
      seen.push({ maxArchive: opts.maxArchive, maxSurface: opts.maxSurface })
      return emptyReport()
    },
  })
  expect(seen[0]).toEqual({ maxArchive: undefined, maxSurface: 2 })
  setSweepLoopSettings({ maxSurface: 0 })
})

test('re-entrancy: an in-flight tick blocks the next one, counted as an overlap skip', async () => {
  setSweepLoopSettings({ enabled: false })
  const before = sweepLoopStatus().overlapSkips
  let release: (() => void) | undefined
  const gate = new Promise<void>((r) => {
    release = r
  })
  let calls = 0
  const slow = async () => {
    calls++
    await gate
    return emptyReport()
  }
  const first = runSweepLoopOnce({ sweep: slow, force: true })
  const second = await runSweepLoopOnce({ sweep: slow, force: true })
  expect(second).toBe(null)
  expect(sweepLoopStatus().overlapSkips).toBe(before + 1)
  release?.()
  await first
  expect(calls).toBe(1)
})

test('a tick stamps the schedule itself - a forced check-now pushes the next due time out', async () => {
  setSweepLoopSettings({ enabled: true, intervalMin: 15 })
  await runSweepLoopOnce({ force: true, sweep: async () => emptyReport() })
  const due = Date.parse(sweepLoopStatus().nextDueAt ?? '')
  expect(due - Date.now()).toBeGreaterThan(13 * 60_000)
  setSweepLoopSettings({ enabled: false })
})

test('a failing tick records lastError and KEEPS the previous good report', async () => {
  await runSweepLoopOnce({ force: true, sweep: async () => emptyReport() })
  const goodAt = sweepLoopStatus().lastRun?.at
  const r = await runSweepLoopOnce({
    force: true,
    sweep: async () => {
      throw new Error('boom in the tick')
    },
  })
  expect(r).toBe(null)
  const s = sweepLoopStatus()
  expect(s.lastError?.message).toContain('boom in the tick')
  expect(s.lastRun?.at).toBe(goodAt)
})

test('the STATUS copy of a huge report is bounded and flagged; the return is untrimmed', async () => {
  const big = emptyReport()
  big.crashedRows = Array.from({ length: 150 }, (_, i) => ({
    sessionId: `s${i}`,
    title: null,
    instance: null,
    state: 'crashed' as const,
    crashedKind: 'mid-turn' as const,
    lane: null,
    action: 'over-cap' as const,
    why: 'x',
  }))
  const r = await runSweepLoopOnce({ force: true, sweep: async () => big })
  expect(r?.crashedRows.length).toBe(150)
  const status = sweepLoopStatus()
  expect(status.lastRun?.report.crashedRows.length).toBe(100)
  expect(status.lastRun?.report.rowsTruncated).toBe(true)
})

test('the tick runs the courier pass when enabled, and a throwing pass is a DURABLE status fact', async () => {
  const { setSetting } = await import('../src/db')
  setSetting('courier_enabled', '1')
  let courierRuns = 0
  await runSweepLoopOnce({
    force: true,
    sweep: async () => emptyReport(),
    courier: async () => {
      courierRuns++
      throw new Error('courier store blew up')
    },
  })
  expect(courierRuns).toBe(1)
  expect(sweepLoopStatus().lastCourierError?.message).toContain('courier store blew up')
  // A clean pass CLEARS it - a healed courier must stop reading as broken.
  await runSweepLoopOnce({
    force: true,
    sweep: async () => emptyReport(),
    courier: async () => ({
      dryRun: false,
      attempts: [],
      held: [],
      unroutable: [],
      deliverable: 0,
      notAttempted: 0,
      capHit: false,
      instancesTouched: 0,
      checkedAt: 'x',
    }),
  })
  expect(sweepLoopStatus().lastCourierError).toBe(null)
})

test('courier_enabled=0 keeps the tick from arming anything', async () => {
  const { setSetting } = await import('../src/db')
  setSetting('courier_enabled', '0')
  let courierRuns = 0
  await runSweepLoopOnce({
    force: true,
    sweep: async () => emptyReport(),
    courier: async () => {
      courierRuns++
      return {
        dryRun: false,
        attempts: [],
        held: [],
        unroutable: [],
        deliverable: 0,
        notAttempted: 0,
        capHit: false,
        instancesTouched: 0,
        checkedAt: 'x',
      }
    },
  })
  expect(courierRuns).toBe(0)
  setSetting('courier_enabled', '1')
})

test('courier housekeeping is ALWAYS-ON but throttled - force bypasses the cadence', async () => {
  const { setSetting } = await import('../src/db')
  const { runCourierHousekeeping } = await import('../src/sweep-loop')
  setSetting('courier_enabled', '1')
  let runs = 0
  const courier = async () => {
    runs++
    return {
      dryRun: false,
      attempts: [],
      held: [],
      unroutable: [],
      deliverable: 0,
      notAttempted: 0,
      capHit: false,
      instancesTouched: 0,
      checkedAt: 'x',
    }
  }
  expect(await runCourierHousekeeping({ courier, force: true })).toBe(true)
  // Within the 5-minute cadence a non-forced call declines...
  expect(await runCourierHousekeeping({ courier })).toBe(false)
  // ...while force (the sweep tick, fresh after its acts) always runs.
  expect(await runCourierHousekeeping({ courier, force: true })).toBe(true)
  expect(runs).toBe(2)
  // And the gate is the courier's OWN switch, not the sweep's.
  setSetting('courier_enabled', '0')
  expect(await runCourierHousekeeping({ courier, force: true })).toBe(false)
  expect(runs).toBe(2)
  setSetting('courier_enabled', '1')
})

test('an autonomous courier pass RECORDS what it did - silence is not evidence of success', async () => {
  const { setSetting } = await import('../src/db')
  const { runCourierHousekeeping } = await import('../src/sweep-loop')
  setSetting('courier_enabled', '1')
  await runCourierHousekeeping({
    force: true,
    courier: async () => ({
      dryRun: false,
      attempts: [
        { sessionId: 's-1', title: 't', instanceDir: 'd', outcome: 'delivered', detail: 'ok' },
        {
          sessionId: 's-2',
          title: 't',
          instanceDir: 'd',
          outcome: 'wrong-chat',
          detail: 'REFUSED: conversation mismatch',
        },
      ],
      held: [{ sessionId: 's-3', reason: 'grace' }],
      unroutable: [],
      deliverable: 0,
      notAttempted: 0,
      capHit: false,
      instancesTouched: 1,
      checkedAt: 'x',
    }),
  })
  const run = sweepLoopStatus().lastCourierRun
  expect(run?.delivered).toBe(1)
  expect(run?.held).toBe(1)
  // A refusal's REASON survives - that is the whole point of recording the pass.
  expect(run?.attempts.find((a) => a.sessionId === 's-2')?.detail).toContain('REFUSED')
})

test('the courier switch is visible in status and settable through the same route', async () => {
  const { setSetting } = await import('../src/db')
  setSetting('courier_enabled', '1')
  expect(getSweepLoopSettings().courierEnabled).toBe(true)
  // A mechanism that types into the owner's live windows must be switchable without him
  // knowing a settings key exists (readiness audit).
  const parsed = parseSweepLoopPatch({ courierEnabled: false })
  expect(parsed.ok).toBe(true)
  if (parsed.ok) setSweepLoopSettings(parsed.patch)
  expect(getSweepLoopSettings().courierEnabled).toBe(false)
  expect(sweepLoopStatus().settings.courierEnabled).toBe(false)
  // ...and the sweep's own switch is untouched by it.
  expect(getSweepLoopSettings().enabled).toBe(false)
  setSetting('courier_enabled', '1')
})

test('a non-boolean courierEnabled is refused, never coerced', () => {
  expect(parseSweepLoopPatch({ courierEnabled: 'yes' }).ok).toBe(false)
})
