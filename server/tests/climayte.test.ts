// server/tests/climayte.test.ts — CliMayte: the pure helpers it decides with, and one real handoff.
//
// CONFIG_DIR, the instance store and TMP are already redirected to a scratch dir by tests/setup.ts
// (the bunfig preload), so climayte's `<CONFIG_DIR>/corch/` state never touches a real install. The
// accounts are fakes pointing at temp config dirs, and the CLI is tests/mocks/fake-claude.ts run by
// the same bun that runs this suite.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addResults,
  atCeiling,
  attemptSpend,
  CliMayteSplitNeeded,
  classifyAttempt,
  climayteCancel,
  climayteCapacity,
  climayteDeliverNow,
  climayteGet,
  climayteJournal,
  climayteJournalLines,
  climayteList,
  climayteLiveReadings,
  climayteRemove,
  climayteReports,
  climayteRun,
  climayteRunningCount,
  climayteScorecard,
  climayteSend,
  climayteSetPriority,
  climayteTotals,
  climayteVerdict,
  climayteWait,
  copySessionTranscript,
  dueOrder,
  freshestPct,
  joinResults,
  livePct,
  MAX_PER_ACCOUNT,
  MAX_RESULTS,
  notConverging,
  pickAccount,
  RECENT_FINISHED,
  RESULT_SEPARATOR,
  recentWorkers,
  SENT_NOW_PREFIX,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  setCliMayteOwnerDir,
  startCliMayte,
  sweepWorkerFiles,
  VERDICT_NOTE_MAX,
  wallUntil,
  windDownAt,
} from '../src/climayte'
import {
  chargeAttempt,
  HOOKS,
  load,
  setSpendKit,
  settleSpends,
  spentOf,
  workers,
} from '../src/climayte-core'
import { attemptCause, type CliMayteWorker } from '../src/climayte-lib'
import { forgetOwnerSync, ownerMcpServers, syncOwnerClaude } from '../src/climayte-owner-sync'
import { waitsForHome } from '../src/climayte-placement'
import { clearRemote, setRemote } from '../src/climayte-remote'
import { isPidAlive, killProcessTree } from '../src/core/process'
import { KitStore } from '../src/kit/store'
import { setProviderSettings } from '../src/provider-settings'
import { parseResetTime } from '../src/usage'
import { harnessKit } from './mocks/climayte-kit'

setSpendKit(harnessKit)

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

  test("a Stop hook's forced turn after the report keeps the report (field note 13)", () => {
    const hook = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Stop hook feedback:\n[gate]: prove the deploy' }],
      },
    }
    const r = classifyAttempt(
      [init, said('THE REPORT'), hook, said('checking'), said('PROOF'), result('PROOF', false)],
      '',
    )
    expect(r.outcome).toBe('done')
    expect(r.turnTexts).toEqual(['THE REPORT', 'PROOF'])
    const all = addResults(['an earlier turn'], r.turnTexts)
    expect(joinResults(all)).toBe(['an earlier turn', 'THE REPORT', 'PROOF'].join(RESULT_SEPARATOR))
    expect(
      addResults(
        [],
        Array.from({ length: MAX_RESULTS + 3 }, (_, i) => `t${i}`),
      ),
    ).toHaveLength(MAX_RESULTS)
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
  // 4:30pm America/Chicago on 2024-10-02 (CDT, UTC-5) is 21:30Z. A fixed day far from today: the
  // clock is handed in, so only the gaps between these times matter.
  const now = Date.parse('2024-10-02T21:30:04Z')
  const wall = (resetsAt: number | null, resets: string | null) =>
    wallUntil(now, { resetsAt, resets }, parseResetTime)

  test('a reset that has just passed is a 2-minute wall, not tomorrow', () => {
    expect(wall(null, '4:30pm (America/Chicago)')).toBe(Date.parse('2024-10-02T21:32:04Z'))
  })

  test('a known resetsAt ends the wall 60 s after it, ahead of the text', () => {
    const resetsAt = Date.parse('2024-10-03T02:00:00Z')
    expect(wall(resetsAt, '4:30pm (America/Chicago)')).toBe(Date.parse('2024-10-03T02:01:00Z'))
  })

  test('a future text reset ends 60 s after it; nothing parsed is an hour', () => {
    expect(wall(null, '9:10pm (America/Chicago)')).toBe(Date.parse('2024-10-03T02:11:00Z'))
    expect(wall(null, null)).toBe(Date.parse('2024-10-02T22:30:04Z'))
  })
})

describe('copySessionTranscript', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-move-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('a moved session lands on the new account with its mtime, so --resume finds it there', () => {
    const from = join(root, 'a')
    const to = join(root, 'b')
    mkdirSync(join(from, 'projects', 'p'), { recursive: true })
    writeFileSync(join(from, 'projects', 'p', 'S.jsonl'), '{"turn":1}')
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(from, 'projects', 'p', 'S.jsonl'), old, old)

    expect(copySessionTranscript(from, to, 'S')).toBe(true)
    const moved = join(to, 'projects', 'p', 'S.jsonl')
    expect(readFileSync(moved, 'utf8')).toBe('{"turn":1}')
    expect(Math.round(statSync(moved).mtimeMs / 1000)).toBe(Math.round(old.getTime() / 1000))
    expect(copySessionTranscript(from, to, 'missing')).toBe(false)
  })
})

describe('attemptSpend', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-climayte-spend-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  // Recent, so the kit still holds these calls raw (a session read over part of a span older than its
  // raw window comes from the hourly rollup, which has no session to filter on).
  const start = Math.floor((Date.now() - 3 * 3_600_000) / 60_000) * 60_000
  const end = start + 10 * 60_000
  const iso = (min: number) => new Date(start + min * 60_000).toISOString()
  const file = join(dir, 'projects', 'p', 'S.jsonl')
  const turn = (iso: string, id: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: iso,
      requestId: `req_${id}`,
      message: {
        id: `msg_${id}`,
        model: 'claude-opus-5-5',
        usage: { input_tokens: 10, output_tokens: 1_000, cache_creation_input_tokens: 300 },
      },
    })
  const write = (lines: string[]) => {
    mkdirSync(join(dir, 'projects', 'p'), { recursive: true })
    writeFileSync(file, lines.join('\n'))
  }
  // One kit call: 10 in, 1000 out, 20000 read, $0.5.
  const call = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
    id,
    ts: Date.parse(at),
    source: 'climayte',
    model: 'claude-opus-5-5',
    instance: 'cli:a',
    session: 'S',
    input: 10,
    output: 1_000,
    cache_read: 20_000,
    list_usd: 0.5,
    ...extra,
  })

  test("an attempt is charged for the kit's calls on its session and instance in its window only", () => {
    const store = new KitStore(':memory:')
    store.upsertEvents([
      call('a', iso(-60)), // copied in from before the attempt started
      call('b', iso(5)),
      call('s', iso(6), { agent: 'subagent' }), // a subagent: the parent's session
      call('c', iso(60)), // a later attempt on the same account
      call('o', iso(5.5), { instance: 'cli:b' }), // a copy in another account's dir
      call('x', iso(5.7), { session: 'T' }), // another session
    ])
    write([turn(iso(5), 'b')])
    const own = attemptSpend(dir, 'cli:a', 'S', start, end, store)
    expect(own.tokens).toEqual({ input: 20, output: 2_000, cacheRead: 40_000, cacheWrite: 0 })
    expect(own.turns).toBe(2)
    expect(own.costUsd).toBeCloseTo(1, 10)
    // The first request is the one thing the kit cannot give: it comes from the transcript.
    expect(own.first).toEqual({ input: 10, output: 1_000, cacheRead: 0, cacheWrite: 300 })
    expect(attemptSpend(dir, 'cli:a', 'missing', start, end, store)).toMatchObject({
      found: false,
      costUsd: 0,
    })
  })

  test("the kit's sweep lag is seen: an attempt is settled only once the kit has read its files", () => {
    const store = new KitStore(':memory:')
    write([turn(iso(5), 'b')])
    const size = statSync(file).size
    const settled = () => attemptSpend(dir, 'cli:a', 'S', start, end, store).settled
    expect(settled()).toBe(false) // never swept
    store.setCursor({ path: file, size: size - 10, mtime: start, offset: size - 10, version: 3 })
    expect(settled()).toBe(false) // swept up to before the last line, before the attempt ended
    store.setCursor({ path: file, size: size - 10, mtime: end, offset: size - 10, version: 3 })
    expect(settled()).toBe(true) // swept after it ended, though the file has grown since
    store.setCursor({ path: file, size, mtime: start, offset: size, version: 3 })
    expect(settled()).toBe(true) // swept to the end of the file
  })

  test('an attempt charged short is made right once the kit catches up, in the task too', () => {
    const store = new KitStore(':memory:')
    write([turn(iso(5), 'b'), turn(iso(9.5), 'last')])
    store.upsertEvents([call('b', iso(5))]) // the sweep is a call behind
    const w = {
      id: 'w-settle',
      costUsd: 0,
      tokens: undefined,
      sessionId: 'S',
      attempts: [
        {
          account: { id: 'a', configDir: dir },
          startedAt: start,
          endedAt: end,
          outcome: 'done',
          sessionId: 'S',
        },
      ],
    } as any
    const at = w.attempts[0]
    workers.set(w.id, w)
    setSpendKit({ store })
    try {
      chargeAttempt(w, at, spentOf(w, at))
      expect(at.spendOpen).toBeCloseTo(0.5, 10) // charged short, and says so
      expect(settleSpends(end + 1_000)).toBe(false) // the kit is still behind: wait
      expect(w.costUsd).toBeCloseTo(0.5, 10)
      // The sweep reaches the end of the file.
      store.upsertEvents([call('last', iso(9.5))])
      store.setCursor({ path: file, size: statSync(file).size, mtime: end, offset: 0, version: 3 })
      expect(settleSpends(end + 61_000)).toBe(true)
      expect(at.spendOpen).toBeUndefined()
      expect(at.tokens).toEqual({ input: 20, output: 2_000, cacheRead: 40_000, cacheWrite: 0 })
      expect(at.spend).toMatchObject({ costUsd: 1, turns: 2 })
      // The task holds exactly the attempt's figures: the late part added, the early part not twice.
      expect(w.costUsd).toBeCloseTo(1, 10)
      expect(w.tokens).toEqual(at.tokens)
      expect(settleSpends(end + 80_000)).toBe(false)
    } finally {
      setSpendKit(harnessKit)
      workers.delete(w.id)
    }
  })

  test('a kit stuck in a long sweep is waited for, queried once a minute, and the spend ends exact', () => {
    const store = new KitStore(':memory:')
    write([turn(iso(5), 'b'), turn(iso(9.5), 'last')])
    store.upsertEvents([call('b', iso(5))])
    const w = {
      id: 'w-longsweep',
      costUsd: 0,
      tokens: undefined,
      sessionId: 'S',
      attempts: [
        {
          account: { id: 'a', configDir: dir },
          startedAt: start,
          endedAt: end,
          outcome: 'done',
          sessionId: 'S',
        },
      ],
    } as any
    const at = w.attempts[0]
    workers.set(w.id, w)
    let queries = 0
    setSpendKit({ store, refresh: () => void queries++ })
    try {
      chargeAttempt(w, at, spentOf(w, at))
      queries = 0
      // 15 minutes of 5 s ticks with the kit behind: nothing settles, no give-up.
      for (let t = 5_000; t <= 15 * 60_000; t += 5_000) {
        expect(settleSpends(end + t)).toBe(false)
      }
      expect(queries).toBeLessThanOrEqual(15)
      expect(at.spendOpen).toBeDefined()
      expect(at.spendCapped).toBeUndefined()
      // The sweep finishes.
      store.upsertEvents([call('last', iso(9.5))])
      store.setCursor({ path: file, size: statSync(file).size, mtime: end, offset: 0, version: 3 })
      expect(settleSpends(end + 15 * 60_000 + 65_000)).toBe(true)
      expect(at.spend).toMatchObject({ costUsd: 1, turns: 2 })
      expect(w.costUsd).toBeCloseTo(1, 10)
      expect(w.tokens).toEqual(at.tokens)
    } finally {
      setSpendKit(harnessKit)
      workers.delete(w.id)
    }
  })
})

