// server/src/reconcile.ts — prove the numbers against the store, by a route that shares no code
// with the numbers.
//
// WHY THIS EXISTS, stated plainly because it is a record of three shipped errors in one day.
//
//   * Codex was reported at 53x its real spend, because a "fix" summed files that replay one
//     shared counter.
//   * Claude was reported 57% high, because one API response is written as several records and
//     every one was charged.
//   * Claude was simultaneously reported at 42% of its real spend, because subagent transcripts
//     live one directory deeper than the index looked.
//
// EVERY ONE OF THOSE PASSED A GREEN TEST SUITE. That is the part worth fixing. A unit test over a
// hand-written fixture pins the behaviour its author believed in; when the belief is wrong, the
// fixture encodes the same wrong belief and the test agrees enthusiastically. Nothing in a suite
// like that can tell you your model of the data is wrong.
//
// So this module does two things no unit test can:
//
//   1. ACCOUNTS FOR EVERY FILE. Walk each store, and put every transcript into exactly one bucket:
//      indexed as a session, attached to a session, or deliberately excluded with a NAMED reason.
//      Anything left over is `unaccounted`, and unaccounted is a failure by definition — not
//      because we know what those files hold, but because nobody decided. The subagent undercount
//      was 16,552 unaccounted files; this check would have printed that number on day one.
//
//   2. RECOUNTS THE TOKENS INDEPENDENTLY. `countTokensIndependently` below is a deliberately dumb
//      second implementation. It does NOT call accumulateUsageLine, does not import usage-tokens,
//      and does not share the parser's idea of what a turn is. Two implementations that must agree
//      is the only arrangement where a wrong assumption has somewhere to show up: an error has to
//      be made twice, the same way, to stay hidden.
//
// It is deliberately slow and deliberately not on any request path. It reads the whole store.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_TOOLS, type AgentTool, rootsFor } from './agent-catalog'
import { ANALYTICS_VERSION } from './analytics'
import { db } from './db'
import type { SessionSource } from './types'

/** Why a file on disk is not a session row. Every exclusion has to be a decision someone made. */
export type ExclusionReason =
  /** A Codex execution thread. Its file replays the conversation's shared counter, so counting it
   *  would multiply that conversation's spend by the number of threads. */
  | 'codex-subagent-replay'
  /** Not a transcript: a lock file, a log, a cache, a sidecar. */
  | 'not-a-transcript'

export interface StoreReconciliation {
  tool: string
  roots: string[]
  filesOnDisk: number
  /** Files that ARE a session row in the index. */
  sessions: number
  /** Files attached to a session row and read as part of its totals. */
  siblings: number
  /** Files deliberately left out, by reason. */
  excluded: Record<string, number>
  /**
   * Files nobody decided about. Non-empty means the index is silently ignoring real data — the
   * exact shape of the bug that hid 89.8 billion Claude tokens.
   */
  unaccounted: string[]
  /** Tokens this store holds, counted by the independent implementation below. */
  tokensIndependent: number
  /** Tokens the analytics tables report for this store. Null when nothing has been scanned yet. */
  tokensReported: number | null
  /** (reported - independent) / independent, or null when there is nothing to compare. */
  drift: number | null
}

export interface Reconciliation {
  at: number
  stores: StoreReconciliation[]
  ok: boolean
  /** Every reason this run is not ok, in plain words. Empty when ok. */
  problems: string[]
  /** False when the analytics tables are still catching up, which makes the token halves of this
   *  audit unanswerable rather than wrong. File accounting is always answerable. */
  warm: boolean
}

/** Drift wider than this is a bug, not rounding. It is deliberately tight: the three real errors
 *  were 53x, +57% and -58%, and nothing legitimate moves a store total by even a percent. */
export const DRIFT_TOLERANCE = 0.01

