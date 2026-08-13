// server/src/pricing.ts — what a pile of tokens actually cost, in dollars.
//
// WHY. usage-tokens.ts already counts the four token kinds per turn, but only ever converts them
// into "base-input-token equivalents" — a unit that is PROPORTIONAL to cost and therefore fine for
// calibrating a quota denominator, and useless for answering "what did this session cost?". This
// module is the other half: real published per-million prices, per model.
//
// THREE RULES, each of which the obvious shortcut gets wrong:
//
//   1. CACHE READS AND CACHE WRITES ARE PRICED SEPARATELY, and a cache write is priced by its TTL.
//      A cache read is a TENTH of an input token; a 5-minute write is 1.25x and a 1-hour write is
//      2x. Those differ by a factor of twenty, and on a heavy Claude Code user cache-read is the
//      single largest line on the bill (a cached prefix is re-read on EVERY turn). Averaging them
//      into one "input" rate produces a number that looks precise and is decorative.
//
//   2. NEVER GUESS A PRICE. An id we do not have a published price for is reported as unpriced —
//      its tokens still count toward the token total, its dollars do not exist. That deliberately
//      covers Bedrock/Vertex ids (`us.anthropic.claude-…-v1:0`, `claude-…@20250219`), which are
//      partner-operated with their OWN pricing: they simply fail to match, which is the right
//      answer, not a bug to paper over with a prefix strip.
//
//   3. THE TABLE IS BUNDLED AND DATED, and it is the FLOOR rather than the whole story. The daemon
//      must work with no network, so this module never fetches; what it does do is accept a
//      downloaded catalog (see price-catalog.ts) that takes precedence when one is in force. The
//      bundled table is what answers on a first run, an offline machine, or a failed download —
//      and either way the effective date travels with the numbers into the UI, so a stale figure
//      is visibly stale rather than silently wrong.
//
// NOT MODELLED (documented rather than approximated): Anthropic's fast mode re-prices Opus 5 at
// 10/50, and transcripts do not record which turns used it; batch requests are half price and
// Claude Code does not make them. Both would need data the transcript does not carry.

/** Per-million-token list prices for one model, in USD. */
export interface ModelPrice {
  input: number
  output: number
  /** A launch/introductory rate with an expiry. Applied to turns dated before `until` (ISO). */
  intro?: { input: number; output: number; until: string }
  /**
   * Absolute cache rates, per million tokens, for providers that do not follow Anthropic's
   * multiples. Left undefined the ratios below apply, which is correct for Anthropic and for every
   * OpenAI model (both publish read = 0.1x); DeepSeek's cache read is under a hundredth of its
   * input rate, so a downloaded catalog states these outright rather than deriving them.
   */
  cacheReadUsd?: number
  cacheWrite5mUsd?: number
  cacheWrite1hUsd?: number
}

/**
 * Cache rates, as multiples of a model's base INPUT price. Anthropic publishes them exactly this
 * way (read = 0.1x, 5-minute write = 1.25x, 1-hour write = 2x) for every model, so deriving them
 * keeps the table half the size and makes it impossible for one model's cache rate to drift out of
 * step with its input rate.
 */
export const CACHE_READ_RATIO = 0.1
export const CACHE_WRITE_5M_RATIO = 1.25
export const CACHE_WRITE_1H_RATIO = 2

/** The day this table was last checked against Anthropic's published pricing. Surfaced in the UI. */
export const PRICES_AS_OF = '2026-08-13'

