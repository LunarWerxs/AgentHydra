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
import type { TranscriptFile } from './transcript'
import type { SessionUsage, SessionUsageStatus } from './types'
import { accumulateUsageLine, emptySpend } from './usage-tokens'

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
