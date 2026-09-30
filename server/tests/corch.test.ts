// server/tests/corch.test.ts — Corch: the pure helpers it decides with, and one real handoff.
//
// CONFIG_DIR, the instance store and TMP are already redirected to a scratch dir by tests/setup.ts
// (the bunfig preload), so corch's `<CONFIG_DIR>/corch/` state never touches a real install. The
// accounts are fakes pointing at temp config dirs, and the CLI is tests/mocks/fake-claude.ts run by
// the same bun that runs this suite.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attemptSpend,
  classifyAttempt,
  copySessionTranscript,
  corchCancel,
  corchGet,
  corchJournal,
  corchJournalLines,
  corchList,
  corchRun,
  corchSend,
  corchWait,
  freshestPct,
  livePct,
  MAX_PER_ACCOUNT,
  pickAccount,
  RECENT_FINISHED,
  recentWorkers,
  setCorchAccountsProvider,
  setCorchClaudeCommand,
  startCorch,
  wallUntil,
} from '../src/corch'
import { setProviderSettings } from '../src/provider-settings'
import { parseResetTime } from '../src/usage'

const NOTICE = "You've hit your session limit · resets 4am"
const init = { type: 'system', subtype: 'init', model: 'fake-model' }
const said = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] },
  ...extra,
})
const result = (text: string, isError: boolean) => ({
  type: 'result',
  is_error: isError,
  result: text,
  total_cost_usd: 0.02,
  num_turns: 3,
})

describe('classifyAttempt', () => {
  test('a clean result is done, with its text and turns', () => {
    const r = classifyAttempt([init, said('ok'), result('all good', false)], '')
    expect(r).toMatchObject({ outcome: 'done', result: 'all good', turns: 3 })
  })

  test('the CLI synthetic limit notice is quota', () => {
    const wall = {
      type: 'assistant',
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: NOTICE }],
      },
    }
    const r = classifyAttempt([init, wall, result(NOTICE, true)], '')
    expect(r.outcome).toBe('quota')
    expect(r.notice).toContain('session limit')
  })

  test('a signed-out CLI is auth', () => {
    expect(classifyAttempt([], 'Invalid API key · Please run /login').outcome).toBe('auth')
    // Measured live 2026-09-30: an expired CLI login ends its turn with exactly this result.
    const expired = 'Failed to authenticate: OAuth session expired and could not be refreshed'
    expect(classifyAttempt([result(expired, true)], '').outcome).toBe('auth')
  })

  test('an overloaded API is transient', () => {
    const r = classifyAttempt([init, result('API Error: 529 Overloaded', true)], '')
    expect(r.outcome).toBe('transient')
  })

  test('a CLI killed from outside is interrupted (resumed), not an error', () => {
    // Measured live 2026-09-30: a daemon restart kills every worker; its log ends mid-turn with no
    // result and its stderr is empty.
    expect(classifyAttempt([init, said('working on it')], '').outcome).toBe('interrupted')
    // A harmless warning a normal run prints on stderr does not turn the kill into an error.
    const warning = '[mcp-sdk] SEP-2352: stored OAuth credential has no issuer stamp'
    expect(classifyAttempt([init, said('working on it')], warning).outcome).toBe('interrupted')
    expect(classifyAttempt([init, result('Something broke', true)], '').outcome).toBe('error')
    // A CLI that failed before system/init, with its reason on stderr, is an error.
    expect(classifyAttempt([], 'error: unknown option --bogus').outcome).toBe('error')
  })

  test('a model that merely TALKS about a session limit is still done', () => {
    const r = classifyAttempt(
      [
        init,
        said(`The docs say "${NOTICE}" means the quota is spent.`),
        result('Explained the session limit.', false),
      ],
      '',
    )
    expect(r.outcome).toBe('done')
  })

  test('a clean result is done even when stderr says 429', () => {
    const stderr = '[mcp-sdk] token refresh for github failed: HTTP 429'
    const r = classifyAttempt([init, said('ok'), result('all good', false)], stderr)
    expect(r).toMatchObject({ outcome: 'done', result: 'all good' })
  })

  test('an organization that disabled subscription access is auth', () => {
    // Real notice, 237 occurrences, `error:"oauth_org_not_allowed"`.
    const text =
      'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access'
    const synthetic = {
      type: 'assistant',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
    }
    expect(classifyAttempt([init, synthetic, result(text, true)], '').outcome).toBe('auth')
  })

  test("a rejected rate_limit_event is quota, with the CLI's own resetsAt", () => {
    const text =
      "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue."
    const rejected = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1785225600 },
    }
    const synthetic = {
      type: 'assistant',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
      error: 'rate_limit',
    }
    const r = classifyAttempt([init, rejected, synthetic, result(text, true)], '')
    expect(r).toMatchObject({ outcome: 'quota', resetsAt: 1785225600000, window: 'weekly' })
  })

  test('a notice only on stderr is its own line, not the warning before it', () => {
    const stderr =
      "[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp\nYou've hit your weekly limit · resets Oct 3, 3am (America/Chicago)"
    const r = classifyAttempt([init], stderr)
    expect(r.outcome).toBe('quota')
    expect(r.notice).toContain('weekly limit')
    expect(r.resets).toBe('Oct 3, 3am (America/Chicago)')
  })
})

