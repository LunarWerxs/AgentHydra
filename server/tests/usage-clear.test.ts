// server/tests/usage-clear.test.ts — a row's usage cleared from the tables (owner, 2026-10-02:
// "clear the like old 5hour and usage stats in the ui", "not like delete the stats").
//
// The contract (usage-cache.ts clearUsageFromTables, routes/usage.ts): after POST /api/usage/clear,
// what the tables read (/api/usage/cache, its live and its kept readings, and /api/cli-instances'
// lastUsageCheck) carries no reading of that row taken up to the clear, and a reading taken after it
// shows again. The stored readings stay, since CliMayte and the account survey rank accounts by them,
// and a row nobody cleared is untouched. CONFIG_DIR and DATA_DIR are scratch dirs (tests/setup.ts).

import { afterAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  setCliInstanceUsage,
} from '../src/core/cli-instances'
import { app } from '../src/http-app'
import '../src/routes/usage'
import type { UsageSnapshot } from '../src/types'
import { allCachedUsage, dropCachedUsage, lastKnownUsage, setCachedUsage } from '../src/usage-cache'

// http-app.ts is ONE object for the whole test process; request through a copy (see
// queue-patch-guard.test.ts) so it stays open for later files.
const http = new Hono().route('/', app)

const reading = (pct: number, capturedAt: string): UsageSnapshot => ({
  account: null,
  session: { pct, resets: 'in 1 hr', resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
  weekAll: { pct, resets: 'tomorrow', resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
  weekModel: null,
  capturedAt,
})

const run = crypto.randomUUID().slice(0, 8)
const live = `desktop:C:/test/usage-clear-live-${run}` // signed in: a cached reading
const kept = `desktop:C:/test/usage-clear-kept-${run}` // signed out: its reading kept, dimmed
const other = `desktop:C:/test/usage-clear-other-${run}` // never cleared
const cliId = crypto.randomUUID()
const cliName = `usage-clear-${run}`
const hourAgo = new Date(Date.now() - 3_600_000).toISOString()

const tables = async () => {
  const res = await http.request('/api/usage/cache')
  return (await res.json()) as {
    cache: Record<string, UsageSnapshot>
    lastKnown: Record<string, UsageSnapshot>
  }
}
const cliRow = async () => {
  const res = await http.request('/api/cli-instances')
  const rows = (await res.json()) as { id: string; lastUsageCheck: UsageSnapshot | null }[]
  return rows.find((r) => r.id === cliId)
}

afterAll(() => {
  for (const key of [live, kept, other]) dropCachedUsage(key)
  deleteCliInstance(cliId, cliName)
})

describe('clearing a row’s usage from the tables', () => {
  test('hides the readings taken up to the clear, keeps them stored, and shows a newer one', async () => {
    setCachedUsage(live, reading(80, hourAgo))
    setCachedUsage(kept, reading(60, hourAgo))
    dropCachedUsage(kept, { keepLastKnown: true })
    setCachedUsage(other, reading(40, hourAgo))
    expect(createCliInstance(cliName, { id: cliId }).ok).toBe(true)
    setCliInstanceUsage(cliId, reading(70, hourAgo))

    const before = await tables()
    expect(before.cache[live]?.session?.pct).toBe(80)
    expect(before.lastKnown[kept]?.session?.pct).toBe(60)
    expect((await cliRow())?.lastUsageCheck?.session?.pct).toBe(70)

    const res = await http.request('/api/usage/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [live, kept, `cli:${cliId}`] }),
    })
    expect(res.status).toBe(200)
    const { clearedAt } = (await res.json()) as { clearedAt: string }

    const after = await tables()
    expect(after.cache[live]).toBeUndefined()
    expect(after.lastKnown[kept]).toBeUndefined()
    expect(after.cache[other]?.session?.pct).toBe(40)
    expect((await cliRow())?.lastUsageCheck).toBeNull()

    // Nothing was deleted: what ranks accounts still reads every number.
    expect(allCachedUsage()[live]?.session?.pct).toBe(80)
    expect(lastKnownUsage()[kept]?.session?.pct).toBe(60)
    expect(getCliInstance(cliId)?.lastUsageCheck?.session?.pct).toBe(70)

    const later = new Date(Date.parse(clearedAt) + 1000).toISOString()
    setCachedUsage(live, reading(15, later))
    setCliInstanceUsage(cliId, reading(25, later))
    expect((await tables()).cache[live]?.session?.pct).toBe(15)
    expect((await cliRow())?.lastUsageCheck?.session?.pct).toBe(25)
  })

  test('refuses a list that is not usage keys', async () => {
    for (const keys of [[], ['nope'], [live, 7]]) {
      const res = await http.request('/api/usage/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys }),
      })
      expect(res.status).toBe(400)
    }
  })
})
