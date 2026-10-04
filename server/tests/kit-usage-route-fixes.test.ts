import { afterAll, describe, expect, test } from 'bun:test'
import { KitStore } from '../src/kit/store'
import { labelSpendAccounts, SESSION_TOOLS } from '../src/mcp-session-tools'
import { hswarmAccountId } from '../src/routes/hswarm'
import { kitTokensFor } from '../src/routes/usage'
import type { UsageSnapshot } from '../src/types'

const H = 3_600_000
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)
const UUID = 'AAAAAAAA-0000-4000-8000-00000000000A'
const ACCOUNT = hswarmAccountId(UUID.toLowerCase())

const store = new KitStore(':memory:', { now: NOW })
afterAll(() => store.close())
let n = 0
const ev = (ago: number, input: number) => ({
  id: `e${++n}`,
  ts: NOW - ago,
  source: 'cli',
  account: ACCOUNT,
  input,
  output: 0,
  cache_read: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
})
store.upsertEvents([ev(30 * 60_000, 1), ev(2 * H, 10), ev(4 * H, 100)])

const snap = (sessionReset: string | null, capturedAt: string): UsageSnapshot =>
  ({
    account: null,
    session: sessionReset ? { percent: 10, resetsAt: sessionReset } : null,
    weekAll: null,
    weekModel: null,
    capturedAt,
  }) as unknown as UsageSnapshot

describe('kitTokensFor', () => {
  test('a mixed-case login uuid is found by the caller’s own spelling', () => {
    const out = kitTokensFor([{ uuid: UUID, snapshot: null }], { store, now: NOW })
    expect(out.get(UUID)?.total.input).toBe(111)
  })

  test('rows sharing an account: a future reset beats a later-captured stale one', () => {
    // Row A's snapshot is older but its reset (in 3h) is still ahead: the 5h window began 2h ago.
    const fresh = snap(new Date(NOW + 3 * H).toISOString(), new Date(NOW - 3 * H).toISOString())
    // Row B was captured later, but its reset is already past: it must not win.
    const stale = snap(new Date(NOW - H).toISOString(), new Date(NOW - 60_000).toISOString())
    const out = kitTokensFor(
      [
        { uuid: UUID, snapshot: fresh },
        { uuid: UUID.toLowerCase(), snapshot: stale },
      ],
      { store, now: NOW },
    )
    // Window starts at reset - 5h = NOW - 2h: holds the 30-minute-old event and the 2h-old edge.
    expect(out.get(UUID)?.fiveHour.input).toBe(11)
    expect(out.get(UUID.toLowerCase())?.fiveHour.input).toBe(11)
  })
})

describe('get_spend', () => {
  test('byAccount entries get the readable label the web uses', () => {
    const out = labelSpendAccounts(
      { byAccount: [{ key: 'acct-1' }, { key: 'acct-2' }] },
      { 'acct-1': { label: 'Work' } },
    ) as { byAccount: Array<{ key: string; label: string | null }> }
    expect(out.byAccount.map((b) => b.label)).toEqual(['Work', null])
  })

  test('its description sends the agent to the kit’s coverage, not the old background scan', () => {
    const d = SESSION_TOOLS.find((t) => t.name === 'get_spend')?.description ?? ''
    expect(d).toContain('kitCoverage')
    expect(d).not.toContain('background scan')
  })
})