describe('climayteCapacity', () => {
  // check_my_usage and list_usage quote this to every agent as room to hand work to: an account
  // someone is using, or one past the wind-down line, is not room.
  afterAll(() => setCliMayteAccountsProvider(null))

  test('counts only accounts free for new work', () => {
    const dir = join(tmpdir(), 'climayte-capacity')
    setCliMayteAccountsProvider(() => [
      { id: 'cap-free', num: 1, name: 'free', configDir: dir, sessionPct: 10, weekPct: 10 },
      {
        id: 'cap-typing',
        num: 2,
        name: 'typing',
        configDir: dir,
        sessionPct: 0,
        weekPct: 0,
        handsOnAgoMs: 60_000,
      },
      {
        id: 'cap-other',
        num: 3,
        name: 'other',
        configDir: dir,
        sessionPct: 0,
        weekPct: 0,
        otherSessions: 2,
      },
      { id: 'cap-near', num: 4, name: 'near', configDir: dir, sessionPct: 95, weekPct: 10 },
    ])
    const cap = climayteCapacity()
    expect(cap.accounts).toBe(4)
    expect(cap.idle).toBe(1)
  })
})

describe('climayteRun refuses what can never run', () => {
  // An unknown account made a task that waited forever (fuzz, 2026-10-02).
  afterAll(() => setCliMayteAccountsProvider(null))

  test('an account that is not a CLI instance', () => {
    setCliMayteAccountsProvider(() => [
      { id: 'run-known', num: 1, name: 'known', configDir: tmpdir(), sessionPct: 0, weekPct: 0 },
    ])
    expect(() =>
      climayteRun({ tasks: [{ prompt: 'x', cwd: tmpdir() }], accounts: ['no-such-account'] }),
    ).toThrow(/not a CLI instance/)
  })
})

