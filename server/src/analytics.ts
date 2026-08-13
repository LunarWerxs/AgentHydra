// server/src/analytics.ts — per-session totals, computed once and kept.
//
// WHY THIS COSTS ALMOST NOTHING TO STORE, which is the whole reason it is allowed to exist. The
// scanner already opens every transcript and reads every line to build the session list; it works
// out the title and the message count and throws the rest away. This keeps a handful of TOTALS per
// session instead: tokens per model, a sparse day and hour histogram, tool counts, and four
// counters. About 600 bytes a session, so a five-thousand-session store is a couple of megabytes.
//
// IT IS NOT THE FULL-TEXT INDEX, and must not become it. Nothing here stores a single word of a
// message. Every field is a number or a key that came from a tool name, a model id or a date. If a
// future field needs message text to be useful, it belongs in that other decision, not this one.
//
// WHY A SEPARATE PASS FROM THE LIST SCANNER. `parseMeta` reads the last 12 MB of a transcript,
// which is the right trade for a title and a preview and the wrong one for a total: a session's
// spend is the whole file. This streams the file end to end, like server/src/session-usage.ts does
// for one session on demand, and runs as a background warm so nobody waits for it.
//
// THE ONE APPROXIMATION, stated plainly because it shows up in a chart: a session's cost is exact,
// and its cost ON A GIVEN DAY is apportioned across the days it touched in proportion to the
// weighted tokens spent on each. For a session that ran inside one day (the common case) that is
// exact. For one spanning midnight it splits the session's own total the same way the tokens split,
// which is the closest thing to the truth that a per-model price table can give without storing a
// price-weighted figure per day per model.

import { db } from './db'
import { readOpenCodeUsage } from './opencode-sessions'
import { priceTokens } from './pricing'
import { streamLines } from './session-search'
import { decodeProjectKey, listTranscriptFiles, type TranscriptFile } from './transcript'
import type {
  ActivityReport,
  AnalyticsCoverage,
  ConcurrencyPoint,
  EditEntry,
  ModelSpend,
  SessionSource,
  SpendBucket,
  SpendReport,
  TokenBreakdown,
} from './types'
import { addTurn, CodexUsageReader, openCodeSpend } from './usage-foreign'
import { accumulateUsageLine, emptySpend } from './usage-tokens'

/**
 * Bumped when the extracted shape changes, which forces every row to be recomputed.
 *
 * 2: Codex and OpenCode totals. Version 1 stored zero for both, and the freshness check is
 *    (mtime, size) — neither of which moves when the PARSER changes — so every one of those
 *    sessions would have kept its empty row forever. Caught by shipping it: the live daemon
 *    reported one Codex session where the store has 136.
 * 3: Every rollout in a Codex conversation, not just the newest. Codex writes one file per
 *    execution thread and the transcript index keeps one ROW per conversation, so the totals were
 *    reading a single file out of hundreds. On this machine that was 5,283 rollouts collapsing to
 *    146, and the reported Codex spend was a fraction of the real figure.
 */
export const ANALYTICS_VERSION = 3

/**
 * Gaps longer than this are not work, they are a lunch break with the window left open.
 *
 * "Agent-minutes" has to mean something, and wall-clock span does not: a session opened at 09:00
 * and touched again at 17:00 spans eight hours of which maybe twenty minutes were real. Summing
 * inter-turn gaps with each one capped gives a figure that tracks engaged time, and the cap is what
 * stops one overnight pause from dwarfing everything else in the chart.
 */
const ACTIVE_GAP_CAP_MS = 5 * 60_000

/** Tools whose use means a file changed. `MultiEdit` is gone from current CLIs but old transcripts
 *  still carry it, and a feed that silently skipped those would be wrong about history. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'str_replace_editor'])
/** Where each of them keeps the path. Checked in order; the first present wins. */
const PATH_KEYS = ['file_path', 'notebook_path', 'path']

/** How many edits one session may contribute to the feed. The feed is a recent-activity surface,
 *  not a version history, and an unbounded list would be the one field here that grows without a
 *  ceiling. */
const MAX_EDITS_PER_SESSION = 40

export interface SessionEdit {
  path: string
  /** Index of the turn that made the change, so the UI can open the transcript at it. */
  turn: number
  ts: number | null
}