describe('wallUntil', () => {
  // 4:30pm America/Chicago on 2026-09-30 (CDT, UTC-5) is 21:30Z.
  const now = Date.parse('2026-09-30T21:30:04Z')
  const wall = (resetsAt: number | null, resets: string | null) =>
    wallUntil(now, { resetsAt, resets }, parseResetTime)

  test('a reset that has just passed is a 2-minute wall, not tomorrow', () => {
    expect(wall(null, '4:30pm (America/Chicago)')).toBe(Date.parse('2026-09-30T21:32:04Z'))
  })

  test('a known resetsAt ends the wall 60 s after it, ahead of the text', () => {
    const resetsAt = Date.parse('2026-10-01T02:00:00Z')
    expect(wall(resetsAt, '4:30pm (America/Chicago)')).toBe(Date.parse('2026-10-01T02:01:00Z'))
  })

  test('a future text reset ends 60 s after it; nothing parsed is an hour', () => {
    expect(wall(null, '9:10pm (America/Chicago)')).toBe(Date.parse('2026-10-01T02:11:00Z'))
    expect(wall(null, null)).toBe(Date.parse('2026-09-30T22:30:04Z'))
  })
})

describe('copySessionTranscript', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-corch-move-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("a moved session brings its project's memory: the newer file wins, nothing is removed", () => {
    const from = join(root, 'a')
    const to = join(root, 'b')
    const mem = (dir: string) => join(dir, 'projects', 'p', 'memory')
    mkdirSync(mem(from), { recursive: true })
    mkdirSync(mem(to), { recursive: true })
    writeFileSync(join(from, 'projects', 'p', 'S.jsonl'), '{}')
    writeFileSync(join(mem(from), 'MEMORY.md'), 'from A')
    writeFileSync(join(mem(from), 'note.md'), 'learned on A')
    writeFileSync(join(mem(to), 'MEMORY.md'), 'older on B')
    writeFileSync(join(mem(to), 'only-b.md'), 'kept')
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(mem(to), 'MEMORY.md'), old, old)

    expect(copySessionTranscript(from, to, 'S')).toBe(true)
    const read = (f: string) => readFileSync(join(mem(to), f), 'utf8')
    expect(read('MEMORY.md')).toBe('from A')
    expect(read('note.md')).toBe('learned on A')
    expect(read('only-b.md')).toBe('kept')
  })
})

describe('attemptSpend', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-corch-spend-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const turn = (iso: string, id: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: iso,
      requestId: `req_${id}`,
      message: {
        id: `msg_${id}`,
        model: 'claude-opus-5-5',
        usage: { input_tokens: 10, output_tokens: 1_000, cache_read_input_tokens: 20_000 },
      },
    })
  const write = (lines: string[]) => {
    mkdirSync(join(dir, 'projects', 'p'), { recursive: true })
    writeFileSync(join(dir, 'projects', 'p', 'S.jsonl'), lines.join('\n'))
  }

  test("an attempt is charged for its own turns only, never the session's earlier or later ones", () => {
    const start = Date.parse('2026-09-30T12:00:00Z')
    const end = Date.parse('2026-09-30T12:10:00Z')
    write([turn('2026-09-30T12:05:00Z', 'b')])
    const own = attemptSpend(dir, 'S', start, end)
    expect(own.costUsd).toBeGreaterThan(0)
    // Its tokens are the one turn's, counted once (owner, 2026-09-30: each session's tokens kept).
    expect(own.tokens).toEqual({ input: 10, output: 1_000, cacheRead: 20_000, cacheWrite: 0 })
    // The same turn (logged twice, one record per content block), a turn copied in from before the
    // attempt started, and one from a later attempt on the same account.
    write([
      turn('2026-09-30T11:00:00Z', 'a'),
      turn('2026-09-30T12:05:00Z', 'b'),
      turn('2026-09-30T12:05:00Z', 'b'),
      turn('2026-09-30T13:00:00Z', 'c'),
    ])
    const again = attemptSpend(dir, 'S', start, end)
    expect(again.costUsd).toBeCloseTo(own.costUsd, 10)
    expect(again.tokens).toEqual(own.tokens)
    expect(attemptSpend(dir, 'missing', start, end).costUsd).toBe(0)
  })
})

