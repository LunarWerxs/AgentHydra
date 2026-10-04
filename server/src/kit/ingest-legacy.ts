// One-time backfill of the kit from the permanent per-session record (session_stats), for the Claude
// usage the kit cannot see: sessions whose transcripts Claude Code's 30-day cleanup already deleted, and
// the days before the kit's oldest Claude event. Without it 'all time' quietly becomes 'the kit's age'.
//
// RULES
//  * Only source 'claude' rows. A day is split out of the row's whole-session per-model tokens by that
//    day's share of the row's per-day weighted map (what the pre-kit spendReport did), re-weighed under
//    the current weights, priced with the kit's own pricing (list_usd null when a model has no price).
//  * Overlap: a session's kit span is [first, last] local day of its kit Claude rows (ref ''). A day
//    inside the span is the kit's; only days outside it are written. A row whose transcript is still on
//    disk (gone_at null) is the kit's whole life of that session, so it only contributes days before
//    `floor`, the kit's oldest Claude day: the kit may simply not have read its newest turns yet.
//  * Written as ref 'legacy' rows, so the kit's own span query never counts them and a transcript the
//    kit reads later keeps its own ledger rows. Source 'desktop' when session_stats names a desktop
//    instance, else 'cli'; account null; model as recorded; calls = one per (session, day, model).
//  * Each day is one event at the local day's FIRST hour. A day older than the raw cut goes straight to
//    usage_hour + the session ledger (settleOld, claimed by id); a newer one is a raw row that the
//    rollup and the prune carry on. A reader grouping by hour therefore sees a day's whole backfill in
//    its first hour.
//  * Idempotent: ids are `legacy:<session_key>:<day>:<model>` (claimed / replaced), progress is a
//    session_key cursor in meta, and the done flag is tied to claude_ingest_version, because
//    upgradeClaudeStore wipes Claude's settled rows (the backfill then simply runs again).
//  * Sliced: about SLICE_MS of work, at most WRITE_SLICE events per write, a turn of the event loop between.
import type { Database } from 'bun:sqlite'
import { priceTokens } from '../pricing'
import type { ModelSpend } from '../types'
import { reweighModels } from '../usage-tokens'
import {
  type KitStore,
  localDay,
  SLICE_MS,
  type UsageEventInput,
  WRITE_SLICE,
  yieldLoop,
} from './store'

const RAW_WINDOW_DAYS = 36
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const PAGE = 100
const CLAUDE_SOURCES = "'cli','desktop','climayte'"

interface StatsRow {
  session_key: string
  session_id: string
  instance: string | null
  last_ts: number | null
  tokens_json: string | null
  days_json: string | null
  gone_at: number | null
}

export interface LegacySummary {
  skipped: boolean
  sessions: number
  events: number
  /** Events written (settled or raw); a re-run reports 0. */
  written: number
}

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback
  try {
    return (JSON.parse(json) as T) ?? fallback
  } catch {
    return fallback
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Local midnight of a YYYY-MM-DD key. */
function dayStart(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d).getTime()
}

/** The events of one session_stats row for the days the kit does not hold. */
export function legacyEvents(
  row: StatsRow,
  span: { from: string; to: string } | null,
  floor: string | null,
  pc: string | null,
): UsageEventInput[] {
  const tokens = reweighModels(parse<Record<string, ModelSpend>>(row.tokens_json, {}))
  let days = parse<Record<string, number>>(row.days_json, {})
  if (Object.keys(days).length === 0 && row.last_ts) days = { [localDay(row.last_ts)]: 1 }
  let total = 0
  for (const [d, w] of Object.entries(days)) if (DAY_RE.test(d)) total += Math.max(0, num(w))
  if (total <= 0) return []
  const source = row.instance?.startsWith('desktop:') ? 'desktop' : 'cli'
  const out: UsageEventInput[] = []
  for (const [day, w] of Object.entries(days)) {
    const share = Math.max(0, num(w)) / total
    if (!DAY_RE.test(day) || share <= 0) continue
    if (span && day >= span.from && day <= span.to) continue
    if (row.gone_at === null && (floor === null || day >= floor)) continue
    const ts = dayStart(day)
    for (const [model, m] of Object.entries(tokens)) {
      const part = {
        input: Math.round(num(m.input) * share),
        output: Math.round(num(m.output) * share),
        cacheRead: Math.round(num(m.cacheRead) * share),
        cacheCreation5m: Math.round(num(m.cacheCreation5m) * share),
        cacheCreation1h: Math.round(num(m.cacheCreation1h) * share),
      }
      const raw =
        part.input + part.output + part.cacheRead + part.cacheCreation5m + part.cacheCreation1h
      if (raw === 0) continue
      const priced = priceTokens({ [model]: part }, ts)
      out.push({
        id: `legacy:${row.session_key}:${day}:${model}`,
        ts,
        day,
        pc,
        account: null,
        instance: row.instance,
        session: row.session_id,
        agent: 'main',
        source,
        model,
        provider: 'anthropic',
        input: part.input,
        output: part.output,
        cache_read: part.cacheRead,
        cache_write_5m: part.cacheCreation5m,
        cache_write_1h: part.cacheCreation1h,
        list_usd: priced.unpriced.length > 0 ? null : priced.costUsd,
        weighted: num(m.weighted) * share,
        ref: 'legacy',
      })
    }
  }
  return out
}