export interface SessionAnalytics {
  /** Per-model token totals, the same shape server/src/usage-tokens.ts produces. */
  tokens: Record<string, ModelSpend>
  /** YYYY-MM-DD (local) -> weighted tokens spent that day. */
  days: Record<string, number>
  /** Hour of week, 0 = Sunday 00:00, 167 = Saturday 23:00 -> turns. */
  hours: Record<string, number>
  /** Tool name -> times used. */
  tools: Record<string, number>
  toolErrors: number
  /** Longest run of consecutive failing tool results. A streak is the signal that something was
   *  actually stuck, which a raw count of scattered failures is not. */
  toolErrorStreak: number
  editCount: number
  edits: SessionEdit[]
  compactions: number
  /** Engaged time, in milliseconds. See ACTIVE_GAP_CAP_MS. */
  activeMs: number
  firstTs: number | null
  lastTs: number | null
  /** A cost the PROVIDER computed itself (OpenCode does). Null when nobody but us can price it. */
  providerCostUsd: number | null
}

function emptyAnalytics(): SessionAnalytics {
  return {
    tokens: {},
    days: {},
    hours: {},
    tools: {},
    toolErrors: 0,
    toolErrorStreak: 0,
    editCount: 0,
    edits: [],
    compactions: 0,
    activeMs: 0,
    firstTs: null,
    lastTs: null,
    providerCostUsd: null,
  }
}

/** Local date key. Local, not UTC: a chart of "what did I spend on Tuesday" has to agree with the
 *  reader's own calendar, and the daemon runs on the reader's machine. */
function dayKey(ms: number): string {
  const d = new Date(ms)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 0 = Sunday 00:00 … 167 = Saturday 23:00. */
function hourKey(ms: number): number {
  const d = new Date(ms)
  return d.getDay() * 24 + d.getHours()
}

function firstPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const rec = input as Record<string, unknown>
  for (const key of PATH_KEYS) {
    const v = rec[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

/**
 * Read one transcript end to end and total it up.
 *
 * Streamed, never held whole: these files reach hundreds of megabytes, and this runs over every one
 * of them. The usage arithmetic is delegated to accumulateUsageLine so there is exactly one parser
 * for what a turn cost; everything else here is counting.
 */
export async function scanSessionAnalytics(
  path: string,
  source: SessionSource,
  sessionId?: string,
  /** Other files belonging to the same session. Codex writes one rollout per execution thread and
   *  each carries its own token counter, so a total that reads only `path` reports a fraction of
   *  the truth. See TranscriptFile.siblingPaths. */
  siblingPaths: string[] = [],
): Promise<SessionAnalytics> {
  const out = emptyAnalytics()
  // OpenCode has already totalled its own session: the numbers are columns on its row, not events
  // in a log, so there is nothing to stream. See openCodeSpend for why `reasoning` is kept out of
  // `output` rather than added to it.
  if (source === 'opencode') {
    const row = sessionId ? readOpenCodeUsage(sessionId) : null
    if (row) {
      const spend = openCodeSpend(row)
      out.tokens = spend.byModel
      out.providerCostUsd = spend.costUsd
      // No per-turn timestamps exist, so the session's own clock places it on the day chart. That
      // puts a session's whole spend on the day it last ran rather than spreading it, which for a
      // provider that records no turn times is the only honest placement.
      const at = typeof row.time_updated === 'number' ? row.time_updated : null
      if (at) {
        out.firstTs = at
        out.lastTs = at
        const weighted = Object.values(spend.byModel).reduce((n, m) => n + m.weighted, 0)
        out.days[dayKey(at)] = weighted
        out.hours[String(hourKey(at))] = 1
      }
    }
    return out
  }
  if (source === 'codex') return scanCodexAnalytics([path, ...siblingPaths], out)

  const spend = emptySpend()
  let lastWeighted = 0
  let prevTs: number | null = null
  let turn = -1
  let streak = 0

  for await (const raw of streamLines(path)) {
    const line = raw.trim()
    if (!line) continue

    // The usage pass first, and on the RAW line: it has its own cheap pre-filter and its own
    // JSON.parse, and letting it skip the ~90% of lines with no `"usage"` in them is most of why
    // this is fast enough to run over a whole store.
    const ts = accumulateUsageLine(spend, line, 0)
    if (ts !== null) {
      const weighted = spend.weighted - lastWeighted
      lastWeighted = spend.weighted
      const day = dayKey(ts)
      out.days[day] = (out.days[day] ?? 0) + weighted
      const hour = String(hourKey(ts))
      out.hours[hour] = (out.hours[hour] ?? 0) + 1
      if (out.firstTs === null) out.firstTs = ts
      out.lastTs = ts
      if (prevTs !== null && ts > prevTs) out.activeMs += Math.min(ts - prevTs, ACTIVE_GAP_CAP_MS)
      prevTs = ts
    }

    // Everything below needs the parsed event. Skip lines that cannot carry one rather than
    // parsing every line twice.
    if (
      !line.includes('"tool_use"') &&
      !line.includes('"tool_result"') &&
      !line.includes('Compact')
    )
      continue
    let ev: {
      type?: string
      isCompactSummary?: boolean
      timestamp?: string
      message?: { role?: string; content?: unknown }
    }
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.isCompactSummary === true) out.compactions++
    const content = ev.message?.content
    if (!Array.isArray(content)) continue
    turn++
    const at = ev.timestamp ? Date.parse(ev.timestamp) : Number.NaN
    const atMs = Number.isFinite(at) ? at : null

    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: string; name?: string; input?: unknown; is_error?: boolean }
      if (b.type === 'tool_use') {
        const name = typeof b.name === 'string' && b.name ? b.name : 'tool'
        out.tools[name] = (out.tools[name] ?? 0) + 1
        if (EDIT_TOOLS.has(name)) {
          const p = firstPath(b.input)
          if (p) {
            out.editCount++
            if (out.edits.length < MAX_EDITS_PER_SESSION)
              out.edits.push({ path: p, turn, ts: atMs })
          }
        }
      } else if (b.type === 'tool_result') {
        if (b.is_error === true) {
          out.toolErrors++
          streak++
          if (streak > out.toolErrorStreak) out.toolErrorStreak = streak
        } else {
          streak = 0
        }
      }
    }
  }

  out.tokens = spend.byModel
  return out
}

