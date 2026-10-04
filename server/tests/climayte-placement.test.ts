// Where CliMayte starts a task so it can finish there (climayte-placement.ts).
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteCapacity,
  climayteList,
  climayteRun,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  setCliMayteMemoryReader,
  startCliMayte,
} from '../src/climayte'
import { type CliMayteAccount, dueOrder, pickAccount, rankAccounts } from '../src/climayte-lib'
import { type MachineMemory, memoryShort } from '../src/climayte-memory'
import {
  DEFAULT_TASK_PCT,
  expectedCost,
  MANAGER_WAKE_PCT,
  planFactor,
  projectedPct,
  WEEK_MS,
  waitsForCooldown,
  waitsForHome,
  waitsForRoom,
} from '../src/climayte-placement'

describe('projectedPct', () => {
  test('counts what running tasks still owe, once, and scales by the plan', () => {
    // An idle Pro account at 10%: a 25% task ends near 35%.
    expect(projectedPct({ sessionPct: 10 }, [], 25)).toBe(35)
    // Three 25% tasks just started there (the meter has not moved yet): a fourth ends at 110.
    const fresh = [25, 25, 25].map((expected) => ({ expected, startPct: 10 }))
    expect(projectedPct({ sessionPct: 10 }, fresh, 25)).toBe(110)
    // Later the meter reads 50: 40 of their 75 are spent and already in the reading.
    expect(projectedPct({ sessionPct: 50 }, fresh, 25)).toBe(110)
    // A Max 5x window holds five Pro windows.
    expect(projectedPct({ sessionPct: 10, planFactor: planFactor('Max 5×') }, fresh, 25)).toBe(30)
    // One 25% task running since 10%; another task that ended meanwhile spent 20 of the rise to 40.
    // The running one has spent 10 and still owes 15: a new 25% task ends near 80, not 65.
    const one = [{ expected: 25, startPct: 10 }]
    expect(projectedPct({ sessionPct: 40 }, one, 25, 20)).toBe(80)
  })
})

describe('expectedCost', () => {
  test('blends from the broadest record to the narrowest, by how many tasks each has', () => {
    const O = 'claude-opus-5-5'
    const S = 'claude-sonnet-5-5'
    const done = (kind: string, model: string, effort: string, pct: number, n = 1) =>
      Array.from({ length: n }, () => ({ kind, model, effort, pct }))
    const sonnetCode = { kind: 'code', model: S, effort: 'medium' }
    expect(expectedCost(sonnetCode, [])).toEqual({
      pct: DEFAULT_TASK_PCT,
      basis: 'default',
      samples: 0,
    })
    // Two Opus code tasks at 26: a Sonnet one is half that at a Sonnet token's weight, pulled toward
    // the default by two tasks' worth: (13 + 13 + 2 * 25) / 4.
    const opus = done('code', O, 'high', 26, 2)
    expect(expectedCost(sonnetCode, opus)).toMatchObject({ basis: 'kind', samples: 2 })
    expect(expectedCost(sonnetCode, opus).pct).toBeCloseTo(19, 6)
    // Three Sonnet medium code tasks at 5 (mobile-w10/m3c, 2026-10-01: 3.9, 4.6, 6.1 against an
    // estimate of 13.7): the estimate comes most of the way down to them, under 6.
    const three = expectedCost(sonnetCode, [...opus, ...done('code', S, 'medium', 5, 3)])
    expect(three).toMatchObject({ basis: 'setting', samples: 3 })
    expect(three.pct).toBeGreaterThan(5)
    expect(three.pct).toBeLessThan(6)
    // Twenty of them and the record is nearly all of it.
    expect(
      expectedCost(sonnetCode, [...opus, ...done('code', S, 'medium', 5, 20)]).pct,
    ).toBeCloseTo(5, 0)
  })

  test('a manager costs a wake, not a task: its kind average, else 2%', () => {
    const S = 'claude-sonnet-5-5'
    const manager = { kind: 'manage', model: S, effort: 'low' }
    const done = (kind: string, pct: number) => ({ kind, model: S, effort: 'low', pct })
    expect(expectedCost(manager, [done('code', 30)])).toMatchObject({
      pct: MANAGER_WAKE_PCT,
      samples: 0,
    })
    const wakes = expectedCost(manager, [done('manage', 1), done('manage', 2), done('code', 30)])
    expect(wakes.pct).toBeCloseTo(1.5, 5)
  })
})

