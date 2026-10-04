// server/src/session-usage.ts — tokens and dollars for ONE session, read from the analytics kit.
//
// The kit's per-session ledger (docs/ANALYTICS-PLAN.md §4) already holds every Claude call of a
// session, its subagents' calls included, priced at the rate in force when each call ran. This file
// only reshapes a `usageQuery` answer into the two response shapes the Sessions chip and the run-cost
// endpoint have always returned. A session the kit has not swept yet (brand new, before the next
// ingest pass) has no rows and answers a real zero, the same as an empty transcript always did.

import { type UsageQueryOpts, usageQuery } from './kit/query'
import { pricesAsOf } from './pricing'
import type { TranscriptFile } from './transcript'
import type { RunCost, SessionUsage } from './types'

/** Kit sources that are Claude calls. HSwarm workers a session spawned are billed elsewhere and, on a
 *  busy session, number in the tens of thousands: this chip and a run's cost are Claude spend. */
const CLAUDE_SOURCES = ['cli', 'desktop', 'climayte']

type Tokens = SessionUsage['tokens']

const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

/** Sums of one session's (optionally windowed) kit rows, split by model so priced and unpriced
 *  models can be named. */
function spend(
  session: string,
  window: { from: number; to?: number } | { last: 'all' },
  opts: UsageQueryOpts,
): { tokens: Tokens; costUsd: number | null; priced: string[]; unpriced: string[] } {
  const res = usageQuery(
    {
      window,
      filter: { session: [session], source: CLAUDE_SOURCES },
      groupBy: ['model'],
      measures: ['tokens', 'input', 'output', 'cache_read', 'cache_write', 'calls', 'list_usd'],
    },
    { ...opts, coverage: false },
  )
  const priced: string[] = []
  const unpriced = new Set(res.unpriced)
  for (const r of res.rows) {
    const model = r.model
    if (typeof model !== 'string' || model === '') continue
    if (r.list_usd === null && num(r.tokens) > 0) unpriced.add(model)
    else if (r.list_usd !== null) priced.push(model)
  }
  const t = res.totals
  return {
    tokens: {
      input: num(t.input),
      output: num(t.output),
      cacheRead: num(t.cache_read),
      cacheCreation: num(t.cache_write),
      total: num(t.tokens),
      turns: num(t.calls),
    },
    costUsd: t.list_usd ?? null,
    priced: priced.sort(),
    unpriced: [...unpriced].sort(),
  }
}

/**
 * Tokens and cost for one session, subagents included.
 *
 * Claude only: a Codex rollout and an OpenCode row answer `source-unsupported` so the UI can say
 * why rather than showing a silent zero.
 */
export function sessionUsage(tf: TranscriptFile, opts: UsageQueryOpts = {}): SessionUsage {
  const base = {
    session_id: tf.session_id,
    source: tf.source,
    pricesAsOf: pricesAsOf(),
  }
  if (tf.source !== 'claude') {
    return {
      ...base,
      status: 'source-unsupported',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, turns: 0 },
      costUsd: null,
      pricedModels: [],
      unpricedModels: [],
    }
  }
  const s = spend(tf.session_id, { last: 'all' }, opts)
  return {
    ...base,
    status: 'ok',
    tokens: s.tokens,
    costUsd: s.costUsd,
    pricedModels: s.priced,
    unpricedModels: s.unpriced,
  }
}

/**
 * What one queued run cost: the session's calls inside the run's own window (start to finish; an
 * unfinished run is open-ended, since it is still spending). Closed at both ends so turns typed by
 * hand after the run finished are not charged to it. Computed, never stored.
 */
export function runCost(
  item: {
    id: string
    session_id: string
    status: string
    started_at: string | null
    finished_at: string | null
  },
  opts: UsageQueryOpts = {},
): RunCost {
  const base: RunCost = {
    id: item.id,
    session_id: item.session_id,
    status: item.status,
    startedAt: item.started_at,
    finishedAt: item.finished_at,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, turns: 0 },
    costUsd: null,
    unpricedModels: [],
    pricesAsOf: pricesAsOf(),
    status_reason: 'ok',
  }
  const from = item.started_at ? Date.parse(item.started_at) : Number.NaN
  if (!Number.isFinite(from)) return { ...base, status_reason: 'no-window' }
  const to = item.finished_at ? Date.parse(item.finished_at) : Number.NaN
  const s = spend(item.session_id, Number.isFinite(to) ? { from, to } : { from }, opts)
  return { ...base, tokens: s.tokens, costUsd: s.costUsd, unpricedModels: s.unpriced }
}