describe('notConverging', () => {
  // A task that keeps moving, handing off or overspending stops and asks instead of spending on:
  // the worst on record ran 12 attempts and 6 moves for $18.77 (stress review, 2026-10-02).
  const at = (
    id: string,
    outcome: string,
    tokens?: Record<string, number>,
    extra: Record<string, unknown> = {},
  ) => ({ account: { id, num: 1, name: id }, outcome, tokens, ...extra }) as any
  // A handoff asked for because its account reached the usage stop line (not conversation size).
  const usage = { windDown: { at: 0, pct: 86, path: 'h.md' } }
  const w = (attempts: unknown[], expected = 10) =>
    ({ attempts, model: 'claude-opus-5-5', size: { expected } }) as any

  test.each([
    ['a few limits on one account', [at('a', 'quota'), at('a', 'quota'), at('a', 'running')], null],
    [
      'four moves',
      [
        at('a', 'transient'),
        at('b', 'transient'),
        at('a', 'transient'),
        at('b', 'transient'),
        at('a', 'transient'),
      ],
      /4 moves/,
    ],
    // Owner, 2026-10-03: a worker at a five-hour or weekly limit is moved and resumed. Those moves,
    // and the handoffs the usage stop line asks for, are the rule working, not a task going round.
    [
      'limit moves are planned',
      [at('a', 'quota'), at('b', 'quota'), at('c', 'quota'), at('d', 'quota'), at('e', 'quota')],
      null,
    ],
    [
      'usage wind-down handoffs are planned',
      [
        at('a', 'handoff', undefined, usage),
        at('b', 'handoff', undefined, usage),
        at('c', 'handoff', undefined, usage),
      ],
      null,
    ],
    ['three handoffs', [at('a', 'handoff'), at('a', 'handoff'), at('a', 'handoff')], /3 handoffs/],
    [
      'only the turn since the last finished one counts',
      [at('a', 'quota'), at('b', 'quota'), at('a', 'quota'), at('b', 'done'), at('a', 'quota')],
      null,
    ],
    [
      'sign-in refusals cost nothing and do not count',
      Array.from({ length: 9 }, (_, i) => at(`s${i}`, 'auth')),
      null,
    ],
    [
      'spending far past its estimate',
      [at('a', 'quota', { input: 0, output: 50_000_000, cacheRead: 0, cacheWrite: 0 })],
      /of a Pro window spent/,
    ],
  ] as const)('%s', (_name, attempts, expected) => {
    const why = notConverging(w([...attempts]))
    if (expected === null) expect(why).toBeNull()
    else expect(why).toMatch(expected)
  })

  // Owner, 2026-10-04: his chat (w-da8a8b1c) was stopped at 96% of a window, 3 times its estimate.
  test('a chat worker over the threshold keeps running; an ordinary one is stopped', () => {
    const over = [at('a', 'quota', { input: 0, output: 50_000_000, cacheRead: 0, cacheWrite: 0 })]
    expect(notConverging({ ...w([...over]), chat: true })).toBeNull()
    expect(notConverging(w([...over]))).toMatch(/of a Pro window spent/)
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

  test('new work goes around an account someone else is using', () => {
    const accounts = [
      { ...acct('typing', 1, 0), handsOnAgoMs: 120_000 },
      { ...acct('chatting', 2, 0), otherSessions: 1 },
      acct('free', 3, 60),
    ]
    expect(pickAccount(worker(), accounts, {}, new Map(), 2, now)?.id).toBe('free')
    // A task that names the account is a person's word; a session living there carries on.
    expect(pickAccount(worker({ accounts: ['typing'] }), accounts, {}, new Map(), 2, now)?.id).toBe(
      'typing',
    )
    expect(
      pickAccount(worker({ accountId: 'chatting' }), accounts, {}, new Map(), 2, now)?.id,
    ).toBe('chatting')
    // Nobody free: it waits rather than take someone's account.
    expect(pickAccount(worker(), accounts.slice(0, 2), {}, new Map(), 2, now)).toBeNull()
  })

  test('a handoff never goes back to the account that hit its limit', () => {
    const accounts = [acct('a', 1, 0), acct('b', 2, 70)]
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

  test('no new work goes to an account past the wind-down line; the session already there stays', () => {
    // Run 1, 19:32-19:36: the one account below the line (#98, 52%) was at its worker cap, so each
    // continuation went to the next best, at 89-97%, and was told to hand off again within three
    // calls: twenty hops, about $0.75 each. It waits for a free slot below the line instead.
    const crowded = [acct('a84', 84, 87, 7), acct('a88', 88, 93, 12), acct('a98', 98, 52, 64)]
    const capped = new Map([['a98', 2]])
    const handedOff = worker({
      accountId: 'a95',
      attempts: [
        { account: { id: 'a95', num: 95, name: 'a95' }, outcome: 'handoff', notice: null },
      ],
    })
    expect(pickAccount(handedOff, crowded, {}, capped, 2, now)).toBeNull()
    expect(pickAccount(worker(), crowded, {}, capped, 2, now)).toBeNull()
    const moved = worker({
      accountId: 'a95',
      attempts: [
        { account: { id: 'a95', num: 95, name: 'a95' }, outcome: 'quota', notice: NOTICE },
      ],
    })
    expect(pickAccount(moved, crowded, {}, capped, 2, now)).toBeNull()
    const home = worker({
      accountId: 'a84',
      attempts: [
        { account: { id: 'a84', num: 84, name: 'a84' }, outcome: 'interrupted', notice: null },
      ],
    })
    expect(pickAccount(home, crowded, {}, capped, 2, now)?.id).toBe('a84')
    // Not at the 90% ceiling, where a session going on is stopped on its first request (2026-10-03:
    // a manager's wake went home to #129 at 92%).
    const atCeiling = [acct('a84', 84, 92, 7), ...crowded.slice(1)]
    expect(pickAccount(home, atCeiling, {}, capped, 2, now)).toBeNull()
  })

  test('with a placement, a task goes where it can finish, counting the work running there', () => {
    // Run 1: an idle account at 75% beat one at 10% running one worker (a flat +100 a worker), and a
    // task that costs a quarter of a Pro window ran out of room there and moved.
    const accounts = [acct('busy', 1, 10, 10), acct('idle', 2, 75, 10)]
    const active = new Map([['busy', 1]])
    expect(pickAccount(worker(), accounts, {}, active, 4, now)?.id).toBe('idle')
    const running = new Map([['busy', [{ expected: 25, startPct: 10 }]]])
    // busy: 10 + 25 still owed + 25 = 60 fits; idle: 75 + 25 = 100 does not.
    const placed = pickAccount(worker(), accounts, {}, active, 4, now, active, false, {
      expected: 25,
      running,
    })
    expect(placed?.id).toBe('busy')
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

  test('an account with no reading in its window takes one worker until that worker reads it', () => {
    // 2026-10-01 09:31: #88's last reading was four hours old, so it counted as half full with room,
    // and one tick sent it four tasks; all four failed sign-in together.
    const accounts = [acct('a88', 88, null, null), acct('a94', 94, 60, 20)]
    const placement = (running: Array<[string, number]>) => ({
      expected: 5,
      running: new Map(running.map(([id]) => [id, [{ expected: 5, startPct: null }]])),
    })
    const pick = (accts: typeof accounts, active: Array<[string, number]>) =>
      pickAccount(
        worker(),
        accts,
        {},
        new Map(active),
        4,
        now,
        new Map(active),
        false,
        placement(active),
      )
    expect(pick(accounts, [])?.id).toBe('a88')
    expect(pick(accounts, [['a88', 1]])?.id).toBe('a94')
    // Once a reading is in, it takes work like any other account.
    expect(pick([acct('a88', 88, 5, 5), acct('a94', 94, 60, 20)], [['a88', 1]])?.id).toBe('a88')
    // A reading past READING_STALE_MS counts as none (2026-10-02: #118 read 82% at 07:59 and 95% at
    // 08:29, used outside CliMayte in between); a fresh one is trusted.
    const readAt = (minutesAgo: number) => [
      { ...acct('a88', 88, 5, 5), readAt: now - minutesAgo * 60_000 },
      acct('a94', 94, 60, 20),
    ]
    expect(pick(readAt(11), [])?.id).toBe('a88')
    expect(pick(readAt(11), [['a88', 1]])?.id).toBe('a94')
    expect(pick(readAt(2), [['a88', 1]])?.id).toBe('a88')
    // While its reading is being refreshed it keeps its rank: the start waits for the reading, a few
    // seconds (readingPending, climayte-placement.test.ts), rather than pass it over.
    const refreshing = [{ ...acct('a88', 88, 5, 5), refreshing: true }, acct('a94', 94, 60, 20)]
    expect(pick(refreshing, [])?.id).toBe('a88')
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
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-'))
  const cwd = join(root, 'work')
  const walledDir = join(root, 'acct-1')
  const freeDir = join(root, 'acct-2')
  for (const d of [cwd, walledDir, freeDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(walledDir, 'fake-quota'), '')
  const ownerDir = join(root, 'owner')
  mkdirSync(join(ownerDir, 'skills', 'tidy'), { recursive: true })
  writeFileSync(join(ownerDir, 'CLAUDE.md'), 'owner rules')
  let group: string | null = null

  afterAll(() => {
    if (group) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    setCliMayteOwnerDir(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('the worker ends done on the second account after one move', async () => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteOwnerDir(ownerDir)
    // The walled account scores lower, so it is picked first and must hit the wall.
    setCliMayteAccountsProvider(() => [
      { id: 'fake-1', num: 1, name: 'walled', configDir: walledDir, sessionPct: 0, weekPct: 0 },
      { id: 'fake-2', num: 2, name: 'free', configDir: freeDir, sessionPct: 50, weekPct: 50 },
    ])
    startCliMayte()
    // One known setting: an auto pick depends on how many auto workers the store already holds
    // (every 4th explores Haiku), and in the serial suite that is every earlier file's workers.
    const run = climayteRun({
      tasks: [
        {
          prompt: 'do the fake task',
          cwd,
          title: 'fake',
          model: 'sonnet',
          effort: 'medium',
          ownerWords: 'the journal line below names one known setting',
        },
      ],
    })
    group = run.group
    const id = run.workers[0]?.id as string
    expect(id).toBeTruthy()

    const deadline = Date.now() + 40_000
    let w = climayteList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = climayteList({ id })[0]
    }

    expect(w?.status).toBe('done')
    expect(w?.result).toBe('FAKE DONE')
    expect(w?.moves).toBe(1)
    expect(w?.attempts[0]?.outcome).toBe('quota')

    // The journal tells the move: the pick on #1 and why, its wall, the move, the pick on #2.
    const log = climayteJournal({ id })
    expect(log.map((e) => e.event)).toEqual([
      'dispatched',
      'launched',
      'limit',
      'moved',
      'launched',
      'turn-end',
      'done',
    ])
    expect(log[5]).toMatchObject({ account: '#2', said: 'FAKE DONE' })
    expect(log[1]).toMatchObject({ account: '#1', sessionPct: 0, weekPct: 0, active: 0 })
    expect(log[2]?.notice).toContain('session limit')
    expect(Date.parse(log[2]?.until ?? '')).toBeGreaterThan(Date.now())
    expect(log[3]).toMatchObject({ from: '#1', account: '#2', copied: true })
    expect(log[4]).toMatchObject({ account: '#2', attempt: 2, sessionPct: 50 })
    // The title only on the worker's first line of the answer; its later lines carry the id alone.
    const lines = climayteJournalLines({ id })
    expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d w-\w+ 'fake' /)
    expect(lines[1]).toMatch(
      /^\d\d:\d\d:\d\d w-\w+ launched on #1 \(session 0%, week 0%, 0 active\) with claude-sonnet-5-5, effort medium$/,
    )
    expect(lines[3]).toContain('moved from #1 to #2')

    // climayte_status { id } is this detail: one object, with every attempt's event lines.
    const detail = climayteGet(id)
    expect(Array.isArray(detail)).toBe(false)
    expect(detail?.events.some((l) => l.startsWith('— attempt 2 on #2 free: done'))).toBe(true)
    expect(typeof detail?.ranS).toBe('number')

    // Each account it launched on got the owner's CLAUDE.md and skills first (field note 5).
    for (const d of [walledDir, freeDir]) {
      expect(readFileSync(join(d, 'CLAUDE.md'), 'utf8')).toBe('owner rules')
      expect(lstatSync(join(d, 'skills', 'tidy')).isSymbolicLink()).toBe(true)
    }
  }, 45_000)
})

describe('integration: a move copies from the account that RAN the session (field note 30)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-ran-'))
  const cwd = join(root, 'work')
  const ranDir = join(root, 'acct-ran')
  const refusedDir = join(root, 'acct-refused')
  const nextDir = join(root, 'acct-next')
  for (const d of [cwd, ranDir, refusedDir, nextDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(ranDir, 'fake-quota'), '')
  writeFileSync(join(refusedDir, 'fake-org-disabled'), '')
  let group: string | null = null

  afterAll(() => {
    if (group) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('it ran on A, a login was refused on B, and the move to C copies from A', async () => {
    // Run 1, 23:19: five sessions ran on #83/#95/#88/#98, were refused on #91 (organization has
    // Claude Code off, its folder gone by the next move), and the move to #84 looked for the
    // transcript on #91 only, so all five failed "not found" with their transcripts intact.
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      { id: 'ran-a', num: 31, name: 'ran', configDir: ranDir, sessionPct: 0, weekPct: 0 },
      {
        id: 'tried-b',
        num: 32,
        name: 'refused',
        configDir: refusedDir,
        sessionPct: 10,
        weekPct: 10,
      },
      { id: 'next-c', num: 33, name: 'next', configDir: nextDir, sessionPct: 50, weekPct: 50 },
    ])
    startCliMayte()
    const run = climayteRun({ tasks: [{ prompt: 'a task that moves', cwd, title: 'ran' }] })
    group = run.group
    const id = run.workers[0]?.id as string

    const deadline = Date.now() + 30_000
    let w = climayteList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = climayteList({ id })[0]
    }

    expect(w?.error ?? null).toBeNull()
    expect(w?.status).toBe('done')
    expect(w?.attempts.map((a) => [a.account.id, a.outcome])).toEqual([
      ['ran-a', 'quota'],
      ['tried-b', 'auth'],
      ['next-c', 'done'],
    ])
    // The same session went on on C from A's copy: C's transcript starts with A's turn.
    const file = join(nextDir, 'projects', 'fake-proj', `${w?.sessionId}.jsonl`)
    expect(readFileSync(file, 'utf8')).toContain('a task that moves')
    const moves = climayteJournal({ id }).filter((e) => e.event === 'moved')
    expect(moves.at(-1)).toMatchObject({ from: '#31', account: '#33', copied: true })
  }, 35_000)
})

describe("integration: a worker has the owner's MCP servers, whatever its account lists", () => {
  // 2026-10-02: a worker asked to use connections_execute had no such tool. Worker settings denied
  // connections-local, and one of 33 accounts listed no MCP server at all: an account's
  // .claude.json is seeded once, when the account is made.
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-mcp-'))
  const cwd = join(root, 'work')
  const ownerDir = join(root, 'home', '.claude')
  const seededDir = join(root, 'acct-seeded')
  const bareDir = join(root, 'acct-bare')
  for (const d of [cwd, ownerDir, seededDir, bareDir]) mkdirSync(d, { recursive: true })
  const local = (port: number, path = '/mcp') => ({
    type: 'http',
    url: `http://127.0.0.1:${port}${path}`,
  })
  // Shaped like the owner's real entries: the two local servers sign in through a headersHelper
  // command run at connect time; a static Authorization header is a credential.
  const seeded = {
    agenthydra: local(7787, '/api/mcp'),
    magnific: { type: 'http', url: 'https://mcp.magnific.com' },
    hswarm: { ...local(7793), headersHelper: 'python -m hswarm connect' },
    'connections-local': { ...local(7791), headersHelper: 'node loader.mjs --connect' },
  }
  const keyed = { ...local(7792), headers: { Authorization: 'Bearer not-a-real-token' } }
  writeFileSync(
    join(root, 'home', '.claude.json'),
    JSON.stringify({ mcpServers: { ...seeded, keyed } }),
  )
  // The account itself lists AgentHydra's endpoint under another name (a second PC's daemon): a
  // name deny cannot reach it, the settings' URL deny does.
  writeFileSync(
    join(seededDir, '.claude.json'),
    JSON.stringify({ mcpServers: { ...seeded, 'hydra-elsewhere': local(7787, '/api/mcp') } }),
  )
  writeFileSync(join(bareDir, '.claude.json'), JSON.stringify({ numStartups: 3 }))
  const groups: string[] = []

  afterAll(() => {
    for (const group of groups) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    setCliMayteOwnerDir(null)
    rmSync(root, { recursive: true, force: true })
  })

  /** Runs one task on the account to its end; its status and the MCP servers its CLI started with. */
  const runOn = async (
    id: string,
    configDir: string,
    task: { prompt: string; sealed?: unknown },
  ) => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteOwnerDir(ownerDir)
    setCliMayteAccountsProvider(() => [
      { id, num: 1, name: id, configDir, sessionPct: 0, weekPct: 0 },
    ])
    startCliMayte()
    const run = climayteRun({
      tasks: [{ cwd, title: id, ...task } as { prompt: string; cwd: string; title: string }],
    })
    groups.push(run.group)
    const wid = run.workers[0]?.id as string
    const deadline = Date.now() + 25_000
    let w = climayteList({ id: wid })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await climayteWait({ id: wid }, Math.min(5_000, deadline - Date.now()))
      w = climayteList({ id: wid })[0]
    }
    const init = readFileSync(workers.get(wid)?.attempts[0]?.log as string, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { subtype?: string; mcp_servers?: { name: string }[] })
      .find((e) => e.subtype === 'init')
    return { wid, status: w?.status, servers: init?.mcp_servers?.map((s) => s.name) }
  }

  // What the --mcp-config file may carry is the filter's test below; fake-claude drops what the
  // settings deny (by name or URL) itself, as the real CLI does, so this one cannot tell whether
  // the file left them out.
  test('connections-local and hswarm on either account, and its files go when it is done', async () => {
    for (const [id, configDir] of [
      ['seeded', seededDir],
      ['bare', bareDir],
    ] as const) {
      const { wid, status, servers } = await runOn(id, configDir, {
        prompt: 'call connections_execute',
      })
      expect(status).toBe('done')
      expect([id, servers]).toEqual([id, ['climayte-worker', 'connections-local', 'hswarm']])
      // 440 settings files and 18 MCP files were left behind on the owner's machine (2026-10-02).
      expect([
        existsSync(join(HOOKS, `${wid}.json`)),
        existsSync(join(HOOKS, `${wid}.mcp.json`)),
      ]).toEqual([false, false])
    }
  }, 60_000)

  // Four sealed test chats of the Free tools named AgentHydra's server and got no tool at all: the
  // ordinary worker's deny list reached them (2026-10-06).
  test("a sealed task has exactly its config's servers, AgentHydra's own when it names it", async () => {
    const prompt = join(root, 'sealed.md')
    const mcp = join(root, 'sealed-mcp.json')
    writeFileSync(prompt, 'You are a test chat.')
    writeFileSync(mcp, JSON.stringify({ mcpServers: { agenthydra: local(7787, '/api/mcp') } }))
    const sealed = {
      systemPromptFile: prompt,
      mcpConfig: mcp,
      allowedTools: ['mcp__agenthydra__*'],
    }
    const { status, servers } = await runOn('seeded', seededDir, { prompt: 'list them', sealed })
    expect(status).toBe('done')
    expect(servers).toEqual(['agenthydra'])
  }, 30_000)
})

describe("the owner's MCP servers a worker is given (ownerMcpServers)", () => {
  // Every value here is fake. The refused entries carry SECRET, so a test can say that no part of
  // one reached the file's servers or the log.
  const SECRET = 'fake0secret0value0for0tests0only'
  const root = mkdtempSync(join(tmpdir(), 'ah-owner-mcp-'))
  const ownerDir = join(root, '.claude')
  mkdirSync(ownerDir)
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const deny = { names: ['agenthydra', 'magnific'], paths: ['/api/mcp'] }
  const http = (url: string, more: Record<string, unknown> = {}) => ({ type: 'http', url, ...more })

  /** The servers carried from an owner config of `text`, and what was logged meanwhile. */
  function carry(text: string): { names: string[]; file: string; logged: string } {
    writeFileSync(join(root, '.claude.json'), text)
    forgetOwnerSync()
    const logged: string[] = []
    const was = console.error
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '))
    try {
      const out = ownerMcpServers(ownerDir, deny)
      return {
        names: Object.keys(out).sort(),
        file: JSON.stringify(out),
        logged: logged.join('\n'),
      }
    } finally {
      console.error = was
    }
  }

  test('a URL and a sign-in command; never a denied server, AgentHydra under any name, or a credential', () => {
    const refused = {
      headers: http('https://h.example.com/mcp', {
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
      oauth: http('https://o.example.com/mcp', { oauth: { clientId: 'x', clientSecret: SECRET } }),
      env: http('https://e.example.com/mcp', { env: { KEY: SECRET } }),
      query: http(`https://q.example.com/mcp?key=${SECRET}`),
      userinfo: http(`https://me:${SECRET}@u.example.com/mcp`),
      path: http(`https://p.example.com/s/${SECRET}/mcp`),
      fragment: http('https://f.example.com/mcp#key=shortfake'),
      'helper-bearer': http('https://b.example.com/mcp', {
        headersHelper: `echo '{"X": "Bearer shortfake"}'`,
      }),
      'helper-header': http('https://a.example.com/mcp', {
        headersHelper: `echo '{"authorization": "shortfake"}'`,
      }),
      'helper-token': http('https://t.example.com/mcp', {
        headersHelper: `node sign.mjs --key ${SECRET}`,
      }),
    }
    const { names, file, logged } = carry(
      JSON.stringify({
        mcpServers: {
          hswarm: http('http://127.0.0.1:7793/mcp', {
            headersHelper:
              'C:/Users/someone/AppData/Local/Programs/Python/Python314/python.exe -m hswarm connect',
          }),
          'connections-local': http('http://127.0.0.1:7791/mcp', {
            headersHelper:
              'node "C:\\Users\\someone\\.claude\\tools\\connections-local\\loader.mjs" --connect',
          }),
          remote: { type: 'sse', url: 'https://mcp.example.com/v1/sse' },
          agenthydra: http('http://127.0.0.1:7787/api/mcp'),
          magnific: http('https://mcp.magnific.com'),
          // AgentHydra's own endpoint under another name: a second PC's daemon, or a renamed entry.
          'second-pc': http('http://192.168.1.20:7787/api/mcp/'),
          'hydra-renamed': http('http://laptop.local:7787/API/MCP'),
          ...refused,
        },
      }),
    )
    expect(names).toEqual(['connections-local', 'hswarm', 'remote'])
    expect(file).not.toContain(SECRET)
    // A server left out for what it carries is named, and only named.
    for (const name of Object.keys(refused)) expect(logged).toContain(`"${name}"`)
    expect(logged).not.toContain(SECRET)
    expect(logged).not.toContain('shortfake')
  })

  test('a stdio server carries with a mode-flag env; one whose env, args or flags look secret does not', () => {
    const stdio = (more: Record<string, unknown>) => ({
      type: 'stdio',
      command: 'node',
      args: ['C:/Users/someone/.claude/tools/connections/server.mjs'],
      ...more,
    })
    const refused = {
      'env-name': stdio({ env: { GITHUB_TOKEN: 'short' } }),
      'env-value': stdio({ env: { MODE: SECRET } }),
      'env-prefix': stdio({ env: { MODE: 'sk-shortfake1' } }),
      'arg-flag': stdio({ args: ['server.mjs', '--token', 'shortfake'] }),
      'arg-value': stdio({ args: ['server.mjs', `ghp_shortfake0`] }),
    }
    const { names, file, logged } = carry(
      JSON.stringify({
        mcpServers: {
          connections: stdio({ env: { CONNECTIONS_ELICITATION: 'form' } }),
          bare: { command: 'python', args: ['-m', 'hswarm'] },
          ...refused,
        },
      }),
    )
    expect(names).toEqual(['bare', 'connections'])
    expect(JSON.parse(file).connections).toEqual(
      stdio({ env: { CONNECTIONS_ELICITATION: 'form' } }),
    )
    for (const name of Object.keys(refused)) expect(logged).toContain(`"${name}"`)
    expect(logged).toContain('GITHUB_TOKEN')
    for (const value of [SECRET, 'shortfake']) {
      expect(file).not.toContain(value)
      expect(logged).not.toContain(value)
    }
  })

  test("an owner config that does not parse is said without the parser's quote of it", () => {
    const { names, logged } = carry(
      `{"mcpServers": {"x": {"headers": {"Authorization": ${SECRET}}}}}`,
    )
    expect(names).toEqual([])
    expect(logged).toContain('could not')
    expect(logged).not.toContain(SECRET)
  })
})

describe("a gone worker's files (sweepWorkerFiles)", () => {
  test("a daemon start removes the settings and MCP files of a worker that is gone or done, never a live one's", () => {
    mkdirSync(HOOKS, { recursive: true })
    const live = { id: 'w-0000a11e', status: 'running', attempts: [] } as unknown as CliMayteWorker
    const done = { id: 'w-0000d0e5', status: 'done', attempts: [] } as unknown as CliMayteWorker
    const files = (id: string) => [join(HOOKS, `${id}.json`), join(HOOKS, `${id}.mcp.json`)]
    const other = join(HOOKS, 'not-a-worker.json')
    for (const f of [...files(live.id), ...files(done.id), ...files('w-0000903e'), other])
      writeFileSync(f, '{}')
    load()
    workers.set(live.id, live)
    workers.set(done.id, done)
    try {
      sweepWorkerFiles()
    } finally {
      workers.delete(live.id)
      workers.delete(done.id)
    }
    const left = (id: string) => files(id).map((f) => existsSync(f))
    expect([left(live.id), left(done.id), left('w-0000903e'), existsSync(other)]).toEqual([
      [true, true],
      [false, false],
      [false, false],
      true,
    ])
    for (const f of [...files(live.id), other]) rmSync(f, { force: true })
  })
})

describe('priority (field note 20)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ah-climayte-priority-'))
  afterAll(() => {
    setCliMayteAccountsProvider(null)
    rmSync(cwd, { recursive: true, force: true })
  })

  test('waiting work starts highest priority first, then oldest; set at dispatch, changed later', () => {
    const at = (priority: number | undefined, createdAt: number) => ({ priority, createdAt })
    const order = [at(undefined, 1), at(0, 2), at(5, 3), at(-1, 0), at(5, 4)].sort(dueOrder)
    expect(order.map((w) => w.createdAt)).toEqual([3, 4, 1, 2, 0])

    setCliMayteAccountsProvider(() => [])
    expect(() => climayteRun({ tasks: [{ prompt: 'x', cwd, priority: 1.5 }] })).toThrow(
      'task 1: priority must be a whole number',
    )
    const run = climayteRun({
      priority: 2,
      tasks: [
        { prompt: 'group default', cwd },
        { prompt: 'its own', cwd, priority: 9 },
      ],
    })
    climayteCancel({ group: run.group })
    expect(run.workers.map((w) => w.priority)).toEqual([2, 9])
    const id = run.workers[0]?.id as string
    expect(climayteSetPriority(id, 7)).toMatchObject({ ok: true, priority: 7 })
    expect(climayteSetPriority(id, 'soon').ok).toBe(false)
    expect(climayteList({ id })[0]?.priority).toBe(7)
    const recorded = climayteJournal({ id }).filter((e) => e.priority !== undefined)
    expect(recorded.map((e) => [e.event, e.priority, e.was])).toEqual([
      ['dispatched', 2, undefined],
      ['priority', 7, 2],
    ])
  })
})

// Field note 62 (2026-10-02): an orchestrator told the 16 workers it had just made did not exist
// sent the same dispatch twice more; 48 ran and 32 had to be cancelled.
describe('a repeated dispatch returns the workers it already made (field note 62)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ah-climayte-repeat-'))
  afterAll(() => {
    setCliMayteAccountsProvider(null)
    rmSync(cwd, { recursive: true, force: true })
  })
  const tasks = [
    { prompt: 'fix the storage fixtures', cwd, title: 'w14: storage' },
    { prompt: 'fix the other fixtures', cwd, title: 'w14: the rest' },
  ]

  test('same group, titles and prompts: the same workers come back, marked, and nothing new is made', () => {
    setCliMayteAccountsProvider(() => [])
    const group = 'repeat-same'
    const first = climayteRun({ group, tasks })
    const again = climayteRun({ group, tasks })
    const mixed = climayteRun({
      group,
      tasks: [...tasks, { prompt: 'a third', cwd, title: 'new' }],
    })
    climayteCancel({ group })
    const ids = first.workers.map((w) => w.id)
    expect(again.workers.map((w) => [w.id, w.repeat])).toEqual(ids.map((id) => [id, true]))
    expect(again.repeated).toBe(2)
    expect(mixed.workers.slice(0, 2).map((w) => w.id)).toEqual(ids)
    expect(mixed.workers[2]?.repeat).toBeUndefined()
    expect(climayteList({ group })).toHaveLength(3)
  })

  test('copies when asked, after the window, after a cancel, or in another group', () => {
    setCliMayteAccountsProvider(() => [])
    const fresh = (run: ReturnType<typeof climayteRun>) => run.workers.every((w) => !w.repeat)
    const group = 'repeat-copies'
    const first = climayteRun({ group, tasks })
    expect(fresh(climayteRun({ group, tasks, copies: true }))).toBe(true)
    expect(fresh(climayteRun({ group: 'repeat-elsewhere', tasks }))).toBe(true)
    climayteCancel({ group: 'repeat-elsewhere' })
    for (const w of workers.values()) if (w.group === group) w.createdAt -= 11 * 60_000
    expect(fresh(climayteRun({ group, tasks }))).toBe(true)
    climayteCancel({ group })
    expect(fresh(climayteRun({ group, tasks }))).toBe(true)
    climayteCancel({ group })
    expect(first.workers).toHaveLength(2)
  })
})