// Keys are canonical (lowercased, date suffix stripped) model ids. Entries below the divider are
// models that no longer take new traffic but still appear in an archived transcript.
const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  // Sonnet 5 is on an introductory rate through 2026-08-31, and it is by far the most common model
  // in a current transcript — billing it at the standard rate would overstate a live session's cost
  // by 50%, which is exactly the kind of confidently-wrong figure this module exists to avoid.
  'claude-sonnet-5': {
    input: 3,
    output: 15,
    intro: { input: 2, output: 10, until: '2026-09-01T00:00:00.000Z' },
  },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // --- retired / deprecated, kept so an old session still prices ---
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4-0': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4-0': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-3-opus': { input: 15, output: 75 },

  // --- OpenAI, as Codex writes the ids -----------------------------------------------------
  //
  // Codex records a bare model id (`gpt-5.6-sol`) in each rollout's `turn_context`. Cache rates
  // follow the same shape as Anthropic's and are therefore derived: OpenAI bills a cached input
  // token at 0.1x uncached, and — for GPT-5.6 and later only — a cache WRITE at 1.25x. Earlier
  // generations create cache entries for free, which is `cacheWrite5mUsd: 0` rather than a missing
  // entry, because "free" and "unknown" must not look the same. In practice Codex reports
  // `cache_write_input_tokens: 0` on every turn observed here, so the write rate is defensive.
  'gpt-5.6-sol': { input: 5, output: 30 },
  'gpt-5.6-terra': { input: 2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
  'gpt-5.6-cyber': { input: 12.5, output: 75 },
  'gpt-5.5': { input: 5, output: 30, cacheWrite5mUsd: 0, cacheWrite1hUsd: 0 },
  'gpt-5.5-pro': { input: 30, output: 180, cacheWrite5mUsd: 0, cacheWrite1hUsd: 0 },
  'gpt-5.4': { input: 2.5, output: 15, cacheWrite5mUsd: 0, cacheWrite1hUsd: 0 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheWrite5mUsd: 0, cacheWrite1hUsd: 0 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheWrite5mUsd: 0, cacheWrite1hUsd: 0 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheWrite5mUsd: 0, cacheWrite1hUsd: 0 },
  'gpt-5.2': { input: 1.75, output: 14, cacheWrite5mUsd: 0, cacheWrite1hUsd: 0 },
  'gpt-5.1': { input: 1.25, output: 10, cacheWrite5mUsd: 0, cacheWrite1hUsd: 0 },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2, cacheWrite5mUsd: 0, cacheWrite1hUsd: 0 },
  'gpt-5': { input: 1.25, output: 10, cacheWrite5mUsd: 0, cacheWrite1hUsd: 0 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheWrite5mUsd: 0, cacheWrite1hUsd: 0 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheWrite5mUsd: 0, cacheWrite1hUsd: 0 },
}

/**
 * A downloaded catalog, when one is in force. Consulted BEFORE the bundled table.
 *
 * Precedence is deliberate and one-directional: a fetched price is newer than a compiled-in one by
 * construction, so it wins outright rather than being merged field-by-field with it. The bundled
 * table keeps answering for anything the catalog does not carry, so adopting a catalog can only
 * ever price MORE models, never fewer.
 */
let fetched: { prices: Record<string, ModelPrice>; asOf: string } | null = null

/** Install a downloaded catalog. `fetchedAt` is epoch ms; only its date is surfaced. */
export function setFetchedPrices(prices: Record<string, ModelPrice>, fetchedAt: number): void {
  const asOf = new Date(fetchedAt).toISOString().slice(0, 10)
  fetched = { prices, asOf }
}

/** Drop any downloaded catalog and fall back to the bundled table. Tests use this; so would a
 *  future setting for an install that wants only what it shipped with. */
export function clearFetchedPrices(): void {
  fetched = null
}

/**
 * The date the prices in force were last known good — the download date when a catalog is in
 * force, the build's own constant otherwise. This is what the UI prints beside a dollar figure.
 */
export function pricesAsOf(): string {
  return fetched?.asOf ?? PRICES_AS_OF
}

/** Where the prices in force came from, so the UI can say so rather than implying they are fresh. */
export function priceSource(): 'catalog' | 'bundled' {
  return fetched ? 'catalog' : 'bundled'
}

/** A model id as transcripts write it, reduced to a table key. Only two normalizations, both
 *  lossless: case, and the `-YYYYMMDD` snapshot suffix that pins an alias to one release. */
const DATE_SUFFIX = /-\d{8}$/
function canonical(model: string): string {
  return model.trim().toLowerCase().replace(DATE_SUFFIX, '')
}

/**
 * The model behind a router's `provider/model` id, for the second lookup attempt only.
 *
 * OpenCode records what it routed to as `openai/gpt-5.5` or `deepseek/deepseek-v4-pro`, so an exact
 * match against a table keyed on bare ids misses a model both sides plainly agree on. The exact key
 * is ALWAYS tried first, so a provider that publishes its own rate for a routed model keeps it; this
 * is the fallback, not the rule.
 *
 * It is a narrower move than it looks and deliberately not a general prefix strip: Bedrock and
 * Vertex ids (`us.anthropic.claude-…-v1:0`, `claude-…@20250219`) use dots and at-signs, so they
 * still fail to match and stay unpriced — which is correct, because those are partner-operated with
 * their own pricing. What it will get wrong is a reseller charging a markup over the upstream id;
 * that is a knowable underestimate, against a total absence of a figure.
 */