describe('waitsForCooldown', () => {
  test('an account ahead of its weekly pace waits for one that refills soon; never on priority', () => {
    const now = 1_000_000_000_000
    const halfWeek = now + WEEK_MS / 2 // half the week gone: pace is 50%
    const max5 = { id: 'max5', weekPct: 70, weekResetsAt: halfWeek, planFactor: 5 }
    // A Pro that has run low: at 80% of its 5-hour window, a 20% task does not fit until it refills.
    const pro = (resetInMin: number, weekPct = 30, sessionPct = 80) => ({
      id: `pro-${resetInMin}`,
      sessionPct,
      weekPct,
      weekResetsAt: halfWeek,
      planFactor: 1,
      sessionResetsAt: now + resetInMin * 60_000,
    })
    const go = { home: false, priority: 0 }
    // The owner's case: the Max 5x has spent 70% of its week at the half-week mark, and a low Pro
    // that refills in 4 minutes can then take the 20% task: wait for that reset.
    expect(waitsForCooldown(max5, [pro(4), pro(45)], 20, now, go)).toBe(now + 4 * 60_000)
    // That Pro already has room (2026-10-02: tasks waited for the reset of #98, at 0%): a reset
    // gains nothing, and neither does one of a Pro whose running work leaves the task room.
    expect(waitsForCooldown(max5, [pro(4, 30, 0)], 20, now, go)).toBeNull()
    const busy = { ...pro(4, 30, 40), running: [{ expected: 30, startPct: 40 }] }
    expect(waitsForCooldown(max5, [busy], 20, now, go)).toBe(now + 4 * 60_000)
    expect(waitsForCooldown(max5, [{ ...busy, running: [] }], 20, now, go)).toBeNull()
    // Whole-percent readings: 3% used with 2.74% of the week gone (#94) is not ahead of pace.
    const noise = { id: 'a94', weekPct: 3, weekResetsAt: now + WEEK_MS * 0.9726 }
    const fresh = { ...pro(4, 0), weekResetsAt: noise.weekResetsAt }
    expect(waitsForCooldown(noise, [fresh], 5, now, go)).toBeNull()
    // The Pro is within the band of the 5x's pace (66% used against 70%): not worth a wait.
    expect(waitsForCooldown(max5, [pro(4, 66)], 20, now, go)).toBeNull()
    // Nothing refills within five minutes: start on the 5x now (owner, 2026-10-03: a task never
    // waits more than five minutes while some account admits it).
    expect(waitsForCooldown(max5, [pro(6)], 20, now, go)).toBeNull()
    // The 5x behind its pace (its week is room it loses at the reset): use it.
    expect(waitsForCooldown({ ...max5, weekPct: 40 }, [pro(4)], 20, now, go)).toBeNull()
    // The Pro is further ahead of its own pace than the 5x: nothing gained by waiting.
    expect(waitsForCooldown(max5, [pro(4, 90)], 20, now, go)).toBeNull()
    // A task no fresh Pro window holds: the 5x is where it fits.
    expect(waitsForCooldown(max5, [pro(4)], 120, now, go)).toBeNull()
    // Priority work and a session at home never wait.
    expect(waitsForCooldown(max5, [pro(4)], 20, now, { home: false, priority: 1 })).toBeNull()
    expect(waitsForCooldown(max5, [pro(4)], 20, now, { home: true, priority: 0 })).toBeNull()
    // Held five minutes already, other work having taken each refill: it starts now (2026-10-03:
    // two small tasks waited 30 minutes for a reset that kept sliding later).
    expect(
      waitsForCooldown(max5, [pro(4)], 20, now, { ...go, heldSince: now - 5 * 60_000 }),
    ).toBeNull()
    expect(waitsForCooldown(max5, [pro(4)], 20, now, { ...go, heldSince: now - 60_000 })).toBe(
      now + 4 * 60_000,
    )
    // A session that hit a limit or handed off is moving anyway: it is never held for pace.
    expect(waitsForCooldown(max5, [pro(4)], 20, now, { ...go, moving: true })).toBeNull()
  })
})