describe("syncOwnerClaude: the owner's CLAUDE.md and skills in an account folder (field note 5)", () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-owner-'))
  const owner = join(root, 'owner')
  const acct = join(root, 'acct')
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('copies and links once, follows changes, keeps what the account wrote itself', () => {
    for (const s of ['alpha', 'beta']) mkdirSync(join(owner, 'skills', s), { recursive: true })
    writeFileSync(join(owner, 'skills', 'alpha', 'SKILL.md'), 'alpha skill')
    writeFileSync(join(owner, 'skills', 'LICENSE'), 'not a skill')
    writeFileSync(join(owner, 'CLAUDE.md'), 'rules v1')
    mkdirSync(join(acct, 'skills', 'synced'), { recursive: true })

    const first = syncOwnerClaude(owner, acct)
    expect(first).toMatchObject({ changed: true, claudeMd: 'copied', linked: ['alpha', 'beta'] })
    expect(readFileSync(join(acct, 'CLAUDE.md'), 'utf8')).toBe('rules v1')
    expect(readFileSync(join(acct, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe('alpha skill')
    expect(existsSync(join(acct, 'skills', 'LICENSE'))).toBe(false)
    expect(existsSync(join(acct, 'skills', 'synced'))).toBe(true)

    // Unchanged: nothing to do, in memory or (after a daemon restart) from the stamp on disk.
    expect(syncOwnerClaude(owner, acct).changed).toBe(false)
    forgetOwnerSync()
    expect(syncOwnerClaude(owner, acct).changed).toBe(false)

    // An edited CLAUDE.md is copied again; a removed skill is unlinked, its files left alone.
    writeFileSync(join(owner, 'CLAUDE.md'), 'rules v2, longer')
    const edited = syncOwnerClaude(owner, acct)
    expect(edited).toMatchObject({ claudeMd: 'copied', linked: [], unlinked: [] })
    expect(readFileSync(join(acct, 'CLAUDE.md'), 'utf8')).toBe('rules v2, longer')
    rmSync(join(owner, 'skills', 'beta'), { recursive: true })
    const removed = syncOwnerClaude(owner, acct)
    expect(removed).toMatchObject({ claudeMd: 'unchanged', unlinked: ['beta'] })
    expect(existsSync(join(acct, 'skills', 'beta'))).toBe(false)

    // A CLAUDE.md the account holds of its own is never replaced.
    writeFileSync(join(acct, 'CLAUDE.md'), 'this account keeps its own')
    writeFileSync(join(owner, 'CLAUDE.md'), 'rules v3, longer still')
    expect(syncOwnerClaude(owner, acct).claudeMd).toBe('kept-own')
    expect(readFileSync(join(acct, 'CLAUDE.md'), 'utf8')).toBe('this account keeps its own')

    // Removing the account folder removes the links, never the owner's skill files behind them.
    rmSync(acct, { recursive: true, force: true })
    expect(readFileSync(join(owner, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe('alpha skill')
  })

  test('a lean worker profile replaces the full CLAUDE.md and limits the skills', () => {
    // Run 1: the full CLAUDE.md and every skill description added 24-33k tokens to each request.
    const lean = join(root, 'lean-owner')
    const leanAcct = join(root, 'lean-acct')
    for (const s of ['alpha', 'beta']) mkdirSync(join(lean, 'skills', s), { recursive: true })
    mkdirSync(leanAcct)
    writeFileSync(join(lean, 'CLAUDE.md'), 'every rule the desktop chat needs')
    expect(syncOwnerClaude(lean, leanAcct).linked).toEqual(['alpha', 'beta'])

    mkdirSync(join(lean, 'climayte-worker'))
    writeFileSync(join(lean, 'climayte-worker', 'CLAUDE.md'), 'the few rules a worker needs')
    writeFileSync(join(lean, 'climayte-worker', 'skills.txt'), '# worker skills\nbeta\r\n')
    expect(syncOwnerClaude(lean, leanAcct)).toMatchObject({
      claudeMd: 'copied',
      unlinked: ['alpha'],
    })
    expect(readFileSync(join(leanAcct, 'CLAUDE.md'), 'utf8')).toBe('the few rules a worker needs')
    expect(existsSync(join(leanAcct, 'skills', 'alpha'))).toBe(false)
    expect(existsSync(join(leanAcct, 'skills', 'beta'))).toBe(true)
  })
})

describe('integration: paid extra usage is never spent', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-overage-'))
  const cwd = join(root, 'work')
  const overDir = join(root, 'acct-over')
  const freeDir = join(root, 'acct-free')
  for (const d of [cwd, overDir, freeDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(overDir, 'fake-overage'), '')
  const groups: string[] = []

  afterAll(() => {
    for (const group of groups) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('a turn that starts billing overage is stopped at once and the session moves on', async () => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    // The overage account scores lower, so it is picked first. Left alone, the fake would go on
    // for 6 s and finish there on overage ('FINISHED ON OVERAGE', no move).
    setCliMayteAccountsProvider(() => [
      { id: 'over-1', num: 1, name: 'overage', configDir: overDir, sessionPct: 0, weekPct: 0 },
      { id: 'over-2', num: 2, name: 'free', configDir: freeDir, sessionPct: 50, weekPct: 50 },
    ])
    startCliMayte()
    const run = climayteRun({ tasks: [{ prompt: 'a long task', cwd, title: 'overage' }] })
    groups.push(run.group)
    const id = run.workers[0]?.id as string

    const deadline = Date.now() + 15_000
    let w = climayteList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = climayteList({ id })[0]
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
      setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
      // New account ids: the test above walled 'over-1'.
      setCliMayteAccountsProvider(() => [
        { id: 'allow-1', num: 1, name: 'overage', configDir: overDir, sessionPct: 0, weekPct: 0 },
        { id: 'allow-2', num: 2, name: 'free', configDir: freeDir, sessionPct: 50, weekPct: 50 },
      ])
      startCliMayte()
      const run = climayteRun({ tasks: [{ prompt: 'a long task', cwd, title: 'overage allowed' }] })
      groups.push(run.group)
      const id = run.workers[0]?.id as string

      const deadline = Date.now() + 15_000
      let w = climayteList({ id })[0]
      while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
        await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
        w = climayteList({ id })[0]
      }

      expect(w?.status).toBe('done')
      expect(w?.result).toBe('FINISHED ON OVERAGE')
      expect(w?.moves).toBe(0)
      expect(w?.attempts).toHaveLength(1)
      // A dispatch-to-done run is four journal lines: its turn's text, then done with its turns and cost.
      const log = climayteJournal({ id })
      expect(log.map((e) => e.event)).toEqual(['dispatched', 'launched', 'turn-end', 'done'])
      expect(log[2]).toMatchObject({ account: '#1', said: 'FINISHED ON OVERAGE' })
      expect(log[3]).toMatchObject({ account: '#1', turns: 1 })
      expect(typeof log[3]?.costUsd).toBe('number')
      expect(climayteJournalLines({ id })[3]).toMatch(
        /^\d\d:\d\d:\d\d w-\w+ done on #1: \$\d+\.\d\d, 1 turn \(/,
      )
    } finally {
      setProviderSettings({ allowExtraUsage: false })
    }
  }, 20_000)

  /** A task on an account that reads 98.5% (and could bill), run until it ends; 'rising': the
   *  account reads 50% first and climbs to 98.5% (fake-claude's fake-near-limit). */
  const nearLimitRun = async (title: string, rising: boolean) => {
    const nearDir = join(root, `acct-near-${rising ? 'rising' : 'full'}`)
    mkdirSync(nearDir, { recursive: true })
    writeFileSync(join(nearDir, 'fake-near-limit'), rising ? 'rising' : '')
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    const near = rising ? 'rise-1' : 'near-1'
    setCliMayteAccountsProvider(() => [
      { id: near, num: 1, name: 'near', configDir: nearDir, sessionPct: 0, weekPct: 0 },
      { id: `${near}-free`, num: 2, name: 'free', configDir: freeDir, sessionPct: 50, weekPct: 50 },
    ])
    startCliMayte()
    const run = climayteRun({ tasks: [{ prompt: 'a long task', cwd, title }] })
    groups.push(run.group)
    const id = run.workers[0]?.id as string
    const deadline = Date.now() + 15_000
    let w = climayteList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = climayteList({ id })[0]
    }
    return { id, w }
  }

  test('a run that climbs into the 90% ceiling is stopped there, short of billing, and goes on elsewhere', async () => {
    const { id, w } = await nearLimitRun('climbs to the ceiling', true)
    expect(w?.status).toBe('done')
    expect(w?.moves).toBe(1)
    expect(w?.attempts[0]).toMatchObject({ outcome: 'quota', ceiling: true })
    expect(w?.attempts[0]?.notice).toContain("CliMayte's ceiling of 90%, well short of the limit")
    const totals = climayteTotals()
    expect(totals.ceilingStopList.some((c) => c.id === id)).toBe(true)
    expect(totals.placedPastList.some((p) => p.id === id)).toBe(false)
  }, 20_000)

  test('at the 90% ceiling the turn is stopped, short of billing and of the limit, and goes on elsewhere', async () => {
    // Left alone, the fake finishes on the near-limit account after 6 s ('FINISHED NEAR LIMIT').
    const { id, w } = await nearLimitRun('near the limit', false)
    expect(w?.status).toBe('done')
    expect(w?.result).toBe('FAKE DONE')
    expect(w?.moves).toBe(1)
    // Owner, 2026-10-01: "85 with a max of 90". The account reads 98.5% (and could bill): the
    // ceiling stops it first, and that is a ceiling stop, not a limit hit. Placed at 0% and found
    // at 98.5% on its first request, it is a placement on a stale reading (pastOnArrival), not a
    // stop line that came too late: listed apart from the ceiling stops.
    expect(w?.attempts[0]).toMatchObject({ outcome: 'quota', ceiling: true })
    expect(w?.attempts[0]?.notice).toContain(
      "Found at 99% of its 5-hour usage on its first request, past CliMayte's ceiling of 90%",
    )
    const totals = climayteTotals()
    expect(totals.limitHitList.some((h) => h.id === id)).toBe(false)
    expect(totals.ceilingStopList.some((c) => c.id === id)).toBe(false)
    expect(totals.placedPastList.find((p) => p.id === id)).toMatchObject({
      pct: 98.5,
      placedPct: 0,
    })
    expect(climayteJournal({ id }).find((e) => e.event === 'limit')).toMatchObject({
      ceiling: true,
      onArrival: true,
    })
  }, 20_000)

  test("a run that found its account past the ceiling is not counted as CliMayte's peak", () => {
    // 2026-10-02: #120 had no reading; its first request was refused at 129%, and the totals showed
    // a 129% peak and a ceiling stop the stop line could never have prevented. Stamped an hour
    // ahead, so `since` holds these two and none of the runs above.
    const t = Date.now() + 3_600_000
    const stop = (id: string, pct: number, onArrival: boolean) =>
      ({
        id,
        title: id,
        status: 'done',
        createdAt: t,
        attempts: [
          {
            account: { id: `acct-${id}`, num: 99, name: 'x' },
            startedAt: t - 1_000,
            endedAt: t,
            outcome: 'quota',
            startPct: onArrival ? null : 40,
            peak: { pct, resetsAt: t + 3_600_000 },
            ceiling: { pct, week: false, resetsAt: t + 3_600_000, onArrival },
          },
        ],
      }) as any
    workers.set('w-arrived', stop('w-arrived', 129, true))
    workers.set('w-climbed', stop('w-climbed', 91, false))
    try {
      const totals = climayteTotals(t - 1_000)
      expect(totals.placedPastList.map((p) => [p.id, p.pct, p.placedPct])).toEqual([
        ['w-arrived', 129, null],
      ])
      expect(totals.ceilingStopList.map((c) => c.id)).toEqual(['w-climbed'])
      expect(totals.peaks.map((p) => p.peakPct)).toEqual([91])
    } finally {
      workers.delete('w-arrived')
      workers.delete('w-climbed')
    }
  })
})

describe('the totals read tokens and $ from the kit', () => {
  test("CliMayte's calls in the kit are the counter, whatever the attempts recorded", () => {
    const store = new KitStore(':memory:')
    const ts = Date.now() - 60_000
    store.upsertEvents([
      { id: 'k1', ts, source: 'climayte', model: 'm', input: 100, output: 50, list_usd: 1.5 },
      { id: 'k2', ts, source: 'climayte', model: 'm', input: 10, output: 5, list_usd: 0.25 },
      { id: 'k3', ts, source: 'cli', model: 'm', input: 9_999, output: 1, list_usd: 99 },
    ])
    const totals = climayteTotals(0, { store })
    expect(totals.tokens).toEqual({ input: 110, output: 55, cacheRead: 0, cacheWrite: 0 })
    expect(totals.costUsd).toBeCloseTo(1.75, 6)
  })
})

describe('each round of a task says why it started', () => {
  test('a check fail, a verdict and a follow-up each name themselves; a handoff speaks for itself', () => {
    // Owner, 2026-10-02, on w-3ace43c8 listed as #94, #103, #103, #103, #103: "Why? Is that some sort of
    // previously broken one that's stuck?" Each #103 was the same session, sent back for another round.
    const at = (startedAt: number, outcome: string) => ({ startedAt, outcome }) as any
    const w = {
      attempts: [at(0, 'handoff'), at(10, 'done'), at(20, 'done'), at(30, 'done'), at(40, 'done')],
      verdicts: [
        {
          at: 15,
          verdict: 'fail',
          by: 'check',
          note: 'The check `x` failed (exit 1). The end of its output:\nconnections: 5 gating error(s)',
        },
        { at: 25, verdict: 'fail', by: 'orchestrator', note: 'Wrong file.\nMore.' },
        { at: 33, verdict: 'pass', by: 'orchestrator', note: null },
      ],
    } as any
    expect(attemptCause(w, 0)).toBeUndefined()
    expect(attemptCause(w, 1)).toBeUndefined() // after a handoff: that attempt's own notice says why
    expect(attemptCause(w, 2)).toEqual({
      cause: 'check',
      detail: 'exit 1: connections: 5 gating error(s)',
    })
    expect(attemptCause(w, 3)).toEqual({ cause: 'sent-back', detail: 'Wrong file.' })
    expect(attemptCause(w, 4)).toEqual({ cause: 'follow-up', detail: null }) // a pass then a message
  })
})

describe('the 85% stop line and the 90% ceiling', () => {
  test("a session goes by its account's newest reading, not only its own stream", () => {
    // 2026-10-01, #102: three workers' streams read 85% at 08:28 and handed off. The fourth sat in a
    // long tool call; its own stream said 76%, it was asked only at 87% six minutes later, and it
    // reached the ceiling writing its handoff.
    const now = Date.now()
    const reading = (sessionPct: number, at: number, sessionResetsAt = now + 3_600_000) => ({
      sessionPct,
      sessionResetsAt,
      weekPct: 10,
      weekResetsAt: null,
      overageAllowed: false,
      at,
    })
    const own = reading(76, now - 360_000)
    expect(windDownAt(own, reading(85, now - 5_000), now)).toMatchObject({ pct: 85, week: false })
    expect(atCeiling(own, reading(90, now - 5_000), now)?.pct).toBe(90)
    // An account reading older than its own, or from a window that has reset, does not count.
    expect(windDownAt(own, reading(85, now - 400_000), now)).toBeNull()
    expect(windDownAt(own, reading(85, now - 5_000, now - 1), now)).toBeNull()
  })

  test("in a week's last five hours the weekly line is 89, so the rest of the week is used", () => {
    // Owner, 2026-10-02: "Up to 90% near reset". At 85 an account took no new work even with its
    // week resetting in an hour, and up to 5 points of every account-week expired unused.
    const now = Date.now()
    const week = (weekPct: number, weekResetsAt: number) => ({
      sessionPct: 10,
      sessionResetsAt: now + 3_600_000,
      weekPct,
      weekResetsAt,
      overageAllowed: false,
      at: now - 5_000,
    })
    const soon = now + 4 * 3_600_000
    const later = now + 22 * 3_600_000
    expect(windDownAt(week(87, soon), null, now)).toBeNull()
    expect(windDownAt(week(89, soon), null, now)).toMatchObject({ pct: 89, week: true })
    expect(windDownAt(week(87, later), null, now)).toMatchObject({ pct: 87, week: true })
    const acct = (weekResetsAt: number) => ({
      id: 'a',
      num: 1,
      name: 'a',
      configDir: 'a',
      sessionPct: 10,
      weekPct: 87,
      weekResetsAt,
    })
    const fresh = { accounts: null, accountId: null, attempts: [] } as any
    expect(pickAccount(fresh, [acct(soon)] as any, {}, new Map(), 2, now)?.id).toBe('a')
    expect(pickAccount(fresh, [acct(later)] as any, {}, new Map(), 2, now)).toBeNull()
  })
})

describe('integration: near its limit a worker hands off to a fresh session', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-winddown-'))
  const cwd = join(root, 'work')
  const nearDir = join(root, 'acct-near')
  const freeDir = join(root, 'acct-free')
  for (const d of [cwd, nearDir, freeDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(nearDir, 'fake-winddown'), '')
  let group: string | null = null

  afterAll(() => {
    if (group) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('it writes a handoff and the task goes on from it in a new session elsewhere', async () => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    // The near-limit account scores lower, so it is picked first. Left alone it works on and
    // finishes there ('NO WIND-DOWN'); the other account has room.
    setCliMayteAccountsProvider(() => [
      { id: 'wind-1', num: 1, name: 'near', configDir: nearDir, sessionPct: 0, weekPct: 0 },
      { id: 'wind-2', num: 2, name: 'free', configDir: freeDir, sessionPct: 50, weekPct: 50 },
    ])
    startCliMayte()
    const run = climayteRun({ tasks: [{ prompt: 'a long task', cwd, title: 'wind down' }] })
    group = run.group
    const id = run.workers[0]?.id as string
    const firstSession = run.workers[0]?.sessionId as string

    const deadline = Date.now() + 15_000
    let w = climayteList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = climayteList({ id })[0]
    }

    expect(w?.status).toBe('done')
    expect(w?.result).toBe('FAKE DONE FROM HANDOFF')
    // The turns before the handoff are kept, labelled, not mixed into the continuation's report.
    expect(climayteGet(id)?.reports?.at(-1)).toMatchObject({ results: ['Handoff written.'] })
    expect(climayteGet(id)?.reports?.at(-1)?.message).toEndWith('(before a handoff)')
    expect(w?.attempts.map((a) => [a.account.id, a.outcome])).toEqual([
      ['wind-1', 'handoff'],
      ['wind-2', 'done'],
    ])
    expect(w?.sessions).toEqual([firstSession])
    expect(w?.sessionId).not.toBe(firstSession)
  }, 20_000)

  test('with no room elsewhere it still stops at the line, and the task waits for the reset', async () => {
    // Owner, 2026-10-01: never the limit, stop at 85-90%. The account reports 87% (as
    // signedInAccounts merges a running worker's reading, so does this provider).
    const aloneDir = join(root, 'acct-alone')
    mkdirSync(aloneDir, { recursive: true })
    writeFileSync(join(aloneDir, 'fake-winddown'), '')
    setCliMayteAccountsProvider(() => {
      const live = climayteLiveReadings().get('wind-3')
      return [
        {
          id: 'wind-3',
          num: 3,
          name: 'alone',
          configDir: aloneDir,
          sessionPct: live?.sessionPct ?? 0,
          weekPct: 0,
          sessionResetsAt: live?.sessionResetsAt ?? null,
        },
      ]
    })
    const run = climayteRun({
      tasks: [{ prompt: 'a long task', cwd, title: 'alone' }],
      group: 'wind-alone',
    })
    const id = run.workers[0]?.id as string
    const deadline = Date.now() + 15_000
    let w = climayteList({ id })[0]
    while (w && w.status !== 'waiting' && w.status !== 'failed' && Date.now() < deadline) {
      await climayteWait({ id }, Math.min(2_000, deadline - Date.now()))
      w = climayteList({ id })[0]
    }
    climayteCancel({ group: 'wind-alone' })
    expect(w?.attempts.map((a) => [a.account.id, a.outcome])).toEqual([['wind-3', 'handoff']])
    expect(w?.status).toBe('waiting')
    expect(w?.error).toContain('85% stop line')
    const resetsAt = climayteLiveReadings().get('wind-3')?.sessionResetsAt as number
    expect(w?.waitUntil).toBe(new Date(resetsAt).toISOString())
    // Its peak is on record: 87, inside the 85-90 band.
    expect(climayteTotals().peaks.find((p) => p.account === '#3')?.peakPct).toBe(87)
  }, 20_000)
})

describe('climayte_status scope (field notes 1, 4 and 7)', () => {
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
    // The caller is pinned: unpinned, it resolves whatever chat runs this suite.
    beforeAll(async () => {
      const { setCallerTranscriptResolver } = await import('../src/mcp-self')
      setCallerTranscriptResolver(async () => {
        throw new Error('no calling chat in this test')
      })
    })
    afterAll(async () => {
      globalThis.fetch = originalFetch
      const { setCallerTranscriptResolver } = await import('../src/mcp-self')
      setCallerTranscriptResolver(null)
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

    test('climayte_status {} asks for active plus 20 recent, brief; { id } asks for the detail', async () => {
      const t = await tool('climayte_status')
      await t.run({})
      await t.run({ group: 'g-1' })
      await t.run({ active: true, limit: 5 })
      await t.run({ id: 'w-1', wait_seconds: 5 })
      const paths = urls.map((u) => new URL(u).pathname + new URL(u).search)
      // Each read first asks which chats hold unread pings (docs/CLIMAYTE.md).
      expect(paths).toEqual([
        '/api/corch/pings',
        '/api/corch/workers?limit=20&brief=1',
        '/api/corch/pings',
        '/api/corch/workers?group=g-1&brief=1',
        '/api/corch/pings',
        '/api/corch/workers?active=1&limit=5&brief=1',
        '/api/corch/pings',
        '/api/corch/workers/w-1?wait=5',
      ])
    })

    test('climayte_run answers the group and, per worker, only id, title, status and account', async () => {
      const t = await tool('climayte_run')
      answer = {
        group: 'g-1',
        workers: [{ id: 'w-1', title: 'x', status: 'queued', account: null, prompt: 'long' }],
      }
      const { ping, ...r } = (await t.run({ tasks: [{ prompt: 'long', cwd: '.' }] })) as {
        ping: string
      }
      expect(r).toEqual({
        group: 'g-1',
        workers: [{ id: 'w-1', title: 'x', status: 'queued', account: null }],
      })
      expect(ping).toBe(
        'off: no calling chat in this test; run python ~/.claude/tools/climayte_wait.py --group g-1',
      )
    })
  })
})

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
    // One known setting, so a follow-up's switch shows against it (auto may explore Haiku).
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
      ['claude-haiku-4-5', null],
    ])
    // Owner, 2026-10-02: the cheapest model that reliably does the task. A model named with no
    // reason is left to the scorecard: a sweep pinned to Opus starts where sweeps start.
    const bare = climayteRun({ tasks: [{ prompt: 'x', cwd, kind: 'sweep', model: 'opus' }] })
    climayteCancel({ group: bare.group })
    expect(bare.workers.map((w) => [w.model, w.effort])).toEqual([['claude-sonnet-5-5', 'medium']])
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
    expect(manager).toMatchObject({ kind: 'manage', effort: 'low' })
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

describe('spend per attempt (field note 41): what each run used, the re-read after a move apart', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-spend-'))
  const cwd = join(root, 'work')
  const quotaDir = join(root, 'acct-quota')
  const nextDir = join(root, 'acct-next')
  for (const d of [cwd, quotaDir, nextDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(quotaDir, 'fake-quota'), '')
  writeFileSync(join(nextDir, 'fake-reread'), '2000000')
  let group: string | null = null

  afterAll(() => {
    if (group) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('a moved task records every attempt, splits work from re-read, and its kind costs the work only', async () => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      { id: 'spend-a', num: 51, name: 'a', configDir: quotaDir, sessionPct: 0, weekPct: 0 },
      // Room for the whole task, so it moves rather than waits (sizing); #51 is tried first by number.
      { id: 'spend-b', num: 52, name: 'b', configDir: nextDir, sessionPct: 0, weekPct: 0 },
    ])
    startCliMayte()
    const run = climayteRun({
      tasks: [
        {
          prompt: 'FAKE-SPEND:100000 a task that moves',
          cwd,
          kind: 'docs',
          model: 'sonnet',
          effort: 'high',
          ownerWords: 'the scorecard row under test',
        },
      ],
      size: 'whole',
    })
    group = run.group
    const id = run.workers[0]?.id as string
    const deadline = Date.now() + 30_000
    let w = climayteList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = climayteList({ id })[0]
    }
    expect(w?.attempts.map((a) => a.outcome)).toEqual(['quota', 'done'])
    const [first, moved] = w?.attempts ?? []
    // The run that hit the limit is measured too, and as the task's first it re-read nothing.
    expect(first).toMatchObject({ turns: 1, rereadPct: 0 })
    expect(first?.costUsd).toBeGreaterThan(0)
    expect(moved?.turns).toBe(1)
    expect(moved?.costUsd).toBeGreaterThan(0)
    expect(moved?.rereadPct).toBeGreaterThan(0)
    expect(w?.used.rereadPct).toBe(moved?.rereadPct as number)
    expect(w?.used.workPct).toBeCloseTo((w?.used.pct ?? 0) - (w?.used.rereadPct ?? 0), 0)
    const totals = climayteTotals()
    expect(totals.rereadByCause.quota).toBeGreaterThan(0)
    // The test metrics: its limit is a hit (target 0), and its size is set against what it used.
    expect(totals.limitHitList.some((h) => h.id === id && h.account === '#51')).toBe(true)
    expect(totals.sizing.list.find((x) => x.id === id)).toMatchObject({
      expected: w?.size?.expected,
      used: w?.used.pct,
    })

    expect(climayteVerdict(id, { verdict: 'pass', by: 'orchestrator' }).ok).toBe(true)
    const row = climayteScorecard().rows.find(
      (r) => r.kind === 'docs' && r.model === 'claude-sonnet-5-5' && r.effort === 'high',
    )
    expect(row?.pctPerTask).toBeCloseTo(w?.used.workPct ?? -1, 0)
  }, 40_000)
})

