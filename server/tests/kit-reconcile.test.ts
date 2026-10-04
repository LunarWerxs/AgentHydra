import { describe, expect, test } from 'bun:test'
import { type OldReaders, reconcile } from '../src/kit/reconcile'
import { KitStore, type UsageEventInput } from '../src/kit/store'
import { hswarmAccountId } from '../src/routes/hswarm'

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const H = 3_600_000
// A made-up account uuid: the kit holds its hashed id, the old ledger the uuid itself.
const UUID = '00000000-0000-4000-8000-000000000001'

const ev = (id: string, source: string, o: Partial<UsageEventInput> = {}): UsageEventInput => ({
  id,
  ts: NOW - H,
  source,
  model: 'm',
  input: 100,
  output: 50,
  list_usd: 1,
  ...o,
})

// Both sides see the same calls: 150 tokens and $1 each.
function seed(store: KitStore) {
  store.upsertEvents([
    ev('d1', 'desktop'),
    ev('c1', 'cli', { instance: 'cli:i1', account: hswarmAccountId(UUID) }),
    ev('m1', 'climayte', { instance: 'cli:i1', account: hswarmAccountId(UUID) }),
    ev('x1', 'codex'),
    ev('h1', 'hswarm', { billed_usd: 0.5, list_usd: 2, ok: true }),
  ])
}

const same: OldReaders = {
  spend: () => ({
    claude: { tokens: 450, usd: 3 },
    byProvider: { claude: { tokens: 450, usd: 3 }, codex: { tokens: 150, usd: 1 } },
  }),
  cliTokens: () => ({
    byInstance: [{ id: 'i1', name: 'work', tokens: 150 }],
    byAccount: { [UUID]: 300 },
  }),
  climayte: () => ({ tokens: 150, usd: 1 }),
  hswarm: () => ({ calls: 1, billedUsd: 0.5, listUsd: 2 }),
}

const row = (r: Awaited<ReturnType<typeof reconcile>>, name: string) => {
  const found = r.rows.find((x) => x.name === name)
  if (!found) throw new Error(`no row ${name}`)
  return found
}

describe('kit reconcile', () => {
  test('the same calls on both sides give 0% gaps', async () => {
    const store = new KitStore(':memory:')
    seed(store)
    // every source's first event is inside the window, and the window starts before them
    const r = await reconcile({ last: '24h' }, same, { store, now: NOW })
    for (const name of [
      'claude tokens',
      'claude list $',
      'codex tokens',
      'cli instance work tokens',
      `account ${hswarmAccountId(UUID)} tokens`,
      'climayte tokens',
      'climayte list $',
      'hswarm calls',
      'hswarm billed $',
      'hswarm list $',
    ])
      expect(row(r, name).gapPct).toBe(0)
  })

  test('an account the old side knows by uuid pairs with the kit hashed id in ONE row', async () => {
    const store = new KitStore(':memory:')
    seed(store)
    const r = await reconcile({ last: '24h' }, same, { store, now: NOW })
    expect(r.rows.filter((x) => x.name.startsWith('account '))).toHaveLength(1)
    expect(row(r, `account ${hswarmAccountId(UUID)} tokens`)).toMatchObject({ kit: 300, old: 300 })
    // the instance pairs on the kit's cli:<id> key and is labelled with the display name
    expect(r.rows.filter((x) => x.name.startsWith('cli instance'))).toHaveLength(1)
  })

  test('a deliberate difference shows the right gap', async () => {
    const store = new KitStore(':memory:')
    seed(store)
    const off: OldReaders = { ...same, climayte: () => ({ tokens: 120, usd: 1 }) }
    const r = await reconcile({ last: '24h' }, off, { store, now: NOW })
    expect(row(r, 'climayte tokens')).toMatchObject({ kit: 150, old: 120, gapPct: 25 })
    expect(row(r, 'climayte list $').gapPct).toBe(0)
  })

  test('a source the kit has not ingested is partial, not a disagreement', async () => {
    const store = new KitStore(':memory:')
    seed(store)
    // OpenCode has run on the old side but the kit holds nothing of it yet; Codex starts mid-window.
    const old: OldReaders = {
      ...same,
      spend: () => ({
        claude: { tokens: 450, usd: 3 },
        byProvider: { opencode: { tokens: 999, usd: 9 }, codex: { tokens: 150, usd: 1 } },
      }),
    }
    const r = await reconcile({ last: '7d' }, old, { store, now: NOW })
    expect(row(r, 'opencode tokens')).toMatchObject({ coverage: 'none', gapPct: -100 })
    expect(row(r, 'opencode tokens').note).toContain('partial')
    // Codex's first event is 1 h old: the 7-day window starts before the kit's data does.
    expect(row(r, 'codex tokens')).toMatchObject({ coverage: 'partial', gapPct: 0 })
  })
})
