// server/src/usage-tokens.ts — count the tokens you ACTUALLY spent, from the transcripts.
//
// WHY. The usage endpoint reports a percentage and nothing else: `limit_dollars`, `used_dollars` and
// `remaining_dollars` are all null on a subscription, and there are no token counts anywhere in the
// response. So "98%" is a percentage of a number Anthropic will not tell us. An agent asking "can I
// afford this task?" has no denominator to reason with.
//
// But Claude Code writes every assistant turn to `<CLAUDE_CONFIG_DIR>/projects/**/*.jsonl`, and each
// one carries its exact `usage` block (input / output / cache-read / cache-creation) and its model.
// Those are real, countable units. Summing them over a time window gives a tokens-per-hour rate.
//
// Combine that with the %-per-hour burn rate from usage-history.ts and the denominator falls out:
//
//     tokensPerPercent  =  tokens/hour  ÷  percent/hour
//     remainingTokens   =  remainingPct × tokensPerPercent
//
// That is the whole trick. We never learn Anthropic's real quota; we MEASURE it, in the only units an
// agent can actually budget in.
//
// HONEST LIMITS (surfaced on the result, never hidden):
//   - This sees Claude CODE transcripts on THIS machine only. Usage from the Claude Desktop app, the
//     web UI, or another machine still counts against the same %, but we cannot see its tokens. When
//     that happens the derived tokensPerPercent is an OVER-estimate (we attribute all the % movement
//     to the tokens we can see), so `remainingTokens` reads high. `coverage` says how much to trust it.
//   - The corpus is large (thousands of sessions, GBs). We therefore only scan files whose mtime
//     falls inside the window, which keeps a 5-hour lookback to a handful of files.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelSpend, TokenSpend } from './types'

/** A Claude config dir's transcript root. */
const projectsDir = (configDir: string): string => join(configDir, 'projects')

/** The default (non-isolated) CLI login. */
export const defaultConfigDir = (): string => join(homedir(), '.claude')

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  /** Per-TTL breakdown of `cache_creation_input_tokens`. A 1-hour write costs more than a
   *  5-minute one, in dollars and on the meter alike (see the weights below). */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// --- weighting: why a raw token SUM is a garbage metric ---------------------------------------
//
// Naively adding the four token counts produces an absurd number: a Claude Code turn re-reads its
// whole cached prefix every time, so `cache_read_input_tokens` is ~500k on EVERY turn. Summing that
// over a thousand turns "measures" hundreds of millions of tokens, which is really just
// (context size x turn count), not work done, and not what burns quota.
//
// The kinds of token do not move the subscription meter equally, so each gets a weight. The weights
// are FITTED TO THE METER, not read off the price list. The price-list ratios (cache read 0.1x
// input, write 1.25x, output 5x) were the first version and the meter disagrees with them: fitted
// against the 5-hour utilization Claude Code streams with each request and the desktop accounts'
// 15-minute usage readings (2026-09-30: 75 Corch intervals and 299 whole 5-hour windows on 47
// accounts, Pro, Max 5x and Max 20x), a 5-minute cache write moves the meter about 32 cache reads' worth
// and an output token, thinking included, about 310; the price list says 12.5 and 50.
//
// The check that decided it was usage_budget's own prediction, replayed on accounts the fit never
// saw: "the last 6 hours spent W weighted tokens and the meter rose D points, so W' more will raise
// it W' x D / W". Against the weekly meter the budget calibrates on, the median miss fell from 3.6
// to 2.7 points per 6 hours (mean 13.0 to 9.5, 1,213 predictions); on the 5-hour meter from 3.1 to
// 1.7 per hour. Weights fitted on Pro accounts alone, Max alone, desktop alone or the CLI alone each
// improved the others. The fit and the replay: scripts/quota-weights/.
//
// The unit is scaled so a cache read stays 0.1, as it was. Its absolute size does not matter for the
// budget (tokensPerPercent is calibrated, so a constant factor cancels); what matters is that it
// tracks the meter, so the calibration holds when the mix of reads, writes, output and model shifts.
export const W_CACHE_READ = 0.1
export const W_CACHE_WRITE_5M = 3.2
/** A 1-hour write at its list-price ratio to a 5-minute one (2x input against 1.25x). The two are
 *  too collinear in the data to fit apart, and pinning the ratio predicted held-out windows better
 *  than one weight for both. Claude Code's own sessions write almost only 1-hour cache. */
export const W_CACHE_WRITE_1H = W_CACHE_WRITE_5M * 1.6
/** An uncached input token: a 5-minute write without the write premium. A request carries a few
 *  hundred of them, too few for the fit to see on their own. */
export const W_INPUT = W_CACHE_WRITE_5M / 1.25
export const W_OUTPUT = 31