/**
 * Codex rollouts: the same totals, from a completely different log.
 *
 * Separate from the Claude walk above rather than bolted into it, because almost nothing is shared.
 * Codex announces its model in `turn_context`, reports usage as a running cumulative in
 * `token_count`, files tool calls under `response_item` shapes of its own, and has no notion of a
 * `tool_result.is_error` block at all. Forcing one loop to serve both would be a function with two
 * unrelated halves and a flag.
 */
async function scanCodexAnalytics(
  paths: string[],
  out: SessionAnalytics,
): Promise<SessionAnalytics> {
  let turn = -1
  // Every file that belongs to this conversation, each with a FRESH reader: a rollout's token
  // counter is its own running cumulative, so carrying one reader across files would read the next
  // file's opening total as one enormous delta. `prevTs` restarts too, since a gap between two
  // parallel threads is not idle time within either of them.
  for (const path of paths) {
    const reader = new CodexUsageReader()
    let prevTs: number | null = null
    // Per FILE, not per session. A conversation here can own hundreds of rollouts and Codex
    // moves them between `sessions/` and `archived_sessions/` while the daemon is scanning, so
    // one file vanishing mid-read is expected. Letting that throw would discard every OTHER
    // file's totals for the same conversation, a far larger error than the one missing file.
    try {
      for await (const raw of streamLines(path)) {
        const line = raw.trim()
        if (!line) continue
        let ev: {
          type?: string
          timestamp?: string
          payload?: { type?: string; name?: string; arguments?: unknown; call_id?: string }
        }
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }

        const t = reader.push(ev)
        if (t) {
          addTurn(out.tokens, t.model, t)
          if (t.ts !== null) {
            const day = dayKey(t.ts)
            // Weighted so the day chart apportions a Codex session the same way it does a Claude one.
            out.days[day] =
              (out.days[day] ?? 0) +
              t.input +
              t.cacheRead * 0.1 +
              t.cacheWrite * 1.25 +
              t.output * 5
            const hour = String(hourKey(t.ts))
            out.hours[hour] = (out.hours[hour] ?? 0) + 1
            if (out.firstTs === null || t.ts < out.firstTs) out.firstTs = t.ts
            if (out.lastTs === null || t.ts > out.lastTs) out.lastTs = t.ts
            if (prevTs !== null && t.ts > prevTs)
              out.activeMs += Math.min(t.ts - prevTs, ACTIVE_GAP_CAP_MS)
            prevTs = t.ts
          }
        }

        const payload = ev.payload
        if (!payload) continue
        // Codex logs a compaction as its own top-level event type rather than a flag on a turn.
        if (ev.type === 'compacted') out.compactions++
        if (ev.type !== 'response_item') continue
        turn++
        // Codex has TWO call shapes and both are tool use: `function_call` for a declared tool, and
        // `custom_tool_call` for its sandbox (`exec`, `wait`). Counting only the first missed the two
        // most-used tools in a real rollout entirely.
        //
        // NOTE ON EDITS: no edit is recorded for Codex, deliberately. Its file changes happen INSIDE
        // the `exec` sandbox as free-form code rather than as a tool call with a path argument, so
        // there is nothing structured to read. Guessing a path out of a code string would produce a
        // feed that is wrong in ways nobody could check, which is worse than one that is empty.
        if (
          (payload.type === 'function_call' || payload.type === 'custom_tool_call') &&
          typeof payload.name === 'string'
        ) {
          const name = payload.name || 'tool'
          out.tools[name] = (out.tools[name] ?? 0) + 1
          if (EDIT_TOOLS.has(name) || /apply_patch|edit_file|write_file/i.test(name)) {
            let input: unknown = payload.arguments
            if (typeof input === 'string') {
              try {
                input = JSON.parse(input)
              } catch {
                input = null
              }
            }
            const p = firstPath(input)
            if (p) {
              out.editCount++
              if (out.edits.length < MAX_EDITS_PER_SESSION)
                out.edits.push({ path: p, turn, ts: out.lastTs })
            }
          }
        }
      }
    } catch {
      // Unreadable or moved: skip this file, keep the conversation.
    }
  }
  return out
}