describe('the five-minute rule (owner, 2026-10-03)', () => {
  // "When a worker hits a five-hour or weekly limit, CliMayte moves it to another account and
  // resumes it, unless the limit resets in under five minutes; distribute the load."
  const now = 1_000_000_000_000
  const min = 60_000

  test('a session waits at home only for a reset within five minutes; priority never waits', () => {
    expect(waitsForHome(now + 4 * min, now, 0)).toBe(now + 4 * min)
    expect(waitsForHome(now + 6 * min, now, 0)).toBeNull()
    expect(waitsForHome(now + 4 * min, now, 1)).toBeNull()
  })

  test('a task waits for room only when an account it fits refills within five minutes', () => {
    const chosen = { id: 'a', sessionPct: 80 }
    const placement = { expected: 40, running: new Map() }
    // 2026-10-03: nine tasks held for "about 19% left" with no time bound on the wait.
    expect(waitsForRoom(chosen, placement, [1], false, now + 20 * min, now)).toBe(false)
    expect(waitsForRoom(chosen, placement, [1], false, now + 4 * min, now)).toBe(true)
    expect(waitsForRoom(chosen, placement, [1], false, null, now)).toBe(false)
  })
})

describe('which account a task starts on', () => {
  const now = 1_000_000_000_000
  const acct = (
    id: string,
    num: number,
    sessionPct = 10,
    weekPct = 10,
    over: Partial<CliMayteAccount> = {},
  ): CliMayteAccount => ({
    id,
    num,
    name: id,
    configDir: join(tmpdir(), id),
    sessionPct,
    weekPct,
    ...over,
  })
  const worker = (over: Record<string, unknown> = {}) =>
    ({ accounts: null, accountId: null, attempts: [], ...over }) as any
  /** The account's weekly reset, placed so that `pace` % of its week has gone. */
  const weekAt = (pace: number) => ({ weekResetsAt: now + WEEK_MS * (1 - pace / 100) })

  test('behind its weekly pace comes first, ahead of it after; the next account is on the list', () => {
    // 2026-10-02 05:09: #90 (+7.5) beat #95 (-20.6) on its lower 5-hour projection, and the task was
    // then held on #90 alone. Ahead: 30% used with 20% of the week gone. Behind: 10% with 60% gone.
    const ahead = acct('ahead', 1, 0, 30, weekAt(20))
    const behind = acct('behind', 2, 40, 10, weekAt(60))
    const placement = { expected: 4.6, running: new Map() }
    const none = new Map<string, number>()
    const rank = (accounts: CliMayteAccount[]) =>
      rankAccounts(worker(), accounts, {}, none, 2, now, none, false, placement).map((a) => a.id)
    expect(rank([ahead, behind])).toEqual(['behind', 'ahead'])
    // Where the task does not fit comes after both, however far behind its pace.
    const fullBehind = acct('full-behind', 3, 84, 0, weekAt(90))
    expect(rank([fullBehind, ahead, behind])).toEqual(['behind', 'ahead', 'full-behind'])
  })

  test('with no cap from the dispatcher, a group gets 2 workers per Pro window of the account', () => {
    // 2026-10-02 04:36: the Max 5x #103 ran 2 tasks at a time, like each Pro, while 24 waited.
    const two = (id: string) => new Map([[id, 2]])
    const max5 = acct('max5', 1, 10, 10, { planFactor: 5, ...weekAt(50) })
    expect(pickAccount(worker(), [max5], {}, two('max5'), null, now)?.id).toBe('max5')
    // A cap the dispatcher set holds as given, and a Pro stays at 2.
    expect(pickAccount(worker(), [max5], {}, two('max5'), 2, now)).toBeNull()
    expect(pickAccount(worker(), [acct('pro', 2)], {}, two('pro'), null, now)).toBeNull()
    // Ahead of its weekly pace (70% used at the half-week mark), the 5x still takes 2 per Pro window:
    // the halving held priority work back while the account had room (owner, 2026-10-03:
    // "distribute the load").
    const spent = acct('spent', 3, 10, 70, { planFactor: 5, ...weekAt(50) })
    expect(pickAccount(worker(), [spent], {}, two('spent'), null, now)?.id).toBe('spent')
    const ten = new Map([['spent', 10]])
    expect(pickAccount(worker(), [spent], {}, new Map(), null, now, ten)).toBeNull()
  })

  test('an account runs 4 workers per Pro window, up to 8 (owner, 2026-10-03)', () => {
    // 2026-10-03 11:05: the Max 20x #35 at 26% ran 4 workers and was refused a fifth by the flat
    // 4-worker cap, while 7 tasks waited.
    const busy = (id: string, n: number) => new Map([[id, n]])
    const none = new Map<string, number>()
    const pro = acct('pro', 1, 10, 10, { planFactor: 1 })
    const max5 = acct('max5', 2, 10, 10, { planFactor: 5 })
    const max20 = acct('max20', 3, 10, 10, { planFactor: 20 })
    expect(pickAccount(worker(), [pro], {}, busy('pro', 3), null, now, none)?.id).toBe('pro')
    expect(pickAccount(worker(), [pro], {}, busy('pro', 4), null, now, none)).toBeNull()
    expect(pickAccount(worker(), [max5], {}, busy('max5', 7), null, now, none)?.id).toBe('max5')
    expect(pickAccount(worker(), [max5], {}, busy('max5', 8), null, now, none)).toBeNull()
    expect(pickAccount(worker(), [max20], {}, busy('max20', 7), null, now, none)?.id).toBe('max20')
    expect(pickAccount(worker(), [max20], {}, busy('max20', 8), null, now, none)).toBeNull()
  })

  test("a session's follow-up goes back to its own account though the group's slots there are taken", () => {
    // 2026-10-02 05:13: a new task took #102's slot while a finished task's check ran; the check
    // failed and the 33-turn session moved to #94 (about 170k cache-write tokens over resuming).
    const w = worker({
      accountId: 'home',
      attempts: [{ account: { id: 'home', num: 1, name: 'home' }, outcome: 'done' }],
    })
    const taken = new Map([['home', 2]])
    const accounts = [acct('home', 1), acct('other', 2)]
    expect(pickAccount(w, accounts, {}, taken, 2, now, taken)?.id).toBe('home')
    // New work is still held to the cap.
    expect(pickAccount(worker(), accounts, {}, taken, 2, now, taken)?.id).toBe('other')
  })

  test('a signed-out account takes no work once its recheck time passes, only once it signs in', () => {
    // 2026-10-03 00:53Z: #135's wall ran out while no tick ran, and a handoff placed before the
    // tick's recheck sent a worker to the dead login (no readings, so it looked emptiest).
    const dead = acct('dead', 1, 0, 0)
    const busy = acct('busy', 2, 60, 60)
    const lapsed = { dead: { reason: 'signed out', until: now - 60_000 } }
    expect(pickAccount(worker(), [dead, busy], lapsed, new Map(), 2, now)?.id).toBe('busy')
    // A usage wall that ran out frees the account, as before.
    const limit = { dead: { reason: 'usage limit', until: now - 60_000 } }
    expect(pickAccount(worker(), [dead, busy], limit, new Map(), 2, now)?.id).toBe('dead')
  })

  test('among tasks of one dispatch, the largest expected cost is placed first', () => {
    // All 31 tasks of odin-w1 shared one createdAt, so insertion order decided who went first.
    const at = (id: string, expected: number, createdAt = 5) =>
      ({ id, priority: 0, createdAt, size: { expected } }) as any
    const order = [at('small', 4.6), at('big', 52.4), at('older', 1, 4)].sort(dueOrder)
    expect(order.map((w) => w.id)).toEqual(['older', 'big', 'small'])
  })
})

