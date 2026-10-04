// Schema of the analytics toolkit store (DATA_DIR/analytics.db). See docs/ANALYTICS-PLAN.md §4.2-4.3.
// Gated on PRAGMA user_version: a file with a lower version is migrated step by step, a higher one is
// refused. The store is an index over the sources' own files, so a drop and rebuild is always safe.

export const KIT_SCHEMA_VERSION = 4

/** Measures every source reports per call (what usage_event stores). */
export const KIT_BASE_MEASURES = [
  'input',
  'output',
  'cache_read',
  'cache_write_5m',
  'cache_write_1h',
  'reasoning',
  'list_usd',
  'billed_usd',
  'weighted',
  'seconds',
] as const

/**
 * Measures derived per call from list_usd and billed_usd, carried only by the rollups (usage_event has no
 * column for them): `unbilled_usd` is the list price of the calls whose billed_usd is unknown (null), and
 * `cost_usd` is what each call cost, billed where known and list otherwise, added up call by call. Both
 * are 0, never null, when nothing contributes.
 */
export const KIT_DERIVED_MEASURES = ['unbilled_usd', 'cost_usd'] as const

/** Measures summed by the hourly rollup (tokens by kind, money, quota units, counts). */
export const KIT_MEASURES = [...KIT_BASE_MEASURES, ...KIT_DERIVED_MEASURES] as const

/** The aggregate over usage_event rows that produces measure `m`. */
export function eventMeasureSql(m: (typeof KIT_MEASURES)[number]): string {
  if (m === 'unbilled_usd')
    return 'coalesce(sum(case when billed_usd is null then list_usd end), 0)'
  if (m === 'cost_usd') return 'coalesce(sum(coalesce(billed_usd, list_usd)), 0)'
  return `sum(${m})`
}

/** One call's value of measure `m` (null for a base measure the call does not carry). */
export function eventMeasure(
  e: {
    list_usd?: number | null
    billed_usd?: number | null
  } & Partial<Record<(typeof KIT_BASE_MEASURES)[number], number | null>>,
  m: (typeof KIT_MEASURES)[number],
): number | null {
  if (m === 'unbilled_usd') return e.billed_usd == null ? (e.list_usd ?? 0) : 0
  if (m === 'cost_usd') return e.billed_usd ?? e.list_usd ?? 0
  return e[m] ?? null
}

/** Dimensions kept by the hourly rollup (no session / ref). NULL is stored as '' there, so it can key. */
export const KIT_HOUR_DIMS = [
  'pc',
  'account',
  'instance',
  'agent',
  'source',
  'model',
  'provider',
] as const

/**
 * Key of the per-session rollup. NULL is stored as ''. A row with session '' is usage that carries no
 * session, so the table is a complete ledger: its sum over every row is every event ever ingested.
 */
export const KIT_SESSION_KEY = [
  'session',
  'ref',
  'source',
  'account',
  'instance',
  'model',
  'provider',
  'pc',
  'agent',
] as const

const NULLABLE_MEASURES: readonly string[] = ['list_usd', 'billed_usd', 'seconds']

export const KIT_TABLES = [
  'usage_event',
  'usage_hour',
  'usage_session',
  'usage_session_settled',
  'settled_claim',
  'ingest_cursor',
  'meta',
  'dirty_hour',
] as const

export const KIT_DDL_V1 = `
create table if not exists usage_event (
  id text primary key,
  ts integer not null,
  day text not null,
  pc text,
  account text,
  instance text,
  session text,
  agent text,
  source text not null,
  model text,
  provider text,
  input integer not null default 0,
  output integer not null default 0,
  cache_read integer not null default 0,
  cache_write_5m integer not null default 0,
  cache_write_1h integer not null default 0,
  reasoning integer not null default 0,
  list_usd real,
  billed_usd real,
  price_ver text,
  weighted real not null default 0,
  ok integer,
  seconds real,
  ref text
);
create index if not exists usage_event_ts on usage_event (ts);
create index if not exists usage_event_account_ts on usage_event (account, ts);
create index if not exists usage_event_instance_ts on usage_event (instance, ts);

create table if not exists usage_hour (
  hour integer not null,
  day text not null,
  pc text not null default '',
  account text not null default '',
  instance text not null default '',
  agent text not null default '',
  source text not null,
  model text not null default '',
  provider text not null default '',
  calls integer not null default 0,
  ok_calls integer not null default 0,
  failed_calls integer not null default 0,
  input integer not null default 0,
  output integer not null default 0,
  cache_read integer not null default 0,
  cache_write_5m integer not null default 0,
  cache_write_1h integer not null default 0,
  reasoning integer not null default 0,
  list_usd real,
  billed_usd real,
  weighted real not null default 0,
  seconds real,
  primary key (hour, pc, account, instance, agent, source, model, provider)
) without rowid;
create index if not exists usage_hour_day on usage_hour (day);

create table if not exists ingest_cursor (
  path text primary key,
  size integer not null default 0,
  mtime integer not null default 0,
  offset integer not null default 0,
  version integer not null default 1
);

create table if not exists meta (
  key text primary key,
  value text not null
);
`