// --- persistence -------------------------------------------------------------------------------
// Stored on session_scan_cache, keyed by the same (path, mtime, size) revision the list scanner
// uses, so a transcript that gains a turn invalidates its analytics along with its title. That is
// why there is no separate staleness bookkeeping here: there is only one notion of "this row
// describes this file as it is now", and it already existed.

interface AnalyticsRow {
  cache_key: string
  session_id: string
  source: string
  project: string
  cwd: string
  analytics_at: number | null
  analytics_version: number | null
  tokens_json: string | null
  days_json: string | null
  hours_json: string | null
  tools_json: string | null
  tool_errors: number | null
  tool_error_streak: number | null
  edit_count: number | null
  compactions: number | null
  active_ms: number | null
  first_ts: number | null
  last_ts: number | null
  provider_cost_usd: number | null
}

const selectRows = db.query<AnalyticsRow, []>(
  'select cache_key, session_id, source, project, cwd, analytics_at, analytics_version, ' +
    'tokens_json, days_json, hours_json, tools_json, tool_errors, tool_error_streak, ' +
    'edit_count, compactions, active_ms, first_ts, last_ts, provider_cost_usd ' +
    'from session_scan_cache ' +
    'where analytics_at is not null',
)

const upsertAnalytics = db.query(
  'update session_scan_cache set analytics_at = ?, analytics_version = ?, ' +
    'analytics_mtime_ms = ?, analytics_size_bytes = ?, provider_cost_usd = ?, session_id = ?, ' +
    'source = ?, project = ?, tokens_json = ?, days_json = ?, hours_json = ?, tools_json = ?, ' +
    'tool_errors = ?, tool_error_streak = ?, edit_count = ?, compactions = ?, active_ms = ?, ' +
    'first_ts = ?, last_ts = ? where cache_key = ?',
)

/**
 * A placeholder row, so analytics can be stored for a transcript the LIST scanner has not parsed yet
 * (the two warms run independently, and the list only warms the newest few hundred).
 *
 * `mtime_ms` and `size_bytes` are -1 ON PURPOSE. The list scanner validates its own cache by
 * comparing those against the file on disk, so an impossible pair guarantees it treats this row as
 * stale and re-parses. Writing the REAL pair here looked harmless and was not: the row satisfied the
 * list's freshness check, so the list read this placeholder as a finished parse with a uuid for a
 * title and zero substantive turns — and a session with zero substantive turns is DROPPED from the
 * list. Analytics would have silently deleted sessions from the sessions view.
 */
const insertShell = db.query(
  'insert into session_scan_cache (cache_key, path, mtime_ms, size_bytes, title, cwd, git_branch, ' +
    'message_count, created_at, last_activity_at, last_role, last_text_preview, ' +
    'substantive_turns, scanned_at) values (?, ?, -1, -1, ?, ?, null, 0, null, ?, null, null, 0, ?) ' +
    'on conflict(cache_key) do nothing',
)

const deleteEdits = db.query('delete from session_edits where cache_key = ?')
const insertEdit = db.query(
  'insert into session_edits (cache_key, session_id, source, project, path, turn, ts) ' +
    'values (?, ?, ?, ?, ?, ?, ?)',
)

/** Matches the key server/src/sessions.ts builds; kept in step by the test that pins both. */
export function analyticsCacheKey(tf: TranscriptFile): string {
  return `${tf.source}:${tf.session_id}:${tf.path}`
}

const selectRevision = db.query<
  {
    analytics_mtime_ms: number | null
    analytics_size_bytes: number | null
    analytics_at: number | null
    analytics_version: number | null
  },
  [string]
>(
  'select analytics_mtime_ms, analytics_size_bytes, analytics_at, analytics_version ' +
    'from session_scan_cache where cache_key = ?',
)

/** Compared against the ANALYTICS stamp, never the list scanner's: the two are written by different
 *  passes, and reading the other one's stamp would make each rescan whenever the other ran. */
function needsScan(tf: TranscriptFile): boolean {
  const row = selectRevision.get(analyticsCacheKey(tf))
  if (!row) return true
  if (row.analytics_at === null || row.analytics_version !== ANALYTICS_VERSION) return true
  return row.analytics_mtime_ms !== tf.mtime_ms || row.analytics_size_bytes !== tf.size_bytes
}