describe('pickAccount', () => {
  const acct = (
    id: string,
    num: number,
    sessionPct: number | null = 10,
    weekPct: number | null = 10,
  ) => ({
    id,
    num,
    name: id,
    configDir: join(tmpdir(), id),
    sessionPct,
    weekPct,
  })
  const worker = (over: Record<string, unknown> = {}) =>
    ({ accounts: null, accountId: null, attempts: [], pending: [], ...over }) as any
  const now = Date.now()

  test('skips walled and full accounts', () => {
    const accounts = [acct('walled', 1), acct('full', 2, 99), acct('ok', 3, 80)]
    const walls = { walled: { until: now + 60_000, reason: 'quota' } }
    expect(pickAccount(worker(), accounts, walls, new Map(), 2, now)?.id).toBe('ok')
    // The only account left is already at its per-account cap.
    expect(pickAccount(worker(), accounts, walls, new Map([['ok', 2]]), 2, now)).toBeNull()
  })

  test('a handoff never goes back to the account that hit its limit', () => {
    const accounts = [acct('a', 1, 0), acct('b', 2, 90)]
    const w = worker({
      accountId: 'a',
      attempts: [{ account: { id: 'a', num: 1, name: 'a' }, outcome: 'quota', notice: NOTICE }],
    })
    expect(pickAccount(w, accounts, {}, new Map(), 2, now)?.id).toBe('b')
  })

  test('the account a worker last failed on is picked again once its wall is gone', () => {
    const accounts = [acct('a', 1), acct('b', 2)]
    const w = worker({
      accounts: ['a'],
      accountId: 'a',
      attempts: [{ account: { id: 'a', num: 1, name: 'a' }, outcome: 'quota', notice: NOTICE }],
    })
    const walled = { a: { until: now + 60_000, reason: 'quota' } }
    expect(pickAccount(w, accounts, walled, new Map(), 2, now)).toBeNull()
    const lifted = { a: { until: now - 1, reason: 'quota' } }
    expect(pickAccount(w, accounts, lifted, new Map(), 2, now)?.id).toBe('a')
  })

  test('after a handoff the next session goes where there is room, not to an account near its limit', () => {
    // Measured live: handed off from #83 (58%, the only account with room), the next session was
    // put on #84 at 91%, which had to hand off again at once.
    const accounts = [acct('a83', 83, 58, 54), acct('a84', 84, 91, 7), acct('a88', 88, 91, 12)]
    const w = worker({
      accountId: 'a83',
      attempts: [
        { account: { id: 'a83', num: 83, name: 'a83' }, outcome: 'handoff', notice: null },
      ],
    })
    expect(pickAccount(w, accounts, {}, new Map(), 2, now)?.id).toBe('a83')
    // With room elsewhere, the account it left is not taken back.
    const roomy = [...accounts, acct('a90', 90, 20, 6)]
    expect(pickAccount(w, roomy, {}, new Map(), 2, now)?.id).toBe('a90')
  })

  test('the per-account cap counts only this group, never above MAX_PER_ACCOUNT in total', () => {
    const accounts = [acct('a', 1)]
    // Another group's worker on the account does not block a group started with per_account 1.
    const other = new Map([['a', 1]])
    expect(pickAccount(worker(), accounts, {}, other, 1, now, new Map())?.id).toBe('a')
    expect(pickAccount(worker(), accounts, {}, other, 1, now, new Map([['a', 1]]))).toBeNull()
    const full = new Map([['a', MAX_PER_ACCOUNT]])
    expect(pickAccount(worker(), accounts, {}, full, 4, now, new Map())).toBeNull()
  })

  test('a usage reading from a window that has already reset does not count', () => {
    const past = new Date(now - 60_000).toISOString()
    const future = new Date(now + 60_000).toISOString()
    expect(livePct({ pct: 99, resetsAt: past }, now)).toBeNull()
    expect(livePct({ pct: 99, resetsAt: future }, now)).toBe(99)
    expect(livePct({ pct: 40 }, now)).toBe(40)
  })

  test('a live reading newer than the usage snapshot wins; an older or reset one does not', () => {
    const snapshot = { pct: 40, resetsAt: new Date(now + 3_600_000).toISOString() }
    const snapshotAt = now - 60_000
    const live = (at: number, resetsAt: number) => ({ pct: 75, resetsAt, at })
    expect(freshestPct(snapshot, snapshotAt, live(now - 1_000, now + 3_600_000), now)).toBe(75)
    expect(freshestPct(snapshot, snapshotAt, live(now - 120_000, now + 3_600_000), now)).toBe(40)
    expect(freshestPct(snapshot, snapshotAt, live(now - 1_000, now - 1), now)).toBeNull()
  })

  test('spreads by the active count', () => {
    const accounts = [acct('a', 1), acct('b', 2)]
    expect(pickAccount(worker(), accounts, {}, new Map(), 2, now)?.id).toBe('a')
    expect(pickAccount(worker(), accounts, {}, new Map([['a', 1]]), 2, now)?.id).toBe('b')
  })

  test("an idle account beats one busy with another group's worker, even at lower usage (note 8)", () => {
    // Measured live: #84 at 5% ran a worker of another group; #83 (week 49%, session unknown) was
    // idle and still lost, 30 to 50. This group has nothing running anywhere.
    const accounts = [acct('a83', 83, null, 49), acct('a84', 84, 5, 0)]
    const otherGroups = new Map([['a84', 1]])
    expect(pickAccount(worker(), accounts, {}, otherGroups, 2, now, new Map())?.id).toBe('a83')
    // Near its limit, the idle account is still passed over for the busy one with room.
    const near = [acct('a83', 83, 90, 49), acct('a84', 84, 5, 0)]
    expect(pickAccount(worker(), near, {}, otherGroups, 2, now, new Map())?.id).toBe('a84')
  })
})

