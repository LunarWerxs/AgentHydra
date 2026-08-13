// server/src/usage-foreign.ts — token totals for the providers that are NOT Claude.
//
// The analytics tier reported zero for every Codex and OpenCode session, which read as "you have
// not used them" rather than "we did not look". Both record their spend; they simply record it in
// their own shapes, and the Claude parser (usage-tokens.ts) understands exactly one.
//
// EACH PROVIDER'S SHAPE, and the trap in each:
//
//  * CODEX writes a `token_count` event carrying BOTH a running `total_token_usage` and a per-turn
//    `last_token_usage`. Summing the per-turn deltas is the obvious move and it OVERCOUNTS: measured
//    on a real 3,476-event rollout, the deltas summed to 539.8M against a final cumulative of
//    514.3M, about 5% high, because the same turn's usage is emitted more than once. The cumulative
//    is monotonic, so this takes deltas OF THE CUMULATIVE instead: attributable per turn, and
//    summing to the session's real total by construction.
//
//  * CODEX COUNTS CACHED INPUT INSIDE `input_tokens`, where Anthropic reports it alongside. Taking
//    Codex's input_tokens at face value would double-count the cached part, and on a real session
//    that part is 98% of the input. Uncached input is `input_tokens - cached_input_tokens`.
//
//  * OPENCODE has already done the work: its `session` table carries tokens_input / _output /
//    _reasoning / _cache_read / _cache_write and a `cost` per session. There is nothing to parse,
//    only to read — which is why it was the most embarrassing of the three to be reporting zero for.
//
// WHAT IS DELIBERATELY NOT DONE: no price is invented. There is no published price table in this
// repo for OpenAI or for the models OpenCode routes to, so their tokens count and their money does
// not. `priceTokens` already reports an unpriced model as exactly that, and the UI already shows a
// cost carrying such models as a floor, so the honest path was already built.

import type { ModelSpend } from './types'

/** The same weights usage-tokens.ts applies to a Claude turn, so a "weighted token" means one thing
 *  across providers: cache reads are cheap, writes carry a premium, output dominates. */
const W_INPUT = 1
const W_CACHE_WRITE = 1.25
const W_CACHE_READ = 0.1
const W_OUTPUT = 5

export function emptyModelSpend(): ModelSpend {
  return {
    weighted: 0,
    output: 0,
    turns: 0,
    input: 0,
    cacheRead: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
  }
}

/** Add one turn's normalised counts into a per-model bucket. Cache writes land in the 5m slot:
 *  neither provider distinguishes a TTL, and inventing one would be a number nobody measured. */