function persist(tf: TranscriptFile, a: SessionAnalytics): void {
  const key = analyticsCacheKey(tf)
  // The list scanner owns this row and may not have written it yet (analytics can warm first on a
  // cold store), so a placeholder carries the not-null columns until the real parse fills them in.
  // Its revision is hard-coded to (-1, -1) in the statement itself: see the comment on insertShell
  // for why writing the file's real mtime and size here silently deleted sessions from the list.
  insertShell.run(key, tf.path, tf.session_id, tf.cwd ?? '', tf.mtime_ms, Date.now())
  db.transaction(() => {
    upsertAnalytics.run(
      Date.now(),
      ANALYTICS_VERSION,
      tf.mtime_ms,
      tf.size_bytes,
      a.providerCostUsd,
      tf.session_id,
      tf.source,
      tf.project,
      JSON.stringify(a.tokens),
      JSON.stringify(a.days),
      JSON.stringify(a.hours),
      JSON.stringify(a.tools),
      a.toolErrors,
      a.toolErrorStreak,
      a.editCount,
      a.compactions,
      a.activeMs,
      a.firstTs,
      a.lastTs,
      key,
    )
    deleteEdits.run(key)
    for (const e of a.edits)
      insertEdit.run(
        key,
        tf.session_id,
        tf.source,
        tf.cwd || decodeProjectKey(tf.project),
        e.path,
        e.turn,
        e.ts,
      )
  })()
}

/**
 * The global cap on the edits feed.
 *
 * Every other field here is bounded per session, so the store grows with the number of sessions and
 * nothing else. Edits are the one list, so they get a ceiling of their own: the feed answers "what
 * has been touched lately", and ten thousand rows is far more than that question needs.
 */
const MAX_EDIT_ROWS = 10_000

function pruneEdits(): void {
  try {
    db.run(
      'delete from session_edits where id not in (select id from session_edits order by ts desc, id desc limit ?)',
      [MAX_EDIT_ROWS],
    )
  } catch {
    // Housekeeping only. A store that grew past the cap is a much smaller problem than a warm-up
    // that aborts.
  }
}

export interface AnalyticsRefresh {
  scanned: number
  skipped: number
  /** Transcripts that could not be totalled. Reported rather than swallowed — see the catch below. */
  failed: number
  budgetExhausted: boolean
}

/**
 * Bring the stored totals up to date, newest transcript first, under a wall-clock budget.
 *
 * Newest-first because the charts are read from the recent end: a store that is only half-scanned
 * should be right about this week and missing last year, never the other way round. The budget is
 * what keeps this from monopolising a daemon that is also serving a UI.
 */
export async function refreshAnalytics(
  files: TranscriptFile[],
  opts: { budgetMs?: number; concurrency?: number } = {},
): Promise<AnalyticsRefresh> {
  const deadline = Date.now() + (opts.budgetMs ?? 60_000)
  const concurrency = Math.max(1, opts.concurrency ?? 4)
  const queue = [...files].sort((a, b) => b.mtime_ms - a.mtime_ms)
  let scanned = 0
  let skipped = 0
  let failed = 0
  let next = 0
  let budgetExhausted = false

  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= queue.length) return
      if (Date.now() > deadline) {
        budgetExhausted = true
        return
      }
      const tf = queue[i]
      if (!tf) return
      if (!needsScan(tf)) {
        skipped++
        continue
      }
      try {
        const a = await scanSessionAnalytics(tf.path, tf.source, tf.session_id, tf.siblingPaths)
        persist(tf, a)
        scanned++
      } catch (err) {
        // An unreadable or half-written transcript is skipped, not fatal: it will be retried on the
        // next refresh, by which point the writer has usually finished.
        //
        // COUNTED AND REPORTED, though, because a silent catch here hid a real bug during
        // development — a mismatched statement meant every single file failed, and the only symptom
        // was a warm that reported nothing and a table that stayed empty. A failure that happens to
        // EVERY file is not the transient case this catch is for, and `failed` is what makes the
        // difference visible.
        failed++
        if (process.env.AGENTHYDRA_DEBUG_ANALYTICS) console.error('[analytics]', err)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  if (scanned > 0) pruneEdits()
  return { scanned, skipped, failed, budgetExhausted }
}

let warming: Promise<void> | null = null

/** Warm in the background, once at a time. Never awaited by a request. */
export function warmAnalyticsInBackground(budgetMs = 120_000): void {
  if (warming) return
  warming = (async () => {
    try {
      await refreshAnalytics(listTranscriptFiles(), { budgetMs })
    } catch {
      // Analytics are an addition; the rest of the daemon does not depend on them.
    } finally {
      warming = null
    }
  })()
}

