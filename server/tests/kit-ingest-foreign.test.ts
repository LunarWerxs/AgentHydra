import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { type ForeignSources, ingestForeign } from '../src/kit/ingest-foreign'
import { KitStore } from '../src/kit/store'

const root = mkdtempSync(join(tmpdir(), 'kit-foreign-'))
afterAll(() => {
  oc.close()
  hm.close()
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // a Windows handle still draining: the OS temp cleaner takes it
  }
})

const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()
const jl = (rows: unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('')

const meta = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  type: 'session_meta',
  timestamp: iso(NOW - 5000),
  payload: { session_id: sessionId, ...extra },
})
const ctx = (model: string) => ({
  type: 'turn_context',
  timestamp: iso(NOW - 4000),
  payload: { model },
})
const tokens = (at: number, input: number, cached: number, output: number) => ({
  type: 'event_msg',
  timestamp: iso(at),
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
      },
    },
  },
})

/** One API response's own usage, the per-call line Codex writes since 2026-09 (input includes the cached part). */
const record = (at: number, responseId: string, input: number, cached: number, output: number) => ({
  timestamp: iso(at),
  type: 'token_usage_record',
  payload: {
    response_id: responseId,
    usage: {
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: input + output,
    },
  },
})

// ---- fixtures ----
const codexRoot = join(root, 'codex', 'sessions')
const codexArchive = join(root, 'codex', 'archived_sessions')
mkdirSync(join(codexRoot, '2026', '01'), { recursive: true })
mkdirSync(codexArchive, { recursive: true })
const mainRollout = join(codexRoot, '2026', '01', 'rollout-a.jsonl')
const mainBody = jl([
  meta('sess-main'),
  ctx('gpt-5'),
  tokens(NOW - 3000, 1000, 800, 50),
  tokens(NOW - 2000, 1500, 1200, 90),
])
writeFileSync(mainRollout, mainBody)
// The same rollout seen in the archive while a move settles.
writeFileSync(join(codexArchive, 'rollout-a.jsonl'), mainBody)
// A subagent: lines 0-2 copy the parent's history (its counter included), then its own counter starts.
writeFileSync(
  join(codexRoot, '2026', '01', 'rollout-sub.jsonl'),
  jl([
    meta('sess-sub', { thread_source: 'subagent', subagent_history_start_ordinal: 3 }),
    ctx('gpt-5'),
    tokens(NOW - 2000, 1500, 1200, 90),
    tokens(NOW - 800, 200, 100, 20),
    tokens(NOW - 700, 260, 150, 30),
  ]),
)
// A subagent from before Codex wrote the ordinal: its copied lines carry the spawn's own timestamp.
writeFileSync(
  join(codexRoot, '2026', '01', 'rollout-fork.jsonl'),
  jl([
    meta('sess-fork', { source: { subagent: { thread_spawn: {} } } }),
    ctx('gpt-5'),
    tokens(NOW - 5000, 1500, 1200, 90),
  ]),
)
// A rollout that spends before it names its model.
const lateRollout = join(codexRoot, '2026', '01', 'rollout-late.jsonl')
writeFileSync(lateRollout, jl([meta('sess-late'), tokens(NOW - 1000, 100, 0, 10)]))

const dshHome = join(root, 'dsh')
const dshDir = join(dshHome, 'sessions', '--p--', 'dsh-1')
mkdirSync(dshDir, { recursive: true })
const dshLog = join(dshDir, 'session.v3.jsonl')
const dshMsg = (seq: number, at: number, input: number, output: number) => ({
  type: 'assistant/message',
  seq,
  time: at,
  data: {
    message: {
      role: 'assistant',
      source: { provider: 'deepseek-official', model: 'deepseek-flash' },
    },
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 5, reasoningTokens: 2 },
  },
})
writeFileSync(
  dshLog,
  jl([
    { type: 'session', id: 'dsh-1', cwd: '/w', createdAt: NOW - 9000 },
    dshMsg(1, NOW - 3000, 10, 4),
    dshMsg(2, NOW - 2000, 20, 6),
  ]),
)

