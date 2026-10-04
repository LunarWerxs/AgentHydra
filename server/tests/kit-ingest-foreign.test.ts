import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
// The same rollout seen in the archive while a move settles, and a subagent replaying the counter.
writeFileSync(join(codexArchive, 'rollout-a.jsonl'), mainBody)
writeFileSync(
  join(codexRoot, '2026', '01', 'rollout-sub.jsonl'),
  jl([meta('sess-main', { thread_source: 'subagent' }), ctx('gpt-5'), tokens(NOW, 1500, 1200, 90)]),
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

const ocPath = join(root, 'opencode.db')
const oc = new Database(ocPath)
oc.exec(`create table session (
  id text primary key, project_id text, directory text, title text, model text,
  tokens_input integer, tokens_output integer, tokens_reasoning integer,
  tokens_cache_read integer, tokens_cache_write integer, cost real,
  time_created integer, time_updated integer, time_archived integer)`)
const addOc = (id: string, at: number) =>
  oc
    .query('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      id,
      'p',
      '/w',
      't',
      '{"id":"glm-5","providerID":"zhipu"}',
      100,
      40,
      10,
      500,
      20,
      0.25,
      at,
      at,
      null,
    )
addOc('oc-1', NOW - 3000)

const hmPath = join(root, 'state.db')
const hm = new Database(hmPath)
hm.exec(`
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

describe('foreign ingest into the kit store', () => {
  const store = new KitStore(':memory:')

  test('every provider lands, a duplicate or subagent rollout adds nothing, a re-run is a no-op', async () => {
    const first = await ingestForeign(store, sources)
    const t = totals(store)
    // gpt-5 main: deltas of the running total, cached input taken OUT of input; plus the late rollout.
    expect(t.codex).toMatchObject({
      calls: 3,
      input: 200 + 100 + 100,
      output: 50 + 40 + 10,
      cache_read: 800 + 400,
    })
    expect(t.dsh).toMatchObject({ calls: 2, input: 30, output: 10, cache_read: 10 })
    expect(t.opencode).toMatchObject({ calls: 1, input: 100, output: 40, cache_read: 500 })
    expect(t.hermes).toMatchObject({ calls: 1, input: 70, output: 30, cache_read: 200 })
    expect(first.files).toBeGreaterThan(0)

    const billed = store.db
      .query("select billed_usd, provider from usage_event where source = 'opencode'")
      .get()
    expect(billed).toEqual({ billed_usd: 0.25, provider: 'zhipu' })
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
    addOc('oc-2', NOW - 500)
    addHm('hm-2', NOW - 500)

    const sum = await ingestForeign(store, sources)
    expect(sum.events).toEqual({ codex: 1, dsh: 1, opencode: 1, hermes: 1 })
    const after = totals(store)
    expect(after.codex?.calls).toBe((before.codex?.calls ?? 0) + 1)
    expect(after.codex?.input).toBe((before.codex?.input ?? 0) + 200) // 500 more input, 300 of it cached
    expect(after.dsh?.calls).toBe(3)
    expect(after.opencode?.calls).toBe(2)
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
    expect(totals(store).codex?.calls).toBe(4)
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

  test('a session that resumes after its row was pruned adds only what is new', async () => {
    const dbPath = join(root, 'opencode-resume.db')
    const db = new Database(dbPath)
    db.exec(`create table session (
      id text primary key, project_id text, directory text, title text, model text,
      tokens_input integer, tokens_output integer, tokens_reasoning integer,
      tokens_cache_read integer, tokens_cache_write integer, cost real,
      time_created integer, time_updated integer, time_archived integer)`)
    const put = (input: number, at: number) =>
      db
        .query('insert or replace into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          's1',
          'p',
          '/w',
          't',
          '{"id":"glm-5","providerID":"zhipu"}',
          input,
          10,
          0,
          0,
          0,
          0,
          at,
          at,
          null,
        )
    const src: ForeignSources = {
      codex: [],
      opencode: [{ dbPath, tool: 'opencode' }],
      hermes: [],
      dsh: [],
    }
    const st = new KitStore(':memory:')
    const total = () =>
      (
        st.db
          .query("select coalesce(sum(input), 0) as n from usage_hour where source = 'opencode'")
          .get() as { n: number }
      ).n
    put(1000, NOW - 40 * 86_400_000)
    await ingestForeign(st, src)
    st.runMaintenance(NOW) // the 40-day-old row is folded into the hours and deleted
    expect(
      st.db.query("select count(*) as n from usage_event where source = 'opencode'").get(),
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