// --- aggregates --------------------------------------------------------------------------------

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Which account dispatched a given session, when we dispatched it at all. */
function accountBySession(): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const rows = db
      .query<{ session_id: string; label: string | null }, []>(
        "select q.session_id as session_id, coalesce(a.label, q.instance_ref, '') as label " +
          'from queue_items q left join accounts a on a.id = q.account_id',
      )
      .all()
    for (const r of rows) if (r.session_id && r.label) out.set(r.session_id, r.label)
  } catch {
    // A schema that does not carry these columns simply yields no account breakdown.
  }
  return out
}

/**
 * Drop the entries that are not models.
 *
 * The CLI attributes its own synthetic notices (an API error, a cancellation) to a pseudo-model
 * `<synthetic>`, which carries turns and no tokens. Left in, it shows up as a zero-dollar row in a
 * chart of models, where a reader has to work out that it is not one. The stored row keeps it,
 * because that is what the transcript said; only the report leaves it out.
 */
const NON_MODELS = new Set(['<synthetic>', 'unknown'])
function withoutNonModels(tokens: Record<string, ModelSpend>): Record<string, ModelSpend> {
  const out: Record<string, ModelSpend> = {}
  for (const [k, v] of Object.entries(tokens)) if (!NON_MODELS.has(k) || v.weighted > 0) out[k] = v
  return out
}

/**
 * Group projects case-insensitively, and remember the first spelling for display.
 *
 * Windows paths are case-insensitive, and the two sources these come from disagree about the drive
 * letter: `D:\NEWProjects\...` from a session's own cwd, `d:\NEWProjects\...` from the decoded store
 * folder. Grouping on the raw string put one project on the chart twice, which is exactly the kind
 * of mistake a chart makes look authoritative. Caught on real data, not in review.
 */
const projectDisplay = new Map<string, string>()
function projectKeyOf(path: string): string {
  const key = path.toLowerCase()
  if (!projectDisplay.has(key)) projectDisplay.set(key, path)
  return key
}

function addTo(map: Map<string, SpendBucket>, key: string, weighted: number, cost: number | null) {
  const b = map.get(key) ?? {
    key,
    weighted: 0,
    costUsd: cost === null ? null : 0,
    sessions: 0,
    turns: 0,
  }
  b.weighted += weighted
  if (cost !== null && b.costUsd !== null) b.costUsd += cost
  map.set(key, b)
  return b
}

/** The four categories, zeroed. */
function emptyTokens(): TokenBreakdown {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
}

/** Fold one model's counts into a running breakdown. The two cache-write TTL slots are summed:
 *  only Anthropic distinguishes them, and a reader asking "how much did I write to cache" wants
 *  one number. */
function addTokens(into: TokenBreakdown, m: ModelSpend): void {
  const write = m.cacheCreation5m + m.cacheCreation1h
  into.input += m.input
  into.cacheRead += m.cacheRead
  into.cacheWrite += write
  into.output += m.output
  into.total += m.input + m.cacheRead + write + m.output
}

const sortBuckets = (m: Map<string, SpendBucket>) =>
  [...m.values()].sort((a, b) => (b.costUsd ?? b.weighted) - (a.costUsd ?? a.weighted))

/**
 * The whole spend report in one pass over the stored rows.
 *
 * One pass rather than four queries because the rows are small and already in this process, and
 * because every breakdown has to agree with every other one: a "by project" total that does not sum
 * to the "by model" total is worse than either on its own.
 */
