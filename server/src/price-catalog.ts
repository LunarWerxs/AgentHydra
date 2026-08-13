// server/src/price-catalog.ts — prices that are FETCHED rather than frozen into the build.
//
// WHY THIS EXISTS. pricing.ts ships a hand-maintained table, which is correct on the day it is
// written and decays from then on: providers cut prices (OpenAI cut the GPT-5.6 family on
// 2026-07-30), ship models faster than anyone can retype rate cards, and every model missing from
// the table is reported as UNPRICED — an honest gap, but still a gap. A user should not have to
// wait for an AgentHydra release to see what a model they used last week cost.
//
// THE SOURCE is LiteLLM's `model_prices_and_context_window.json`: ~3,000 models across every
// provider these tools route to (OpenAI, Anthropic, DeepSeek, xAI, Google, Moonshot, Alibaba),
// maintained continuously because LiteLLM's own cost accounting depends on it. It is the same
// catalog other session-analytics tools use, for the same reason: nobody sane maintains a private
// copy of 3,000 rate cards.
//
// FOUR RULES, each of which the obvious implementation gets wrong:
//
//   1. THE DAEMON MUST WORK WITH NO NETWORK. The fetch is deferred, best-effort, and never
//      awaited by anything a request depends on. Until it lands (and forever, on an offline
//      machine) the bundled table answers, exactly as it did before this file existed. A failed
//      fetch is logged once and is not an error state.
//
//   2. A DOWNLOADED PRICE IS STILL DATED. The cache records when it was fetched, and that date is
//      surfaced next to the numbers — the whole point of PRICES_AS_OF was that a stale figure must
//      LOOK stale, and downloading it does not exempt it from that.
//
//   3. SERVICE-TIER VARIANTS ARE IGNORED. The catalog carries `_flex`, `_priority`, `_batches` and
//      `_above_272k_tokens` companions for many models. A stored transcript does not record which
//      tier a request used, so picking one would be a guess dressed as precision. Standard rates
//      only. (The 1-hour cache-write companion IS read, because the transcript does record a
//      turn's cache TTL.)
//
//   4. A MALFORMED CATALOG MUST NOT POISON THE TABLE. Entries are validated one by one and a bad
//      one is dropped, not fatal; a catalog that parses to fewer than a plausible number of models
//      is rejected wholesale, so a truncated download or an HTML error page cannot silently
//      replace three thousand prices with four.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from './config'
import { type ModelPrice, setFetchedPrices } from './pricing'

/** LiteLLM's catalog, from the branch it publishes rather than a pinned commit: a pin would freeze
 *  the very staleness this file exists to remove. Overridable for tests and for an air-gapped
 *  install that mirrors the file internally. */
const CATALOG_URL =
  process.env.AGENTHYDRA_PRICES_URL?.trim() ||
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

/** Where the last good download is kept, so a restart is priced correctly before the network is. */
const CACHE_PATH = join(DATA_DIR, 'price-catalog.json')

/** Re-check daily. Prices move on the scale of months; a daily fetch of a 1.7 MB file is already
 *  far more often than the data changes, and anything shorter is just traffic. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

/** A download is capped so a hung or hostile endpoint cannot stall the refresh forever. */
const FETCH_TIMEOUT_MS = 20_000

/** Below this the payload is not a price catalog — it is an error page, a truncated body, or a
 *  file that changed shape. Real ones carry ~3,000 entries; 200 is a floor, not an expectation. */
const MIN_PLAUSIBLE_MODELS = 200

/** One raw catalog entry. Every field is optional: the catalog carries embeddings, rerankers and
 *  audio models alongside chat models, and most of them have no cache rates at all. */
interface CatalogEntry {
  input_cost_per_token?: unknown
  output_cost_per_token?: unknown
  cache_read_input_token_cost?: unknown
  cache_creation_input_token_cost?: unknown
  cache_creation_input_token_cost_above_1hr?: unknown
  litellm_provider?: unknown
}

export interface PriceCatalog {
  /** Model key -> per-million prices, in the same units the bundled table uses. */
  prices: Record<string, ModelPrice>
  /** Epoch ms the payload was downloaded. */
  fetchedAt: number
}

const PER_MILLION = 1_000_000

/** A finite, non-negative number, or null. Zero is meaningful (a free model), so it passes. */
function rate(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
  return v * PER_MILLION
}

/**
 * One catalog entry as a ModelPrice, or null when it cannot be priced.
 *
 * Requires BOTH an input and an output rate. An entry with only one is an embedding or a rerank
 * model, not something a coding session spends output tokens on, and half a price is worse than
 * none — it would produce a confident dollar figure missing its largest term.
 */
