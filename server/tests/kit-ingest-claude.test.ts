import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ClaudeFileOwner, type ClaudeRoot, ingestClaude } from '../src/kit/ingest-claude'
import { KitStore } from '../src/kit/store'
import { hswarmAccountId } from '../src/routes/hswarm'

const root = mkdtempSync(join(tmpdir(), 'kit-claude-'))
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // a Windows handle still draining: the OS temp cleaner takes it
  }
})

const NOW = Date.now()
const DAY = 86_400_000
const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

/** One transcript line: an assistant reply (or one content block of it) with a usage block. */
function reply(id: string, ts: number, out = 50, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    requestId: `req_${id}`,
    message: {
      id: `msg_${id}`,
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 10,
        output_tokens: out,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 15 },
      },
    },
    ...extra,
  })}\n`
}

let n = 0
function fixture(): { dir: string; store: KitStore; file: (rel: string, text: string) => string } {
  const dir = join(root, `case${n++}`)
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    store: new KitStore(':memory:'),
    file: (rel, text) => {
      const p = join(dir, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, text)
      return p
    },
  }
}

const cliOwner = (accountAt: ClaudeFileOwner['accountAt'], id = 'inst1'): ClaudeFileOwner => ({
  instance: `cli:${id}`,
  source: 'cli',
  accountAt,
})
const rootOf = (dir: string, owner: (sid: string) => ClaudeFileOwner | null): ClaudeRoot => ({
  dir,
  owner,
})
const events = (store: KitStore) =>
  store.db.query('select * from usage_event order by ts, id').all() as Array<Record<string, any>>

describe('ingestClaude', () => {
  test('attributes instance, source, session, agent and tokens; repeated block lines are one call', async () => {
    const f = fixture()
    f.file(
      'proj/s1.jsonl',
      // three content blocks of one reply carry the same usage, then a second reply
      reply('a', NOW - 5000) +
        reply('a', NOW - 5000) +
        reply('a', NOW - 5000) +
        reply('b', NOW - 4000),
    )
    f.file('proj/s1/subagents/agent-x.jsonl', reply('c', NOW - 3000))
    f.file('proj/dsk.jsonl', reply('d', NOW - 2000))
    f.file('proj/cm.jsonl', reply('e', NOW - 1000))
    const desktop: ClaudeFileOwner = {
      instance: 'desktop:3claude',
      source: 'desktop',
      accountAt: () => UUID_B,
    }
    await ingestClaude(
      f.store,
      [rootOf(f.dir, (sid) => (sid === 'dsk' ? desktop : cliOwner(() => UUID_A)))],
      { pc: 'box', climayte: new Set(['cm']), maxBytesPerSec: Number.POSITIVE_INFINITY },
    )
    const rows = events(f.store)
    expect(rows.map((r) => r.id)).toEqual([
      'claude:msg_a',
      'claude:msg_b',
      'claude:msg_c',
      'claude:msg_d',
      'claude:msg_e',
    ])
    const by = Object.fromEntries(rows.map((r) => [r.id.slice(-1), r]))
    expect(by.a).toMatchObject({
      instance: 'cli:inst1',
      source: 'cli',
      session: 's1',
      agent: 'main',
      account: hswarmAccountId(UUID_A),
      pc: 'box',
      provider: 'anthropic',
      input: 10,
      output: 50,
      cache_read: 100,
      cache_write_5m: 5,
      cache_write_1h: 15,
    })
    expect(by.a.list_usd).toBeGreaterThan(0)
    expect(by.a.price_ver).toBeTruthy()
    expect(by.a.weighted).toBeGreaterThan(0)
    expect(by.c).toMatchObject({ agent: 'subagent', session: 's1', source: 'cli' })
    expect(by.d).toMatchObject({
      instance: 'desktop:3claude',
      source: 'desktop',
      account: hswarmAccountId(UUID_B),
    })
    expect(by.e.source).toBe('climayte')
  })

  test('an account switch mid-file splits the file by each message time', async () => {
    const f = fixture()
    const switchAt = NOW - 10_000
    f.file(
      'p/s.jsonl',
      reply('1', NOW - 20_000) + reply('2', NOW - 15_000) + reply('3', NOW - 5000),
    )
    await ingestClaude(
      f.store,
      [rootOf(f.dir, () => cliOwner((ts) => (ts < switchAt ? UUID_A : UUID_B)))],
      { maxBytesPerSec: Number.POSITIVE_INFINITY },
    )
    expect(events(f.store).map((r) => r.account)).toEqual([
      hswarmAccountId(UUID_A),
      hswarmAccountId(UUID_A),
      hswarmAccountId(UUID_B),
    ])
  })

  test('resumes from the cursor, holds an unfinished last line, and re-reads a shrunken file whole', async () => {
    const f = fixture()
    const opts = { maxBytesPerSec: Number.POSITIVE_INFINITY }
    const roots = [rootOf(f.dir, () => cliOwner(() => UUID_A))]
    const path = f.file('p/s.jsonl', reply('1', NOW - 9000) + reply('2', NOW - 8000))
    const first = await ingestClaude(f.store, roots, opts)
    expect(first).toMatchObject({ files: 1, events: 2 })

    // untouched: nothing is read
    const again = await ingestClaude(f.store, roots, opts)
    expect(again).toMatchObject({ files: 0, unchanged: 1, bytes: 0 })

    // grown by one finished reply and half of another: only the new bytes are read, the half waits
    const third = reply('3', NOW - 7000)
    const fourth = reply('4', NOW - 6000)
    appendFileSync(path, third + fourth.slice(0, 40))
    const grown = await ingestClaude(f.store, roots, opts)
    expect(grown.bytes).toBe(Buffer.byteLength(third) + 40)
    expect(grown.events).toBe(1)
    appendFileSync(path, fourth.slice(40))
    await ingestClaude(f.store, roots, opts)
    expect(events(f.store).map((r) => r.id)).toEqual([
      'claude:msg_1',
      'claude:msg_2',
      'claude:msg_3',
      'claude:msg_4',
    ])

    // shrunk (rewritten with a corrected value): read from byte 0, last write wins
    writeFileSync(path, reply('1', NOW - 9000, 999))
    const shrunk = await ingestClaude(f.store, roots, opts)
    expect(shrunk.events).toBe(1)
    const one = f.store.db.query("select output from usage_event where id = 'claude:msg_1'").get()
    expect(one).toEqual({ output: 999 })
  })

  test('calls older than the raw window go to usage_hour only, once, and a re-read does not add them again', async () => {
    const f = fixture()
    const opts = { maxBytesPerSec: Number.POSITIVE_INFINITY, now: NOW }
    const roots = [rootOf(f.dir, () => cliOwner(() => UUID_A))]
    const oldTs = NOW - 60 * DAY
    const path = f.file(
      'p/s.jsonl',
      reply('o1', oldTs) + reply('o1', oldTs) + reply('o2', oldTs + 1000) + reply('n1', NOW - 1000),
    )
    const sum = await ingestClaude(f.store, roots, opts)
    expect(sum).toMatchObject({ events: 1, hourly: 2 })
    expect(events(f.store).map((r) => r.id)).toEqual(['claude:msg_n1'])
    const hourly = () =>
      f.store.db
        .query('select sum(calls) as calls, sum(output) as output from usage_hour where hour < ?')
        .get(NOW - 40 * DAY) as { calls: number; output: number }
    expect(hourly()).toEqual({ calls: 2, output: 100 })

    // a shrink forces a whole re-read: the old rows were counted already
    writeFileSync(path, reply('o1', oldTs) + reply('o2', oldTs + 1000))
    await ingestClaude(f.store, roots, opts)
    expect(hourly()).toEqual({ calls: 2, output: 100 })
  })

  const ledger = (store: KitStore, table = 'usage_session') =>
    store.db
      .query(
        `select session, instance, calls, output, first_ts, last_ts from ${table} order by session, instance`,
      )
      .all()
  const hourTotals = (store: KitStore) =>
    store.db.query('select sum(calls) as calls, sum(output) as output from usage_hour').get()

  test('an old session has its total in the session ledger, settled part included, and a raw call joins it', async () => {
    const f = fixture()
    const opts = { maxBytesPerSec: Number.POSITIVE_INFINITY, now: NOW }
    const oldTs = NOW - 60 * DAY
    f.file('p/old.jsonl', reply('o1', oldTs) + reply('o2', oldTs + 5000, 70))
    f.file('p/mix.jsonl', reply('m1', oldTs) + reply('m2', NOW - 1000))
    await ingestClaude(f.store, [rootOf(f.dir, () => cliOwner(() => UUID_A))], opts)
    f.store.runMaintenance(NOW)
    const want = [
      {
        session: 'mix',
        instance: 'cli:inst1',
        calls: 2,
        output: 100,
        first_ts: oldTs,
        last_ts: NOW - 1000,
      },
      {
        session: 'old',
        instance: 'cli:inst1',
        calls: 2,
        output: 120,
        first_ts: oldTs,
        last_ts: oldTs + 5000,
      },
    ]
    expect(ledger(f.store)).toEqual(want)
    // the settled part holds only what is no longer raw
    expect(ledger(f.store, 'usage_session_settled').map((r: any) => [r.session, r.calls])).toEqual([
      ['mix', 1],
      ['old', 2],
    ])
  })

  test('a session copied into two config dirs counts once, for raw and for old calls', async () => {
    const f = fixture()
    const opts = { maxBytesPerSec: Number.POSITIVE_INFINITY, now: NOW }
    const oldTs = NOW - 60 * DAY
    const text = reply('c1', oldTs) + reply('c2', NOW - 9000)
    f.file('orig/p/s.jsonl', text)
    f.file('copy/p/s.jsonl', text + reply('c3', oldTs + 1000)) // the copy carries on with one more old call
    const roots = [
      rootOf(join(f.dir, 'orig'), () => cliOwner(() => UUID_A, 'one')),
      rootOf(join(f.dir, 'copy'), () => cliOwner(() => UUID_B, 'two')),
    ]
    await ingestClaude(f.store, roots, opts)
    f.store.runMaintenance(NOW)
    expect(hourTotals(f.store)).toEqual({ calls: 3, output: 150 })
    expect(ledger(f.store)).toEqual([
      {
        session: 's',
        instance: 'cli:one',
        calls: 2,
        output: 100,
        first_ts: oldTs,
        last_ts: NOW - 9000,
      },
      {
        session: 's',
        instance: 'cli:two',
        calls: 1,
        output: 50,
        first_ts: oldTs + 1000,
        last_ts: oldTs + 1000,
      },
    ])
  })

  test('the upgrade drops only Claude old rows and settled sessions, and the next sweep counts them once', async () => {
    const f = fixture()
    const opts = { maxBytesPerSec: Number.POSITIVE_INFINITY, now: NOW }
    const roots = [rootOf(f.dir, () => cliOwner(() => UUID_A))]
    const oldTs = NOW - 60 * DAY
    f.file('p/s.jsonl', reply('u1', oldTs) + reply('u2', NOW - 1000))
    await ingestClaude(f.store, roots, opts)
    f.store.runMaintenance(NOW)
    const claude = () =>
      f.store.db
        .query(
          "select sum(calls) as calls, sum(output) as output from usage_hour where source = 'cli'",
        )
        .get()
    expect(claude()).toEqual({ calls: 2, output: 100 })

    // an HSwarm row below the cut, and what 7356156f's ingest left: the old call counted a second time
    f.store.addToHourly([{ id: 'h1', ts: oldTs, source: 'hswarm', instance: 'hs', output: 7 }])
    f.store.addToHourly([
      { id: 'dup', ts: oldTs, source: 'cli', instance: 'cli:inst1', output: 50 },
    ])
    f.store.db.exec("delete from meta where key = 'claude_ingest_version'")
    f.store.db.exec('update ingest_cursor set version = 1')
    f.store.db.exec('delete from settled_claim')

    await ingestClaude(f.store, roots, opts)
    f.store.runMaintenance(NOW)
    const hour = f.store.db
      .query(
        'select source, sum(calls) as calls, sum(output) as output from usage_hour group by source order by source',
      )
      .all()
    expect(hour).toEqual([
      { source: 'cli', calls: 2, output: 100 },
      { source: 'hswarm', calls: 1, output: 7 },
    ])
    expect(ledger(f.store)).toEqual([
      {
        session: 's',
        instance: 'cli:inst1',
        calls: 2,
        output: 100,
        first_ts: oldTs,
        last_ts: NOW - 1000,
      },
    ])

    // current version: a further sweep does not reset anything
    await ingestClaude(f.store, roots, { ...opts, fullPass: true })
    f.store.runMaintenance(NOW)
    expect(claude()).toEqual({ calls: 2, output: 100 })
  })

  test('a session copied into another instance keeps its calls with the first account that ran them', async () => {
    const f = fixture()
    const text = reply('x1', NOW - 9000) + reply('x2', NOW - 8000)
    f.file('orig/p/s.jsonl', text)
    f.file('copy/p/s.jsonl', text + reply('x3', NOW - 1000)) // the handoff target carries on from the copy
    const roots = [
      rootOf(join(f.dir, 'orig'), () => cliOwner(() => UUID_A, 'one')),
      rootOf(join(f.dir, 'copy'), () => cliOwner(() => UUID_B, 'two')),
    ]
    // the copy is the newer file, so it is read last whichever way the roots are listed
    await ingestClaude(f.store, roots, { maxBytesPerSec: Number.POSITIVE_INFINITY })
    expect(events(f.store).map((r) => [r.id.slice(-2), r.instance])).toEqual([
      ['x1', 'cli:one'],
      ['x2', 'cli:one'],
      ['x3', 'cli:two'],
    ])
  })
})
