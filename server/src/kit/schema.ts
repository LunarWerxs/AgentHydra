// Schema of the analytics toolkit store (DATA_DIR/analytics.db). See docs/ANALYTICS-PLAN.md §4.2-4.3.
// Gated on PRAGMA user_version: a file with a lower version is migrated step by step, a higher one is
// refused. The store is an index over the sources' own files, so a drop and rebuild is always safe.

export const KIT_SCHEMA_VERSION = 3

/** Measures summed by the hourly rollup (tokens by kind, money, quota units, counts). */
export const KIT_MEASURES = [
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
  const measures = KIT_MEASURES.map((m) =>
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

/** SELECT of usage_event rows (optionally filtered) aggregated to usage_session's key and columns. */
export function sessionAggSql(where = '1'): string {
  const sums = KIT_MEASURES.map((m) => `sum(${m})`).join(', ')
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
    if (have >= 1) backfillV2(db)
  }
  // Covers the per-source coverage summary. Building it over a live-size table takes seconds on the
  // thread that runs the daemon, so a big table gets it from KitStore.ensureIndexes (a worker thread).
  if (!hasManyEvents(db)) db.exec(SOURCE_TS_INDEX_SQL)
  if (have < 3) db.exec(KIT_DDL_V3)
  if (have !== KIT_SCHEMA_VERSION) db.exec(`pragma user_version = ${KIT_SCHEMA_VERSION}`)
}

export function dropKitSchema(db: Exec): void {
  for (const t of KIT_TABLES) db.exec(`drop table if exists ${t}`)
  db.exec('pragma user_version = 0')
}
