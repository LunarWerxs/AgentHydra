// Schema of the analytics toolkit store (DATA_DIR/analytics.db). See docs/ANALYTICS-PLAN.md §4.2-4.3.
// Gated on PRAGMA user_version: a file with a lower version is migrated step by step, a higher one is
// refused. The store is an index over the sources' own files, so a drop and rebuild is always safe.

export const KIT_SCHEMA_VERSION = 1

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

export const KIT_TABLES = ['usage_event', 'usage_hour', 'ingest_cursor', 'meta'] as const

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

type Exec = { exec(sql: string): unknown; query(sql: string): { get(): unknown } }

/** Bring the file to KIT_SCHEMA_VERSION. Throws on a file written by a newer build. */
export function migrateKitSchema(db: Exec): void {
  const row = db.query('pragma user_version').get() as { user_version: number }
  const have = row.user_version
  if (have > KIT_SCHEMA_VERSION) {
    throw new Error(`analytics.db is schema ${have}, this build understands ${KIT_SCHEMA_VERSION}`)
  }
  if (have < 1) db.exec(KIT_DDL_V1)
  if (have !== KIT_SCHEMA_VERSION) db.exec(`pragma user_version = ${KIT_SCHEMA_VERSION}`)
}

export function dropKitSchema(db: Exec): void {
  for (const t of KIT_TABLES) db.exec(`drop table if exists ${t}`)
  db.exec('pragma user_version = 0')
}