// --- the independent count ------------------------------------------------------------------
// Everything below is written to share NOTHING with server/src/usage-tokens.ts. It reparses, it
// re-decides what a turn is, and it re-implements the deduplication rule from the observation
// rather than from that module. If the two ever agree by accident it is because they are both
// right; if they agree because they call the same function, this whole file is decoration.

interface IndependentTotals {
  tokens: number
  /** Distinct requests seen, which is the number a per-response charge should equal. */
  requests: number
  records: number
}

/** One assistant record's contribution to the running totals, or `null` when it is a stale replay
 *  of a request already counted at an output size at least as large. Split out of
 *  `countClaudeFile` purely to keep that loop flat; the accounting rules are unchanged. */
function resolveClaudeUsageDelta(
  rec: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
  usage: Record<string, number>,
  seen: Map<string, number>,
): { tokensDelta: number; requestsDelta: number } | null {
  const output = usage.output_tokens ?? 0
  const fullSum =
    (usage.input_tokens ?? 0) +
    output +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  const id = `${message?.id ?? ''}|${rec.requestId ?? ''}`
  const key = rec.requestId ? id : ''
  if (!key) return { tokensDelta: fullSum, requestsDelta: 1 }
  const applied = seen.get(key)
  if (applied !== undefined && output <= applied) return null
  const requestsDelta = applied === undefined ? 1 : 0
  seen.set(key, output)
  if (applied !== undefined) return { tokensDelta: output - applied, requestsDelta: 0 }
  return { tokensDelta: fullSum, requestsDelta }
}

/** Claude and its forks: one JSON object per line, `type: "assistant"` carrying `message.usage`.
 *  A request may be written several times; its tokens are counted once, at its largest output. */
function countClaudeFile(text: string, seen: Map<string, number>): IndependentTotals {
  let tokens = 0
  let records = 0
  let requests = 0
  for (const line of text.split('\n')) {
    if (line.length < 2 || !line.includes('"usage"')) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.type !== 'assistant') continue
    const message = rec.message as Record<string, unknown> | undefined
    const usage = message?.usage as Record<string, number> | undefined
    if (!usage) continue
    records++
    const delta = resolveClaudeUsageDelta(rec, message, usage, seen)
    if (!delta) continue
    tokens += delta.tokensDelta
    requests += delta.requestsDelta
  }
  return { tokens, requests, records }
}

/** Codex: `token_count` events carry a running SESSION-WIDE total, so a conversation's spend is the
 *  furthest any of its files got — never the sum. Re-derived here from the raw events. */
function countCodexFile(text: string): IndependentTotals {
  let highest = 0
  let records = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"token_count"')) continue
    let rec: { payload?: { type?: string; info?: Record<string, Record<string, number>> } }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.payload?.type !== 'token_count') continue
    const total = rec.payload.info?.total_token_usage
    if (!total) continue
    records++
    const sum =
      (total.input_tokens ?? 0) + (total.output_tokens ?? 0) + (total.cache_write_input_tokens ?? 0)
    if (sum > highest) highest = sum
  }
  return { tokens: highest, requests: records, records }
}

// --- walking a store ---------------------------------------------------------------------------

const TRANSCRIPT_EXT = /\.jsonl$/

function walkFiles(dir: string, depth: number, out: string[], cap = 40_000): void {
  if (depth > 6 || out.length >= cap) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (out.length >= cap) return
    const path = join(dir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (st.isDirectory()) walkFiles(path, depth + 1, out, cap)
    else out.push(path)
  }
}

interface IndexView {
  /** Paths that are a session row. */
  sessions: Set<string>
  /** Paths attached to a session row. */
  siblings: Set<string>
  /** Which tool each session row belongs to. */
  toolOf: Map<string, string>
  /** Reported tokens per source, from the analytics tables. */
  tokensBySource: Map<SessionSource, number>
  /** Sessions carrying CURRENT-version analytics. */
  scanned: number
  /** Sessions in the index. */
  indexed: number
}