// OpenCode's store: a message per assistant turn and a part per step in it. A `step-finish` part carries
// that step's own tokens and cost.
const openCodeDb = (path: string) => {
  const db = new Database(path)
  db.exec(`
    create table message (id text primary key, session_id text not null, time_created integer not null,
      time_updated integer not null, data text not null);
    create table part (id text primary key, message_id text not null, session_id text not null,
      time_created integer not null, time_updated integer not null, data text not null);`)
  return db
}
interface OcStep {
  at: number
  input: number
  output: number
  cacheRead: number
  cost: number
}
let ocIds = 0
/** One assistant message of `session`, with a step-start and a step-finish part per step. */
const addOcMessage = (db: Database, session: string, steps: OcStep[]) => {
  const msg = `msg-${++ocIds}`
  const at = steps[0]?.at ?? NOW
  db.query('insert into message values (?,?,?,?,?)').run(
    msg,
    session,
    at,
    at,
    JSON.stringify({ role: 'assistant', modelID: 'glm-5', providerID: 'zhipu' }),
  )
  const part = (when: number, data: Record<string, unknown>) =>
    db
      .query('insert into part values (?,?,?,?,?,?)')
      .run(`prt-${++ocIds}`, msg, session, when, when, JSON.stringify(data))
  for (const s of steps) {
    part(s.at - 100, { type: 'step-start' })
    part(s.at, {
      type: 'step-finish',
      reason: 'stop',
      tokens: {
        input: s.input,
        output: s.output,
        reasoning: 0,
        cache: { read: s.cacheRead, write: 0 },
      },
      cost: s.cost,
    })
  }
}
const ocPath = join(root, 'opencode.db')
const oc = openCodeDb(ocPath)
addOcMessage(oc, 'oc-1', [
  { at: NOW - 3000, input: 60, output: 25, cacheRead: 300, cost: 0.15 },
  { at: NOW - 2500, input: 40, output: 15, cacheRead: 200, cost: 0.1 },
])

const hermesDb = (path: string) => {
  const db = new Database(path)
  db.exec(`
  create table sessions (id text primary key, cwd text, display_name text, title text,
    started_at real, ended_at real, last_activity_at real, archived integer not null default 0,
    parent_session_id text);
  create table messages (id integer primary key autoincrement, session_id text not null, role text not null,
    content text, tool_call_id text, tool_calls text, tool_name text, timestamp real not null,
    active integer not null default 1);
  create table session_model_usage (session_id text not null, model text not null,
    billing_provider text not null default '', billing_base_url text not null default '',
    billing_mode text not null default '', task text not null default '',
    api_call_count integer not null default 0, input_tokens integer not null default 0,
    output_tokens integer not null default 0, cache_read_tokens integer not null default 0,
    cache_write_tokens integer not null default 0, reasoning_tokens integer not null default 0,
    estimated_cost_usd real not null default 0, actual_cost_usd real not null default 0,
    first_seen real, last_seen real);`)
  return db
}
const hmPath = join(root, 'state.db')
const hm = hermesDb(hmPath)
const addHm = (id: string, atMs: number) => {
  hm.query('insert into sessions values (?,?,?,?,?,?,?,0,null)').run(
    id,
    '/w',
    'n',
    't',
    atMs / 1000,
    null,
    atMs / 1000,
  )
  hm.query(
    `insert into session_model_usage (session_id, model, api_call_count, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, reasoning_tokens, first_seen, last_seen)
     values (?, 'hm-model', 3, 70, 30, 200, 0, 0, ?, ?)`,
  ).run(id, atMs / 1000, atMs / 1000)
}
addHm('hm-1', NOW - 3000)

const sources: ForeignSources = {
  codex: [
    { root: codexRoot, instance: 'codex:default' },
    { root: codexArchive, instance: 'codex:default' },
  ],
  opencode: [{ dbPath: ocPath, tool: 'opencode' }],
  hermes: [{ dbPath: hmPath, profile: null }],
  dsh: [{ home: dshHome, instance: 'dsh:default' }],
}

const totals = (s: KitStore) =>
  Object.fromEntries(
    (
      s.db
        .query(
          'select source, count(*) as calls, sum(input) as input, sum(output) as output, sum(cache_read) as cache_read from usage_event group by source',
        )
        .all() as Array<{
        source: string
        calls: number
        input: number
        output: number
        cache_read: number
      }>
    ).map((r) => [r.source, r]),
  )

const codexByAgent = (s: KitStore) =>
  s.db
    .query(
      `select agent, group_concat(distinct session) as sessions, count(*) as calls, sum(input) as input,
         sum(output) as output, sum(cache_read) as cache_read
       from usage_event where source = 'codex' group by agent order by agent`,
    )
    .all()

