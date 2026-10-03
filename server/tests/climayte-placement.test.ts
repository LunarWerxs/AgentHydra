// Where CliMayte starts a task so it can finish there (climayte-placement.ts).
import { afterAll, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteCapacity,
  climayteRun,
  setCliMayteAccountsProvider,
} from '../src/climayte'
import { type CliMayteAccount, dueOrder, pickAccount, rankAccounts } from '../src/climayte-lib'
import {
  DEFAULT_TASK_PCT,
  expectedCost,
  MANAGER_WAKE_PCT,
  planFactor,
  projectedPct,
  WEEK_MS,
  waitsForCooldown,
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
    // that refills in 12 minutes can then take the 20% task: wait for that reset.
    expect(waitsForCooldown(max5, [pro(12), pro(45)], 20, now, go)).toBe(now + 12 * 60_000)
    // That Pro already has room (2026-10-02: tasks waited for the reset of #98, at 0%): a reset
    // gains nothing, and neither does one of a Pro whose running work leaves the task room.
    expect(waitsForCooldown(max5, [pro(12, 30, 0)], 20, now, go)).toBeNull()
    const busy = { ...pro(12, 30, 40), running: [{ expected: 30, startPct: 40 }] }
    expect(waitsForCooldown(max5, [busy], 20, now, go)).toBe(now + 12 * 60_000)
    expect(waitsForCooldown(max5, [{ ...busy, running: [] }], 20, now, go)).toBeNull()
    // Whole-percent readings: 3% used with 2.74% of the week gone (#94) is not ahead of pace.
    const noise = { id: 'a94', weekPct: 3, weekResetsAt: now + WEEK_MS * 0.9726 }
    const fresh = { ...pro(12, 0), weekResetsAt: noise.weekResetsAt }
    expect(waitsForCooldown(noise, [fresh], 5, now, go)).toBeNull()
    // The Pro is within the band of the 5x's pace (66% used against 70%): not worth a wait.
    expect(waitsForCooldown(max5, [pro(12, 66)], 20, now, go)).toBeNull()
    // Nothing refills within half an hour: start on the 5x now.
    expect(waitsForCooldown(max5, [pro(45)], 20, now, go)).toBeNull()
    // The 5x behind its pace (its week is room it loses at the reset): use it.
    expect(waitsForCooldown({ ...max5, weekPct: 40 }, [pro(12)], 20, now, go)).toBeNull()
    // The Pro is further ahead of its own pace than the 5x: nothing gained by waiting.
    expect(waitsForCooldown(max5, [pro(12, 90)], 20, now, go)).toBeNull()
    // A task no fresh Pro window holds: the 5x is where it fits.
    expect(waitsForCooldown(max5, [pro(12)], 120, now, go)).toBeNull()
    // Priority work and a session at home never wait.
    expect(waitsForCooldown(max5, [pro(12)], 20, now, { home: false, priority: 1 })).toBeNull()
    expect(waitsForCooldown(max5, [pro(12)], 20, now, { home: true, priority: 0 })).toBeNull()
    // Held a whole cooldown window already, other work having taken each refill: it starts now
    // (2026-10-03: two small tasks waited 30 minutes for a reset that kept sliding later).
    expect(
      waitsForCooldown(max5, [pro(12)], 20, now, { ...go, heldSince: now - 30 * 60_000 }),
    ).toBeNull()
    expect(waitsForCooldown(max5, [pro(12)], 20, now, { ...go, heldSince: now - 60_000 })).toBe(
      now + 12 * 60_000,
    )
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
    // Ahead of its weekly pace (70% used at the half-week mark), the 5x takes no more than a Pro.
    const spent = acct('spent', 3, 10, 70, { planFactor: 5, ...weekAt(50) })
    expect(pickAccount(worker(), [spent], {}, two('spent'), null, now)).toBeNull()
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

describe('climayteCapacity', () => {
  // check_my_usage quotes this to every chat. 2026-10-02 04:58: it said 9 accounts sat idle while
  // 24 tasks waited, because it counted every account under the stop lines.
  afterAll(() => setCliMayteAccountsProvider(null))

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
  })
})

describe('waitsForRoom', () => {
  test('never holds a session going on at home, nor a task no window fits', () => {
    const chosen = { id: 'a', sessionPct: 80 }
    const placement = { expected: 40, running: new Map() }
    expect(waitsForRoom(chosen, placement, [1], false)).toBe(true)
    // Its own account has its conversation in a warm cache: it carries on there.
    expect(waitsForRoom(chosen, placement, [1], true)).toBe(false)
    // 150% fits no Pro window, so waiting would be for ever: it goes where the projection is lowest.
    expect(waitsForRoom(chosen, { ...placement, expected: 150 }, [1], false)).toBe(false)
  })
})
