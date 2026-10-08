// server/tests/climayte-limits.test.ts — a task sized against an account's window (split when too
// big, waiting for room when it fits), a session that waits for a reset at its own account, and the
// five-minute rule, against the fake CLI. Split from climayte.test.ts on 2026-10-08 to keep each
// file under the Architect's 2,500-line gate.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CliMayteSplitNeeded,
  climayteCancel,
  climayteJournal,
  climayteList,
  climayteRun,
  climayteVerdict,
  climayteWait,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  startCliMayte,
} from '../src/climayte'
import { setSpendKit, workers } from '../src/climayte-core'
import { waitsForHome } from '../src/climayte-placement'
import { clearRemote, setRemote } from '../src/climayte-remote'
import { isPidAlive } from '../src/core/process'
import { harnessKit } from './mocks/climayte-kit'

setSpendKit(harnessKit)

describe('sizing (owner, 2026-10-01): too big for a window is split, one that fits waits for room', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-size-'))
  const cwd = join(root, 'work')
  const proDir = join(root, 'acct-pro')
  for (const d of [cwd, proDir]) mkdirSync(d, { recursive: true })
  const groups: string[] = []
  let sessionPct = 0
  let factor = 1
  let resetAt = Date.now() + 2 * 3_600_000

  afterAll(() => {
    for (const group of groups) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  const settle = async (id: string, ms = 20_000) => {
    const deadline = Date.now() + ms
    let w = climayteList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = climayteList({ id })[0]
    }
    return w
  }
  // A finished, passed task of this kind on Sonnet `effort` that billed `tokens` output tokens: the
  // expected cost of the next one (a Sonnet output token weighs 31 units, a Pro % is 320k units).
  const onRecord = async (kind: string, effort: string, tokens: number) => {
    const run = climayteRun({
      tasks: [
        {
          prompt: `FAKE-SPEND:${tokens} history`,
          cwd,
          kind,
          model: 'sonnet',
          effort,
          ownerWords: 'the record under test',
        },
      ],
      group: `size-history-${kind}`,
      size: 'whole',
    })
    groups.push(run.group)
    const id = run.workers[0]?.id as string
    expect((await settle(id))?.status).toBe('done')
    expect(climayteVerdict(id, { verdict: 'pass', by: 'orchestrator' }).ok).toBe(true)
  }

  test('a dispatch with a task over half the biggest window starts nothing; whole, or a Max window, runs it', async () => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      {
        id: 'size-pro',
        num: 41,
        name: 'pro',
        configDir: proDir,
        sessionPct,
        weekPct: 0,
        planFactor: factor,
        sessionResetsAt: resetAt,
      },
    ])
    startCliMayte()
    await onRecord('debug', 'low', 1_550_000) // about 150% of a Pro window

    const big = {
      prompt: 'a big debug task',
      cwd,
      kind: 'debug',
      model: 'sonnet',
      effort: 'low',
      ownerWords: 'sized on its own record',
    }
    const before = climayteList().length
    let refused: unknown = null
    try {
      climayteRun({ tasks: [{ prompt: 'a small one', cwd }, big], group: 'size-big' })
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(CliMayteSplitNeeded)
    expect((refused as CliMayteSplitNeeded).message).toContain('split needed')
    // One task at 150% on record, blended toward the broader record (expectedCost): still far over
    // half the 85% window, in pieces of at most half.
    const [split] = (refused as CliMayteSplitNeeded).tasks
    expect(split).toMatchObject({ task: 2, title: 'a big debug task', window: 85 })
    expect(split?.expected).toBeGreaterThan(85)
    expect(split?.pieces).toBe(Math.ceil((split?.expected ?? 0) / 42.5))
    expect(climayteList().length).toBe(before)

    // On the owner's say it runs as it is: no window fits it, so it starts rather than wait forever.
    const whole = climayteRun({ tasks: [{ ...big, size: 'whole' }], group: 'size-whole' })
    groups.push(whole.group)
    const wholeId = whole.workers[0]?.id as string
    expect(whole.workers[0]?.size).toMatchObject({ window: 85, roomOn: '#41' })
    expect(whole.workers[0]?.size?.basis).toBe('debug on claude-sonnet-5-5 low, 1 finished')
    expect(Math.round(whole.workers[0]?.size?.expected ?? 0)).toBe(split?.expected as number)
    expect(['running', 'done']).toContain((await settle(wholeId))?.status)

    // A Max 20x window holds twenty Pro windows: the same task fits it whole.
    factor = 20
    const max = climayteRun({ tasks: [big], group: 'size-max' })
    groups.push(max.group)
    expect(max.workers[0]?.size?.window).toBe(1700)
    climayteCancel({ group: 'size-max' })
  }, 60_000)

  test('a manager is priced per wake and never asked to split, however big the tasks on record ran (piece 6)', async () => {
    factor = 1
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      {
        id: 'size-pro',
        num: 41,
        name: 'pro',
        configDir: proDir,
        sessionPct,
        weekPct: 0,
        planFactor: factor,
        sessionResetsAt: resetAt,
      },
    ])
    startCliMayte()
    await onRecord('debug', 'low', 1_550_000) // about 150% of a Pro window on Sonnet
    const big = {
      prompt: 'a big task',
      cwd,
      kind: 'debug',
      model: 'sonnet',
      effort: 'low',
      ownerWords: 'sized',
    }
    expect(() => climayteRun({ tasks: [big], group: 'size-not-manage' })).toThrow('split needed')

    const run = climayteRun({
      tasks: [{ prompt: 'manage the wave of 20 tasks', cwd, kind: 'manage' }],
      group: 'size-manage',
    })
    groups.push(run.group)
    const manager = run.workers[0]
    // Every kind starts on Haiku 5.5 medium, a manager too (owner, 2026-10-07).
    expect(manager).toMatchObject({ kind: 'manage', model: 'claude-haiku-5-5', effort: 'medium' })
    expect(manager?.size?.expected).toBe(2)
    climayteCancel({ group: 'size-manage' })
  }, 60_000)

  test('a task that fits a fresh window but not the room left waits, then starts once there is room', async () => {
    factor = 1
    await onRecord('review', 'medium', 310_000) // about 30% of a Pro window
    sessionPct = 70
    // The account refills within five minutes, so the task waits for it (owner, 2026-10-03).
    resetAt = Date.now() + 4 * 60_000
    const run = climayteRun({
      tasks: [
        {
          prompt: 'a review that needs room',
          cwd,
          kind: 'review',
          model: 'sonnet',
          effort: 'medium',
          // Sonnet on the owner's words, so the review is sized as recorded, not tried on Haiku.
          ownerWords: 'sized',
        },
      ],
      group: 'size-room',
    })
    groups.push(run.group)
    const id = run.workers[0]?.id as string
    const deadline = Date.now() + 10_000
    let w = climayteList({ id })[0]
    while (w?.status === 'queued' && Date.now() < deadline) {
      await climayteWait({ id }, 1_000)
      w = climayteList({ id })[0]
    }
    expect(w?.status).toBe('waiting')
    expect(w?.error).toContain('Waiting for room')
    // A timed hold names the time it starts by, whatever happens to the room meanwhile.
    const by = new Date(resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    expect(w?.error).toContain(`It starts by ${by} either way (an account it fits refills then).`)
    // The row a status read returns carries the size, with the room when it started waiting.
    expect(w?.size).toMatchObject({ window: 85, room: 15, roomOn: '#41' })
    // When it expects room, for a waiter to sleep until: the account's 5-hour reset, in UTC.
    expect(w?.waitUntil).toBe(new Date(resetAt).toISOString())
    sessionPct = 10
    const done = await settle(id)
    expect(done?.status).toBe('done')
    expect(done?.waitUntil).toBeUndefined()
  }, 60_000)

  test('with no reset within five minutes it starts short where at least 10% is left, else waits', async () => {
    // Owner, 2026-10-03: nine tasks sat "expected to use about 22% of a Pro 5-hour window, and the
    // best account now has about 19% left". A task that runs short hands off at the stop line and
    // its continuation moves by itself; under 10% left it would hand off at once.
    factor = 1
    resetAt = Date.now() + 2 * 3_600_000
    await onRecord('sweep', 'medium', 400_000)
    sessionPct = 80
    const task = {
      prompt: 'a sweep that runs short',
      cwd,
      kind: 'sweep',
      model: 'sonnet',
      effort: 'medium',
      ownerWords: 'sized', // as recorded, not tried on Haiku
    }
    const run = climayteRun({ tasks: [task], group: 'size-short', size: 'whole' })
    groups.push(run.group)
    const expected = run.workers[0]?.size?.expected ?? 0
    // Over the 15% left at 70% and within a fresh window, so only the room left decides.
    expect(expected).toBeGreaterThan(15)
    expect(expected).toBeLessThan(85)
    const id = run.workers[0]?.id as string
    const deadline = Date.now() + 10_000
    let w = climayteList({ id })[0]
    while (w?.status === 'queued' && Date.now() < deadline) {
      await climayteWait({ id }, 1_000)
      w = climayteList({ id })[0]
    }
    // 5% left: it waits.
    expect(w?.status).toBe('waiting')
    sessionPct = 70
    const done = await settle(id)
    expect(done?.status).toBe('done')
    expect(climayteJournal({ id }).some((e) => e.event === 'start-short')).toBe(true)
  }, 60_000)
})

