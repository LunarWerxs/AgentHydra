// What Claude's old (settled) calls contributed, per session and hour (docs/ANALYTICS-PLAN.md §4.6).
// The rollups keep that history forever but cannot say which transcript it came from, and a transcript can
// be gone (Claude Code's own cleanup, a deleted desktop chat, a removed instance). A CLAUDE_INGEST_VERSION
// bump re-reads the transcripts that still exist, so it must take back exactly their part and leave the rest:
// this table is that part, one row per (session key, hour), written wherever a Claude call is settled (a
// call older than the raw window, or a raw row folded by the prune). It is created by the store itself so a
// schema bump is not needed; dropAndRebuild drops it with everything else.
import type { Database } from 'bun:sqlite'
import { KIT_MEASURES, KIT_SESSION_KEY } from './schema'

/** The sources the Claude ingest writes; HSwarm and the foreign ingest use others. */
export const CLAUDE_SOURCES = ['cli', 'desktop', 'climayte']
const SOURCE_LIST = CLAUDE_SOURCES.map((s) => `'${s}'`).join(',')
const HOUR_MS = 3_600_000
const NULLABLE = ['list_usd', 'billed_usd', 'seconds']
const COUNTS = ['calls', 'ok_calls', 'failed_calls']
const VALUES = [...COUNTS, ...KIT_MEASURES]
const COLS = [...KIT_SESSION_KEY, 'hour', ...VALUES]

export const SETTLED_PART_DDL = `create table if not exists settled_part (
  ${KIT_SESSION_KEY.map((k) => `${k} text not null default ''`).join(', ')},
  hour integer not null,
  ${COUNTS.map((c) => `${c} integer not null default 0`).join(', ')},
  ${KIT_MEASURES.map((m) =>
    NULLABLE.includes(m)
      ? `${m} real`
      : m === 'weighted'
        ? 'weighted real not null default 0'
        : `${m} integer not null default 0`,
  ).join(', ')},
  primary key (${KIT_SESSION_KEY.join(', ')}, hour)
) without rowid`

export const ensureSettledPart = (db: Database): void => {
  db.exec(SETTLED_PART_DDL)
}

const addSet = VALUES.map((c) =>
  NULLABLE.includes(c)
    ? `${c} = case when settled_part.${c} is null then excluded.${c} when excluded.${c} is null then settled_part.${c} else settled_part.${c} + excluded.${c} end`
    : `${c} = settled_part.${c} + excluded.${c}`,
).join(', ')
const INSERT = `insert into settled_part (${COLS.join(', ')}) `
const ON_CONFLICT = ` on conflict (${KIT_SESSION_KEY.join(', ')}, hour) do update set ${addSet}`

/** Calls settled without a raw row (Claude sources only): one row each, added onto the session's hour. */
export function tagSettledCalls(db: Database, events: readonly object[]): void {
  const stmt = db.prepare(`${INSERT}values (${COLS.map((c) => `$${c}`).join(', ')})${ON_CONFLICT}`)
  for (const ev of events) {
    const e = ev as { ts: number; source: string; ok?: boolean | null; [k: string]: unknown }
    if (!CLAUDE_SOURCES.includes(e.source)) continue
    const p: Record<string, string | number | null> = {}
    for (const k of KIT_SESSION_KEY) p[`$${k}`] = (e[k] as string | null | undefined) ?? ''
    p.$hour = e.ts - (((e.ts % HOUR_MS) + HOUR_MS) % HOUR_MS)
    p.$calls = 1
    p.$ok_calls = e.ok === true ? 1 : 0
    p.$failed_calls = e.ok === false ? 1 : 0
    for (const m of KIT_MEASURES) {
      const v = e[m] as number | null | undefined
      p[`$${m}`] = typeof v === 'number' ? v : NULLABLE.includes(m) ? null : 0
    }
    stmt.run(p)
  }
}

/** Raw Claude rows in [a, b) about to be pruned: their part is kept per session and hour. */
export function tagRawRange(db: Database, a: number, b: number): void {
  const key = KIT_SESSION_KEY.map((k) => `coalesce(${k}, '')`).join(', ')
  const hour = `(ts - ((ts % ${HOUR_MS}) + ${HOUR_MS}) % ${HOUR_MS})`
  const sums = KIT_MEASURES.map((m) => `sum(${m})`).join(', ')
  db.query(
    `${INSERT}select ${key}, ${hour}, count(*), sum(case when ok = 1 then 1 else 0 end),
      sum(case when ok = 0 then 1 else 0 end), ${sums} from usage_event
      where ts >= $a and ts < $b and source in (${SOURCE_LIST}) group by ${key}, ${hour}${ON_CONFLICT}`,
  ).run({ $a: a, $b: b })
}

/** Takes one session-hour row's part back out of usage_hour (the hour row goes when no call is left). */
export function subtractFromHour(db: Database): (row: Record<string, unknown>) => void {
  const sets = VALUES.map((c) =>
    NULLABLE.includes(c)
      ? `${c} = case when ${c} is null or $${c} is null then ${c} else ${c} - $${c} end`
      : `${c} = ${c} - $${c}`,
  ).join(', ')
  const where =
    'hour = $hour and pc = $pc and account = $account and instance = $instance and agent = $agent and source = $source and model = $model and provider = $provider'
  const upd = db.prepare(`update usage_hour set ${sets} where ${where}`)
  const del = db.prepare(`delete from usage_hour where ${where} and calls <= 0`)
  return (row) => {
    const p: Record<string, string | number | null> = {}
    for (const c of ['hour', 'pc', 'account', 'instance', 'agent', 'source', 'model', 'provider'])
      p[`$${c}`] = row[c] as string | number
    for (const c of VALUES) p[`$${c}`] = row[c] as number | null
    upd.run(p)
    del.run(
      Object.fromEntries(Object.entries(p).filter(([k]) => !VALUES.includes(k.slice(1)))) as Record<
        string,
        string | number
      >,
    )
  }
}
