// server/tests/climayte-steering.test.ts — steering a running worker (climayte_send, urgent
// messages, a new model or folder mid-task) and a task judged by its check, against the fake CLI.
// Split from climayte.test.ts on 2026-10-08 to keep each file under the Architect's 2,500-line gate.

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteDeliverNow,
  climayteGet,
  climayteJournal,
  climayteList,
  climayteRemove,
  climayteReports,
  climayteRun,
  climayteRunningCount,
  climayteSend,
  climayteVerdict,
  climayteWait,
  SENT_NOW_PREFIX,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  startCliMayte,
  VERDICT_NOTE_MAX,
} from '../src/climayte'
import { setSpendKit, workers } from '../src/climayte-core'
import { killProcessTree } from '../src/core/process'
import { harnessKit } from './mocks/climayte-kit'

setSpendKit(harnessKit)

describe('integration: steering a running worker (field notes 10 and 11)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-steer-'))
  const cwd = join(root, 'work')
  const slowDir = join(root, 'acct-slow')
  for (const d of [cwd, slowDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(slowDir, 'fake-slow'), '')
  const groups: string[] = []

  afterAll(() => {
    for (const group of groups) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  const start = async (title: string, account: string) => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      { id: account, num: 7, name: 'slow', configDir: slowDir, sessionPct: 0, weekPct: 0 },
    ])
    startCliMayte()
    // One known setting, so a follow-up's switch shows against it (auto may try Haiku).
    const run = climayteRun({
      tasks: [
        {
          prompt: 'a slow task',
          cwd,
          title,
          model: 'sonnet',
          effort: 'medium',
          ownerWords: 'steering starts from one known setting',
        },
      ],
    })
    groups.push(run.group)
    const id = run.workers[0]?.id as string
    const deadline = Date.now() + 10_000
    while (climayteList({ id })[0]?.status !== 'running' && Date.now() < deadline)
      await climayteWait({ id }, 1_000)
    // Its init line is in the log: the CLI started and the session exists. A fixed 1.5 s was short
    // under the gate's load, and a stop before the CLI starts now stops it (2026-10-02), so the
    // next turn was a fresh session, which fake-slow runs for 30 s, not a resume.
    const started = () => {
      const log = workers.get(id)?.attempts.at(-1)?.log
      return !!log && existsSync(log) && readFileSync(log, 'utf8').includes('"subtype":"init"')
    }
    while (!started() && Date.now() < deadline) await Bun.sleep(50)
    return id
  }
  const settle = async (id: string, ms: number) => {
    const deadline = Date.now() + ms
    let w = climayteList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = climayteList({ id })[0]
    }
    return w
  }

  test('a plain message is held and says so; urgent stops the work and goes first', async () => {
    const id = await start('steer', 'slow-1')
    expect(climayteSend(id, 'queued one').message).toContain('Held until this worker finishes')
    const urgent = climayteSend(id, 'STEER NOW', { urgent: true })
    expect(urgent).toMatchObject({ ok: true, urgent: true })
    expect(urgent.message).toContain('then the 1 message(s) queued before it')

    const w = await settle(id, 15_000)
    expect(w?.status).toBe('done')
    expect(w?.pending).toEqual([])
    expect(w?.attempts.map((a) => a.outcome)).toEqual(['cancelled', 'done', 'done'])
    expect(w?.attempts[0]?.notice).toContain('urgent message')
    const events = climayteJournal({ id }).map((e) => e.event)
    expect(events.filter((e) => e === 'follow-up-delivered')).toHaveLength(2)
    expect(climayteJournal({ id }).find((e) => e.urgent)?.event).toBe('follow-up-queued')
  }, 25_000)

  test('send now: a held message leads the next turn at once, with no second copy', async () => {
    const id = await start('send-now', 'slow-1')
    expect(climayteDeliverNow('no-such-worker')).toMatchObject({ ok: false })
    climayteSend(id, 'first held')
    climayteSend(id, 'SECOND HELD')
    expect(climayteDeliverNow(id, 'never sent')).toMatchObject({ ok: true, stopped: false })
    const now = climayteDeliverNow(id, 'SECOND HELD')
    expect(now).toMatchObject({ ok: true, stopped: true })
    expect(now.message).toContain('then the 1 other held message(s)')
    expect(climayteList({ id })[0]?.pending).toEqual([
      `${SENT_NOW_PREFIX}\n\nSECOND HELD`,
      'first held',
    ])

    const w = await settle(id, 15_000)
    expect(w?.status).toBe('done')
    expect(w?.pending).toEqual([])
    expect(w?.attempts.map((a) => a.outcome)).toEqual(['cancelled', 'done', 'done'])
    expect(w?.attempts[0]?.notice).toContain('sent now')
    expect(climayteJournal({ id }).filter((e) => e.event === 'follow-up-delivered')).toHaveLength(2)
    expect(climayteDeliverNow(id)).toMatchObject({ ok: true, stopped: false })
  }, 25_000)

  test('model and effort: unknown values are refused, aliases become full ids, the group default fills in', () => {
    expect(() => climayteRun({ tasks: [{ prompt: 'x', cwd, model: 'gpt-5' }] })).toThrow(
      "task 1: unknown model 'gpt-5': use auto, haiku, sonnet or opus",
    )
    expect(() => climayteRun({ tasks: [{ prompt: 'x', cwd, effort: 'ultra' }] })).toThrow(
      'use low, medium, high, xhigh, max',
    )
    expect(() => climayteRun({ model: 'gpt', tasks: [{ prompt: 'x', cwd }] })).toThrow(
      'unknown model',
    )
    // Owner, 2026-10-07: never Haiku 4.5. Its names are refused, never run as Haiku 5.5.
    for (const model of ['haiku-4.5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'])
      expect(() => climayteRun({ tasks: [{ prompt: 'x', cwd, model }] })).toThrow(
        'task 1: Haiku 4.5 is retired here (owner, 2026-10-07): use haiku (Haiku 5.5)',
      )
    const run = climayteRun({
      model: 'sonnet',
      effort: 'medium',
      ownerWords: 'the setting under test',
      tasks: [
        { prompt: 'by default', cwd },
        // A task naming its own setting needs its own words; the run's cover the run's setting only.
        {
          prompt: 'its own',
          cwd,
          model: 'Opus',
          effort: 'xhigh',
          ownerWords: 'the setting under test',
        },
        { prompt: 'haiku', cwd, model: 'haiku', ownerWords: 'the setting under test' },
      ],
    })
    climayteCancel({ group: run.group })
    expect(run.workers.map((w) => [w.model, w.effort])).toEqual([
      ['claude-sonnet-5-5', 'medium'],
      ['claude-opus-5-5', 'xhigh'],
      ['claude-haiku-5-5', 'medium'],
    ])
    // Owner, 2026-10-02: the cheapest model that reliably does the task. A model named with no
    // reason is left to the scorecard: a sweep pinned to Opus starts where sweeps start, on
    // Haiku 5.5 medium (owner, 2026-10-07).
    const bare = climayteRun({ tasks: [{ prompt: 'x', cwd, kind: 'sweep', model: 'opus' }] })
    climayteCancel({ group: bare.group })
    expect(bare.workers.map((w) => [w.model, w.effort])).toEqual([['claude-haiku-5-5', 'medium']])
  })

  test('a follow-up switches model and effort for its turn on, in the same session', async () => {
    const id = await start('escalate', 'slow-3')
    const session = climayteList({ id })[0]?.sessionId
    expect(climayteSend(id, 'x', { model: 'fable' })).toMatchObject({ ok: false })
    const sent = climayteSend(id, 'try harder', { urgent: true, model: 'opus', effort: 'xhigh' })
    expect(sent).toMatchObject({ ok: true, model: 'claude-opus-5-5', effort: 'xhigh' })
    const w = await settle(id, 15_000)
    expect(w?.status).toBe('done')
    expect(w?.attempts.at(-1)?.requested).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' })
    expect(w?.attempts[0]?.requested).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
    // The fake CLI reports the --model it was given, as the real one does at init.
    expect(w?.reportedModel).toBe('claude-opus-5-5')
    expect(climayteGet(id)?.sessionId).toBe(session)
    const delivered = climayteJournal({ id }).filter((e) => e.event === 'follow-up-delivered')
    expect(delivered.at(-1)).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' })

    // `judged` is the waiter's handled list (--unjudged): a verdict covers the work before it, and
    // a later follow-up's result needs judging again, or its report would never wake anyone.
    expect(w?.judged).toBe(false)
    expect(climayteVerdict(id, { verdict: 'pass' }).ok).toBe(true)
    expect(climayteList({ id })[0]?.judged).toBe(true)
    climayteSend(id, 'one more thing')
    expect((await settle(id, 15_000))?.judged).toBe(false)
  }, 40_000)

  test('a verdict note over the limit is refused whole and records nothing; one just under it is kept whole', async () => {
    const id = await start('verdict-note', 'slow-1')
    climayteCancel({ id }) // a stopped worker can be judged; the fake CLI would run 30 s otherwise
    expect(climayteList({ id })[0]?.status).not.toBe('running')
    const over = 'x'.repeat(VERDICT_NOTE_MAX + 1)
    const refused = climayteVerdict(id, { verdict: 'fail', note: over, retry: false })
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain(String(VERDICT_NOTE_MAX + 1))
    expect(refused.message).toContain(String(VERDICT_NOTE_MAX))
    expect(climayteGet(id)?.verdicts ?? []).toEqual([])
    const fits = 'y'.repeat(VERDICT_NOTE_MAX - 1)
    expect(climayteVerdict(id, { verdict: 'fail', note: fits, retry: false }).ok).toBe(true)
    expect(climayteGet(id)?.verdicts?.map((v) => v.note)).toEqual([fits])
  }, 40_000)

  test('severity is refused on a pass and outside 0-3, and a fail without one stays accepted', async () => {
    const id = await start('severity', 'slow-1')
    climayteCancel({ id })
    for (const bad of [4, -1, 1.5, 'x'])
      expect(
        climayteVerdict(id, { verdict: 'fail', note: 'n', retry: false, severity: bad }).ok,
      ).toBe(false)
    expect(climayteVerdict(id, { verdict: 'pass', severity: 1 }).ok).toBe(false)
    expect(climayteGet(id)?.verdicts ?? []).toEqual([])
    expect(climayteVerdict(id, { verdict: 'fail', note: 'n', retry: false, severity: 2 }).ok).toBe(
      true,
    )
    // A fail without one stays accepted (the old window's thumbs-down) and carries none.
    expect(climayteVerdict(id, { verdict: 'fail', note: 'n', retry: false }).ok).toBe(true)
    expect(climayteGet(id)?.verdicts?.map((v) => v.severity)).toEqual([2, undefined])
  }, 40_000)

  test('a cancel keeps queued messages and delivers them when the worker is continued', async () => {
    const id = await start('cancel keeps', 'slow-2')
    climayteSend(id, 'first')
    climayteSend(id, 'second')
    const r = climayteCancel({ id })
    expect(r).toEqual({ cancelled: [id], keptMessages: { [id]: 2 } })
    expect(climayteList({ id })[0]?.pending).toEqual(['first', 'second'])

    climayteSend(id, 'third')
    const w = await settle(id, 15_000)
    expect(w?.status).toBe('done')
    expect(w?.pending).toEqual([])
    expect(climayteJournal({ id }).filter((e) => e.event === 'follow-up-delivered')).toHaveLength(3)
    // Each message delivered on the heels of the last keeps the report before it (field note 13
    // regression: a queued follow-up wiped the first turn's report before anyone read it).
    expect(climayteGet(id)?.reports?.map((r) => r.message)).toEqual(['first', 'second'])
    expect(climayteGet(id)?.reports?.every((r) => r.results.length > 0)).toBe(true)
  }, 25_000)

  // 2026-10-02: three cancels 87-209 ms after launch found no pid file yet, marked the attempt
  // stopped, and the runner still started the CLI and ran the task to completion ($0.145-0.150
  // each, charged to nothing), leaving its pid and exit files behind.
  test('a cancel before the runner claims its spec starts no CLI and leaves no runner files', async () => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      { id: 'slow-early', num: 7, name: 'slow', configDir: slowDir, sessionPct: 0, weekPct: 0 },
    ])
    startCliMayte()
    const run = climayteRun({ tasks: [{ prompt: 'a slow task', cwd, title: 'early cancel' }] })
    groups.push(run.group)
    const id = run.workers[0]?.id as string
    // Cancel the moment it is dispatched: the runner takes 0.4-2.2 s to reach its spec.
    const deadline = Date.now() + 10_000
    while (climayteList({ id })[0]?.status !== 'running' && Date.now() < deadline)
      await Bun.sleep(5)
    expect(climayteCancel({ id }).cancelled).toEqual([id])

    await Bun.sleep(5_000) // past any hand-off: a runner that was going to start the CLI has
    const log = workers.get(id)?.attempts[0]?.log as string
    expect(log).toBeString()
    expect(readFileSync(log, 'utf8')).toBe('')
    for (const suffix of ['.spec.json', '.spec.json.taken', '.pid.json', '.exit.json'])
      expect(existsSync(`${log}${suffix}`)).toBe(false)
  }, 20_000)
})