/** A model's weight relative to Sonnet, at current list prices: Opus 5.5 $4 and Fable 5.1 $10 per
 *  million input against Sonnet 5.5's $2, Haiku 4.5 $1. Quota is shared across models, so a turn's
 *  weight must account for WHICH model spent it. The meter agrees where the data can tell: weighing
 *  Fable 2.5x Opus instead of the same cut the held-out error about as much as the token weights
 *  did. Sonnet was about 4% of the measured weighted traffic, too little to tell half of Opus from
 *  equal. */
export function modelMultiplier(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('fable')) return 5
  if (m.includes('opus')) return 2
  if (m.includes('haiku')) return 0.5
  return 1 // sonnet + anything unrecognized
}

/** Token counts in weighted tokens. The one place the weights are applied, so a live turn, a stored
 *  session and another provider's spend are all weighed alike. */
export function weighCounts(
  model: string,
  c: {
    input: number
    cacheRead: number
    cacheWrite5m: number
    cacheWrite1h: number
    output: number
  },
): number {
  return (
    (c.input * W_INPUT +
      c.cacheRead * W_CACHE_READ +
      c.cacheWrite5m * W_CACHE_WRITE_5M +
      c.cacheWrite1h * W_CACHE_WRITE_1H +
      c.output * W_OUTPUT) *
    modelMultiplier(model)
  )
}

/** Each model's `weighted` recomputed from its counts under the current weights. A stored session
 *  (analytics' cache and its permanent record) keeps the figure from whichever weights were current
 *  when it was scanned; re-weighing on read keeps old and new rows in one unit without a rescan. */
export function reweighModels(tokens: Record<string, ModelSpend>): Record<string, ModelSpend> {
  const out: Record<string, ModelSpend> = {}
  for (const [model, m] of Object.entries(tokens)) {
    out[model] = {
      ...m,
      weighted: weighCounts(model, {
        input: num(m.input),
        cacheRead: num(m.cacheRead),
        cacheWrite5m: num(m.cacheCreation5m),
        cacheWrite1h: num(m.cacheCreation1h),
        output: num(m.output),
      }),
    }
  }
  return out
}

/** A fresh, zeroed spend. A factory rather than a shared constant because callers ACCUMULATE into
 *  it — handing out one frozen object would have every caller adding to the same totals. */
export function emptySpend(): TokenSpend {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    raw: 0,
    weighted: 0,
    byModel: {},
    turns: 0,
  }
}

/**
 * Split one turn's cache WRITE by TTL. Current Claude Code writes carry `usage.cache_creation`
 * with the two buckets; older transcripts have only the combined `cache_creation_input_tokens`,
 * and 5 minutes is the default TTL, so that is where an unlabelled write is attributed. The two
 * always sum to the combined figure, which is what the top-level `cacheCreation` total reports.
 */
function splitCacheWrite(usage: RawUsage): { w5m: number; w1h: number } {
  const total = num(usage.cache_creation_input_tokens)
  const split = usage.cache_creation
  if (split) {
    const w5m = num(split.ephemeral_5m_input_tokens)
    const w1h = num(split.ephemeral_1h_input_tokens)
    if (w5m + w1h > 0) return { w5m, w1h }
  }
  return { w5m: total, w1h: 0 }
}

/**
 * Requests already counted, so one API response is charged once.
 *
 * WHY THIS IS NEEDED, measured on a real store rather than assumed. Claude Code does not write one
 * transcript record per assistant reply; it writes one PER CONTENT BLOCK, and stamps the same
 * complete `usage` object on every one of them. A reply that says something and then makes two tool
 * calls is three records, each claiming the full input, cache-read and output of the single request
 * that produced them. Summing records therefore charges that request three times.
 *
 * Across 1,230 transcripts here: 445,317 assistant records carry usage, but only 185,264 distinct
 * (message.id, requestId) pairs. A naive sum reports 148.8 BILLION tokens where the real figure is
 * 64.6 billion, an overcount of 56.6%. Of the 124,042 repeated keys, 4,997 out of a 5,000 sample are
 * byte-identical copies rather than a growing partial, so this is content-block fan-out and not
 * streaming.
 *
 * The map holds the output count applied for each request, which is what distinguishes the two
 * cases: an equal-or-smaller output is a duplicate and contributes nothing, while a larger one is a
 * streaming turn's final record and contributes only the difference.
 */
export type UsageSeen = Map<string, number>

export function newUsageSeen(): UsageSeen {
  return new Map()
}