function sessionTableDdl(name: string): string {
  const measures = KIT_BASE_MEASURES.map((m) =>
    NULLABLE_MEASURES.includes(m)
      ? `${m} real`
      : m === 'weighted'
        ? 'weighted real not null default 0'
        : `${m} integer not null default 0`,
  ).join(', ')
  return `create table if not exists ${name} (
  ${KIT_SESSION_KEY.map((k) => `${k} text not null default ''`).join(', ')},
  first_ts integer not null,
  last_ts integer not null,
  calls integer not null default 0,
  ok_calls integer not null default 0,
  failed_calls integer not null default 0,
  ${measures},
  primary key (${KIT_SESSION_KEY.join(', ')})
) without rowid;`
}

/**
 * v2: usage_session is the per-session ledger, kept forever. usage_session_settled holds the part of it
 * that came from raw events already pruned (folded in by pruneRaw), so the rollup can rebuild a session
 * as settled + whatever raw rows remain.
 */
export const KIT_DDL_V2 = `
${sessionTableDdl('usage_session')}
create index if not exists usage_session_ts on usage_session (first_ts, last_ts);
${sessionTableDdl('usage_session_settled')}
create index if not exists usage_event_session on usage_event (coalesce(session, ''), coalesce(ref, ''));
`

/**
 * v3: settled_claim holds a 64-bit hash of the id of every call that went straight to the rollups
 * (older than the raw window, so it has no usage_event row). The hash is the rowid, so a row is the
 * hash and nothing else; the first source to claim an id keeps the call.
 */
export const KIT_DDL_V3 = `
create table if not exists settled_claim (h integer primary key);
`

/**
 * v4: dirty_hour lists the hours whose usage_hour / usage_session rows are stale (one row per hour a write
 * touched), so a rollup redoes exactly those and a reader splits at the oldest of them. usage_hour and
 * both session tables gain unbilled_usd and cost_usd (KIT_DERIVED_MEASURES), filled for old rows by
 * KitStore.backfillAsync (sliced, so the migration itself stays instant).
 */
export const KIT_DDL_V4 = `
create table if not exists dirty_hour (hour integer primary key);
`

/** SELECT of usage_event rows (optionally filtered) aggregated to usage_session's key and columns. */
export function sessionAggSql(where = '1'): string {
  const sums = KIT_MEASURES.map(eventMeasureSql).join(', ')
  const key = KIT_SESSION_KEY.map((k) => `coalesce(${k}, '')`).join(', ')
  return `select ${key}, min(ts), max(ts), count(*), sum(case when ok = 1 then 1 else 0 end),
    sum(case when ok = 0 then 1 else 0 end), ${sums} from usage_event where ${where} group by ${key}`
}

/** `insert ... select ... on conflict do update` that ADDS the selected rows onto existing ones. */
export function sessionAddSql(table: string, select: string): string {
  const add = (c: string) =>
    NULLABLE_MEASURES.includes(c)
      ? `${c} = case when ${table}.${c} is null then excluded.${c} when excluded.${c} is null then ${table}.${c} else ${table}.${c} + excluded.${c} end`
      : `${c} = ${table}.${c} + excluded.${c}`
  const sets = [
    `first_ts = min(${table}.first_ts, excluded.first_ts)`,
    `last_ts = max(${table}.last_ts, excluded.last_ts)`,
    ...['calls', 'ok_calls', 'failed_calls', ...KIT_MEASURES].map(add),
  ]
  const cols = [
    ...KIT_SESSION_KEY,
    'first_ts',
    'last_ts',
    'calls',
    'ok_calls',
    'failed_calls',
    ...KIT_MEASURES,
  ]
  return `insert into ${table} (${cols.join(', ')}) ${select} on conflict (${KIT_SESSION_KEY.join(', ')}) do update set ${sets.join(', ')}`
}

type Exec = {
  exec(sql: string): unknown
  query(sql: string): { get(): unknown; run(...a: unknown[]): unknown }
}

/**
 * A v1 file has no session ledger: build it from the raw rows that survive (older sessions were pruned
 * with nothing to keep, so their totals start from the raw cut). When pruning evidently happened (rollup
 * hours older than the oldest raw row), record that row's hour as the raw cut, so a re-read of the old
 * events cannot rewrite the hours that no raw row backs any more.
 */
function backfillV2(db: Exec): void {
  db.exec(sessionAddSql('usage_session', sessionAggSql()))
  const r = db
    .query(`select (select min(ts) from usage_event) as t, (select min(hour) from usage_hour) as h`)
    .get() as { t: number | null; h: number | null }
  if (r.t !== null && r.h !== null && r.h < r.t - (r.t % 3_600_000)) {
    db.query("insert or replace into meta (key, value) values ('raw_cut', ?)").run(
      String(r.t - (r.t % 3_600_000)),
    )
  }
}

