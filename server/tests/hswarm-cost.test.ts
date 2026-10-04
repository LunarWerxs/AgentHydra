// server/tests/hswarm-cost.test.ts - HSwarm's spend (server/src/hswarm-cost.ts): the ledger
// aggregation and the DeepSeek account balance check.
//
// The balance check mocks globalThis.fetch (the same pattern codex-account.test.ts and
// instances-crypto.test.ts use) rather than hitting the real DeepSeek endpoint; the credentials
// file is a scratch path passed in rather than the real ~/.dsh, and HSWARM_HOME points at a scratch
// home for every key test - so this suite never touches the network or the real ~/.hswarm / ~/.dsh.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deepseekBalance,
  readDeepSeekKey,
  readHSwarmLedger,
  resetHSwarmBalanceCache,
} from '../src/hswarm-cost'

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function newHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hswarm-home-'))
  homes.push(dir)
  return dir
}

/** The env the key reader looks at, cleared before and restored after each key test, with
 *  HSWARM_HOME on an empty scratch home so this machine's own swarm keys are never found. */
const KEY_ENV = ['DEEPSEEK_API_KEYS', 'DEEPSEEK_API_KEY', 'HSWARM_HOME'] as const
function isolateKeyEnv(): void {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of KEY_ENV) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    process.env.HSWARM_HOME = newHome()
  })
  afterEach(() => {
    for (const k of KEY_ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
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

describe('readHSwarmLedger', () => {
  test('reads every line and skips a torn one', () => {
    const home = newHome()
    writeFileSync(
      join(home, 'ledger.jsonl'),
      `${JSON.stringify(LEDGER_ROWS[0])}\n{"ts": "2026-09-15T0` /* torn final line */,
    )
    const rows = readHSwarmLedger(home)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.job).toBe('a')
  })

  test('a missing ledger reads as empty, not an error', () => {
    expect(readHSwarmLedger(join(tmpdir(), 'no-such-hswarm-home'))).toEqual([])
  })
})

describe('readDeepSeekKey', () => {
  isolateKeyEnv()

  test('env var wins when set', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-from-env'
    expect(readDeepSeekKey('/does/not/matter.yaml')).toBe('sk-from-env')
  })

  // The balance list_usage reports must be the account HSwarm spends from, so the swarm's own key
  // file is read the way hswarm/config.py reads it: a comment line is never taken for a key.
  test("HSwarm's secrets/deepseek_api_keys: its first key, ahead of the yaml file", () => {
    const secrets = join(process.env.HSWARM_HOME as string, 'secrets')
    mkdirSync(secrets, { recursive: true })
    writeFileSync(
      join(secrets, 'deepseek_api_keys'),
      '# funded 2026-10\n\nsk-from-swarm\nsk-second\n',
    )
    const yaml = join(newHome(), '.credentials.yaml')
    writeFileSync(yaml, "refs:\n  DEEPSEEK_API_KEY: 'sk-from-yaml'\n")
    expect(readDeepSeekKey(yaml)).toBe('sk-from-swarm')
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
  isolateKeyEnv()
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-key'
    resetHSwarmBalanceCache()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    resetHSwarmBalanceCache()
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
