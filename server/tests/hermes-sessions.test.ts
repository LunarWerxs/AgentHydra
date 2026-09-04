import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSessionAnalytics } from '../src/analytics'
import { CONFIG_DIR } from '../src/config'
import {
  listHermesSearchEvents,
  listHermesSessions,
  listHermesStores,
  readHermesSession,
  readHermesUsage,
} from '../src/hermes-sessions'
import { priceTokens } from '../src/pricing'

/** The subset of hermes_state_common.py's SCHEMA_SQL (NousResearch/hermes-agent, MIT) this reader
 *  actually touches — enough columns to exercise every field the reader maps, not a full copy of
 *  every column that schema carries. */
function createSchema(db: Database): void {
  db.exec(`
    create table sessions (
      id text primary key, cwd text, display_name text, title text,
      started_at real, ended_at real, last_activity_at real,
      archived integer not null default 0, parent_session_id text
    );
    create table messages (
      id integer primary key autoincrement, session_id text not null,
      role text not null, content text, tool_call_id text, tool_calls text, tool_name text,
      timestamp real not null, active integer not null default 1
    );
    create table session_model_usage (
      session_id text not null, model text not null,
      billing_provider text not null default '', billing_base_url text not null default '',
      billing_mode text not null default '', task text not null default '',
      api_call_count integer not null default 0,
      input_tokens integer not null default 0, output_tokens integer not null default 0,
      cache_read_tokens integer not null default 0, cache_write_tokens integer not null default 0,
      reasoning_tokens integer not null default 0,
      estimated_cost_usd real not null default 0, actual_cost_usd real not null default 0,
      first_seen real, last_seen real,
      primary key (session_id, model, billing_provider, billing_base_url, billing_mode, task)
    );
  `)
}

function newDbPath(): string {
  return join(CONFIG_DIR, `hermes-${crypto.randomUUID()}.db`)
}