test("a session stopped at its own account's limit waits for a reset soon instead of moving", () => {
  const now = Date.now()
  // A move re-writes the whole conversation into a cold cache (median 219k cache-write tokens
  // against 49k for a resume at home), but the owner ruled on 2026-10-03: "CliMayte moves it to
  // another account and resumes it, unless the limit resets in under five minutes". Four minutes'
  // wait holds; ten minutes' moves.
  expect(waitsForHome(now + 4 * 60_000, now, 0)).toBe(now + 4 * 60_000)
  expect(waitsForHome(now + 10 * 60_000, now, 0)).toBeNull()
  expect(waitsForHome(now + 4 * 60_000, now, 1)).toBeNull()
})

describe('integration: the five-minute rule (owner, 2026-10-03)', () => {
  // "When a worker hits a five-hour or weekly limit, CliMayte moves it to another account and
  // resumes it, unless the limit resets in under five minutes; distribute the load."
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-five-'))
  const cwd = join(root, 'work')
  const dir = (name: string, marker?: [string, string]) => {
    const d = join(root, name)
    mkdirSync(d, { recursive: true })
    if (marker) writeFileSync(join(d, marker[0]), marker[1])
    return d
  }
  mkdirSync(cwd, { recursive: true })
  const groups: string[] = []
  const acct = (
    id: string,
    num: number,
    configDir: string,
    sessionPct: number,
    planFactor = 1,
  ) => ({
    id,
    num,
    name: id,
    configDir,
    sessionPct,
    weekPct: 10,
    planFactor,
  })

  afterAll(async () => {
    for (const group of groups) climayteCancel({ group })
    // The folder goes once the stopped CLIs have exited: on Windows one still running in `cwd`
    // holds it open (EBUSY, 2026-10-03). Read after the cancel, which fills in the pids it found,
    // and again each round: a runner that claimed its spec without writing a pid is killed by a
    // later tick (killLateStarts), which reads it then. A finished attempt's pid is left out, as
    // Windows may have handed it to a stranger since.
    const stopping = () => {
      const ats = [...workers.values()]
        .filter((w) => groups.includes(w.group))
        .flatMap((w) => w.attempts.filter((a) => a.outcome === 'cancelled'))
      const pids = ats.flatMap((a) => [a.pid, a.runner?.pid ?? null])
      return ats.some((a) => a.runner?.killOnStart) || pids.some((p) => p !== null && isPidAlive(p))
    }
    const gone = Date.now() + 10_000
    while (stopping() && Date.now() < gone) await Bun.sleep(200)
    clearRemote()
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  }, 15_000)

  const fake = () =>
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
  const until = async (
    id: string,
    done: (w: ReturnType<typeof climayteList>[number] | undefined) => boolean,
    ms: number,
  ) => {
    const deadline = Date.now() + ms
    let w = climayteList({ id })[0]
    while (!done(w) && Date.now() < deadline) {
      await climayteWait({ id }, Math.min(1_000, Math.max(1, deadline - Date.now())))
      w = climayteList({ id })[0]
    }
    return w
  }
  const dispatch = (group: string, title: string, extra: Record<string, unknown> = {}) => {
    const run = climayteRun({
      tasks: [{ prompt: `${title}: do the fake task`, cwd, title }],
      group,
      size: 'whole',
      ...extra,
    })
    groups.push(run.group)
    return run.workers[0]?.id as string
  }
  const launchedOn = (id: string) =>
    climayteJournal({ id })
      .filter((e) => e.event === 'launched')
      .map((e) => e.account)

  test('the 11:05 repro: a priority task starts on the Max with room, not behind a flat 4-worker cap', async () => {
    // 2026-10-03 11:05: the Max 20x #35 at 26% ran 4 workers from other groups and the Pros ran 4
    // each; the one Pro with no worker had about 19% left of a 22% task. Seven tasks waited.
    fake()
    const running = (account: { id: string; num: number }, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `w-remote-${account.id}-${i}`,
        title: 'other work',
        group: 'g-other',
        status: 'running',
        kind: null,
        model: null,
        effort: null,
        account: { id: account.id, num: account.num, name: account.id },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        activeS: 60,
        costUsd: 0,
        lastActivity: null,
        error: null,
        verdict: null,
      }))
    const max = acct('rp-max', 35, dir('rp-max'), 26, 20)
    const pros = [101, 102, 103].map((n) => acct(`rp-pro-${n}`, n, dir(`rp-pro-${n}`), 30))
    setRemote(
      {
        pc: 'five-minute-rule-pc',
        name: 'other PC',
        at: Date.now(),
        workers: [max, ...pros].flatMap((a) => running(a, 4)),
        live: {},
      },
      1,
    )
    setCliMayteAccountsProvider(() => [
      acct('rp-short', 133, dir('rp-short'), 66),
      max,
      ...pros,
      acct('rp-past', 98, dir('rp-past'), 90),
    ])
    startCliMayte()
    const id = dispatch('rp-teardown', 'teardown plane', { perAccount: 1, priority: 1 })
    const w = await until(id, (x) => x?.status !== 'queued', 10_000)
    expect(w?.error ?? '').not.toContain('Waiting for room')
    expect(launchedOn(id)).toEqual(['#35'])
  }, 30_000)

  test('per_account spills to an account with room once nothing within it fits; strict waits', async () => {
    fake()
    const spillDirs = [dir('sp-1', ['fake-slow', '']), dir('sp-2')]
    const strictDirs = [dir('st-1', ['fake-slow', '']), dir('st-2')]
    setCliMayteAccountsProvider(() => [
      acct('sp-1', 141, spillDirs[0] as string, 10, 5),
      acct('sp-2', 142, spillDirs[1] as string, 86),
      acct('st-1', 151, strictDirs[0] as string, 10, 5),
      acct('st-2', 152, strictDirs[1] as string, 86),
    ])
    startCliMayte()
    const only = (ids: string[]) => ({ perAccount: 1, accounts: ids })
    const first = dispatch('sp-G', 'spill one', only(['sp-1', 'sp-2']))
    expect((await until(first, (x) => x?.status === 'running', 10_000))?.status).toBe('running')
    expect(launchedOn(first)).toEqual(['#141'])
    // #142 is past the 85% stop line (a room test would hang on the cost estimate, which earlier
    // tests' finished tasks move), and #141 already runs this group's one: it spills to #141.
    const second = dispatch('sp-G', 'spill two', only(['sp-1', 'sp-2']))
    const spilled = await until(second, (x) => x?.status !== 'queued', 10_000)
    expect(spilled?.status).toBe('running')
    expect(launchedOn(second)).toEqual(['#141'])
    expect(climayteJournal({ id: second }).some((e) => e.event === 'spill')).toBe(true)

    // per_account_strict keeps the old hard cap: the second task stays queued for a slot, and says
    // #151 has room but runs this group's one.
    const strict = { ...only(['st-1', 'st-2']), perAccountStrict: true }
    const one = dispatch('st-G', 'strict one', strict)
    expect((await until(one, (x) => x?.status === 'running', 10_000))?.status).toBe('running')
    const two = dispatch('st-G', 'strict two', strict)
    const held = await until(two, (x) => !!x?.error, 10_000)
    expect(held?.status).toBe('queued')
    expect(held?.error).toContain('#151')
    expect(held?.error).toContain('per_account_strict')
    expect(launchedOn(two)).toEqual([])
  }, 40_000)

  test('a task held off an account with room by its worker cap says so (not strict)', async () => {
    // capNote, 2026-10-03 11:05: seven tasks waited behind a flat 4-worker cap while #35 had room.
    fake()
    const cd = dir('cn-1', ['fake-slow', ''])
    // A Max 5x account: a cap of 8, and room left once 8 Pro-sized tasks run on it.
    setCliMayteAccountsProvider(() => [acct('cn-1', 181, cd, 10, 5)])
    startCliMayte()
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
      dispatch('cn-G', `cap ${n}`, { accounts: ['cn-1'] }),
    )
    for (const id of ids) await until(id, (x) => x?.status === 'running', 10_000)
    const ninth = dispatch('cn-G', 'cap 9', { accounts: ['cn-1'] })
    const held = await until(ninth, (x) => !!x?.error, 10_000)
    expect(launchedOn(ninth)).toEqual([])
    expect(held?.error).toContain('#181 has room but runs 8 workers (its cap).')
    expect(held?.error).not.toContain('per_account_strict')
  }, 40_000)

  test('a limit that resets in 20 minutes moves at once; one that resets in 3 waits at home', async () => {
    fake()
    setCliMayteAccountsProvider(() => [
      acct('q-home', 161, dir('q-home', ['fake-quota', '20']), 0),
      acct('q-other', 162, dir('q-other'), 20),
      acct('q3-home', 171, dir('q3-home', ['fake-quota', '3']), 0),
      acct('q3-other', 172, dir('q3-other'), 20),
    ])
    startCliMayte()
    const moves = dispatch('q-move', 'moves on', { accounts: ['q-home', 'q-other'] })
    const done = await until(moves, (x) => x?.status === 'done' || x?.status === 'failed', 20_000)
    expect(done?.status).toBe('done')
    expect(done?.attempts[0]?.outcome).toBe('quota')
    expect(launchedOn(moves)).toEqual(['#161', '#162'])

    const waits = dispatch('q-wait', 'waits at home', { accounts: ['q3-home', 'q3-other'] })
    const held = await until(waits, (x) => x?.status === 'waiting', 15_000)
    expect(held?.status).toBe('waiting')
    expect(held?.error).toContain('Waiting for its own account #171')
    expect(launchedOn(waits)).toEqual(['#171'])
  }, 45_000)
})
