// server/src/usage-budget.ts — assemble the answer to "how much can I actually spend?".
//
// This is the join between the two halves:
//   usage-history.ts  gives  percent/hour   (how fast the cap is being eaten)
//   usage-tokens.ts   gives  tokens/hour    (what we actually spent, counted)
//
// Dividing one by the other yields TOKENS PER PERCENT: the size of 1% of the weekly quota, measured
// rather than looked up. Anthropic does not publish the quota (limit_dollars is null, no token
// counts), so measuring it from our own spend is the only way to get a denominator at all.
//
// The confidence rating is not decoration. The derivation assumes the tokens we can SEE are the
// tokens that moved the percentage. That assumption breaks whenever the account is also used
// somewhere we cannot observe (the Claude Desktop app, the web UI, another machine) — and when it
// breaks it always fails the SAME way: we attribute all of the % movement to a fraction of the real
// spend, so tokensPerPercent comes out too big and remainingTokens reads optimistically high. An
// agent that trusts an inflated budget overruns its quota mid-task, which is exactly the failure this
// whole subsystem exists to prevent. So the caveat travels with the number, always.

import { calibrateQuotaDollars, dollarsSummary } from './quota-calibration'
import type { BudgetConfidence, UsageBudget, UsageSnapshot } from './types'
import { burnRateBounds, forecastUsage, usageSamples } from './usage-history'
import { tokensPerPercent, tokensSince } from './usage-tokens'

/** Match the burn-rate lookback, so tokens/hour and percent/hour describe the SAME window. Comparing
 *  a 6-hour token rate against a 1-hour burn rate would silently skew tokensPerPercent. */
const LOOKBACK_HOURS = 6

/** Below this many readings the burn rate is noise, not a trend. */
const MIN_SAMPLES_FOR_GOOD = 4

export interface BudgetOpts {
  /** Claude config dirs whose transcripts count toward this account's spend. */
  configDirs?: string[]
  now?: Date
}

/**
 * Build the full budget for one account.
 *
 * Never throws and always returns a usable object: when the inputs aren't there yet (a fresh install
 * has no history), every derived field is null and `confidence` is 'none' with a caveat explaining
 * what is missing. A null is honest; a fabricated number is not.
 */