export function spendReport(opts: { sinceMs?: number | null } = {}): SpendReport {
  const since = opts.sinceMs ?? null
  const rows = selectRows.all()
  const accounts = accountBySession()
  projectDisplay.clear()

  const byModel = new Map<string, SpendBucket>()
  const byProject = new Map<string, SpendBucket>()
  const byDay = new Map<string, SpendBucket>()
  const byAccount = new Map<string, SpendBucket>()
  const unpriced = new Set<string>()
  let totalCost = 0
  let anyPriced = false
  let totalWeighted = 0
  let sessions = 0
  const tokenTotals = emptyTokens()
  const byProvider = new Map<
    SessionSource,
    { key: SessionSource; tokens: TokenBreakdown; sessions: number; costUsd: number | null }
  >()
  let from: string | null = null
  let to: string | null = null

  for (const row of rows) {
    if (row.analytics_version !== ANALYTICS_VERSION) continue
    if (since !== null && (row.last_ts ?? 0) < since) continue
    const tokens = withoutNonModels(parseJson<Record<string, ModelSpend>>(row.tokens_json, {}))
    const days = parseJson<Record<string, number>>(row.days_json, {})
    const modelKeys = Object.keys(tokens)
    if (modelKeys.length === 0) continue
    sessions++

    // Priced at the session's own newest turn, matching what the session header shows, so the two
    // surfaces cannot disagree about the same session.
    const at = row.last_ts ?? Date.now()
    const priced = priceTokens(tokens, at)
    // A cost the provider computed itself wins over our table: OpenCode routes to models this repo
    // has no prices for, and its own figure is the real one rather than a gap we would report as
    // unpriced. Only its models are then left out of the unpriced list, since they ARE priced.
    const ownCost = row.provider_cost_usd
    const hasOwnCost = typeof ownCost === 'number' && Number.isFinite(ownCost)
    if (!hasOwnCost) for (const m of priced.unpriced) unpriced.add(m)
    const sessionCost = hasOwnCost ? ownCost : priced.costUsd
    if (sessionCost !== null) {
      totalCost += sessionCost
      anyPriced = true
    }

    // When the PROVIDER priced the session, its models are priced too — split proportionally, the
    // same way the day chart splits a session across days. Without this, "cost by model" showed a
    // dash for every OpenCode model while "cost by provider" showed real money for the same
    // sessions, which is two answers to one question.
    const totalWeightedInSession = Object.values(tokens).reduce((n, m) => n + m.weighted, 0)
    let sessionWeighted = 0
    for (const [model, spend] of Object.entries(tokens)) {
      sessionWeighted += spend.weighted
      const share =
        hasOwnCost && totalWeightedInSession > 0 ? spend.weighted / totalWeightedInSession : 0
      const modelCost = hasOwnCost
        ? (sessionCost ?? 0) * share
        : priceTokens({ [model]: spend }, at).costUsd
      const b = addTo(byModel, model, spend.weighted, modelCost)
      b.sessions++
      b.turns += spend.turns
      b.tokens = b.tokens ?? emptyTokens()
      addTokens(b.tokens, spend)
      addTokens(tokenTotals, spend)
    }
    totalWeighted += sessionWeighted

    // Per provider, because "my statistics only show Claude" is exactly the question this answers.
    const provider = (row.source as SessionSource) ?? 'claude'
    const pv = byProvider.get(provider) ?? {
      key: provider,
      tokens: emptyTokens(),
      sessions: 0,
      costUsd: null as number | null,
    }
    for (const spend of Object.values(tokens)) addTokens(pv.tokens, spend)
    pv.sessions++
    if (sessionCost !== null) pv.costUsd = (pv.costUsd ?? 0) + sessionCost
    byProvider.set(provider, pv)

    // Decoded, not the raw key. A row whose scan never filled in `cwd` falls back to the transcript
    // store's own folder name (`d--NEWProjects-shared-Connections`), and leaving that undecoded put
    // the SAME project on the chart twice under two spellings — caught on real data, and the kind of
    // error a chart states with total confidence.
    const project = row.cwd || (row.project ? decodeProjectKey(row.project) : '') || 'unknown'
    const pb = addTo(byProject, projectKeyOf(project), sessionWeighted, sessionCost)
    pb.sessions++

    const account = accounts.get(row.session_id)
    if (account) {
      const ab = addTo(byAccount, account, sessionWeighted, sessionCost)
      ab.sessions++
    }

    // The one approximation, documented at the top of this file: a session's cost is split across
    // the days it touched in proportion to the weighted tokens spent on each.
    const dayTotal = Object.values(days).reduce((n, v) => n + v, 0)
    for (const [day, weighted] of Object.entries(days)) {
      const share = dayTotal > 0 ? weighted / dayTotal : 0
      const db_ = addTo(byDay, day, weighted, sessionCost === null ? null : sessionCost * share)
      db_.sessions++
      if (from === null || day < from) from = day
      if (to === null || day > to) to = day
    }
  }

  return {
    from,
    to,
    totalCostUsd: anyPriced ? totalCost : null,
    totalWeighted,
    tokens: tokenTotals,
    byProvider: [...byProvider.values()].sort((a, b) => b.tokens.total - a.tokens.total),
    sessions,
    byModel: sortBuckets(byModel),
    // Re-labelled with the spelling the reader will recognise, now that grouping is done.
    byProject: sortBuckets(byProject)
      .slice(0, 25)
      .map((b) => ({ ...b, key: projectDisplay.get(b.key) ?? b.key })),
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byAccount: sortBuckets(byAccount),
    unpricedModels: [...unpriced].sort(),
    coverage: analyticsCoverage(),
  }
}