/**
 * Fold ONE transcript line into `spend`, if it is an assistant turn carrying a usage block inside
 * the window. Returns that turn's timestamp when it counted a dated turn, else null.
 *
 * This is the single per-turn parser in the product: {@link sumTranscriptTokens} runs it over a
 * string and session-usage.ts runs it over a stream, so a whole-session cost and a quota window can
 * never disagree about what a turn spent.
 *
 * `sinceMs <= 0` means "no cutoff", which also lets an undated turn count — a whole-file sum wants
 * every turn, and a missing timestamp is not a reason to drop real spend from a total that has no
 * time window in the first place.
 *
 * A malformed line is skipped rather than aborting (transcripts are appended live, so the last
 * line can be a partial write).
 */
export function accumulateUsageLine(
  spend: TokenSpend,
  line: string,
  sinceMs: number,
  /** See {@link newUsageSeen}. Omit only where a caller genuinely wants every record counted. */
  seen?: UsageSeen,
): number | null {
  if (line?.charCodeAt(0) !== 123 /* '{' */) return null
  // Cheap pre-filter: skip the ~90% of lines that cannot contribute, before paying for JSON.parse.
  if (!line.includes('"usage"')) return null

  let rec: {
    type?: string
    timestamp?: string
    requestId?: string
    message?: { id?: string; model?: string; usage?: RawUsage }
  }
  try {
    rec = JSON.parse(line)
  } catch {
    return null // partial trailing write, or a line we don't understand
  }
  // Only an ASSISTANT turn spends quota. A user turn or tool result can carry a `usage` echo, and
  // counting those would double-count the same spend.
  if (rec.type !== 'assistant') return null
  const usage = rec.message?.usage
  if (!usage) return null
  const ts = rec.timestamp ? Date.parse(rec.timestamp) : Number.NaN
  const dated = Number.isFinite(ts)
  if (sinceMs > 0 && (!dated || ts < sinceMs)) return null

  let input = num(usage.input_tokens)
  let output = num(usage.output_tokens)
  let cacheRead = num(usage.cache_read_input_tokens)
  let cacheCreation = num(usage.cache_creation_input_tokens)
  let { w5m, w1h } = splitCacheWrite(usage)
  const model = rec.message?.model ?? 'unknown'

  // ONE API RESPONSE, SEVERAL RECORDS. See newUsageSeen: Claude Code writes a transcript record per
  // content block and stamps the SAME complete usage object on every one, so a reply with text plus
  // two tool calls appears three times at full price. Counted once here.
  const key = rec.requestId ? `${rec.message?.id ?? ''}|${rec.requestId}` : ''
  if (seen && key) {
    const applied = seen.get(key)
    if (applied === undefined) {
      seen.set(key, output)
    } else if (output <= applied) {
      // Output has not grown, so this record is a repeat of one already counted.
      return null
    } else {
      // Output HAS grown: the finished form of a reply whose earlier record was a partial count.
      // Only the new output is new spend — a request's input side is charged once and does not
      // change between the partial record and the final one.
      seen.set(key, output)
      output -= applied
      input = 0
      cacheRead = 0
      cacheCreation = 0
      w5m = 0
      w1h = 0
    }
  }

  const weightedForModel = weighCounts(model, {
    input,
    cacheRead,
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
    output,
  })

  spend.input += input
  spend.output += output
  spend.cacheRead += cacheRead
  spend.cacheCreation += cacheCreation
  spend.raw += input + output + cacheRead + cacheCreation
  spend.weighted += weightedForModel
  spend.turns += 1

  const m = spend.byModel[model] ?? {
    weighted: 0,
    output: 0,
    turns: 0,
    input: 0,
    cacheRead: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
  }
  m.weighted += weightedForModel
  m.output += output
  m.turns += 1
  m.input += input
  m.cacheRead += cacheRead
  m.cacheCreation5m += w5m
  m.cacheCreation1h += w1h
  spend.byModel[model] = m

  return dated ? ts : null
}

/**
 * Sum the token usage recorded in one transcript file for turns inside [since, now].
 *
 * Exported for the unit test.
 */
export function sumTranscriptTokens(
  text: string,
  sinceMs: number,
  /** Pass one across several files to also catch a resumed session that copied its parent's
   *  messages into a new transcript: the same request then appears in both, and was billed once. */
  seen: UsageSeen = newUsageSeen(),
): TokenSpend {
  const spend = emptySpend()
  for (const line of text.split('\n')) accumulateUsageLine(spend, line, sinceMs, seen)
  return spend
}

/** Add b into a fresh total. Exported for server/src/session-usage.ts's per-run windowing, which
 *  accumulates one turn at a time so it can drop the ones outside the run's window. */