export function buildUsageBudget(
  snap: UsageSnapshot,
  key: string,
  opts: BudgetOpts = {},
): UsageBudget {
  const now = opts.now ?? new Date()
  const samples = usageSamples(key)
  const forecast = forecastUsage(snap, samples, now)

  const since = new Date(now.getTime() - LOOKBACK_HOURS * 3600_000)
  const spend = tokensSince(since, opts.configDirs)
  // Budget in WEIGHTED (cost-equivalent) tokens, never the raw sum — a cached prefix is re-read every
  // turn, so a raw sum measures context size, not cost. See usage-tokens.ts.
  const weightedPerHour = spend.weighted > 0 ? spend.weighted / LOOKBACK_HOURS : null

  // Divide by the burn rate's UPPER bound, not the point estimate. Two reasons, both important:
  //  1. The point estimate can legitimately be 0 (the % is an integer and hasn't ticked yet), and
  //     dividing by it yields an infinite token budget — the single most dangerous possible answer.
  //  2. A larger denominator means a SMALLER tokensPerPercent, so the remaining budget comes out
  //     conservative. Consistent with the forecast, which is pessimistic for the same reason.
  const bounds = burnRateBounds(samples, now, LOOKBACK_HOURS)
  const tpp = tokensPerPercent(weightedPerHour, bounds?.upper ?? null)
  const remainingPct = forecast.remainingPct
  const remainingWeighted =
    tpp !== null && remainingPct !== null ? Math.round(tpp * remainingPct) : null

  const weightedPerTurn = spend.turns > 0 ? spend.weighted / spend.turns : null
  const remainingTurns =
    remainingWeighted !== null && weightedPerTurn && weightedPerTurn > 0
      ? Math.round(remainingWeighted / weightedPerTurn)
      : null

  let confidence: BudgetConfidence = 'none'
  let caveat: string

  if (tpp === null) {
    // Say precisely WHICH input is missing — "no data" sends someone hunting the wrong thing.
    if (samples.length < 2) {
      caveat =
        'No token budget yet: usage has only been sampled ' +
        `${samples.length} time(s). The background refresh samples every 15 minutes; a rate needs at least two readings ~45 minutes apart (the reported % is an integer, so a shorter window cannot resolve a slow burn). Percentages below are still exact.`
    } else if (bounds === null) {
      caveat =
        'No token budget yet: the readings so far span under 45 minutes (or cross a quota reset), which is too short to resolve a burn rate from an integer percentage. Percentages below are still exact.'
    } else {
      caveat =
        'No Claude Code transcripts were written in the last ' +
        `${LOOKBACK_HOURS}h, so there are no tokens to count. Quota may still be moving from the desktop app or another machine, which this cannot see. Percentages below are still exact.`
    }
  } else {
    confidence = samples.length >= MIN_SAMPLES_FOR_GOOD ? 'good' : 'rough'
    const rough =
      confidence === 'rough'
        ? ` Only ${samples.length} usage readings so far, so the rate is provisional and will sharpen as more land.`
        : ''
    caveat =
      'Derived, not reported: Anthropic publishes no token or dollar quota, so 1% is measured as (tokens counted / percent burned) over the last ' +
      `${LOOKBACK_HOURS}h. This counts Claude Code transcripts on THIS machine only. If the same account is also used from the Claude Desktop app, the web UI, or another machine, that usage still burns the same quota but is invisible here, which makes tokensPerPercent too LARGE and remainingTokens too OPTIMISTIC. Treat it as an upper bound.${rough}`
  }

  return {
    forecast,
    spend,
    lookbackHours: LOOKBACK_HOURS,
    weightedPerHour,
    weightedPerPercent: tpp,
    remainingWeighted,
    remainingTurns,
    weightedPerTurn,
    confidence,
    caveat,
    // The same transcripts, priced, against whole quota windows: the percentage in dollars. Only the
    // caller's own dirs, never the ~/.claude fallback: another login's turns would inflate the
    // figure, and calibrateQuotaDollars refuses (with a caveat) when none are given or for Codex.
    dollars: calibrateQuotaDollars(key, snap, samples, opts.configDirs, now),
  }
}

/**
 * A one-line, agent-readable summary of the budget. This is what actually lands in an LLM's context,
 * so it leads with the decision (can I work?) and only then the numbers behind it.
 */
export function budgetSummary(budget: UsageBudget, pct: number | null): string {
  const parts: string[] = []
  if (pct !== null) parts.push(`Weekly (all models): ${pct}% used.`)

  const f = budget.forecast
  if (f.burnPctPerHourUpper !== null) {
    // Report the point estimate, but qualify it: the source % is an integer, so a measured 0 only
    // means "under the resolution of this window", never "idle".
    parts.push(
      f.burnPctPerHour !== null && f.burnPctPerHour > 0
        ? `Burning ~${f.burnPctPerHour.toFixed(2)}%/hour (at most ${f.burnPctPerHourUpper.toFixed(2)}%/hour).`
        : `Burn is below what these readings can resolve (under ${f.burnPctPerHourUpper.toFixed(2)}%/hour).`,
    )
    if (f.exhaustsBeforeReset === false) {
      parts.push(
        `Even at the worst rate consistent with the readings you will NOT hit the cap before it resets${f.hoursToReset !== null ? ` in ${f.hoursToReset.toFixed(1)}h` : ''}. Work freely.`,
      )
    } else if (f.exhaustsBeforeReset === true && f.headroomHours !== null) {
      parts.push(
        `Worst case you hit the cap in ~${f.headroomHours.toFixed(1)}h, before it resets${f.hoursToReset !== null ? ` in ${f.hoursToReset.toFixed(1)}h` : ''}. Plan around it.`,
      )
    }
  }

  if (budget.remainingTurns !== null) {
    parts.push(
      `Estimated headroom: ~${budget.remainingTurns.toLocaleString()} more assistant turns at your recent average cost` +
        `${budget.spend.turns > 0 ? ` (measured over ${budget.spend.turns} turns in the last ${budget.lookbackHours}h)` : ''}.` +
        ` Confidence: ${budget.confidence}; this is an UPPER bound (see caveat).`,
    )
  }
  const dollars = dollarsSummary(budget.dollars)
  if (dollars) parts.push(dollars)
  return parts.join(' ')
}