const GIB = 2 ** 30
/** A 64 GB machine with `free` GB of RAM free and, when given, `commitFree` GB of a 160 GB commit
 *  limit left. */
const box = (free: number, commitFree: number | null = null): MachineMemory => ({
  freeBytes: free * GIB,
  totalBytes: 64 * GIB,
  commitFreeBytes: commitFree === null ? null : commitFree * GIB,
  commitLimitBytes: commitFree === null ? null : 160 * GIB,
})

describe('climayteCapacity', () => {
  // check_my_usage quotes this to every chat. 2026-10-02 04:58: it said 9 accounts sat idle while
  // 24 tasks waited, because it counted every account under the stop lines.
  afterAll(() => {
    setCliMayteAccountsProvider(null)
    setCliMayteMemoryReader(null)
  })

  test('says how many tasks already wait, and counts as idle only where a task would start now', () => {
    setCliMayteAccountsProvider(() => [])
    const before = climayteCapacity().waiting
    const run = climayteRun({ tasks: [{ prompt: 'x', cwd: tmpdir() }] })
    expect(climayteCapacity().waiting).toBe(before + 1)
    climayteCancel({ group: run.group })
    expect(climayteCapacity().waiting).toBe(before)
    // At 70% an account is under the 85% stop line, but an ordinary task (25%) would wait for room
    // there rather than start.
    const dir = join(tmpdir(), 'climayte-placement-capacity')
    setCliMayteAccountsProvider(() => [
      { id: 'room-roomy', num: 1, name: 'roomy', configDir: dir, sessionPct: 10, weekPct: 10 },
      { id: 'room-tight', num: 2, name: 'tight', configDir: dir, sessionPct: 70, weekPct: 10 },
    ])
    expect(climayteCapacity()).toMatchObject({ accounts: 2, idle: 1 })
    // A machine out of memory starts nothing, so no account is idle with room.
    setCliMayteMemoryReader(() => box(1))
    expect(climayteCapacity()).toMatchObject({ accounts: 2, idle: 0 })
  })
})