export function addTurn(
  byModel: Record<string, ModelSpend>,
  model: string,
  t: { input: number; cacheRead: number; cacheWrite: number; output: number },
): void {
  const m = byModel[model] ?? emptyModelSpend()
  m.input += t.input
  m.cacheRead += t.cacheRead
  m.cacheCreation5m += t.cacheWrite
  m.output += t.output
  m.turns += 1
  m.weighted +=
    t.input * W_INPUT +
    t.cacheRead * W_CACHE_READ +
    t.cacheWrite * W_CACHE_WRITE +
    t.output * W_OUTPUT
  byModel[model] = m
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export interface CodexTurn {
  model: string
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  ts: number | null
}

/**
 * Stateful reader for one Codex rollout, fed line by line.
 *
 * Stateful because a `token_count` event carries a RUNNING total and the model is announced
 * separately in a `turn_context` event; a per-line pure function would have neither.
 */
export class CodexUsageReader {
  private model = 'codex'
  private prev = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

  /** Feed one parsed JSONL event. Returns this turn's delta, or null when the line carries none. */
  push(ev: unknown): CodexTurn | null {
    if (!ev || typeof ev !== 'object') return null
    const e = ev as { type?: string; timestamp?: string; payload?: Record<string, unknown> }
    const payload = e.payload
    if (!payload) return null

    // The model is announced per turn and can change mid-session (a /model switch), so it is read
    // every time rather than once from the session header.
    if (e.type === 'turn_context' && typeof payload.model === 'string' && payload.model)
      this.model = payload.model

    if (payload.type !== 'token_count') return null
    const info = payload.info as Record<string, unknown> | undefined
    const total = info?.total_token_usage as Record<string, unknown> | undefined
    if (!total) return null

    const rawInput = num(total.input_tokens)
    const cacheRead = num(total.cached_input_tokens)
    const cur = {
      // Codex reports cached input INSIDE input_tokens; Anthropic reports it alongside. Subtracting
      // is what makes the two providers' "input" mean the same thing. Clamped at zero because a
      // provider that changes its mind about this must not produce a negative token count.
      input: Math.max(0, rawInput - cacheRead),
      cacheRead,
      cacheWrite: num(total.cache_write_input_tokens),
      output: num(total.output_tokens),
    }

    // A running total that went DOWN is a reset (a fresh context after compaction), not a negative
    // turn: take the new total as the delta rather than subtracting into nonsense.
    const reset = cur.input + cur.output < this.prev.input + this.prev.output
    const delta = reset
      ? cur
      : {
          input: Math.max(0, cur.input - this.prev.input),
          cacheRead: Math.max(0, cur.cacheRead - this.prev.cacheRead),
          cacheWrite: Math.max(0, cur.cacheWrite - this.prev.cacheWrite),
          output: Math.max(0, cur.output - this.prev.output),
        }
    this.prev = cur

    if (delta.input + delta.cacheRead + delta.cacheWrite + delta.output === 0) return null
    const at = e.timestamp ? Date.parse(e.timestamp) : Number.NaN
    return { model: this.model, ...delta, ts: Number.isFinite(at) ? at : null }
  }
}

export interface OpenCodeUsageRow {
  /** OpenCode stores the model as a JSON blob, e.g. {"id":"glm-5.2","providerID":"dashscope2"}. */
  model: string | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  cost: number | null
  /** Epoch ms of the last write, used to place the session on the day chart: OpenCode keeps no
   *  per-turn timestamps, so the session's own clock is the only date available. */
  time_updated?: number | null
  /** Assistant replies, counted alongside the totals. */
  turns?: number | null
}

/**
 * A readable model name out of OpenCode's stored blob.
 *
 * It stores `{"id":"glm-5.2","providerID":"dashscope2","variant":"default"}`, and putting that
 * verbatim on a chart axis is unreadable. Provider and id together, because two providers routing
 * to the same model id are genuinely different rows to a reader deciding where their money went.
 */
export function openCodeModelName(raw: string | null): string {
  const value = (raw ?? '').trim()
  if (!value) return 'opencode'
  if (!value.startsWith('{')) return value
  try {
    const m = JSON.parse(value) as { id?: unknown; providerID?: unknown }
    const id = typeof m.id === 'string' && m.id ? m.id : null
    const provider = typeof m.providerID === 'string' && m.providerID ? m.providerID : null
    if (id && provider) return `${provider}/${id}`
    return id ?? provider ?? 'opencode'
  } catch {
    return value
  }
}

/**
 * One OpenCode session's totals, straight off its row.
 *
 * `tokens_reasoning` is deliberately NOT added to output: OpenCode records it the way its providers
 * do, as a subset of the output it already counted, so adding it would inflate every OpenCode
 * session. It is returned separately for anyone who wants to show it.
 */
export function openCodeSpend(row: OpenCodeUsageRow): {
  byModel: Record<string, ModelSpend>
  reasoning: number
  costUsd: number | null
} {
  const byModel: Record<string, ModelSpend> = {}
  const model = openCodeModelName(row.model)
  const input = num(row.tokens_input)
  const cacheRead = num(row.tokens_cache_read)
  const cacheWrite = num(row.tokens_cache_write)
  const output = num(row.tokens_output)
  if (input + cacheRead + cacheWrite + output > 0) {
    addTurn(byModel, model, { input, cacheRead, cacheWrite, output })
    // addTurn counts one turn per call, and this call carries a whole session. Correct it to the
    // real reply count, so "N replies" does not read as 1 for a session with hundreds.
    const m = byModel[model]
    if (m) m.turns = Math.max(1, num(row.turns))
  }
  return {
    byModel,
    reasoning: num(row.tokens_reasoning),
    // OpenCode computes its own cost against whatever provider it routed to. Passed through rather
    // than recomputed: we have no price table for those models, and its figure is the real one.
    costUsd: typeof row.cost === 'number' && Number.isFinite(row.cost) ? row.cost : null,
  }
}
