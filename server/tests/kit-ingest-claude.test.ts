import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCliInstance, deleteCliInstance } from '../src/core/cli-instances'
import {
  type ClaudeFileOwner,
  type ClaudeRoot,
  classify,
  discoverClaudeRoots,
  ingestClaude,
} from '../src/kit/ingest-claude'
import { hourStart, KitStore } from '../src/kit/store'
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

describe('classify', () => {
  const at = (rel: string) => classify(join('r', 'projects'), join('r', 'projects', rel))
  test('a sub-agent id is the file under subagents/ without its extension, folders kept', () => {
    expect(at('p/s1.jsonl')).toEqual({ session: 's1', agent: 'main', agentId: null })
    expect(at('p/s1/subagents/agent-ab12.jsonl')).toEqual({
      session: 's1',
      agent: 'subagent',
      agentId: 'agent-ab12',
    })
    expect(at('p/s1/subagents/workflows/wf_1/agent-b.jsonl')?.agentId).toBe(
      'workflows/wf_1/agent-b',
    )
    expect(at('p/s1/other/agent-b.jsonl')).toBeNull()
  })
})

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
    expect(by.c).toMatchObject({
      agent: 'subagent',
      agent_id: 'agent-x',
      session: 's1',
      source: 'cli',
    })
    expect(by.a.agent_id).toBeNull()
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
      .query<
        {
          session: string
          instance: string
          calls: number
          output: number
          first_ts: number
          last_ts: number
        },
        []
      >(
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
    expect(ledger(f.store, 'usage_session_settled').map((r) => [r.session, r.calls])).toEqual([
      ['mix', 1],
      ['old', 2],
    ])
  })

  test('a session copied into two config dirs counts once, for raw and for old calls', async () => {
    const f = fixture()
    const opts = { maxBytesPerSec: Number.POSITIVE_INFINITY, now: NOW }
    const oldTs = NOW - 60 * DAY
    const text = reply('c1', oldTs) + reply('c2', NOW - 9000)
    const orig = f.file('orig/p/s.jsonl', text)
    f.file('copy/p/s.jsonl', text + reply('c3', oldTs + 1000)) // the copy carries on with one more old call
    utimesSync(orig, new Date(NOW - 5000), new Date(NOW - 5000)) // the original is the older file
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
    f.store.db.exec(
      "delete from meta where key in ('claude_ingest_version', 'claude_settled_tags')",
    ) // a store from before the tags
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

  test('a warm pass that skips unchanged folders still reads a new file, a new folder and a file that grew', async () => {
    const f = fixture()
    const opts = { maxBytesPerSec: Number.POSITIVE_INFINITY }
    const roots = [rootOf(f.dir, () => cliOwner(() => UUID_A))]
    f.file('p1/a.jsonl', reply('a1', NOW - 5000))
    f.file('p2/b.jsonl', reply('b1', NOW - 4000))
    await ingestClaude(f.store, roots, { ...opts, fullPass: true })
    expect(events(f.store).length).toBe(2)
    // the folder listings are remembered now; a pass over unchanged folders reads nothing
    expect((await ingestClaude(f.store, roots, { ...opts, fullPass: false })).events).toBe(0)

    await new Promise((r) => setTimeout(r, 30)) // a folder's mtime must move past the remembered one
    f.file('p1/c.jsonl', reply('c1', NOW - 3000))
    f.file('p3/d.jsonl', reply('d1', NOW - 2000))
    appendFileSync(join(f.dir, 'p2/b.jsonl'), reply('b2', NOW - 1000))
    await ingestClaude(f.store, roots, { ...opts, fullPass: false })
    expect(events(f.store).map((r) => r.id.slice(-2))).toEqual(['a1', 'b1', 'c1', 'd1', 'b2'])
  })

  test('a session copied into another instance keeps its calls with the first account that ran them', async () => {
    const f = fixture()
    const text = reply('x1', NOW - 9000) + reply('x2', NOW - 8000)
    const orig = f.file('orig/p/s.jsonl', text)
    utimesSync(orig, new Date(NOW - 5000), new Date(NOW - 5000)) // the original is the older file
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

  test('an upgrade keeps the history of a transcript that is gone and re-reads the one that remains', async () => {
    const f = fixture()
    const opts = { maxBytesPerSec: Number.POSITIVE_INFINITY, now: NOW }
    const roots = [rootOf(f.dir, () => cliOwner(() => UUID_A))]
    const oldTs = NOW - 60 * DAY
    const gone = f.file('p/gone.jsonl', reply('g1', oldTs) + reply('g2', NOW - 1000))
    f.file('p/kept.jsonl', reply('k1', oldTs) + reply('k2', NOW - 2000))
    await ingestClaude(f.store, roots, opts)
    f.store.runMaintenance(NOW)
    const totals = () => ({
      old: f.store.db
        .query('select sum(calls) as c from usage_hour where hour < ?')
        .get(hourStart(NOW - 35 * DAY)),
      all: f.store.db.query('select sum(calls) as c from usage_hour').get(),
      sessions: f.store.db
        .query(
          'select session, sum(calls) as c from usage_session group by session order by session',
        )
        .all(),
    })
    expect(totals()).toEqual({
      old: { c: 2 },
      all: { c: 4 },
      sessions: [
        { session: 'gone', c: 2 },
        { session: 'kept', c: 2 },
      ],
    })

    rmSync(gone)
    f.store.setMeta('claude_ingest_version', '2') // the previous version
    await ingestClaude(f.store, roots, opts)
    f.store.runMaintenance(NOW)
    // the gone transcript's old call survives, the kept one is re-read and counted once
    expect(totals()).toEqual({
      old: { c: 2 },
      all: { c: 4 },
      sessions: [
        { session: 'gone', c: 2 },
        { session: 'kept', c: 2 },
      ],
    })
  })

  test('a handoff copy that keeps the original mtime does not take the first account calls', async () => {
    const f = fixture()
    const text = reply('y1', NOW - 9000) + reply('y2', NOW - 8000) + reply('y3', NOW - 100)
    const a = f.file('A/p/s.jsonl', reply('y1', NOW - 9000) + reply('y2', NOW - 8000))
    const b = f.file('B/p/s.jsonl', text)
    // the copy keeps the original's mtime (cpSync preserveTimestamps), and B comes first in the roots
    for (const p of [a, b]) utimesSync(p, new Date(NOW - 5000), new Date(NOW - 5000))
    const roots = [
      rootOf(join(f.dir, 'B'), () => cliOwner(() => UUID_B, 'bee')),
      rootOf(join(f.dir, 'A'), () => cliOwner(() => UUID_A, 'ay')),
    ]
    // attempt 1 ran in A, a handoff attempt 2 started after y2 and ran in B
    const attempts = new Map([
      [
        's',
        [
          { startedAt: NOW - 20_000, configDir: join(f.dir, 'A') },
          { startedAt: NOW - 5000, configDir: join(f.dir, 'B') },
        ],
      ],
    ])
    await ingestClaude(f.store, roots, { maxBytesPerSec: Number.POSITIVE_INFINITY, attempts })
    expect(events(f.store).map((r) => [r.id.slice(-2), r.instance, r.source])).toEqual([
      ['y1', 'cli:ay', 'climayte'],
      ['y2', 'cli:ay', 'climayte'],
      ['y3', 'cli:bee', 'climayte'],
    ])
  })

  test('without attempt records, equal mtimes are broken by path, not by the order of the roots', async () => {
    const f = fixture()
    const text = reply('z1', NOW - 9000)
    const a = f.file('A/p/s.jsonl', text)
    const b = f.file('B/p/s.jsonl', text)
    for (const p of [a, b]) utimesSync(p, new Date(NOW - 5000), new Date(NOW - 5000))
    const mk = (order: string[]) =>
      order.map((n) => rootOf(join(f.dir, n), () => cliOwner(() => UUID_A, n)))
    await ingestClaude(f.store, mk(['B', 'A']), { maxBytesPerSec: Number.POSITIVE_INFINITY })
    expect(events(f.store).map((r) => r.instance)).toEqual(['cli:A'])
  })

  test('a CLI instance signed in to another account between two sweeps is attributed to it from then on', async () => {
    const name = `kit-holder-${crypto.randomUUID().slice(0, 8)}`
    const made = createCliInstance(name)
    expect(made.ok).toBe(true)
    try {
      const dir = made.dir as string
      writeFileSync(join(dir, '.credentials.json'), '{}')
      const signIn = (uuid: string, at: number) => {
        const p = join(dir, '.claude.json')
        writeFileSync(p, JSON.stringify({ oauthAccount: { accountUuid: uuid } }))
        utimesSync(p, new Date(at), new Date(at)) // the cache revalidates by mtime
      }
      const ownerOf = async () => {
        const r = (await discoverClaudeRoots()).find((x) => x.dir === join(dir, 'projects'))
        return r?.owner('x') as ClaudeFileOwner
      }
      signIn(UUID_A, NOW - 10_000)
      const first = await ownerOf()
      const t1 = Date.now()
      expect(first.accountAt(t1)).toBe(UUID_A)

      await new Promise((r) => setTimeout(r, 5))
      signIn(UUID_B, NOW - 5000)
      const second = await ownerOf()
      expect(second.accountAt(Date.now() + 1)).toBe(UUID_B)
      expect(second.accountAt(t1)).toBe(UUID_A) // what ran before the switch stays with A
    } finally {
      deleteCliInstance(made.data?.id as string, name)
    }
  })
})
