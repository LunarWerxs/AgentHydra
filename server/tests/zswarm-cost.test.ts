// server/tests/zswarm-cost.test.ts - the DeepSeek zswarm's spend (server/src/zswarm-cost.ts): the
// ledger aggregation and the account balance check.
//
// The balance check mocks globalThis.fetch (the same pattern codex-account.test.ts and
// instances-crypto.test.ts use) rather than hitting the real DeepSeek endpoint, and the credentials
// file is a scratch path passed in rather than the real ~/.dsh - so this suite never touches the
// network or the real ~/.zswarm / ~/.dsh.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deepseekBalance,
  readDeepSeekKey,
  readZswarmLedger,
  resetZswarmBalanceCache,
  summarizeZswarmCost,
} from '../src/zswarm-cost'

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function newHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zswarm-home-'))
  homes.push(dir)
  return dir
}

function writeLedger(home: string, lines: unknown[]): void {
  writeFileSync(join(home, 'ledger.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
}

const LEDGER_ROWS = [
  {
    // arkitect-allow: spec-drifting-date-fixture - a ledger record's own timestamp: sliced to a UTC day for bucketing and echoed back as `day`, never compared with the real clock
    ts: '2026-09-15T05:15:33+00:00',
    job: 'a',
    task: 't1',
    backend: 'api',
    model: 'deepseek-flash',
    status: 'ok',
    cost_usd: 0.0003,
  },
  {
    // arkitect-allow: spec-drifting-date-fixture - same fixed-record-timestamp reason as the first row: bucketed by day, never compared with the real clock
    ts: '2026-09-15T05:16:24+00:00',
    job: 'b',
    task: 't1',
    backend: 'api',
    model: 'deepseek-flash',
    status: 'ok',
    cost_usd: 0.0002,
  },
  // the `dsh` backend keeps no cost data at all
  {
    // arkitect-allow: spec-drifting-date-fixture - same fixed-record-timestamp reason as the first row: bucketed by day, never compared with the real clock
    ts: '2026-09-15T05:16:40+00:00',
    job: 'c',
    task: 't1',
    backend: 'dsh',
    model: 'deepseek-flash',
    status: 'ok',
    cost_usd: null,
  },
  // a different day, different model
  {
    // arkitect-allow: spec-drifting-date-fixture - same fixed-record-timestamp reason as the first row: this second day is compared only against the other fixture days
    ts: '2026-09-14T12:00:00+00:00',
    job: 'd',
    task: 't1',
    backend: 'cc',
    model: 'deepseek-v4-pro',
    status: 'ok',
    cost_usd: 0.05,
  },
]

describe('readZswarmLedger', () => {
  test('reads every line and skips a torn one', () => {
    const home = newHome()
    writeFileSync(
      join(home, 'ledger.jsonl'),
      `${JSON.stringify(LEDGER_ROWS[0])}\n{"ts": "2026-09-15T0` /* torn final line */,
    )
    const rows = readZswarmLedger(home)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.job).toBe('a')
  })

  test('a missing ledger reads as empty, not an error', () => {
    expect(readZswarmLedger(join(tmpdir(), 'no-such-zswarm-home'))).toEqual([])
  })
})

describe('summarizeZswarmCost', () => {
  test('sums cost_usd by day/model/backend, and counts unpriced tasks separately', () => {
    const home = newHome()
    writeLedger(home, LEDGER_ROWS)
    const summary = summarizeZswarmCost(home)
    expect(summary.total_usd).toBeCloseTo(0.0003 + 0.0002 + 0.05, 6)
    expect(summary.unpriced_tasks).toBe(1) // the dsh-backend row
    // two same-day/model/backend rows collapse into one bucket
    const flashBucket = summary.rows.find(
      (r) => r.day === '2026-09-15' && r.model === 'deepseek-flash' && r.backend === 'api',
    )
    expect(flashBucket?.tasks).toBe(2)
    expect(flashBucket?.cost_usd).toBeCloseTo(0.0005, 6)
    // the dsh row still gets a bucket, just at $0
    const dshBucket = summary.rows.find((r) => r.backend === 'dsh')
    expect(dshBucket?.cost_usd).toBe(0)
    expect(dshBucket?.tasks).toBe(1)
    // newest day first
    expect(summary.rows[0]?.day >= summary.rows[summary.rows.length - 1]!.day).toBe(true)
  })

  test('an empty ledger summarizes to zero, not an error', () => {
    const home = newHome()
    writeLedger(home, [])
    const summary = summarizeZswarmCost(home)
    expect(summary.rows).toEqual([])
    expect(summary.total_usd).toBe(0)
    expect(summary.unpriced_tasks).toBe(0)
  })
})

describe('readDeepSeekKey', () => {
  const originalEnv = process.env.DEEPSEEK_API_KEY

  beforeEach(() => {
    delete process.env.DEEPSEEK_API_KEY
  })
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = originalEnv
  })

  test('env var wins when set', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-from-env'
    expect(readDeepSeekKey('/does/not/matter.yaml')).toBe('sk-from-env')
  })

  test('falls back to refs.DEEPSEEK_API_KEY in the yaml file', () => {
    const home = newHome()
    const path = join(home, '.credentials.yaml')
    writeFileSync(
      path,
      "version: 1\n\nrefs:\n  DEEPSEEK_API_KEY: 'sk-from-yaml'\n  XAI_API_KEY: 'xai-other'\n",
    )
    expect(readDeepSeekKey(path)).toBe('sk-from-yaml')
  })

  test('no env and no file: null, never a throw', () => {
    expect(readDeepSeekKey(join(tmpdir(), 'no-such-credentials.yaml'))).toBeNull()
  })
})

describe('deepseekBalance', () => {
  const originalEnv = process.env.DEEPSEEK_API_KEY
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-key'
    resetZswarmBalanceCache()
  })
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = originalEnv
    globalThis.fetch = originalFetch
    resetZswarmBalanceCache()
  })

  test('a 200 with a usable figure reports ok', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: 'USD', total_balance: '12.34' }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const result = await deepseekBalance()
    expect(result).toMatchObject({ status: 'ok', balance_usd: 12.34, currency: 'USD' })
  })

  test('a non-200 degrades to unknown, never throws', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 401 })) as unknown as typeof fetch
    const result = await deepseekBalance()
    expect(result.status).toBe('unknown')
    expect(result.balance_usd).toBeNull()
    expect(result.reason).toBeTruthy()
  })

  test('a network error degrades to unknown, never throws', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const result = await deepseekBalance()
    expect(result.status).toBe('unknown')
    expect(result.reason).toContain('network down')
  })

  test('no key at all degrades to unknown without ever calling fetch', async () => {
    delete process.env.DEEPSEEK_API_KEY
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const result = await deepseekBalance({ credentialsPath: join(tmpdir(), 'no-such-file.yaml') })
    expect(result.status).toBe('unknown')
    expect(called).toBe(false)
  })

  test('a cached reading is reused within the TTL, not re-fetched', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(
        JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: '1.00' }] }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    // The TTL check is `now - cachedAt < BALANCE_CACHE_MS`, so the base is only ever compared with
    // itself: a real-clock start keeps this fixture from going stale as a fixed date would.
    const now = Date.now()
    await deepseekBalance({ now })
    await deepseekBalance({ now: now + 1000 })
    expect(calls).toBe(1)
  })
})