describe('a Hermes store: sessions, transcript mapping, search and usage', () => {
  const path = newDbPath()
  const db = new Database(path)
  createSchema(db)

  db.query('insert into sessions values (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'ses_test',
    'D:\\work',
    'Incident bot chat', // display_name: the chat platform's own label
    'Summarize the incident channel', // title: Hermes' own, wins over display_name
    1, // started_at (seconds)
    4, // ended_at
    4, // last_activity_at
    0,
    null,
  )
  // A second session, titled from display_name only (no title of its own) and archived — the
  // fallback chain and the archived flag both get their own assertion below.
  db.query('insert into sessions values (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'ses_two',
    'D:\\work',
    'Standup notes',
    null,
    10,
    12,
    12,
    1,
    null,
  )

  const insertMsg = db.query(
    'insert into messages (session_id, role, content, tool_calls, tool_name, timestamp, active) ' +
      'values (?, ?, ?, ?, ?, ?, ?)',
  )
  // The system prompt: never a turn either side spoke, and must not appear as an event.
  insertMsg.run('ses_test', 'system', 'You are a helpful assistant.', null, null, 1, 1)
  insertMsg.run('ses_test', 'user', 'Please check the incident channel.', null, null, 2, 1)
  insertMsg.run(
    'ses_test',
    'assistant',
    null,
    JSON.stringify([
      { id: 'call_1', function: { name: 'search_logs', arguments: '{"query":"error"}' } },
    ]),
    null,
    3,
    1,
  )
  insertMsg.run('ses_test', 'tool', '3 matches found.', null, 'search_logs', 3.5, 1)
  insertMsg.run('ses_test', 'assistant', 'Found 3 related errors.', null, null, 4, 1)
  // A compacted/superseded turn: active = 0, must be excluded from both the transcript and search.
  insertMsg.run('ses_test', 'user', 'an earlier draft of the same question', null, null, 1.5, 0)

  const insertUsage = db.query(
    'insert into session_model_usage ' +
      '(session_id, model, billing_provider, task, api_call_count, input_tokens, output_tokens, ' +
      'cache_read_tokens, cache_write_tokens, reasoning_tokens, first_seen, last_seen) ' +
      'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  // Two rows for the SAME model under different billing providers — session_model_usage's real
  // primary key allows this (routed through more than one provider), and readHermesUsage must
  // group them into one total rather than reporting the model twice.
  insertUsage.run(
    'ses_test',
    'claude-opus-5',
    'anthropic-direct',
    'chat',
    1,
    1000,
    500,
    200,
    50,
    0,
    2,
    3,
  )
  insertUsage.run('ses_test', 'claude-opus-5', 'openrouter', 'chat', 1, 200, 100, 0, 0, 0, 3, 4)
  // A model this repo's price catalog has never heard of.
  insertUsage.run(
    'ses_test',
    'some-unreleased-model-xyz',
    'custom',
    'chat',
    1,
    300,
    100,
    0,
    0,
    10,
    3,
    3,
  )
  db.close()

  test('sessions are listed with title/display_name fallback and the archived flag', () => {
    const rows = listHermesSessions(path, null)
    const byId = new Map(rows.map((r) => [r.session_id, r]))
    expect(byId.get('ses_test')).toMatchObject({
      session_id: 'ses_test',
      project: 'hermes',
      cwd: 'D:\\work',
      title: 'Summarize the incident channel',
      created_at: 1000,
      last_activity_at: 4000,
      archived: false,
      parent_id: null,
    })
    expect(byId.get('ses_test')?.size_bytes).toBeGreaterThan(0)
    // No title of its own: falls back to the chat platform's display_name, not the bare id.
    expect(byId.get('ses_two')).toMatchObject({ title: 'Standup notes', archived: true })
  })

  test('a profile name is carried through as the project grouping', () => {
    const rows = listHermesSessions(path, 'work')
    expect(rows.every((r) => r.project === 'work')).toBe(true)
  })

  test('the transcript drops the system prompt and the inactive turn, keeps the tool call and its result', () => {
    const content = readHermesSession('ses_test', path)
    expect(content?.events.map((e) => [e.role, e.kind, e.tool_name, e.text])).toEqual([
      ['user', 'text', null, 'Please check the incident channel.'],
      ['assistant', 'tool_use', 'search_logs', '{"query":"error"}'],
      ['user', 'tool_result', 'search_logs', '3 matches found.'],
      ['assistant', 'text', null, 'Found 3 related errors.'],
    ])
    // Only the two TEXT turns count toward messageCount — the tool call/result are activity, not
    // conversation turns, matching how OpenCode's reader counts.
    expect(content?.messageCount).toBe(2)
  })

  test('search sees every active user/assistant/tool message, and none of the dropped ones', () => {
    const texts = listHermesSearchEvents(path, null).map((e) => e.text)
    expect(texts).toContain('Please check the incident channel.')
    expect(texts).toContain('3 matches found.')
    expect(texts).toContain('Found 3 related errors.')
    expect(texts).not.toContain('You are a helpful assistant.')
    expect(texts).not.toContain('an earlier draft of the same question')
  })

  test('usage is grouped by model, summed across billing providers, before pricing ever sees it', () => {
    const rows = readHermesUsage('ses_test', path)
    const byModel = new Map(rows.map((r) => [r.model, r]))
    const known = byModel.get('claude-opus-5')
    expect(known).toMatchObject({
      input_tokens: 1200,
      output_tokens: 600,
      cache_read_tokens: 200,
      cache_write_tokens: 50,
      api_call_count: 2,
    })
    expect(known?.first_seen_ms).toBe(2000)
    expect(known?.last_seen_ms).toBe(4000)
    expect(byModel.get('some-unreleased-model-xyz')?.input_tokens).toBe(300)
  })

  test('the analytics scan prices a known model through the catalog and flags the unknown one, never taking a Hermes cost figure on faith', async () => {
    const out = await scanSessionAnalytics(path, 'hermes', 'ses_test')
    expect(Object.keys(out.tokens).sort()).toEqual(['claude-opus-5', 'some-unreleased-model-xyz'])
    // Never Hermes' own estimated/actual cost — see the file header on hermes-sessions.ts.
    expect(out.providerCostUsd).toBeNull()
    const priced = priceTokens(out.tokens, Date.now())
    expect(priced.priced).toEqual(['claude-opus-5'])
    expect(priced.unpriced).toEqual(['some-unreleased-model-xyz'])
    // A dollar figure exists (from the priced model) even though one model in the mix is unpriced —
    // it is a lower bound, not a zero, and the caller is told which model it is missing.
    expect(priced.costUsd).toBeGreaterThan(0)
  })

  test('a session id with no usage rows at all analyzes to an empty, not a thrown error', async () => {
    const out = await scanSessionAnalytics(path, 'hermes', 'ses_two')
    expect(out.tokens).toEqual({})
    expect(out.providerCostUsd).toBeNull()
  })
})

describe('listHermesStores: the root store plus its profiles', () => {
  function makeHome(): string {
    return mkdtempSync(join(tmpdir(), 'agenthydra-hermes-home-'))
  }

  test('the root store and every profile that actually has a database', () => {
    const home = makeHome()
    new Database(join(home, 'state.db')).close()
    mkdirSync(join(home, 'profiles', 'work'), { recursive: true })
    new Database(join(home, 'profiles', 'work', 'state.db')).close()
    // A profile directory with no database in it yet: not a store.
    mkdirSync(join(home, 'profiles', 'empty'), { recursive: true })

    const stores = listHermesStores(home, 'state.db')
    expect(stores.map((s) => s.profile).sort()).toEqual([null, 'work'])
    expect(stores.find((s) => s.profile === 'work')?.dbPath).toBe(
      join(home, 'profiles', 'work', 'state.db'),
    )
  })

  test('no profiles directory at all: just the root store', () => {
    const home = makeHome()
    new Database(join(home, 'state.db')).close()
    expect(listHermesStores(home, 'state.db')).toEqual([
      { dbPath: join(home, 'state.db'), profile: null },
    ])
  })

  test('profiles with no root-level database: only the profiles are stores', () => {
    const home = makeHome()
    mkdirSync(join(home, 'profiles', 'work'), { recursive: true })
    new Database(join(home, 'profiles', 'work', 'state.db')).close()
    const stores = listHermesStores(home, 'state.db')
    expect(stores).toEqual([
      { dbPath: join(home, 'profiles', 'work', 'state.db'), profile: 'work' },
    ])
  })
})

describe('a missing, empty, or locked database never throws — it just has nothing to say', () => {
  test('a path nothing has ever written to', () => {
    const path = join(CONFIG_DIR, `hermes-missing-${crypto.randomUUID()}.db`)
    expect(existsSync(path)).toBe(false)
    expect(listHermesSessions(path, null)).toEqual([])
    expect(readHermesSession('anything', path)).toBeNull()
    expect(readHermesUsage('anything', path)).toEqual([])
    expect(listHermesSearchEvents(path, null)).toEqual([])
  })

  test('a valid SQLite file with none of Hermes\u2019 tables in it', () => {
    const path = newDbPath()
    new Database(path).close() // a real, openable, entirely empty database
    expect(listHermesSessions(path, null)).toEqual([])
    expect(readHermesSession('anything', path)).toBeNull()
    expect(readHermesUsage('anything', path)).toEqual([])
  })

  test('a database another connection holds exclusively', () => {
    const path = newDbPath()
    const writer = new Database(path)
    createSchema(writer)
    // Forces the OS-level exclusive lock SQLite otherwise only takes for the instant of a commit,
    // so a concurrent readonly open genuinely cannot get in — the condition this test needs to be
    // real rather than a coincidence of timing.
    writer.exec('pragma locking_mode = exclusive')
    writer.exec('begin immediate')
    writer.query("insert into sessions (id, cwd, title, started_at) values ('x', '', 'x', 0)").run()

    expect(listHermesSessions(path, null)).toEqual([])

    writer.exec('commit')
    writer.close()
  })
})

test('a readonly connection reads a session still sitting only in the WAL, not yet checkpointed', () => {
  const path = newDbPath()
  const writer = new Database(path)
  writer.exec('pragma journal_mode = WAL')
  createSchema(writer)
  writer
    .query('insert into sessions values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('ses_wal', 'D:\\work', null, 'Still in the log', 1, null, 1, 0, null)
  // The writer stays open and uncheckpointed on purpose: this is the state a live `hermes serve`
  // process leaves the store in between its own commits, which is most of the time.
  expect(existsSync(`${path}-wal`)).toBe(true)

  expect(listHermesSessions(path, null).map((s) => s.session_id)).toEqual(['ses_wal'])

  writer.close()
})