/**
 * Backfill the kit from `stats` (the daemon's db). Resumes from its saved position and returns at once
 * when the current ingest version is already done. `now` and `pc` are for the caller's clock and machine.
 */
export async function ingestLegacy(
  store: KitStore,
  stats: Database,
  opts: { now?: number; pc?: string | null } = {},
): Promise<LegacySummary> {
  const now = opts.now ?? Date.now()
  const ver = store.getMeta('claude_ingest_version') ?? ''
  const tag = `v${ver}`
  const flag = store.getMeta('legacy_backfill')
  if (flag === `${tag}:done`) return { skipped: true, sessions: 0, events: 0, written: 0 }
  const posRaw = store.getMeta('legacy_backfill_pos')
  let pos = ''
  let floor: string | null = null
  if (posRaw?.startsWith(`${tag}\u0000`)) {
    const [, p, f] = posRaw.split('\u0000')
    pos = p ?? ''
    floor = f ? f : null
  } else {
    // Oldest Claude call the kit holds from transcripts: the live ledger or a raw row, whichever is older.
    // Ordered walks of the time indexes, which stop at the first Claude row (the oldest rows are Claude's).
    const t = store.db
      .query(
        `select min(a) as t from (
           select (select first_ts from usage_session where source in (${CLAUDE_SOURCES}) and ref = '' order by first_ts limit 1) as a
           union all
           select (select ts from usage_event where source in (${CLAUDE_SOURCES}) and coalesce(ref, '') = '' order by ts limit 1))`,
      )
      .get() as { t: number | null }
    const oldest = t.t
    floor = oldest === null ? null : localDay(oldest)
  }
  // A newer day than this stays a raw row (the rollup would rebuild an hourly row there).
  const cut = store.rawCut() ?? now - RAW_WINDOW_DAYS * 86_400_000
  const spanQ = store.db.prepare(
    `select min(a) as a, max(b) as b from (
       select min(first_ts) as a, max(last_ts) as b from usage_session
         where session = ?1 and ref = '' and source in (${CLAUDE_SOURCES})
       union all
       select min(ts), max(ts) from usage_event
         where coalesce(session, '') = ?1 and coalesce(ref, '') = '' and source in (${CLAUDE_SOURCES}))`,
  )
  const page = stats.prepare(
    `select session_key, session_id, instance, last_ts, tokens_json, days_json, gone_at
     from session_stats where source = 'claude' and session_key > ? order by session_key limit ${PAGE}`,
  )
  const sum: LegacySummary = { skipped: false, sessions: 0, events: 0, written: 0 }
  const batch: UsageEventInput[] = []
  let lastKey = pos
  // Events per write: random claim and hour pages can be cold, so the size follows how long the last write took.
  let chunk = 100
  const flush = async (): Promise<void> => {
    const have = store.db.prepare('select 1 from usage_event where id = ?')
    while (batch.length > 0) {
      const part = batch.splice(0, chunk)
      const t = performance.now()
      sum.written += store.settleOld(part.filter((e) => e.ts < cut))
      const fresh = part.filter((e) => e.ts >= cut && !have.get(e.id))
      store.upsertEvents(fresh)
      sum.written += fresh.length
      const took = performance.now() - t
      chunk =
        took > SLICE_MS / 2
          ? Math.max(10, chunk >> 1)
          : Math.min(WRITE_SLICE, chunk + (chunk >> 2) + 1)
      if (batch.length > 0) await yieldLoop()
    }
    store.setMeta('legacy_backfill_pos', `${tag}\u0000${lastKey}\u0000${floor ?? ''}`)
  }
  let since = performance.now()
  for (;;) {
    const rows = page.all(lastKey) as StatsRow[]
    if (rows.length === 0) break
    for (const row of rows) {
      const s = spanQ.get(row.session_id) as { a: number | null; b: number | null }
      const span = s.a !== null && s.b !== null ? { from: localDay(s.a), to: localDay(s.b) } : null
      const evs = legacyEvents(row, span, floor, opts.pc ?? null)
      sum.sessions++
      sum.events += evs.length
      batch.push(...evs)
      lastKey = row.session_key
      if (batch.length >= chunk || performance.now() - since >= SLICE_MS) {
        await flush()
        await yieldLoop()
        since = performance.now()
      }
    }
  }
  await flush()
  store.setMeta('legacy_backfill', `${tag}:done`)
  return sum
}