describe('integration: a quota wall hands the session to the next account', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-corch-'))
  const cwd = join(root, 'work')
  const walledDir = join(root, 'acct-1')
  const freeDir = join(root, 'acct-2')
  for (const d of [cwd, walledDir, freeDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(walledDir, 'fake-quota'), '')
  let group: string | null = null

  afterAll(() => {
    if (group) corchCancel({ group })
    setCorchClaudeCommand(null)
    setCorchAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('the worker ends done on the second account after one move', async () => {
    setCorchClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    // The walled account scores lower, so it is picked first and must hit the wall.
    setCorchAccountsProvider(() => [
      { id: 'fake-1', num: 1, name: 'walled', configDir: walledDir, sessionPct: 0, weekPct: 0 },
      { id: 'fake-2', num: 2, name: 'free', configDir: freeDir, sessionPct: 50, weekPct: 50 },
    ])
    startCorch()
    const run = corchRun({ tasks: [{ prompt: 'do the fake task', cwd, title: 'fake' }] })
    group = run.group
    const id = run.workers[0]?.id as string
    expect(id).toBeTruthy()

    const deadline = Date.now() + 40_000
    let w = corchList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await corchWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = corchList({ id })[0]
    }

    expect(w?.status).toBe('done')
    expect(w?.result).toBe('FAKE DONE')
    expect(w?.moves).toBe(1)
    expect(w?.attempts[0]?.outcome).toBe('quota')

    // The journal tells the move: the pick on #1 and why, its wall, the move, the pick on #2.
    const log = corchJournal({ id })
    expect(log.map((e) => e.event)).toEqual([
      'dispatched',
      'launched',
      'limit',
      'moved',
      'launched',
      'done',
    ])
    expect(log[1]).toMatchObject({ account: '#1', sessionPct: 0, weekPct: 0, active: 0 })
    expect(log[2]?.notice).toContain('session limit')
    expect(Date.parse(log[2]?.until ?? '')).toBeGreaterThan(Date.now())
    expect(log[3]).toMatchObject({ from: '#1', account: '#2', copied: true })
    expect(log[4]).toMatchObject({ account: '#2', attempt: 2, sessionPct: 50 })
    const lines = corchJournalLines({ id })
    expect(lines[1]).toMatch(
      /^\d\d:\d\d:\d\d w-\w+ 'fake' launched on #1 \(session 0%, week 0%, 0 active\)$/,
    )
    expect(lines[3]).toContain('moved from #1 to #2')

    // corch_status { id } is this detail: one object, with every attempt's event lines.
    const detail = corchGet(id)
    expect(Array.isArray(detail)).toBe(false)
    expect(detail?.events.some((l) => l.startsWith('— attempt 2 on #2 free: done'))).toBe(true)
    expect(typeof detail?.ranS).toBe('number')
  }, 45_000)
})

describe('integration: paid extra usage is never spent', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-corch-overage-'))
  const cwd = join(root, 'work')
  const overDir = join(root, 'acct-over')
  const freeDir = join(root, 'acct-free')
  for (const d of [cwd, overDir, freeDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(overDir, 'fake-overage'), '')
  const groups: string[] = []

  afterAll(() => {
    for (const group of groups) corchCancel({ group })
    setCorchClaudeCommand(null)
    setCorchAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('a turn that starts billing overage is stopped at once and the session moves on', async () => {
    setCorchClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    // The overage account scores lower, so it is picked first. Left alone, the fake would go on
    // for 6 s and finish there on overage ('FINISHED ON OVERAGE', no move).
    setCorchAccountsProvider(() => [
      { id: 'over-1', num: 1, name: 'overage', configDir: overDir, sessionPct: 0, weekPct: 0 },
      { id: 'over-2', num: 2, name: 'free', configDir: freeDir, sessionPct: 50, weekPct: 50 },
    ])
    startCorch()
    const run = corchRun({ tasks: [{ prompt: 'a long task', cwd, title: 'overage' }] })
    groups.push(run.group)
    const id = run.workers[0]?.id as string

    const deadline = Date.now() + 15_000
    let w = corchList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await corchWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = corchList({ id })[0]
    }

    expect(w?.status).toBe('done')
    expect(w?.result).toBe('FAKE DONE')
    expect(w?.moves).toBe(1)
    expect(w?.attempts[0]?.outcome).toBe('quota')
    expect(w?.attempts[0]?.notice).toContain('extra usage')
  }, 20_000)

  test('with allowExtraUsage on, the turn is not stopped and finishes on the overage account', async () => {
    setProviderSettings({ allowExtraUsage: true })
    try {
      setCorchClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
      // New account ids: the test above walled 'over-1'.
      setCorchAccountsProvider(() => [
        { id: 'allow-1', num: 1, name: 'overage', configDir: overDir, sessionPct: 0, weekPct: 0 },
        { id: 'allow-2', num: 2, name: 'free', configDir: freeDir, sessionPct: 50, weekPct: 50 },
      ])
      startCorch()
      const run = corchRun({ tasks: [{ prompt: 'a long task', cwd, title: 'overage allowed' }] })
      groups.push(run.group)
      const id = run.workers[0]?.id as string

      const deadline = Date.now() + 15_000
      let w = corchList({ id })[0]
      while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
        await corchWait({ id }, Math.min(5_000, deadline - Date.now()))
        w = corchList({ id })[0]
      }

      expect(w?.status).toBe('done')
      expect(w?.result).toBe('FINISHED ON OVERAGE')
      expect(w?.moves).toBe(0)
      expect(w?.attempts).toHaveLength(1)
      // A dispatch-to-done run is three journal lines; the last carries its turns and cost.
      const log = corchJournal({ id })
      expect(log.map((e) => e.event)).toEqual(['dispatched', 'launched', 'done'])
      expect(log[2]).toMatchObject({ account: '#1', turns: 1 })
      expect(typeof log[2]?.costUsd).toBe('number')
      expect(corchJournalLines({ id })[2]).toMatch(
        /'overage allowed' done on #1: \$\d+\.\d\d, 1 turn \(/,
      )
    } finally {
      setProviderSettings({ allowExtraUsage: false })
    }
  }, 20_000)

  test('on an account that can bill, the turn is stopped at 98%, before any request bills', async () => {
    const nearDir = join(root, 'acct-near')
    mkdirSync(nearDir, { recursive: true })
    writeFileSync(join(nearDir, 'fake-near-limit'), '')
    setCorchClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    // Left alone, the fake finishes on the near-limit account after 6 s ('FINISHED NEAR LIMIT').
    setCorchAccountsProvider(() => [
      { id: 'near-1', num: 1, name: 'near', configDir: nearDir, sessionPct: 0, weekPct: 0 },
      { id: 'near-2', num: 2, name: 'free', configDir: freeDir, sessionPct: 50, weekPct: 50 },
    ])
    startCorch()
    const run = corchRun({ tasks: [{ prompt: 'a long task', cwd, title: 'near the limit' }] })
    groups.push(run.group)
    const id = run.workers[0]?.id as string

    const deadline = Date.now() + 15_000
    let w = corchList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await corchWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = corchList({ id })[0]
    }

    expect(w?.status).toBe('done')
    expect(w?.result).toBe('FAKE DONE')
    expect(w?.moves).toBe(1)
    expect(w?.attempts[0]?.outcome).toBe('quota')
    expect(w?.attempts[0]?.notice).toContain('before it could bill')
  }, 20_000)
})

