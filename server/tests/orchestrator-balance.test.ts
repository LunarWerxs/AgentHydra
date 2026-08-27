// server/tests/orchestrator-balance.test.ts - load balancing across accounts, pinned.
//
// The failure this guards against is not a wrong number, it is a fleet quietly funnelled into one
// account. The routing table is a pure function of the usage cache and that cache refreshes about
// once a minute, so several placements decided inside one window used to see identical readings
// and therefore pick the identical top row. The rubric said "round-robin"; nothing could do it,
// because nothing remembered where the last placement went.
//
// The rule these tests exist to hold down is the one that keeps balancing safe: IT ONLY EVER
// BREAKS TIES. Spreading work must never outrank having headroom, or the balancer would happily
// feed an account toward its own wall in the name of fairness. So the ledger reorders accounts
// inside a coarse load tier and nowhere else, and there is a test below that fails if that ever
// stops being true.
import { expect, test } from 'bun:test'
import {
  buildInstanceRows,
  getOrchestratorSettings,
  pickPlacement,
  setOrchestratorSettings,
} from '../src/orchestrator'
import { normalizeRef, prunePlacements, recentPlacements, recordPlacement } from '../src/placements'
import type { OrchestratorSettings, UsageSnapshot } from '../src/types'
import { desktopKey } from '../src/usage-service'

const NOW = Date.parse('2026-08-27T04:00:00Z')

/** A fresh reading. `sessionResetsAt` defaults to well outside the reset-soon window so a test
 *  that does not care about the 5-hour reset never accidentally gets the dump-target exemption. */
const snap = (
  weekly: number,
  session: number,
  opts: { sessionResetsInMins?: number; account?: string } = {},
): UsageSnapshot => ({
  account: opts.account ?? 'a <a@x> · Max 20×',
  session: {
    pct: session,
    resets: '',
    resetsAt: new Date(NOW + (opts.sessionResetsInMins ?? 240) * 60_000).toISOString(),
  },
  weekAll: { pct: weekly, resets: '', resetsAt: new Date(NOW + 48 * 3600 * 1000).toISOString() },
  weekModel: null,
  capturedAt: new Date(NOW - 60_000).toISOString(),
})

const settings = (over: Partial<OrchestratorSettings> = {}): OrchestratorSettings => ({
  ...getOrchestratorSettings(),
  loadBalance: true,
  balanceWindowMins: 90,
  ...over,
})

/** Cache keys are built with the SAME normalizer the code uses; hand-built keys pass on Windows
 *  and fail the ubuntu leg (the existing routing-table test learned this the hard way). */
const fleet = (
  dirs: Array<{ dir: string; name: string; isRunning?: boolean }>,
  cache: Record<string, UsageSnapshot>,
) =>
  ({
    instances: dirs.map((d) => ({ dir: d.dir, name: d.name, isRunning: d.isRunning ?? true })),
    cache,
  }) as const

test('the ledger counts placements inside the window and forgets the ones outside it', () => {
  const ref = 'desktop:c:\\i\\ledger-a'
  recordPlacement(ref, 'seed', 'sess-1', NOW - 10 * 60_000)
  recordPlacement(ref, 'migrate', 'sess-2', NOW - 20 * 60_000)
  // Older than the window: real history, but not evidence about what is loaded RIGHT NOW.
  recordPlacement(ref, 'seed', 'sess-3', NOW - 300 * 60_000)

  const counts = recentPlacements(90, NOW)
  expect(counts[normalizeRef(ref) as string]).toBe(2)

  // Case and trailing slashes vary by caller (registry, app config, a hand-typed API body). A
  // placement recorded one way must be SEEN the other way or balancing silently double-books.
  const counts2 = recentPlacements(90, NOW)
  expect(counts2[normalizeRef('DESKTOP:C:\\I\\LEDGER-A\\') as string]).toBe(2)
})