/** What the index currently believes, read once so a store walk does not re-query per file. */
function indexView(): IndexView {
  // Imported lazily to keep this module out of the transcript index's own import cycle.
  const { listTranscriptFiles } = require('./transcript') as {
    listTranscriptFiles: () => Array<{
      path: string
      source: SessionSource
      tool?: string
      siblingPaths?: string[]
    }>
  }
  const sessions = new Set<string>()
  const siblings = new Set<string>()
  const toolOf = new Map<string, string>()
  for (const f of listTranscriptFiles()) {
    sessions.add(f.path)
    if (f.tool) toolOf.set(f.path, f.tool)
    for (const p of f.siblingPaths ?? []) siblings.add(p)
  }

  // How much of the store has been scanned at the current version. A half-warmed store legitimately
  // reports less than the disk holds, so tokens are only compared once it is complete.
  const scanned =
    db
      .query<{ n: number }, [number]>(
        'select count(*) as n from session_scan_cache where analytics_version = ?',
      )
      .get(ANALYTICS_VERSION)?.n ?? 0

  const tokensBySource = new Map<SessionSource, number>()
  // CURRENT-version rows only. A row written by an older extraction is not a disagreement about
  // the data, it is a row that has not been recomputed yet, and reporting it as drift would make
  // this check scream through every scan and be ignored by the time it mattered.
  const rows = db
    .query<{ source: string; tokens_json: string | null }, [number]>(
      'select source, tokens_json from session_scan_cache where tokens_json is not null ' +
        'and analytics_version = ?',
    )
    .all(ANALYTICS_VERSION)
  for (const row of rows) {
    if (!row.tokens_json) continue
    let byModel: Record<string, Record<string, number>>
    try {
      byModel = JSON.parse(row.tokens_json)
    } catch {
      continue
    }
    let total = 0
    for (const spend of Object.values(byModel))
      total +=
        (spend.input ?? 0) +
        (spend.output ?? 0) +
        (spend.cacheRead ?? 0) +
        (spend.cacheCreation5m ?? 0) +
        (spend.cacheCreation1h ?? 0)
    const key = row.source as SessionSource
    tokensBySource.set(key, (tokensBySource.get(key) ?? 0) + total)
  }
  return { sessions, siblings, toolOf, tokensBySource, scanned, indexed: sessions.size }
}

/** How many paths of a store's files to keep when they are unaccounted. Enough to act on, few
 *  enough that a completely unindexed store does not print forty thousand lines. */
const UNACCOUNTED_SAMPLE = 20

/**
 * Stores where "account for every file" is a meaningful question.
 *
 * Claude and Codex keep one transcript per conversation under a root that is theirs alone, so a
 * file nobody claimed IS a bug. The others are not like that: OpenCode is a single database, and
 * VS Code Copilot's root is the editor's entire user directory, where tens of thousands of files
 * have nothing to do with chat. Demanding every file there be "accounted for" would produce a
 * number with no meaning and drown the one that has one.
 */
const FILE_ACCOUNTED: ReadonlyArray<string | null> = ['claude', 'codex']

/** Mutable accounting shared across one store's file walk, so the per-format helpers below can
 *  update it without each carrying its own copy of the same five parameters. */
interface FileAccountingState {
  out: StoreReconciliation
  exclude: (reason: ExclusionReason) => void
  claudeSeen: Map<string, number>
  codexBySession: Map<string, number>
}

function accountForCodexFile(
  text: string,
  isSession: boolean,
  isSibling: boolean,
  state: FileAccountingState,
): void {
  const sessionId = codexSessionIdOf(text)
  const counted = countCodexFile(text)
  if (!isSession && !isSibling) {
    // Every non-row Codex rollout must be a replay of a conversation we DO have. That is the
    // decision, and it is recorded here rather than left implicit.
    state.exclude('codex-subagent-replay')
  }
  if (sessionId)
    state.codexBySession.set(
      sessionId,
      Math.max(state.codexBySession.get(sessionId) ?? 0, counted.tokens),
    )
}