describe('integration: near its limit a worker hands off to a fresh session', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-corch-winddown-'))
  const cwd = join(root, 'work')
  const nearDir = join(root, 'acct-near')
  const freeDir = join(root, 'acct-free')
  for (const d of [cwd, nearDir, freeDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(nearDir, 'fake-winddown'), '')
  let group: string | null = null

  afterAll(() => {
    if (group) corchCancel({ group })
    setCorchClaudeCommand(null)
    setCorchAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('it writes a handoff and the task goes on from it in a new session elsewhere', async () => {
    setCorchClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    // The near-limit account scores lower, so it is picked first. Left alone it works on and
    // finishes there ('NO WIND-DOWN'); the other account has room.
    setCorchAccountsProvider(() => [
      { id: 'wind-1', num: 1, name: 'near', configDir: nearDir, sessionPct: 0, weekPct: 0 },
      { id: 'wind-2', num: 2, name: 'free', configDir: freeDir, sessionPct: 50, weekPct: 50 },
    ])
    startCorch()
    const run = corchRun({ tasks: [{ prompt: 'a long task', cwd, title: 'wind down' }] })
    group = run.group
    const id = run.workers[0]?.id as string
    const firstSession = run.workers[0]?.sessionId as string

    const deadline = Date.now() + 15_000
    let w = corchList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await corchWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = corchList({ id })[0]
    }

    expect(w?.status).toBe('done')
    expect(w?.result).toBe('FAKE DONE FROM HANDOFF')
    expect(w?.attempts.map((a) => [a.account.id, a.outcome])).toEqual([
      ['wind-1', 'handoff'],
      ['wind-2', 'done'],
    ])
    expect(w?.sessions).toEqual([firstSession])
    expect(w?.sessionId).not.toBe(firstSession)
  }, 20_000)
})

describe('corch_status scope (field notes 1, 4 and 7)', () => {
  const at = (status: string, createdAt: number, updatedAt = createdAt) =>
    ({ status, createdAt, updatedAt }) as { status: 'done'; createdAt: number; updatedAt: number }

  test('no filter: every active worker plus the most recently finished ones, newest first', () => {
    const ws = [
      at('done', 1, 100),
      at('running', 2),
      at('failed', 3, 50),
      at('done', 4, 10),
      at('queued', 5),
      at('waiting', 6),
    ]
    const kept = recentWorkers(ws, 2)
    // Finished ones by their last change (100 and 50 win over 10); active ones always.
    expect(kept.map((w) => w.createdAt)).toEqual([6, 5, 3, 2, 1])
    expect(recentWorkers(ws, undefined)).toHaveLength(6)
    expect(RECENT_FINISHED).toBe(20)
  })

  describe('the MCP tools', () => {
    const originalFetch = globalThis.fetch
    let urls: string[] = []
    let answer: unknown = []
    afterAll(() => {
      globalThis.fetch = originalFetch
    })
    const tool = async (name: string) => {
      const { TOOLS } = await import('../src/mcp')
      const t = TOOLS.find((x) => x.name === name)
      if (!t) throw new Error(`no MCP tool named ${name}`)
      globalThis.fetch = (async (input: string | URL | Request) => {
        urls.push(String(input))
        return new Response(JSON.stringify(answer), {
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch
      urls = []
      return t
    }

    test('corch_status {} asks for active plus 20 recent, brief; { id } asks for the detail', async () => {
      const t = await tool('corch_status')
      await t.run({})
      await t.run({ group: 'g-1' })
      await t.run({ active: true, limit: 5 })
      await t.run({ id: 'w-1', wait_seconds: 5 })
      const paths = urls.map((u) => new URL(u).pathname + new URL(u).search)
      expect(paths).toEqual([
        '/api/corch/workers?limit=20&brief=1',
        '/api/corch/workers?group=g-1&brief=1',
        '/api/corch/workers?active=1&limit=5&brief=1',
        '/api/corch/workers/w-1?wait=5',
      ])
    })

    test('corch_run answers the group and, per worker, only id, title, status and account', async () => {
      const t = await tool('corch_run')
      answer = {
        group: 'g-1',
        workers: [{ id: 'w-1', title: 'x', status: 'queued', account: null, prompt: 'long' }],
      }
      const r = await t.run({ tasks: [{ prompt: 'long', cwd: '.' }] })
      expect(r).toEqual({
        group: 'g-1',
        workers: [{ id: 'w-1', title: 'x', status: 'queued', account: null }],
      })
    })
  })
})

describe('integration: steering a running worker (field notes 10 and 11)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-corch-steer-'))
  const cwd = join(root, 'work')
  const slowDir = join(root, 'acct-slow')
  for (const d of [cwd, slowDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(slowDir, 'fake-slow'), '')
  const groups: string[] = []

  afterAll(() => {
    for (const group of groups) corchCancel({ group })
    setCorchClaudeCommand(null)
    setCorchAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  const start = async (title: string, account: string) => {
    setCorchClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCorchAccountsProvider(() => [
      { id: account, num: 7, name: 'slow', configDir: slowDir, sessionPct: 0, weekPct: 0 },
    ])
    startCorch()
    const run = corchRun({ tasks: [{ prompt: 'a slow task', cwd, title }] })
    groups.push(run.group)
    const id = run.workers[0]?.id as string
    const deadline = Date.now() + 10_000
    while (corchList({ id })[0]?.status !== 'running' && Date.now() < deadline)
      await corchWait({ id }, 1_000)
    await Bun.sleep(1_500) // its init line is in the log: the message reached the session
    return id
  }
  const settle = async (id: string, ms: number) => {
    const deadline = Date.now() + ms
    let w = corchList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await corchWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = corchList({ id })[0]
    }
    return w
  }

  test('a plain message is held and says so; urgent stops the work and goes first', async () => {
    const id = await start('steer', 'slow-1')
    expect(corchSend(id, 'queued one').message).toContain('Held until this worker finishes')
    const urgent = corchSend(id, 'STEER NOW', { urgent: true })
    expect(urgent).toMatchObject({ ok: true, urgent: true })
    expect(urgent.message).toContain('then the 1 message(s) queued before it')

    const w = await settle(id, 15_000)
    expect(w?.status).toBe('done')
    expect(w?.pending).toEqual([])
    expect(w?.attempts.map((a) => a.outcome)).toEqual(['cancelled', 'done', 'done'])
    expect(w?.attempts[0]?.notice).toContain('urgent message')
    const events = corchJournal({ id }).map((e) => e.event)
    expect(events.filter((e) => e === 'follow-up-delivered')).toHaveLength(2)
    expect(corchJournal({ id }).find((e) => e.urgent)?.event).toBe('follow-up-queued')
  }, 25_000)

  test('a cancel keeps queued messages and delivers them when the worker is continued', async () => {
    const id = await start('cancel keeps', 'slow-2')
    corchSend(id, 'first')
    corchSend(id, 'second')
    const r = corchCancel({ id })
    expect(r).toEqual({ cancelled: [id], keptMessages: { [id]: 2 } })
    expect(corchList({ id })[0]?.pending).toEqual(['first', 'second'])

    corchSend(id, 'third')
    const w = await settle(id, 15_000)
    expect(w?.status).toBe('done')
    expect(w?.pending).toEqual([])
    expect(corchJournal({ id }).filter((e) => e.event === 'follow-up-delivered')).toHaveLength(3)
  }, 25_000)
})