describe('integration: a task with a check is judged by it', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-check-'))
  const cwd = join(root, 'work')
  const acct = join(root, 'acct')
  for (const d of [cwd, acct]) mkdirSync(d, { recursive: true })
  const groups: string[] = []

  afterAll(() => {
    for (const group of groups) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('a failing check sends the task back one rung up; the passing one records the pass', async () => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      { id: 'check-1', num: 1, name: 'check', configDir: acct, sessionPct: 0, weekPct: 0 },
    ])
    startCliMayte()
    // Fails the first time (leaving a marker), passes the second.
    const check = 'test -f proved || { touch proved; echo not yet; exit 1; }'
    const run = climayteRun({
      tasks: [
        {
          prompt: 'prove it',
          cwd,
          title: 'checked',
          kind: 'code',
          model: 'sonnet',
          effort: 'high',
          ownerWords: 'the rung this test climbs from',
          check,
        },
      ],
    })
    groups.push(run.group)
    const id = run.workers[0]?.id as string

    const deadline = Date.now() + 25_000
    let w = climayteList({ id })[0]
    while (
      w &&
      !(w.status === 'done' && (w.verdicts?.length ?? 0) >= 2) &&
      w.status !== 'failed' &&
      Date.now() < deadline
    ) {
      await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = climayteList({ id })[0]
    }

    expect(w?.verdicts?.map((v) => [v.verdict, v.by, v.model, v.effort])).toEqual([
      ['fail', 'check', 'claude-sonnet-5-5', 'high'],
      ['pass', 'check', 'claude-opus-5-5', 'medium'],
    ])
    expect(w?.verdicts?.[0]?.note).toContain('not yet')
    expect(w?.status).toBe('done')
    // The check's pass covers the retry too, and the report view says who judged it.
    expect(climayteReports({ ids: [id] })[0]).toMatchObject({
      judged: true,
      verdict: 'pass',
      by: 'check',
      attempts: 2,
    })
  }, 30_000)

  test('a running check holds no restart back and is still judged from its files', async () => {
    // Owner, 2026-10-02: "I thought we were supposed to have decoupling from tasks running and my
    // ability to restart". A check was a daemon child, so the Restart button stayed refused while two
    // megarun checks of up to 20 minutes ran; it runs under a runner now, like a worker's CLI.
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      { id: 'check-1', num: 1, name: 'check', configDir: acct, sessionPct: 0, weekPct: 0 },
    ])
    startCliMayte()
    const run = climayteRun({
      tasks: [
        {
          prompt: 'prove it slowly',
          cwd,
          title: 'slow check',
          kind: 'code',
          // Opus: a Sonnet task finished here would feed the Sonnet estimate the sizing tests below pin.
          model: 'opus',
          effort: 'high',
          check: 'sleep 4; echo proved',
        },
      ],
    })
    groups.push(run.group)
    const id = run.workers[0]?.id as string
    const until = async (
      ok: (w: ReturnType<typeof climayteList>[number] | undefined) => boolean,
    ) => {
      const deadline = Date.now() + 25_000
      let w = climayteList({ id })[0]
      while (!ok(w) && w?.status !== 'failed' && Date.now() < deadline) {
        await climayteWait({ id }, Math.min(2_000, deadline - Date.now()))
        w = climayteList({ id })[0]
      }
      return w
    }

    expect((await until((w) => w?.status === 'checking'))?.status).toBe('checking')
    expect(climayteRunningCount()).toBe(0)
    const w = await until((w) => w?.status === 'done' && (w.verdicts?.length ?? 0) >= 1)
    expect(w?.verdicts?.map((v) => [v.verdict, v.by])).toEqual([['pass', 'check']])
  }, 30_000)

  test("a passing check with the worker's files uncommitted sends it back; a task told not to commit passes", async () => {
    // 2026-10-05: a worker's check passed with 15 of its files never committed, and the task sat
    // 'done' 2h26m while the two tasks after it waited on work that was not in git.
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      { id: 'check-1', num: 1, name: 'check', configDir: acct, sessionPct: 0, weekPct: 0 },
    ])
    startCliMayte()
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    spawnSync('git', ['init', '-q'], { cwd: repo })
    const task = (prompt: string, title: string) => ({
      prompt,
      cwd: repo,
      title,
      kind: 'code',
      model: 'opus',
      effort: 'high',
      // Opus: a Sonnet task finished here would feed the Sonnet estimate the sizing tests below pin.
      ownerWords: 'the setting under test',
      check: 'echo proved',
    })
    const run = climayteRun({
      tasks: [
        task('draft the page FAKE-EDIT:draft-a.txt', 'left unsaved'),
        task('draft the page, do not commit it FAKE-EDIT:draft-b.txt', 'draft only'),
      ],
    })
    groups.push(run.group)
    const [a, b] = run.workers.map((w) => w.id as string)
    const judged = (id: string) => (climayteList({ id })[0]?.verdicts?.length ?? 0) >= 1
    const deadline = Date.now() + 25_000
    while (!(judged(a as string) && judged(b as string)) && Date.now() < deadline)
      await climayteWait({ group: run.group }, Math.min(2_000, deadline - Date.now()))

    const first = climayteList({ id: a })[0]?.verdicts?.[0]
    expect([first?.verdict, first?.by]).toEqual(['fail', 'check'])
    expect(first?.note).toContain('not committed: draft-a.txt')
    // Right work, a small miss: a slip (1), recorded without changing the send-back.
    expect(first?.severity).toBe(1)
    expect(climayteList({ id: b })[0]?.verdicts?.map((v) => [v.verdict, v.by])).toEqual([
      ['pass', 'check'],
    ])
    climayteCancel({ id: a })
  }, 30_000)

  test('a check that cannot run records severity 0 and still fails the task as before', async () => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      { id: 'check-1', num: 1, name: 'check', configDir: acct, sessionPct: 0, weekPct: 0 },
    ])
    startCliMayte()
    const run = climayteRun({
      tasks: [
        {
          prompt: 'prove it with a missing command',
          cwd,
          title: 'broken check',
          kind: 'code',
          model: 'opus',
          effort: 'high',
          ownerWords: 'the setting under test',
          check: 'exit 127',
        },
      ],
    })
    groups.push(run.group)
    const id = run.workers[0]?.id as string
    const deadline = Date.now() + 25_000
    while (!(climayteList({ id })[0]?.verdicts?.length ?? 0) && Date.now() < deadline)
      await climayteWait({ group: run.group }, Math.min(2_000, deadline - Date.now()))
    const w = climayteList({ id })[0]
    expect(w?.status).toBe('failed')
    expect(w?.verdicts?.map((v) => [v.verdict, v.by, v.severity])).toEqual([['fail', 'check', 0]])
  }, 30_000)

  test('a check whose runner dies runs again, even past the timeout, and a stop under way is never removed', async () => {
    // Review, 2026-10-02: after an outage longer than 20 minutes a check that died with the machine was judged
    // 'timed out' (a fail sent one rung up) instead of run again; and Remove dropped a cancelled task whose check
    // was still being stopped, leaving its runner going for good.
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      { id: 'check-1', num: 1, name: 'check', configDir: acct, sessionPct: 0, weekPct: 0 },
    ])
    startCliMayte()
    const run = climayteRun({
      tasks: [
        {
          prompt: 'prove it at length',
          cwd,
          title: 'long check',
          kind: 'code',
          model: 'opus',
          effort: 'high',
          check: 'sleep 60',
        },
      ],
    })
    groups.push(run.group)
    const id = run.workers[0]?.id as string
    const deadline = Date.now() + 25_000
    while (!workers.get(id)?.checkRunner?.pid && Date.now() < deadline)
      await climayteWait({ id }, 1_000)
    const first = workers.get(id)?.checkRunner
    expect(first?.pid).toBeGreaterThan(0)
    if (!first?.pid) return
    first.launchedAt = Date.now() - 25 * 60_000 // as if the daemon was down past CHECK_TIMEOUT_MS
    killProcessTree(first.pid)
    while (workers.get(id)?.checkRunner === first && Date.now() < deadline) await Bun.sleep(250)

    const again = workers.get(id)
    expect(again?.status).toBe('checking')
    expect(again?.checkRunner?.relaunches).toBe(1)
    expect(again?.verdicts ?? []).toEqual([]) // not judged: it never gave an answer

    // Copied before the cancel: `again` is the live record, which the cancel's stop clears.
    const record = { ...(again?.checkRunner as NonNullable<typeof first>) }
    climayteCancel({ id })
    const stopping = workers.get(id)
    if (stopping) stopping.checkRunner = { ...record, pid: null } // a stop still waiting on its runner
    expect(climayteRemove([id]).skipped).toContain(id)

    // A new round while that stop is still pending gets its own check; the old one is set aside and
    // stopped on its own (background review, 2026-10-02: the new round's result was never judged).
    const pending = stopping?.checkRunner
    climayteSend(id, 'one more round')
    const next = Date.now() + 25_000
    while (workers.get(id)?.status !== 'checking' && Date.now() < next)
      await climayteWait({ id }, 1_000)
    const round = workers.get(id)
    expect(round?.status).toBe('checking')
    expect(round?.checkRunner).not.toBe(pending)
    expect(round?.staleChecks).toContain(pending as NonNullable<typeof pending>)
    climayteCancel({ id })
    if (round) round.staleChecks = undefined // the stand-in stop: nothing of it may outlive this test
  }, 60_000)
})