describe('memoryShort (owner, 2026-10-04: the same progress with less memory)', () => {
  test('a start leaves 8% of RAM and 5% of commit, counting workers still growing; an unread machine never holds', () => {
    // 64 GB: the RAM floor is 5.12 GB, and a worker needs about 0.75 GB above it.
    expect(memoryShort(box(6), 0)).toBeNull()
    expect(memoryShort(box(5.5), 0)).toContain('5.5 GB of 64.0 GB RAM free')
    // Two workers that started a minute ago are not in the reading yet: 6 GB holds one start, not
    // three (2026-10-04: 33 started on one free figure).
    expect(memoryShort(box(6), 2)).toContain('2 workers started in the last 2 minutes')
    // RAM to spare, but the commit limit nearly reached (160 GB, floor 8 GB).
    expect(memoryShort(box(30, 8.5), 0)).toContain('commit limit')
    expect(memoryShort(box(30, 20), 0)).toBeNull()
    expect(memoryShort(null, 50)).toBeNull()
  })
})

describe('a task waits for memory, and starts on the first tick with room', () => {
  // 2026-10-04: 33 workers ran at once with 0.5 GB of RAM free and commit at 96% of its limit.
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-memory-'))
  const cwd = join(root, 'work')
  const acctDir = join(root, 'acct')
  for (const d of [cwd, acctDir]) mkdirSync(d, { recursive: true })
  let group: string | null = null

  afterAll(() => {
    if (group) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    setCliMayteMemoryReader(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('held while a start would leave RAM under the floor, then run to done', async () => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    let memory = box(1)
    setCliMayteMemoryReader(() => memory)
    let ticks = 0
    setCliMayteAccountsProvider(() => {
      ticks++
      return [
        {
          id: 'mem-roomy',
          num: 61,
          name: 'roomy',
          configDir: acctDir,
          sessionPct: 5,
          weekPct: 5,
          readAt: Date.now(),
        },
      ]
    })
    const until = async (ok: () => boolean) => {
      const deadline = Date.now() + 20_000
      while (!ok() && Date.now() < deadline) await Bun.sleep(100)
    }
    const aTick = async () => {
      const seen = ticks
      await until(() => ticks >= seen + 2)
    }
    startCliMayte()
    // A named setting: an auto task would shift the scorecard's every-4th pick for later suites.
    const run = climayteRun({
      model: 'sonnet',
      effort: 'medium',
      modelWhy: 'the memory gate under test',
      tasks: [{ prompt: 'do the fake task', cwd, title: 'fake' }],
    })
    group = run.group
    const id = run.workers[0]?.id as string
    const view = () => climayteList({ id })[0]
    await aTick()
    expect(view()?.status).toBe('queued')
    expect(view()?.attempts).toHaveLength(0)
    expect(view()?.error).toContain('Waiting for memory: 1.0 GB of 64.0 GB RAM free')
    memory = box(32)
    await until(() => view()?.status === 'done' || view()?.status === 'failed')
    expect(view()?.status).toBe('done')
    expect(view()?.attempts).toHaveLength(1)
  }, 45_000)
})

describe('a reading over 10 minutes old is read again before a task starts there', () => {
  // 2026-10-03: #116 read 69% about 21 minutes earlier and #152 24% 70 minutes earlier; each took a
  // task in the second it became due, before any re-read began, and was found at 110% and 101%.
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-reading-'))
  const cwd = join(root, 'work')
  const oldDir = join(root, 'acct-old')
  const busyDir = join(root, 'acct-busy')
  for (const d of [cwd, oldDir, busyDir]) mkdirSync(d, { recursive: true })
  let group: string | null = null

  afterAll(() => {
    if (group) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('the task waits for the read, and a read that fails lets it go on', async () => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    const stale = Date.now() - 21 * 60_000
    let old: Partial<CliMayteAccount> = { readAt: stale }
    let ticks = 0
    setCliMayteAccountsProvider(() => {
      ticks++
      return [
        {
          id: 'read-old',
          num: 41,
          name: 'old',
          configDir: oldDir,
          sessionPct: 24,
          weekPct: 10,
          ...old,
        },
        {
          id: 'read-busy',
          num: 42,
          name: 'busy',
          configDir: busyDir,
          sessionPct: 60,
          weekPct: 10,
          readAt: Date.now(),
        },
      ]
    })
    const until = async (ok: () => boolean) => {
      const deadline = Date.now() + 20_000
      while (!ok() && Date.now() < deadline) await Bun.sleep(100)
    }
    // A whole tick has run since the accounts last changed.
    const aTick = async () => {
      const seen = ticks
      await until(() => ticks >= seen + 2)
    }
    startCliMayte()
    // A named setting: an auto task would shift the scorecard's every-4th pick for later suites.
    const run = climayteRun({
      model: 'sonnet',
      effort: 'medium',
      modelWhy: 'the placement under test',
      tasks: [{ prompt: 'do the fake task', cwd, title: 'fake' }],
    })
    group = run.group
    const id = run.workers[0]?.id as string
    const view = () => climayteList({ id })[0]
    await aTick()
    // #41 has the most room: the task neither starts there on the old 24% nor goes to #42 instead.
    expect(view()?.status).toBe('queued')
    expect(view()?.attempts).toHaveLength(0)
    expect(view()?.error).toContain('Reading the usage of #41')
    // The read is asked and still running.
    old = { readAt: stale, readTriedAt: Date.now(), refreshing: true }
    await aTick()
    expect(view()?.attempts).toHaveLength(0)
    // The read failed (the reading is as old as before): the task goes on there.
    old = { readAt: stale, readTriedAt: Date.now() }
    await until(() => view()?.status === 'done' || view()?.status === 'failed')
    expect(view()?.status).toBe('done')
    expect(view()?.attempts[0]?.account.id).toBe('read-old')
  }, 45_000)
})

describe('waitsForRoom', () => {
  test('never holds a session going on at home, nor a task no window fits', () => {
    const chosen = { id: 'a', sessionPct: 80 }
    const placement = { expected: 40, running: new Map() }
    const now = 1_000_000_000_000
    const soon = now + 60_000
    expect(waitsForRoom(chosen, placement, [1], false, soon, now)).toBe(true)
    // Its own account has its conversation in a warm cache: it carries on there.
    expect(waitsForRoom(chosen, placement, [1], true, soon, now)).toBe(false)
    // 150% fits no Pro window, so waiting would be for ever: it goes where the projection is lowest.
    expect(waitsForRoom(chosen, { ...placement, expected: 150 }, [1], false, soon, now)).toBe(false)
  })
})