export function mergeSpend(a: TokenSpend, b: TokenSpend): TokenSpend {
  const byModel = { ...a.byModel }
  for (const [model, m] of Object.entries(b.byModel)) {
    const cur = byModel[model] ?? {
      weighted: 0,
      output: 0,
      turns: 0,
      input: 0,
      cacheRead: 0,
      cacheCreation5m: 0,
      cacheCreation1h: 0,
    }
    byModel[model] = {
      weighted: cur.weighted + m.weighted,
      output: cur.output + m.output,
      turns: cur.turns + m.turns,
      input: cur.input + m.input,
      cacheRead: cur.cacheRead + m.cacheRead,
      cacheCreation5m: cur.cacheCreation5m + m.cacheCreation5m,
      cacheCreation1h: cur.cacheCreation1h + m.cacheCreation1h,
    }
  }
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    raw: a.raw + b.raw,
    weighted: a.weighted + b.weighted,
    turns: a.turns + b.turns,
    byModel,
  }
}

/** How deep under `projects/` the walk goes. A subagent transcript sits at
 *  `<project>/<parent-session>/subagents/agent-<id>.jsonl` (depth 3 from the root) and a
 *  workflow's descendants one or two levels under that; six is headroom, not a target, and it
 *  bounds the walk against a pathological tree. */
const RECENT_TRANSCRIPT_MAX_DEPTH = 6

/** Every *.jsonl under a transcripts root whose mtime is at/after `sinceMs`. The mtime filter is what
 *  keeps this cheap: the corpus is thousands of files and gigabytes, but a 5-hour window touches only
 *  the handful that were actually written to.
 *
 *  RECURSIVE, for the same reason transcript.ts's discovery is (audit AH-33): a Task-tool
 *  subagent writes its OWN transcript, nested under its parent's, carrying its own usage blocks -
 *  separate API calls and separate spend. The old two-level readdir never saw them, so a window in
 *  which the work was delegated reported no token activity at all and the budget's remaining-turn
 *  estimate came out optimistic. Reproduced with a nested-only 12-token fixture: raw 0, turns 0. */
function recentTranscripts(root: string, sinceMs: number): string[] {
  const hits: string[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // no transcripts here (never used, not logged in, or vanished mid-scan)
    }
    for (const entry of entries) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < RECENT_TRANSCRIPT_MAX_DEPTH) walk(p, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      try {
        if (statSync(p).mtimeMs >= sinceMs) hits.push(p)
      } catch {
        // vanished mid-scan (a session being rotated); skip
      }
    }
  }
  walk(root, 0)
  return hits
}

/**
 * Total tokens spent since `since`, across the given Claude config dirs (default: the plain
 * `~/.claude` login). Reads only the transcripts touched inside the window.
 */
export function tokensSince(since: Date, configDirs: string[] = [defaultConfigDir()]): TokenSpend {
  const sinceMs = since.getTime()
  let spend = emptySpend()
  // Shared across every file in the window. A window is a handful of files, and a resumed session
  // copies its parent's messages into its own transcript, so the same request can appear in two of
  // them and was billed once.
  const seen = newUsageSeen()
  for (const dir of configDirs) {
    for (const file of recentTranscripts(projectsDir(dir), sinceMs)) {
      try {
        spend = mergeSpend(spend, sumTranscriptTokens(readFileSync(file, 'utf8'), sinceMs, seen))
      } catch {
        // unreadable/locked file: skip rather than fail the whole count
      }
    }
  }
  return spend
}

/**
 * Visit every dated assistant turn spent since `since`, one turn at a time, with its own per-model
 * counts. The quota calibration (quota-calibration.ts) needs spend BETWEEN two usage readings, which
 * one lump sum from {@link tokensSince} cannot give; this walks the same files through the same
 * per-turn parser and the same request de-duplication, so a turn is never priced differently here.
 */
export function forEachTurnSince(
  since: Date,
  configDirs: string[],
  visit: (ts: number, byModel: TokenSpend['byModel']) => void,
): void {
  const sinceMs = since.getTime()
  const seen = newUsageSeen()
  for (const dir of configDirs) {
    for (const file of recentTranscripts(projectsDir(dir), sinceMs)) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue // unreadable/locked file: skip rather than fail the whole walk
      }
      for (const line of text.split('\n')) {
        const turn = emptySpend()
        const ts = accumulateUsageLine(turn, line, sinceMs, seen)
        if (ts !== null) visit(ts, turn.byModel)
      }
    }
  }
}

/**
 * The empirically-measured size of one percent of the weekly quota, in tokens.
 *
 * `tokensPerHour / burnPctPerHour`. Returns null when either input is missing or the burn is zero
 * (dividing by a zero burn is how you get an infinite, useless answer).
 */
export function tokensPerPercent(
  tokensPerHour: number | null,
  burnPctPerHour: number | null,
): number | null {
  if (tokensPerHour === null || burnPctPerHour === null) return null
  if (burnPctPerHour <= 0 || tokensPerHour <= 0) return null
  return tokensPerHour / burnPctPerHour
}