function routedModel(key: string): string {
  const slash = key.lastIndexOf('/')
  return slash < 0 ? key : key.slice(slash + 1)
}

function lookup(key: string): ModelPrice | undefined {
  return fetched?.prices[key] ?? PRICES[key]
}

/** Every rate needed to price one model's tokens, in USD per million. */
export interface ResolvedPrice {
  /** The table key that matched — not necessarily the id passed in (a date suffix is stripped). */
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

/**
 * Published prices for a model id, or null when we have none.
 *
 * `at` is the instant the tokens were spent (epoch ms), which only matters while a model is on an
 * introductory rate. Callers pass the session's newest turn rather than "now", so an archived
 * session keeps the price that actually applied to it.
 *
 * A bare family name ("opus", "sonnet") deliberately does NOT resolve: Opus has been billed at both
 * 15/75 and 5/25 depending on the generation, so a name with no generation in it is unpriceable —
 * see rule 2 at the top of the file.
 */
export function priceFor(model: string, at: number = Date.now()): ResolvedPrice | null {
  const key = canonical(model)
  const entry = lookup(key) ?? lookup(routedModel(key))
  if (!entry) return null
  const intro = entry.intro && at < Date.parse(entry.intro.until) ? entry.intro : null
  const input = intro ? intro.input : entry.input
  return {
    model: key,
    input,
    output: intro ? intro.output : entry.output,
    // An absolute rate wins over the derived one where the source published it. `?? ` and not `||`:
    // zero is a real, published rate (a provider that creates cache entries for free), and `||`
    // would quietly replace it with the 1.25x premium.
    cacheRead: entry.cacheReadUsd ?? input * CACHE_READ_RATIO,
    cacheWrite5m: entry.cacheWrite5mUsd ?? input * CACHE_WRITE_5M_RATIO,
    cacheWrite1h: entry.cacheWrite1hUsd ?? input * CACHE_WRITE_1H_RATIO,
  }
}

/** The raw counts one model contributed — the subset of TokenSpend's per-model entry that has a
 *  price attached to it. */
export interface PriceableTokens {
  input: number
  output: number
  cacheRead: number
  cacheCreation5m: number
  cacheCreation1h: number
}

export interface PricedSpend {
  /** Dollars, at list prices, for the models we could price. Null when NONE of them priced —
   *  distinct from 0, which means "priced, and it cost essentially nothing". */
  costUsd: number | null
  /** Table keys that priced, sorted. */
  priced: string[]
  /** Model ids that carried tokens and had no published price, sorted. Non-empty alongside a
   *  non-null costUsd means the dollar figure is a LOWER BOUND, and callers must say so. */
  unpriced: string[]
}

const tokensIn = (t: PriceableTokens): number =>
  t.input + t.output + t.cacheRead + t.cacheCreation5m + t.cacheCreation1h

/**
 * Cost of a per-model token breakdown, in USD.
 *
 * A model with no published price is listed in `unpriced` — but only if it actually carried
 * tokens. Claude Code writes synthetic assistant turns (`"model":"<synthetic>"`) with an all-zero
 * usage block for its own local error messages; counting those as "unpriced" would stamp a
 * perfectly complete cost figure with an incompleteness warning about nothing.
 */
export function priceTokens(
  byModel: Record<string, PriceableTokens>,
  at: number = Date.now(),
): PricedSpend {
  const priced: string[] = []
  const unpriced: string[] = []
  let cost = 0
  for (const [model, t] of Object.entries(byModel)) {
    const p = priceFor(model, at)
    if (!p) {
      if (tokensIn(t) > 0) unpriced.push(model)
      continue
    }
    priced.push(p.model)
    cost +=
      (t.input * p.input +
        t.output * p.output +
        t.cacheRead * p.cacheRead +
        t.cacheCreation5m * p.cacheWrite5m +
        t.cacheCreation1h * p.cacheWrite1h) /
      1_000_000
  }
  return {
    costUsd: priced.length ? cost : null,
    priced: [...new Set(priced)].sort(),
    unpriced: [...new Set(unpriced)].sort(),
  }
}