export function entryToPrice(raw: unknown): ModelPrice | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as CatalogEntry
  const input = rate(e.input_cost_per_token)
  const output = rate(e.output_cost_per_token)
  if (input === null || output === null) return null

  const cacheRead = rate(e.cache_read_input_token_cost)
  const write5m = rate(e.cache_creation_input_token_cost)
  const write1h = rate(e.cache_creation_input_token_cost_above_1hr)
  return {
    input,
    output,
    // Absolute rates, not ratios: the bundled table derives cache rates from input because
    // Anthropic publishes them that way, but the catalog states them outright for every provider —
    // and they do NOT all follow Anthropic's multiples (DeepSeek's cache read is under a hundredth
    // of its input rate, not a tenth). A model with no published cache rate keeps `undefined` and
    // falls back to the ratios, which is right for Anthropic and harmless elsewhere: neither Codex
    // nor OpenCode reports a nonzero cache-write count for such a model.
    cacheReadUsd: cacheRead ?? undefined,
    cacheWrite5mUsd: write5m ?? undefined,
    // 1-hour writes are Anthropic-only today. Falling back to the 5-minute rate rather than to the
    // 2x ratio keeps a provider that has one cache rate from being billed for a TTL it does not
    // sell.
    cacheWrite1hUsd: write1h ?? write5m ?? undefined,
  }
}

/**
 * The catalog's keys, indexed the way transcripts actually spell a model.
 *
 * The catalog mixes bare ids (`gpt-5.6-sol`) with provider-qualified ones (`deepseek/deepseek-v4-pro`,
 * `openrouter/anthropic/claude-opus-5`). Transcripts do both: Codex writes bare ids, OpenCode writes
 * `provider/id`. So every entry is indexed under its full key AND under its last path segment —
 * with the full key winning, and a bare-name collision resolved FIRST-WINS in catalog order rather
 * than by an invented preference. A bare name that two providers both claim at different prices is
 * exactly the ambiguity rule 2 of pricing.ts refuses to guess at, but dropping it entirely would
 * unprice the common case (one provider, one price) to protect the rare one.
 */
export function indexCatalog(payload: unknown): Record<string, ModelPrice> {
  if (!payload || typeof payload !== 'object') return {}
  const out: Record<string, ModelPrice> = {}
  const bare: Record<string, ModelPrice> = {}
  for (const [key, raw] of Object.entries(payload as Record<string, unknown>)) {
    // LiteLLM's own metadata row, not a model.
    if (key === 'sample_spec') continue
    const price = entryToPrice(raw)
    if (!price) continue
    const full = key.toLowerCase()
    out[full] = price
    const slash = full.lastIndexOf('/')
    if (slash < 0) continue
    const short = full.slice(slash + 1)
    if (short && !(short in bare)) bare[short] = price
  }
  // Full keys last: an entry that IS a bare name outranks another entry's trailing segment.
  return { ...bare, ...out }
}

let loaded: PriceCatalog | null = null

/** The catalog currently in force, or null when only the bundled table has answered so far. */
export function currentCatalog(): PriceCatalog | null {
  return loaded
}

function apply(catalog: PriceCatalog): void {
  loaded = catalog
  setFetchedPrices(catalog.prices, catalog.fetchedAt)
}

/** Read the on-disk cache into memory. Safe to call before any network exists. */
export function loadCachedCatalog(): PriceCatalog | null {
  if (!existsSync(CACHE_PATH)) return null
  try {
    const saved = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as {
      fetchedAt?: unknown
      payload?: unknown
    }
    const fetchedAt = typeof saved.fetchedAt === 'number' ? saved.fetchedAt : 0
    const prices = indexCatalog(saved.payload)
    if (Object.keys(prices).length < MIN_PLAUSIBLE_MODELS) return null
    const catalog = { prices, fetchedAt }
    apply(catalog)
    return catalog
  } catch {
    // A corrupt cache is a cache miss, not a failure: the bundled table still answers and the next
    // refresh overwrites the file.
    return null
  }
}

function writeCache(payload: unknown, fetchedAt: number): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true })
    writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt, payload }))
  } catch {
    // An unwritable data dir costs us the restart shortcut, nothing else.
  }
}

/**
 * Download the catalog and put it in force.
 *
 * Returns the number of models priced, or null when the fetch failed or the payload was not a
 * plausible catalog. Never throws: every caller is fire-and-forget by design.
 */
export async function refreshPriceCatalog(now: number = Date.now()): Promise<number | null> {
  try {
    const res = await fetch(CATALOG_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const payload = (await res.json()) as unknown
    const prices = indexCatalog(payload)
    const count = Object.keys(prices).length
    if (count < MIN_PLAUSIBLE_MODELS) return null
    apply({ prices, fetchedAt: now })
    writeCache(payload, now)
    return count
  } catch {
    return null
  }
}

/**
 * Startup path: adopt the cached catalog immediately, then refresh if it is stale.
 *
 * Deliberately not awaited by the daemon. The cache read is synchronous and instant, so prices are
 * as good as last run's before the first request is served; the network half happens whenever it
 * happens.
 */
export function startPriceCatalog(now: number = Date.now()): void {
  const cached = loadCachedCatalog()
  if (cached && now - cached.fetchedAt < MAX_AGE_MS) return
  void refreshPriceCatalog(now).then((count) => {
    if (count === null && !cached)
      console.warn(
        '[agenthydra] price catalog unavailable; using the prices bundled with this build',
      )
  })
}