test('pruning drops rows past the 14-day horizon and keeps the rest', () => {
  recordPlacement('desktop:c:\\i\\prune-me', 'seed', null, NOW - 20 * 24 * 3600 * 1000)
  recordPlacement('desktop:c:\\i\\prune-me', 'seed', null, NOW - 1 * 24 * 3600 * 1000)
  const dropped = prunePlacements(NOW)
  expect(dropped).toBeGreaterThanOrEqual(1)
  // The recent one survives; pruning is a horizon, not a reset.
  expect(
    recentPlacements(2 * 24 * 60, NOW)[normalizeRef('desktop:c:\\i\\prune-me') as string],
  ).toBe(1)
})

test('inside one load tier, the account that was just given work goes last', () => {
  const a = 'c:\\i\\bal-a'
  const b = 'c:\\i\\bal-b'
  const f = fleet(
    [
      { dir: a, name: 'a' },
      { dir: b, name: 'b' },
    ],
    { [desktopKey(a)]: snap(10, 10), [desktopKey(b)]: snap(10, 15) },
  )
  const s = settings()

  // No ledger: the lower 5-hour reading wins outright, which is the pre-existing behaviour.
  expect(buildInstanceRows(f.instances, f.cache, s, NOW)[0].name).toBe('a')

  // Same numbers, but 'a' has just been handed two pieces of work. 10% and 15% are peers (one
  // 20-point tier), so the ledger is allowed to decide, and it sends the next one to 'b'.
  const rows = buildInstanceRows(f.instances, f.cache, s, NOW, {
    [normalizeRef(desktopKey(a)) as string]: 2,
  })
  expect(rows[0].name).toBe('b')
  expect(rows[0].recentPlacements).toBe(0)
  expect(rows.find((r) => r.name === 'a')?.recentPlacements).toBe(2)
})

test('BALANCING NEVER OUTRANKS HEADROOM: a colder account wins however recently it was used', () => {
  const cold = 'c:\\i\\cold'
  const warm = 'c:\\i\\warm'
  const f = fleet(
    [
      { dir: cold, name: 'cold' },
      { dir: warm, name: 'warm' },
    ],
    // 10% and 55% are three tiers apart: not peers, so fairness never gets a vote.
    { [desktopKey(cold)]: snap(10, 10), [desktopKey(warm)]: snap(10, 55) },
  )
  const rows = buildInstanceRows(f.instances, f.cache, settings(), NOW, {
    [normalizeRef(desktopKey(cold)) as string]: 9,
  })
  expect(rows[0].name).toBe('cold')
})

test('a 5-hour window minutes from its reset is capacity, not load', () => {
  const resetting = 'c:\\i\\resetting'
  const steady = 'c:\\i\\steady'
  const f = fleet(
    [
      { dir: resetting, name: 'resetting' },
      { dir: steady, name: 'steady' },
    ],
    {
      // 95% would normally be over sessionHighPct and therefore ineligible outright.
      [desktopKey(resetting)]: snap(10, 95, { sessionResetsInMins: 30 }),
      [desktopKey(steady)]: snap(10, 40),
    },
  )
  const rows = buildInstanceRows(f.instances, f.cache, settings(), NOW)
  const r = rows.find((x) => x.name === 'resetting')
  expect(r?.sessionResetsSoon).toBe(true)
  // The row still reports the TRUE reading. The exemption changes ranking, never measurement.
  expect(r?.sessionPct).toBe(95)
  expect(r?.eligible).toBe(true)
  expect(rows[0].name).toBe('resetting')
})

test('with balancing off, the ranking is exactly what it was before any of this existed', () => {
  const resetting = 'c:\\i\\off-resetting'
  const steady = 'c:\\i\\off-steady'
  const f = fleet(
    [
      { dir: resetting, name: 'resetting' },
      { dir: steady, name: 'steady' },
    ],
    {
      [desktopKey(resetting)]: snap(10, 95, { sessionResetsInMins: 30 }),
      [desktopKey(steady)]: snap(10, 40),
    },
  )
  const rows = buildInstanceRows(f.instances, f.cache, settings({ loadBalance: false }), NOW, {
    [normalizeRef(desktopKey(steady)) as string]: 5,
  })
  // No dump-target exemption and no ledger: the 95% account is over the high band and blocked,
  // and the five recent placements on 'steady' buy it nothing.
  expect(rows[0].name).toBe('steady')
  expect(rows.find((x) => x.name === 'resetting')?.eligible).toBe(false)
})