function accountForClaudeFile(
  path: string,
  text: string,
  isSession: boolean,
  isSibling: boolean,
  state: FileAccountingState,
): void {
  if (!isSession && !isSibling) state.out.unaccounted.push(path)
  state.out.tokensIndependent += countClaudeFile(text, state.claudeSeen).tokens
}

/** One file's contribution to a store's reconciliation. Split out of `reconcileStore` so the
 *  per-format branches (codex/claude/other) each read as their own small function rather than
 *  one loop body doing all three; the decisions made are unchanged. */
function accountForFile(
  path: string,
  tool: AgentTool,
  view: IndexView,
  state: FileAccountingState,
): void {
  const isSession = view.sessions.has(path)
  const isSibling = view.siblings.has(path)
  if (isSession) state.out.sessions++
  else if (isSibling) state.out.siblings++

  if (!TRANSCRIPT_EXT.test(path)) {
    if (!isSession && !isSibling) state.exclude('not-a-transcript')
    return
  }

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }

  if (tool.format === 'codex') return accountForCodexFile(text, isSession, isSibling, state)
  if (tool.format === 'claude') return accountForClaudeFile(path, text, isSession, isSibling, state)

  // A store with no token model of its own (foreign) or one whose totals come from its own
  // columns (opencode): file accounting still applies, token accounting does not.
  if (!isSession && !isSibling) state.exclude('not-a-transcript')
}

function reconcileStore(tool: AgentTool, view: IndexView): StoreReconciliation | null {
  const roots = rootsFor(tool)
  if (roots.length === 0) return null
  if (!FILE_ACCOUNTED.includes(tool.format)) {
    const sessions = [...view.sessions].filter((p) => view.toolOf.get(p) === tool.id).length
    return {
      tool: tool.id,
      roots: roots.map((r) => r.root),
      filesOnDisk: -1,
      sessions,
      siblings: 0,
      excluded: {},
      unaccounted: [],
      tokensIndependent: 0,
      tokensReported: null,
      drift: null,
    }
  }

  const files: string[] = []
  for (const r of roots) walkFiles(r.root, 0, files)

  const out: StoreReconciliation = {
    tool: tool.id,
    roots: roots.map((r) => r.root),
    filesOnDisk: files.length,
    sessions: 0,
    siblings: 0,
    excluded: {},
    unaccounted: [],
    tokensIndependent: 0,
    tokensReported: null,
    drift: null,
  }
  const exclude = (reason: ExclusionReason) => {
    out.excluded[reason] = (out.excluded[reason] ?? 0) + 1
  }

  // Codex's conversation totals are per CONVERSATION, not per file, so they are accumulated by
  // session id and only the furthest reading of each is kept.
  const codexBySession = new Map<string, number>()
  const claudeSeen = new Map<string, number>()
  const state: FileAccountingState = { out, exclude, claudeSeen, codexBySession }

  for (const path of files) accountForFile(path, tool, view, state)

  if (tool.format === 'codex') for (const v of codexBySession.values()) out.tokensIndependent += v

  if (out.unaccounted.length > UNACCOUNTED_SAMPLE)
    out.unaccounted = out.unaccounted.slice(0, UNACCOUNTED_SAMPLE)

  return out
}

/** The session id a Codex rollout belongs to, from its first record. */
function codexSessionIdOf(text: string): string {
  const end = text.indexOf('\n')
  const first = end < 0 ? text : text.slice(0, end)
  if (!first.includes('session_meta')) return ''
  try {
    const rec = JSON.parse(first) as { payload?: { session_id?: string } }
    return rec.payload?.session_id ?? ''
  } catch {
    return ''
  }
}

/**
 * Audit every installed store.
 *
 * Slow by design: it reads the whole corpus. Meant for `bun run audit`, for CI against a fixture
 * store, and for a "verify" button — never for a request that someone is waiting on.
 *
 * A store's tokens are only compared where the format has a token model AND the analytics tables
 * have been fully warmed; a half-warmed store legitimately reports less, and calling that drift
 * would make the check cry wolf until every scan finished.
 */