export const SOURCE_TS_INDEX_SQL =
  'create index if not exists usage_event_source_ts on usage_event (source, ts)'
/** Ledger rows still active at a time (covering last_ts and first_ts): sessions mode finds the rows a window cuts through from the index alone. */
export const SESSION_LAST_INDEX_SQL =
  'create index if not exists usage_session_span on usage_session (last_ts, first_ts)'
/** Raw rows of one session, newest window first: the key equality plus a ts range is one index seek. */
export const SESSION_TS_INDEX_SQL =
  "create index if not exists usage_event_session_ts on usage_event (coalesce(session, ''), coalesce(ref, ''), ts)"
/** Everything a big table gets from KitStore.ensureIndexes instead of the migration. */
export const LAZY_INDEXES_SQL = `${SOURCE_TS_INDEX_SQL}; ${SESSION_LAST_INDEX_SQL}; ${SESSION_TS_INDEX_SQL}; drop index if exists usage_event_session`
export const LAZY_INDEX_NAMES = [
  'usage_event_source_ts',
  'usage_session_span',
  'usage_event_session_ts',
]

/** True when usage_event holds more rows than an index can be built over without a noticeable pause. */
function hasManyEvents(db: Exec): boolean {
  return db.query('select 1 as x from usage_event limit 1 offset 50000').get() != null
}

/** Bring the file to KIT_SCHEMA_VERSION. Throws on a file written by a newer build. */
export function migrateKitSchema(db: Exec): void {
  const row = db.query('pragma user_version').get() as { user_version: number }
  const have = row.user_version
  if (have > KIT_SCHEMA_VERSION) {
    throw new Error(`analytics.db is schema ${have}, this build understands ${KIT_SCHEMA_VERSION}`)
  }
  if (have < 1) db.exec(KIT_DDL_V1)
  if (have < 2) {
    db.exec(KIT_DDL_V2)
    addDerivedColumns(db)
    if (have >= 1) backfillV2(db)
  }
  // Covers the per-source coverage summary. Building it over a live-size table takes seconds on the
  // thread that runs the daemon, so a big table gets it from KitStore.ensureIndexes (a worker thread).
  if (!hasManyEvents(db)) {
    db.exec(SOURCE_TS_INDEX_SQL)
    db.exec(SESSION_LAST_INDEX_SQL)
    db.exec(SESSION_TS_INDEX_SQL)
    db.exec('drop index if exists usage_event_session')
  }
  // coverage reads the cursor count and newest mtime: a narrow index makes both a short walk, not a scan
  // of 60k wide path rows (0.3 s cold).
  db.exec('create index if not exists ingest_cursor_mtime on ingest_cursor (mtime)')
  if (have < 3) db.exec(KIT_DDL_V3)
  if (have < 4) {
    addDerivedColumns(db)
    migrateV4(db, have)
  }
  if (have !== KIT_SCHEMA_VERSION) db.exec(`pragma user_version = ${KIT_SCHEMA_VERSION}`)
}

const HOUR = 3_600_000

/** New columns with constant defaults, so no table is rewritten. Safe to run again. */
function addDerivedColumns(db: Exec): void {
  for (const t of ['usage_hour', 'usage_session', 'usage_session_settled']) {
    const cols = db.query(`select name from pragma_table_info('${t}')`) as unknown as {
      all(): { name: string }[]
    }
    const names = new Set(cols.all().map((c) => c.name))
    for (const m of KIT_DERIVED_MEASURES) {
      if (!names.has(m)) db.exec(`alter table ${t} add column ${m} real not null default 0`)
    }
  }
}

/** v3 -> v4: the dirty-hour list seeded from the old single dirty_from floor, and a marker for the backfill. */
function migrateV4(db: Exec, have: number): void {
  db.exec(KIT_DDL_V4)
  if (have < 1) return
  const meta = (k: string) =>
    (db.query(`select value from meta where key = '${k}'`).get() as { value: string } | null)?.value
  const dirty = meta('dirty_from')
  if (dirty !== undefined) {
    const lo = Math.max(Number(dirty), Number(meta('raw_cut') ?? 0))
    const top = (db.query('select max(ts) as t from usage_event').get() as { t: number | null }).t
    if (top !== null && top >= lo) {
      const a = lo - (lo % HOUR)
      const b = top - (top % HOUR)
      db.query(
        `with recursive h(x) as (select ?1 union all select x + ${HOUR} from h where x + ${HOUR} <= ?2)
         insert or ignore into dirty_hour select x from h`,
      ).run(a, b)
    }
    db.exec("delete from meta where key = 'dirty_from'")
  }
  const any = db.query('select 1 as x from usage_hour limit 1').get()
  const anyRaw = db.query('select 1 as x from usage_event limit 1').get()
  if (any || anyRaw) {
    db.exec("insert or replace into meta (key, value) values ('backfill_v4', 'a')")
  }
}

export function dropKitSchema(db: Exec): void {
  for (const t of KIT_TABLES) db.exec(`drop table if exists ${t}`)
  db.exec('pragma user_version = 0')
}
