// server/tests/corch.test.ts — Corch: the pure helpers it decides with, and one real handoff.
//
// CONFIG_DIR, the instance store and TMP are already redirected to a scratch dir by tests/setup.ts
// (the bunfig preload), so corch's `<CONFIG_DIR>/corch/` state never touches a real install. The
// accounts are fakes pointing at temp config dirs, and the CLI is tests/mocks/fake-claude.ts run by
// the same bun that runs this suite.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyAttempt,
  corchCancel,
  corchList,
  corchRun,
  corchWait,
  livePct,
  MAX_PER_ACCOUNT,
  pickAccount,
  setCorchAccountsProvider,
  setCorchClaudeCommand,
  spentFromLog,
  startCorch,
} from '../src/corch'

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
  test('a clean result is done, with its text, cost and turns', () => {
    const r = classifyAttempt([init, said('ok'), result('all good', false)], '')
    expect(r).toMatchObject({ outcome: 'done', result: 'all good', costUsd: 0.02, turns: 3 })
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
})

describe('spentFromLog', () => {
  // One API response, logged as two stream-json lines (a text block, then a tool call), as the CLI
  // writes it; a killed attempt has no closing `result` to take the price from.
  const usage = { input_tokens: 10, output_tokens: 2_000, cache_read_input_tokens: 50_000 }
  const block = (type: string) =>
    JSON.stringify({
      type: 'assistant',
      request_id: 'req_1',
      message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type }], usage },
    })

  test('a killed turn is priced from its log, once per response however many blocks it logged', () => {
    const once = spentFromLog(block('text'))
    expect(once).toBeGreaterThan(0)
    expect(spentFromLog([block('text'), block('tool_use'), JSON.stringify(init)].join('\n'))).toBe(
      once,
    )
    expect(spentFromLog(JSON.stringify(init))).toBe(0)
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

  test('spreads by the active count', () => {
    const accounts = [acct('a', 1), acct('b', 2)]
    expect(pickAccount(worker(), accounts, {}, new Map(), 2, now)?.id).toBe('a')
    expect(pickAccount(worker(), accounts, {}, new Map([['a', 1]]), 2, now)?.id).toBe('b')
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
  }, 45_000)
})
