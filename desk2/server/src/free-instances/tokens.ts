// The Free table's Tokens column (owner, 2026-10-06: "a column on the free table called tokens to show the amount
// of tokens run through the account, just like the others"). Neither claude.ai nor chatgpt.com reports tokens, so
// Desk estimates them from characters, at about 4 a token as server/src/analytics.ts does: a message's input is the
// text it sent plus the thread it continues (the model reads the whole conversation again), its output the reply.
// Only counts are kept, never text. The windows are cut the way the CLI and desktop tables cut theirs
// (server/src/core/account-tokens.ts windowStartMs): at the account's own reset when its reading has one, else rolling.
import type { FreeTokenParts, FreeTokens, FreeUsage } from '@shared/free-instances'

export const CHARS_PER_TOKEN = 4
const HOUR_MS = 3_600_000
export const FIVE_HOURS_MS = 5 * HOUR_MS
export const WEEK_MS = 7 * 24 * HOUR_MS

/** One message's estimate. */
export interface TokenEntry { at: number; input: number; output: number }
/** An account's ledger: the messages a window can still reach (the last week) and the all-time sums. */
export interface TokenLedger { entries: TokenEntry[]; total: { input: number; output: number } }

export const estimateTokens = (chars: number): number => Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN)

/** The ledger with one more message; entries older than any window's start are dropped. */
export function addTokens(ledger: TokenLedger | undefined, entry: TokenEntry): TokenLedger {
  const reach = entry.at - WEEK_MS
  return {
    entries: [...(ledger?.entries ?? []).filter(e => e.at >= reach), entry],
    total: { input: (ledger?.total.input ?? 0) + entry.input, output: (ledger?.total.output ?? 0) + entry.output },
  }
}

/** Where a window starts: its reset minus its span while the reset is ahead; the reset itself for a span after a reset
 *  no reading has followed yet; else the last span (account-tokens.ts windowStartMs). */
export function windowStart(resetsAt: string | null | undefined, spanMs: number, now: number): number {
  const end = Date.parse(resetsAt ?? '')
  if (!Number.isFinite(end)) return now - spanMs
  if (end > now) return end - spanMs
  return now - end < spanMs ? end : now - spanMs
}

const resetOf = (usage: FreeUsage | null | undefined, id: string): string | null => {
  const w = usage?.windows.find(x => x.id === id) ?? usage?.windows.find(x => x.id.startsWith(id))
  return w?.resets_at ?? null
}

const parts = (input: number, output: number): FreeTokenParts => ({ input, output, total: input + output })

function since(ledger: TokenLedger, start: number): FreeTokenParts {
  let input = 0
  let output = 0
  for (const e of ledger.entries) if (e.at >= start) { input += e.input; output += e.output }
  return parts(input, output)
}

/** The account's estimate for its current 5-hour window, current week and all time. */
export function tokenWindows(ledger: TokenLedger, usage: FreeUsage | null | undefined, now: number): FreeTokens {
  return {
    fiveHour: since(ledger, windowStart(resetOf(usage, 'five_hour'), FIVE_HOURS_MS, now)),
    week: since(ledger, windowStart(resetOf(usage, 'seven_day'), WEEK_MS, now)),
    total: parts(ledger.total.input, ledger.total.output),
  }
}

/** A stored ledger as it must be, or null for a damaged one (dropped, never trusted). */
export function validLedger(value: unknown): TokenLedger | null {
  const v = value as TokenLedger | null
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0
  if (!v || !Array.isArray(v.entries) || !v.total || !n(v.total.input) || !n(v.total.output)) return null
  return { entries: v.entries.filter(e => e && n(e.at) && n(e.input) && n(e.output)), total: { input: v.total.input, output: v.total.output } }
}