export function activityReport(opts: { sinceMs?: number | null } = {}): ActivityReport {
  const since = opts.sinceMs ?? null
  const rows = selectRows.all()
  const hours = new Array<number>(168).fill(0)
  const tools = new Map<string, number>()
  let agentMs = 0
  const health: ActivityReport['health'] = []

  for (const row of rows) {
    if (row.analytics_version !== ANALYTICS_VERSION) continue
    if (since !== null && (row.last_ts ?? 0) < since) continue
    for (const [k, v] of Object.entries(parseJson<Record<string, number>>(row.hours_json, {}))) {
      const i = Number(k)
      if (Number.isInteger(i) && i >= 0 && i < 168) hours[i] = (hours[i] ?? 0) + v
    }
    for (const [k, v] of Object.entries(parseJson<Record<string, number>>(row.tools_json, {})))
      tools.set(k, (tools.get(k) ?? 0) + v)
    agentMs += row.active_ms ?? 0
    const toolErrors = row.tool_errors ?? 0
    const streak = row.tool_error_streak ?? 0
    const compactions = row.compactions ?? 0
    // Only sessions with something to say. A list of every session with zero problems is not a
    // health signal, it is the session list again.
    if (streak >= 3 || toolErrors >= 10 || compactions >= 1)
      health.push({
        session_id: row.session_id,
        source: (row.source as SessionSource) ?? 'claude',
        project: row.cwd || row.project || '',
        toolErrors,
        toolErrorStreak: streak,
        edits: row.edit_count ?? 0,
        compactions,
      })
  }

  health.sort(
    (a, b) =>
      b.toolErrorStreak - a.toolErrorStreak ||
      b.compactions - a.compactions ||
      b.toolErrors - a.toolErrors,
  )

  return {
    hours,
    tools: [...tools.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    agentMinutes: Math.round(agentMs / 60_000),
    health: health.slice(0, 50),
    coverage: analyticsCoverage(),
  }
}

/**
 * How many sessions were alive at the same time, bucketed.
 *
 * Built from the first and last turn of each session rather than from any stored timeline: two
 * numbers per session is all an overlap count needs, so this costs no storage at all.
 */
export function concurrencyReport(opts: {
  sinceMs?: number | null
  bucketMs?: number
}): ConcurrencyPoint[] {
  const bucket = opts.bucketMs ?? 60 * 60_000
  const since = opts.sinceMs ?? Date.now() - 7 * 24 * 60 * 60_000
  const rows = selectRows.all()
  const counts = new Map<number, number>()
  for (const row of rows) {
    if (row.analytics_version !== ANALYTICS_VERSION) continue
    const first = row.first_ts
    const last = row.last_ts
    if (first === null || last === null) continue
    if (last < since) continue
    const start = Math.max(first, since)
    for (let t = Math.floor(start / bucket) * bucket; t <= last; t += bucket)
      counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([at, sessions]) => ({ at, sessions }))
    .sort((a, b) => a.at - b.at)
}

/** The recent-edits feed, newest first, grouped by the caller. */
export function recentEdits(limit = 200): EditEntry[] {
  try {
    return db
      .query<EditEntry, [number]>(
        'select session_id, source, project, path, turn, ts from session_edits ' +
          'order by ts desc, id desc limit ?',
      )
      .all(Math.max(1, Math.min(limit, 1000)))
  } catch {
    return []
  }
}

export function analyticsCoverage(): AnalyticsCoverage {
  let sessions = 0
  let bytes = 0
  try {
    const row = db
      .query<{ n: number; b: number }, [number]>(
        "select count(*) as n, coalesce(sum(length(coalesce(tokens_json, '')) + " +
          "length(coalesce(days_json, '')) + length(coalesce(hours_json, '')) + " +
          "length(coalesce(tools_json, ''))), 0) as b from session_scan_cache " +
          'where analytics_at is not null and analytics_version = ?',
      )
      .get(ANALYTICS_VERSION)
    sessions = row?.n ?? 0
    bytes = row?.b ?? 0
  } catch {
    // A database that predates the migration reports nothing rather than throwing.
  }
  let total = 0
  try {
    total = listTranscriptFiles().length
  } catch {
    total = sessions
  }
  return { sessions, total, refreshing: warming !== null, bytes }
}

/** Forget every stored total. The next warm rebuilds them; nothing else depends on them. */
export function dropAnalytics(): boolean {
  try {
    db.run(
      'update session_scan_cache set analytics_at = null, analytics_version = null, ' +
        'tokens_json = null, days_json = null, hours_json = null, tools_json = null, ' +
        'tool_errors = null, tool_error_streak = null, edit_count = null, compactions = null, ' +
        'active_ms = null, first_ts = null, last_ts = null, provider_cost_usd = null, ' +
        'analytics_mtime_ms = null, ' +
        'analytics_size_bytes = null',
    )
    db.run('delete from session_edits')
    return true
  } catch {
    return false
  }
}