/** A zip of deflated entries, the way Codex packs a month of archived rollouts. */
function writeZip(path: string, files: Array<[name: string, text: string]>): void {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of files) {
    const body = Buffer.from(text)
    const packed = deflateRawSync(body)
    const nameBytes = Buffer.from(name)
    const crc = Bun.hash.crc32(body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(body.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, packed)
    central.push(entry, nameBytes)
    offset += 30 + nameBytes.length + packed.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  writeFileSync(path, Buffer.concat([...locals, dir, end]))
}

describe('foreign ingest into the kit store', () => {
  const store = new KitStore(':memory:')

  test("every provider lands, a duplicate rollout or a subagent's copied history adds nothing, a re-run is a no-op", async () => {
    const first = await ingestForeign(store, sources)
    const t = totals(store)
    // gpt-5 main: deltas of the running total, cached input taken OUT of input; plus the late rollout.
    // The subagent's own counter starts below the copied one (a reset): its first total is its first turn.
    expect(codexByAgent(store)).toEqual([
      {
        agent: 'main',
        sessions: expect.any(String),
        calls: 3,
        input: 200 + 100 + 100,
        output: 50 + 40 + 10,
        cache_read: 800 + 400,
      },
      {
        agent: 'subagent',
        sessions: 'sess-sub',
        calls: 2,
        input: 100 + 10,
        output: 20 + 10,
        cache_read: 100 + 50,
      },
    ])
    expect(t.dsh).toMatchObject({ calls: 2, input: 30, output: 10, cache_read: 10 })
    // One call per step, at the step's own time, each with OpenCode's own price for it.
    expect(t.opencode).toMatchObject({ calls: 2, input: 100, output: 40, cache_read: 500 })
    expect(t.hermes).toMatchObject({ calls: 1, input: 70, output: 30, cache_read: 200 })
    expect(first.files).toBeGreaterThan(0)

    const billed = store.db
      .query(
        "select ts, billed_usd, provider from usage_event where source = 'opencode' order by ts",
      )
      .all()
    expect(billed).toEqual([
      { ts: NOW - 3000, billed_usd: 0.15, provider: 'zhipu' },
      { ts: NOW - 2500, billed_usd: 0.1, provider: 'zhipu' },
    ])
    expect(
      store.db.query("select provider from usage_event where source = 'dsh' limit 1").get(),
    ).toEqual({
      provider: 'deepseek-official',
    })

    const again = await ingestForeign(store, sources)
    expect(again.files).toBe(0)
    expect(again.skipped).toBeGreaterThan(0)
    expect(totals(store)).toEqual(t)
  })

  test('a file that grows adds only its new calls', async () => {
    const before = totals(store)
    appendFileSync(mainRollout, jl([tokens(NOW - 1500, 2000, 1500, 100)]))
    appendFileSync(dshLog, jl([dshMsg(3, NOW - 1000, 7, 3)]))
    addOcMessage(oc, 'oc-2', [{ at: NOW - 500, input: 10, output: 5, cacheRead: 0, cost: 0.01 }])
    addHm('hm-2', NOW - 500)

    const sum = await ingestForeign(store, sources)
    expect(sum.events).toEqual({ codex: 1, dsh: 1, opencode: 1, hermes: 1 })
    const after = totals(store)
    expect(after.codex?.calls).toBe((before.codex?.calls ?? 0) + 1)
    expect(after.codex?.input).toBe((before.codex?.input ?? 0) + 200) // 500 more input, 300 of it cached
    expect(after.dsh?.calls).toBe(3)
    expect(after.opencode?.calls).toBe(3)
    expect(after.hermes?.calls).toBe(2)
  })

  test('turns that spent before the rollout named a model are attributed once it does', async () => {
    const model = () =>
      (
        store.db.query("select model from usage_event where session = 'sess-late'").get() as {
          model: string
        }
      ).model
    expect(model()).toBe('codex')
    appendFileSync(lateRollout, jl([ctx('gpt-5')]))
    await ingestForeign(store, sources)
    expect(model()).toBe('gpt-5')
    expect(totals(store).codex?.calls).toBe(6)
  })
  test('two rollouts of one session count only the larger, however the sweep is split', async () => {
    const dir = join(root, 'codex2')
    mkdirSync(dir, { recursive: true })
    const big = join(dir, 'rollout-big.jsonl')
    const small = join(dir, 'rollout-big_other.jsonl')
    writeFileSync(
      big,
      jl([
        meta('sess-two'),
        ctx('gpt-5'),
        tokens(NOW - 3000, 1000, 0, 10),
        tokens(NOW - 2000, 3000, 0, 30),
      ]),
    )
    // A restarted counter: its first delta is large, and it must not overwrite the other's turns.
    writeFileSync(small, jl([meta('sess-two'), ctx('gpt-5'), tokens(NOW - 1000, 500, 0, 5)]))
    const s2 = new KitStore(':memory:')
    const src: ForeignSources = {
      codex: [{ root: dir, instance: 'codex:default' }],
      opencode: [],
      hermes: [],
      dsh: [],
    }
    await ingestForeign(s2, src)
    expect(totals(s2).codex).toMatchObject({ calls: 2, input: 3000, output: 30 })
    // The loser grows past the winner: it is read again from its start and now counts alone.
    appendFileSync(small, jl([tokens(NOW - 500, 9000, 0, 90)]))
    await ingestForeign(s2, src)
    expect(totals(s2).codex).toMatchObject({ calls: 2, input: 9000, output: 90 })
    await ingestForeign(s2, src)
    expect(totals(s2).codex).toMatchObject({ calls: 2, input: 9000, output: 90 })
    s2.close()
  })

  test('a rollout packed into a zip is read, and once only beside its loose copy', async () => {
    const home = join(root, 'codex3')
    const sessionsDir = join(home, 'sessions', '2026', '01')
    const packedDir = join(home, 'archived_sessions', '_packed')
    mkdirSync(sessionsDir, { recursive: true })
    mkdirSync(packedDir, { recursive: true })
    const name = (id: string) =>
      `rollout-2026-01-02T03-04-05-00000000-0000-4000-8000-00000000000${id}.jsonl`
    const bodyA = jl([
      meta('sess-a'),
      ctx('gpt-5'),
      tokens(NOW - 3000, 1000, 0, 10),
      tokens(NOW - 2000, 3000, 0, 30),
    ])
    const bodyB = jl([meta('sess-b'), ctx('gpt-5'), tokens(NOW - 1000, 400, 100, 4)])
    writeFileSync(join(sessionsDir, name('a')), bodyA)
    writeZip(join(packedDir, 'codex-sessions-2026-01.zip'), [
      [`2026/01/${name('a')}`, bodyA],
      [`2026/01/${name('b')}`, bodyB],
    ])
    const s3 = new KitStore(':memory:')
    const src: ForeignSources = {
      codex: [
        { root: join(home, 'sessions'), instance: 'codex:default' },
        { root: join(home, 'archived_sessions'), instance: 'codex:default' },
      ],
      opencode: [],
      hermes: [],
      dsh: [],
    }
    await ingestForeign(s3, src)
    const want = { calls: 3, input: 3000 + 300, output: 34, cache_read: 100 }
    expect(totals(s3).codex).toMatchObject(want)
    const again = await ingestForeign(s3, src)
    expect(again.files).toBe(0)
    expect(totals(s3).codex).toMatchObject(want)
    s3.close()
  })

  test('a rollout that records its calls counts each once, whatever its pages and copies say', async () => {
    const home = join(root, 'codex4')
    const day = join(home, 'a', 'sessions', '2026', '10')
    const other = join(home, 'b', 'sessions', '2026', '10')
    mkdirSync(day, { recursive: true })
    mkdirSync(other, { recursive: true })
    const uuid = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`
    const name = (...ids: string[]) => `rollout-2026-10-02T03-04-05-${ids.join('_')}.jsonl`
    const original = jl([
      meta('thread-a'),
      ctx('gpt-5'),
      record(NOW - 3000, 'resp-1', 1000, 800, 50),
      tokens(NOW - 2990, 1000, 800, 50),
      record(NOW - 2000, 'resp-2', 600, 500, 30),
      tokens(NOW - 1990, 1600, 1300, 80),
    ])
    writeFileSync(join(day, name(uuid(1))), original)
    // A later page of the same thread: its first running total carries the whole base before its own call.
    writeFileSync(
      join(day, name(uuid(1), uuid(2))),
      jl([
        meta('thread-a', { history_mode: 'paginated', history_base: { thread_id: 'thread-a' } }),
        ctx('gpt-5'),
        record(NOW - 1000, 'resp-3', 2000, 1500, 40),
        tokens(NOW - 990, 3600, 2800, 120),
      ]),
    )
    // The thread moved to another account: the same records under a new file name.
    writeFileSync(join(other, name(uuid(3))), original)
    const s4 = new KitStore(':memory:')
    await ingestForeign(s4, {
      codex: [
        { root: join(home, 'a', 'sessions'), instance: 'codex:a' },
        { root: join(home, 'b', 'sessions'), instance: 'codex:b' },
      ],
      opencode: [],
      hermes: [],
      dsh: [],
    })
    expect(totals(s4).codex).toMatchObject({
      calls: 3,
      input: 200 + 100 + 500,
      output: 50 + 30 + 40,
      cache_read: 800 + 500 + 1500,
    })
    expect(
      s4.db.query("select distinct instance from usage_event where source = 'codex'").all(),
    ).toEqual([{ instance: 'codex:a' }])
    s4.close()
  })

  test('a store holding Codex rows under the old ids ends with the re-read ones, once', async () => {
    const dir = join(root, 'codex5', 'sessions', '2026', '08')
    mkdirSync(dir, { recursive: true })
    const id = '00000000-0000-4000-8000-000000000050'
    const path = join(dir, `rollout-2026-08-01T00-00-00-${id}.jsonl`)
    const OLD = NOW - 40 * 86_400_000
    writeFileSync(
      path,
      jl([meta('sess-old'), ctx('gpt-5'), tokens(OLD, 100, 0, 10), tokens(NOW - 2000, 150, 0, 15)]),
    )
    const src: ForeignSources = {
      codex: [{ root: join(root, 'codex5', 'sessions'), instance: 'codex:default' }],
      opencode: [],
      hermes: [],
      dsh: [],
    }
    // What version 2 left: its first turn settled into the rollups (and claimed), its second still raw,
    // its read state and cursor, and another PC's imported hour.
    const st = new KitStore(':memory:')
    const old = (n: number, ts: number, input: number) => ({
      id: `codex:${id}:${n}`,
      ts,
      session: 'sess-old',
      ref: id,
      agent: 'main',
      source: 'codex',
      model: 'gpt-5',
      provider: 'openai',
      input,
      output: 1,
    })
    await st.upsertEventsAsync([old(0, OLD, 999), old(1, NOW - 2000, 777)])
    st.setMeta(`codex_total:sess-old:${id}`, '1778')
    st.setCursor({ path, size: 1, mtime: 1, offset: 1, version: 2 })
    st.db.query("insert into imported_pc (pc, sig, rows, at) values ('other-pc', 'x', 1, 0)").run()
    st.db
      .query(
        `insert into usage_hour (hour, day, pc, source, model, calls, input)
         values (?, '2026-01-01', 'other-pc', 'codex', 'gpt-5', 1, 5000)`,
      )
      .run(OLD - (OLD % 3_600_000))
    const sums = () =>
      st.db
        .query(
          `select (select sum(input) from usage_hour where source = 'codex' and pc <> 'other-pc') as here,
             (select sum(calls) from usage_hour where source = 'codex' and pc <> 'other-pc') as calls,
             (select sum(input) from usage_hour where pc = 'other-pc') as imported,
             (select sum(input) from usage_session where source = 'codex') as ledger`,
        )
        .get()

    await ingestForeign(st, src)
    st.runMaintenance(NOW)
    expect(sums()).toEqual({ here: 150, calls: 2, imported: 5000, ledger: 150 })

    // The next turn adds itself only: the old rows are not dropped a second time.
    appendFileSync(path, jl([tokens(NOW - 1000, 200, 0, 20)]))
    await ingestForeign(st, src)
    st.runMaintenance(NOW)
    expect(sums()).toEqual({ here: 200, calls: 3, imported: 5000, ledger: 200 })
    st.close()
  })

  test('a store holding the per-session OpenCode totals ends with the per-call ones, once', async () => {
    const dbPath = join(root, 'opencode-upgrade.db')
    const db = openCodeDb(dbPath)
    const OLD = NOW - 40 * 86_400_000
    addOcMessage(db, 's1', [{ at: OLD, input: 100, output: 10, cacheRead: 0, cost: 0 }])
    addOcMessage(db, 's2', [{ at: NOW - 2000, input: 50, output: 5, cacheRead: 0, cost: 0 }])
    const src: ForeignSources = {
      codex: [],
      opencode: [{ dbPath, tool: 'opencode' }],
      hermes: [],
      dsh: [],
    }
    // What the per-session read left: s1's whole total settled into the rollups, s2's still raw, both
    // with their cumulative bases, a cursor at the last session write, and another PC's imported hour.
    const st = new KitStore(':memory:')
    const old = (session: string, ts: number, input: number) => ({
      id: `opencode:opencode:${session}`,
      ts,
      session,
      agent: 'main',
      source: 'opencode',
      model: 'zhipu/glm-5',
      provider: 'zhipu',
      input,
      output: 1,
    })
    await st.upsertEventsAsync([old('s1', OLD, 999), old('s2', NOW - 2000, 777)])
    for (const session of ['s1', 's2']) {
      st.setMeta(`cum:opencode:opencode:${session}`, JSON.stringify({ input: 999 }))
      st.setMeta(`cumbase:opencode:opencode:${session}`, JSON.stringify({ input: 999 }))
    }
    st.setCursor({ path: dbPath, size: 1, mtime: 1, offset: NOW, version: 1 })
    st.db.query("insert into imported_pc (pc, sig, rows, at) values ('other-pc', 'x', 1, 0)").run()
    st.db
      .query(
        `insert into usage_hour (hour, day, pc, source, model, calls, input)
         values (?, '2026-01-01', 'other-pc', 'opencode', 'zhipu/glm-5', 1, 5000)`,
      )
      .run(OLD - (OLD % 3_600_000))
    const sums = () =>
      st.db
        .query(
          `select (select sum(input) from usage_hour where source = 'opencode' and pc <> 'other-pc') as here,
             (select sum(calls) from usage_hour where source = 'opencode' and pc <> 'other-pc') as calls,
             (select sum(input) from usage_hour where pc = 'other-pc') as imported,
             (select sum(input) from usage_session where source = 'opencode') as ledger`,
        )
        .get()

    await ingestForeign(st, src)
    st.runMaintenance(NOW)
    expect(sums()).toEqual({ here: 150, calls: 2, imported: 5000, ledger: 150 })

    // The next call adds itself only: the old totals are not dropped a second time.
    addOcMessage(db, 's2', [{ at: NOW - 1000, input: 30, output: 3, cacheRead: 0, cost: 0 }])
    await ingestForeign(st, src)
    st.runMaintenance(NOW)
    expect(sums()).toEqual({ here: 180, calls: 3, imported: 5000, ledger: 180 })
    db.close()
    st.close()
  })

  test('a cumulative session that resumes after its row was pruned adds only what is new', async () => {
    const dbPath = join(root, 'hermes-resume.db')
    const db = hermesDb(dbPath)
    const put = (input: number, at: number) => {
      db.query('insert or replace into sessions values (?,?,?,?,?,?,?,0,null)').run(
        's1',
        '/w',
        'n',
        't',
        at / 1000,
        null,
        at / 1000,
      )
      db.query("delete from session_model_usage where session_id = 's1'").run()
      db.query(
        `insert into session_model_usage (session_id, model, api_call_count, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, reasoning_tokens, first_seen, last_seen)
         values ('s1', 'hm-model', 1, ?, 10, 0, 0, 0, ?, ?)`,
      ).run(input, at / 1000, at / 1000)
    }
    const src: ForeignSources = {
      codex: [],
      opencode: [],
      hermes: [{ dbPath, profile: null }],
      dsh: [],
    }
    const st = new KitStore(':memory:')
    const total = () =>
      (
        st.db
          .query("select coalesce(sum(input), 0) as n from usage_hour where source = 'hermes'")
          .get() as { n: number }
      ).n
    put(1000, NOW - 40 * 86_400_000)
    await ingestForeign(st, src)
    st.runMaintenance(NOW) // the 40-day-old row is folded into the hours and deleted
    expect(
      st.db.query("select count(*) as n from usage_event where source = 'hermes'").get(),
    ).toEqual({ n: 0 })
    expect(total()).toBe(1000)

    put(1500, NOW) // the session resumes: its row now holds the running total, 1500
    await ingestForeign(st, src)
    st.runMaintenance(NOW)
    expect(total()).toBe(1500)

    put(1800, NOW + 1000) // and carries on while its new row is still raw
    await ingestForeign(st, src)
    st.runMaintenance(NOW + 1000)
    expect(total()).toBe(1800)
    db.close()
    st.close()
  })
})