/** Independent token totals, summed PER READER (not per tool): several products share one reader
 *  and the analytics tables key on the reader, so Cowork's tokens land in the same bucket as
 *  Claude Code's. Comparing a single tool's independent count against that shared bucket is the
 *  kind of apples-to-oranges the first version of this file got wrong, loudly. */
function computeIndependentBySource(stores: StoreReconciliation[]): Map<SessionSource, number> {
  const independentBySource = new Map<SessionSource, number>()
  for (const tool of AGENT_TOOLS) {
    if (!FILE_ACCOUNTED.includes(tool.format) || !tool.format) continue
    const s = stores.find((x) => x.tool === tool.id)
    if (!s) continue
    independentBySource.set(
      tool.format,
      (independentBySource.get(tool.format) ?? 0) + s.tokensIndependent,
    )
  }
  return independentBySource
}

/** Fills in each store's `tokensReported`/`drift` against the shared per-reader totals. Mutates
 *  `stores` in place, same as the loop this was extracted from. */
function applyDriftComparisons(
  stores: StoreReconciliation[],
  view: IndexView,
  warm: boolean,
  independentBySource: Map<SessionSource, number>,
): void {
  for (const s of stores) {
    const tool = AGENT_TOOLS.find((t) => t.id === s.tool)
    if (!tool?.format || !FILE_ACCOUNTED.includes(tool.format)) continue
    const independent = independentBySource.get(tool.format) ?? 0
    const reported = warm ? (view.tokensBySource.get(tool.format) ?? null) : null
    s.tokensReported = reported
    if (reported !== null && independent > 0) s.drift = (reported - independent) / independent
  }
}

function collectProblems(
  stores: StoreReconciliation[],
  independentBySource: Map<SessionSource, number>,
  opts: { requireWarm?: boolean },
  warm: boolean,
  view: IndexView,
): string[] {
  const problems: string[] = []
  const driftSeen = new Set<string>()
  for (const s of stores) {
    if (s.unaccounted.length > 0)
      problems.push(
        `${s.tool}: ${s.unaccounted.length}+ transcript(s) are neither indexed nor deliberately excluded, e.g. ${s.unaccounted[0]}`,
      )
    const tool = AGENT_TOOLS.find((t) => t.id === s.tool)
    const source = tool?.format ?? ''
    if (
      s.drift !== null &&
      Math.abs(s.drift) > DRIFT_TOLERANCE &&
      opts.requireWarm !== false &&
      !driftSeen.has(source)
    ) {
      driftSeen.add(source)
      problems.push(
        `${source}: reported tokens are ${(s.drift * 100).toFixed(1)}% off an independent count of the same files ` +
          `(${s.tokensReported} vs ${independentBySource.get(source as SessionSource) ?? 0})`,
      )
    }
  }
  if (!warm)
    problems.push(
      `tokens not compared: ${view.scanned} of ${view.indexed} sessions have been scanned at the ` +
        `current extraction version, so the reported totals are progress rather than an answer`,
    )
  return problems
}

export function reconcile(opts: { requireWarm?: boolean } = {}): Reconciliation {
  const view = indexView()
  const stores: StoreReconciliation[] = []
  for (const tool of AGENT_TOOLS) {
    const r = reconcileStore(tool, view)
    if (r) stores.push(r)
  }

  // Every indexed session recomputed at the current version. Below that the totals are a partial
  // read of the store and comparing them would be comparing progress, not correctness.
  const warm = view.indexed > 0 && view.scanned >= view.indexed

  const independentBySource = computeIndependentBySource(stores)
  applyDriftComparisons(stores, view, warm, independentBySource)
  const problems = collectProblems(stores, independentBySource, opts, warm, view)
  return { at: Date.now(), stores, ok: problems.length === 0, problems, warm }
}