describe.skipIf(process.platform !== 'win32')(
  'an ended attempt ends what its session left running (field note 43)',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-climayte-leftover-'))
    const cwd = join(root, 'work')
    const dir = join(root, 'acct')
    for (const d of [cwd, dir]) mkdirSync(d, { recursive: true })
    writeFileSync(join(dir, 'fake-leftover'), '')
    let group: string | null = null

    afterAll(() => {
      if (group) climayteCancel({ group })
      setCliMayteClaudeCommand(null)
      setCliMayteAccountsProvider(null)
      rmSync(root, { recursive: true, force: true })
    })

    test('the background process ends with the attempt, and the journal names it', async () => {
      setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
      setCliMayteAccountsProvider(() => [
        { id: 'left-1', num: 61, name: 'left', configDir: dir, sessionPct: 0, weekPct: 0 },
      ])
      startCliMayte()
      const run = climayteRun({
        tasks: [{ prompt: 'start a dev server and finish', cwd }],
        size: 'whole',
      })
      group = run.group
      const id = run.workers[0]?.id as string
      const deadline = Date.now() + 20_000
      let w = climayteList({ id })[0]
      while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
        await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
        w = climayteList({ id })[0]
      }
      expect(w?.status).toBe('done')
      const pid = Number(readFileSync(join(dir, 'leftover.pid'), 'utf8'))
      const gone = Date.now() + 10_000
      while (isPidAlive(pid) && Date.now() < gone) await Bun.sleep(200)
      expect(isPidAlive(pid)).toBe(false)
      const cleaned = climayteJournal({ id }).find((e) => e.event === 'cleaned')
      expect(cleaned?.notice).toContain(String(pid))
      // ...and the orchestrator's report says so, not just the journal (Odin mega-run, 2026-10-02:
      // a worker's background deploy vanished while its turn ended "still waiting on the deploy").
      expect(climayteReports({ ids: [id] })[0]?.leftRunning).toBeTruthy()
    }, 40_000)
  },
)

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
