// server/src/session-usage.ts — tokens and dollars for ONE open session.
//
// The whole feature is "read a file the user already asked us to open, and add up a column that was
// always there": zero new tables, zero new columns, nothing written to disk. It exists because the
// numbers were being parsed and thrown away — usage-tokens.ts reads every assistant turn's usage
// block already, but only for files inside a quota lookback window, and only to derive a
// denominator. Point the same parser at one transcript with no window and you get that session's
// real spend.
//
// COST, not just size. A transcript's line count says nothing about what it cost: one 40-turn Opus
// session with a large cached prefix outspends a thousand Haiku turns. pricing.ts does the money.
//
// Streamed, not slurped. The largest transcript on a real machine is ~40 MB and this runs on a
// request the UI makes whenever a session is opened, so it uses session-search.ts's constant-memory
// line reader rather than reading the file into a string.
//
// Cached by (mtime, size). Opening the same finished session twice, or re-opening it after a tool
// toggle, must not re-stream 40 MB — and a transcript that HAS grown is a cache key that changed,
// so a live session still reports fresh numbers with no invalidation logic of its own.

import { statSync } from 'node:fs'
import { PRICES_AS_OF, priceTokens } from './pricing'
import { streamLines } from './session-search'
import { findTranscript, type TranscriptFile } from './transcript'
import type { RunCost, SessionUsage, SessionUsageStatus } from './types'
import { accumulateUsageLine, emptySpend, mergeSpend } from './usage-tokens'

/** Small on purpose: a user opens a handful of sessions in a sitting, and each entry is a dozen
 *  numbers. Oldest-first eviction, which for this access pattern is close enough to LRU. */
const CACHE_MAX = 32
const cache = new Map<string, { mtimeMs: number; size: number; value: SessionUsage }>()

function remember(path: string, mtimeMs: number, size: number, value: SessionUsage): SessionUsage {
  cache.delete(path)
  cache.set(path, { mtimeMs, size, value })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return value
}

function blank(tf: TranscriptFile, status: SessionUsageStatus): SessionUsage {
  return {
    session_id: tf.session_id,
    source: tf.source,
    status,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, turns: 0 },
    costUsd: null,
    pricedModels: [],
    unpricedModels: [],
    pricesAsOf: PRICES_AS_OF,
  }
}

/**
 * Tokens and cost for one session's transcript.
 *
 * Claude only: a Codex rollout and an OpenCode row record their own token counts in their own
 * shapes, and inventing a second parser for each is how the two numbers start disagreeing. Those
 * sources answer `source-unsupported` so the UI can say why rather than showing a silent zero.
 */
export async function sessionUsage(tf: TranscriptFile): Promise<SessionUsage> {
  if (tf.source !== 'claude') return blank(tf, 'source-unsupported')

  let stat: { mtimeMs: number; size: number }
  try {
    stat = statSync(tf.path)
  } catch {
    return blank(tf, 'unreadable') // rotated or deleted between the index sweep and this request
  }
  const hit = cache.get(tf.path)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value

  const spend = emptySpend()
  // The newest turn we counted, used as the pricing instant: a model on an introductory rate must
  // be billed at the rate that applied WHEN the session ran, not at today's.
  let newestTurnMs = 0
  try {
    for await (const line of streamLines(tf.path)) {
      const at = accumulateUsageLine(spend, line, 0 /* no cutoff: the whole session */)
      if (at !== null && at > newestTurnMs) newestTurnMs = at
    }
  } catch {
    return blank(tf, 'unreadable')
  }

  const priced = priceTokens(spend.byModel, newestTurnMs || stat.mtimeMs)
  return remember(tf.path, stat.mtimeMs, stat.size, {
    session_id: tf.session_id,
    source: tf.source,
    status: 'ok',
    tokens: {
      input: spend.input,
      output: spend.output,
      cacheRead: spend.cacheRead,
      cacheCreation: spend.cacheCreation,
      total: spend.raw,
      turns: spend.turns,
    },
    costUsd: priced.costUsd,
    pricedModels: priced.priced,
    unpricedModels: priced.unpriced,
    pricesAsOf: PRICES_AS_OF,
  })
}

// --- what ONE queued run cost -------------------------------------------------------------------

/**
 * Attribute spend to one queued run.
 *
 * AgentsView structurally cannot do this: it never dispatched the work, so it does not know which
 * run a stretch of a transcript belongs to. We do — the queue row carries the session id and the
 * exact instants the run started and finished — so the run's cost is simply the session's own
 * per-turn usage restricted to that window.
 *
 * Computed, never stored. A stored figure would be a second number for the same tokens, free to
 * drift from what the session header reports; recomputing means the two can only ever agree.
 *
 * The window is closed at BOTH ends deliberately. Using only a start would hand a run every turn
 * typed by hand after it finished, which on a session someone kept working in is not a small error.
 */
export async function runCost(item: {
  id: string
  session_id: string
  status: string
  started_at: string | null
  finished_at: string | null
}): Promise<RunCost> {
  const blankTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, turns: 0 }
  const base: RunCost = {
    id: item.id,
    session_id: item.session_id,
    status: item.status,
    startedAt: item.started_at,
    finishedAt: item.finished_at,
    tokens: blankTokens,
    costUsd: null,
    unpricedModels: [],
    pricesAsOf: PRICES_AS_OF,
    status_reason: 'ok',
  }

  const from = item.started_at ? Date.parse(item.started_at) : Number.NaN
  if (!Number.isFinite(from)) return { ...base, status_reason: 'no-window' }
  // An unfinished run is open-ended, which is correct: it is still spending.
  const to = item.finished_at ? Date.parse(item.finished_at) : Number.POSITIVE_INFINITY
  const until = Number.isFinite(to) ? to : Number.POSITIVE_INFINITY

  const tf = findTranscript(item.session_id, 'claude')
  if (!tf) return { ...base, status_reason: 'unreadable' }
  if (tf.source !== 'claude') return { ...base, status_reason: 'source-unsupported' }

  let spend = emptySpend()
  let newestTurnMs = 0
  try {
    for await (const line of streamLines(tf.path)) {
      // One turn at a time into a scratch, merged only if it falls inside the window. The parser
      // has no "peek the timestamp" entry point and adding one would put a second notion of what a
      // turn costs into the codebase; an empty spend is a handful of zeros, so this is cheap.
      const turn = emptySpend()
      const at = accumulateUsageLine(turn, line, from)
      if (at === null || at > until) continue
      spend = mergeSpend(spend, turn)
      if (at > newestTurnMs) newestTurnMs = at
    }
  } catch {
    return { ...base, status_reason: 'unreadable' }
  }

  const priced = priceTokens(spend.byModel, newestTurnMs || Date.now())
  return {
    ...base,
    tokens: {
      input: spend.input,
      output: spend.output,
      cacheRead: spend.cacheRead,
      cacheCreation: spend.cacheCreation,
      total: spend.raw,
      turns: spend.turns,
    },
    costUsd: priced.costUsd,
    unpricedModels: priced.unpriced,
  }
}