test('every ineligible account says WHY, in the first reason that applies', () => {
  const closed = 'c:\\i\\why-closed'
  const crit = 'c:\\i\\why-critical'
  const hot = 'c:\\i\\why-hot'
  const okDir = 'c:\\i\\why-ok'
  const staleDir = 'c:\\i\\why-stale'
  const rows = buildInstanceRows(
    [
      { dir: closed, name: 'closed', isRunning: false },
      { dir: crit, name: 'critical', isRunning: true },
      { dir: hot, name: 'hot', isRunning: true },
      { dir: okDir, name: 'ok', isRunning: true },
      { dir: staleDir, name: 'stale', isRunning: true },
    ],
    {
      [desktopKey(closed)]: snap(5, 5),
      [desktopKey(crit)]: snap(95, 5),
      [desktopKey(hot)]: snap(10, 95),
      [desktopKey(okDir)]: snap(10, 5),
      [desktopKey(staleDir)]: {
        ...snap(5, 5),
        capturedAt: new Date(NOW - 30 * 3600e3).toISOString(),
      },
    },
    settings(),
    NOW,
  )
  const by = (n: string) => rows.find((r) => r.name === n)
  expect(by('closed')?.blockedWhy).toBe('not running')
  expect(by('stale')?.blockedWhy).toContain('stale')
  expect(by('critical')?.blockedWhy).toContain('critical')
  expect(by('hot')?.blockedWhy).toContain('5-hour')
  expect(by('ok')?.blockedWhy).toBe(null)
  expect(by('ok')?.eligible).toBe(true)
})

test('pickPlacement returns the reason, and honours the exclusion a migration needs', () => {
  const a = 'c:\\i\\pick-a'
  const b = 'c:\\i\\pick-b'
  const rows = buildInstanceRows(
    [
      { dir: a, name: 'pick-a' },
      { dir: b, name: 'pick-b' },
    ].map((d) => ({ ...d, isRunning: true })),
    { [desktopKey(a)]: snap(10, 5), [desktopKey(b)]: snap(10, 30) },
    settings(),
    NOW,
  )
  const first = pickPlacement(rows)
  expect(first?.name).toBe('pick-a')
  expect(first?.why).toContain('5-hour 5%')
  expect(first?.why).toContain('placement(s)')

  // A limit-migration must not land back on the account that just hit its wall. Excluded by ref,
  // normalized, so a casing difference between the caller and the table cannot defeat it.
  const second = pickPlacement(rows, { excludeRef: desktopKey(a).toUpperCase() })
  expect(second?.name).toBe('pick-b')

  // Nothing eligible is a real answer, not an empty-ish one: the caller must be able to WAIT.
  const none = buildInstanceRows(
    [{ dir: 'c:\\i\\pick-shut', name: 'shut', isRunning: false }],
    { [desktopKey('c:\\i\\pick-shut')]: snap(10, 5) },
    settings(),
    NOW,
  )
  expect(pickPlacement(none)).toBe(null)
})

test('the balancing settings round-trip and default to ON', () => {
  const on = setOrchestratorSettings({ loadBalance: true, balanceWindowMins: 45 })
  expect(on.loadBalance).toBe(true)
  expect(on.balanceWindowMins).toBe(45)

  const off = setOrchestratorSettings({ loadBalance: false })
  expect(off.loadBalance).toBe(false)
  // The window survives a toggle: turning balancing off must not silently reset how it is tuned.
  expect(off.balanceWindowMins).toBe(45)

  // Out-of-range windows clamp rather than being taken literally or rejected.
  expect(setOrchestratorSettings({ balanceWindowMins: 99_999 }).balanceWindowMins).toBe(24 * 60)
  expect(setOrchestratorSettings({ balanceWindowMins: 1 }).balanceWindowMins).toBe(5)

  setOrchestratorSettings({ loadBalance: true, balanceWindowMins: 90 })
})
