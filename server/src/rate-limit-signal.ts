// server/src/rate-limit-signal.ts — telling a QUOTA wall apart from a TRANSIENT overload.
//
// These used to be ONE pattern list in dispatch.ts, and that conflation was a real bug: a run that
// died on "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in
// a moment." was finalized status='rate_limited', i.e. parked as though the user's 5-hour window
// were spent. It isn't. They are opposite failures wearing the same word:
//
//   · QUOTA    — "You've hit your session limit · resets 9:10am", 429/too many requests, usage
//                limit. YOUR allowance is spent. Only TIME fixes it; the right move is to wait for
//                the reset and resume (monitor.ts).
//   · TRANSIENT — 529, "Overloaded", "temporarily unavailable". ANTHROPIC'S servers are saturated.
//                It clears in seconds; the right move is to back off and retry (dispatch.ts).
//
// Retrying a quota wall hammers a door that won't open for hours. Parking an overload for 5 hours
// wastes the run for no reason — which is exactly what happened, and why the same message sent from
// the desktop app (which just retries) went through fine.
//
// A LEAF module: zero imports, so dispatch.ts, rate-limit-discovery.ts and db.ts's repair migration
// can all share one truth without an import cycle.

/**
 * YOUR allowance is spent — only time fixes it.
 *
 * The ambiguous/generic entries (`rate limit`, bare `429`) live HERE on purpose. Quota is the
 * conservative bucket: it is what the single list already did for every one of these strings, so
 * anything that doesn't unambiguously name a server-side overload keeps its existing, shipped
 * behavior. Mis-sorting a real overload into quota reproduces today's bug; mis-sorting a real quota
 * wall into transient burns a couple of harmless retries against a wall and then still parks. The
 * asymmetry says: only promote to TRANSIENT on an unmistakable signature.
 */
const QUOTA_PATTERNS: RegExp[] = [
  // The CLI's own wall notice, whichever window it names: "You've hit your session limit · resets
  // 9:10am", "You've hit your weekly limit · resets 3am (America/Chicago)", and any future window
  // wearing the same sentence. This used to name only the SESSION wording, so a genuine weekly wall
  // matched nothing at all and finalized as a bare 'failed' — no rate-limited badge, and invisible
  // to monitor.ts's resume-after-reset, which selects on that status (observed 2026-07-27).
  /\byou['’]?ve hit your\b[^.]{0,40}\blimit\b/i,
  /\bsession limit\b/i,
  /\bweekly limit\b/i,
  /\busage limit\b/i,
  /\bquota\b/i,
  /\brate[- ]?limit(?:ed|ing)?\b/i,
  /\btoo many requests\b/i,
  /\b429\b/,
]

/** ANTHROPIC'S servers are saturated — seconds, not hours. Only unmistakable signatures. */
const TRANSIENT_PATTERNS: RegExp[] = [
  /\b529\b/,
  /\boverloaded\b/i,
  /\btemporarily unavailable\b/i,
  /\btry again (?:later|in a moment)\b/i,
]

export type LimitKind = 'quota' | 'transient'

/**
 * Which wall did this text hit, if any?
 *
 * QUOTA IS CHECKED FIRST, and that order is the whole safety argument: a string carrying both
 * signals ("rate limited — try again later") is ambiguous, and ambiguous must land on quota, which
 * is the behavior that already ships. Only text that names NO quota concept at all can be promoted
 * to transient — which the real 529 notice satisfies exactly (it says 529/Overloaded/try again in a
 * moment and never says limit, quota, or 429).
 */
export function classifyLimit(text: string): LimitKind | null {
  if (QUOTA_PATTERNS.some((re) => re.test(text))) return 'quota'
  if (TRANSIENT_PATTERNS.some((re) => re.test(text))) return 'transient'
  return null
}

/**
 * WHERE a pattern above is allowed to match — the other half of the detector, and the more
 * important one.
 *
 * The patterns are deliberately loose (`\b529\b`, `\bquota\b`), which is fine for text the CLI
 * emits about its own state and catastrophic for anything else. Matching them against every event
 * marked EVERY run that merely TALKED about rate limits as rate-limited: an agent grepping for
 * "session limit", a Read whose output happened to contain line number 529, an Edit touching this
 * very file. Both `rate_limited` rows in the shipped DB were exactly that — false positives on runs
 * that exited 0 with the job done (2026-07-15), which then fed the auto-resume monitor a queue of
 * phantom stops to babysit.
 *
 * So: model prose, tool inputs, and tool results are NEVER evidence — only the CLI's own report is.
 * A genuine limit surfaces as a SYNTHETIC assistant message (`message.model === '<synthetic>'` with
 * `isApiErrorMessage: true`, e.g. "You've hit your session limit · resets 5:40am"), as an errored
 * terminal `result`, or on stderr. Note `<synthetic>` alone is not enough: the CLI also emits
 * `<synthetic>` no-op chatter with `isApiErrorMessage: false` ("No response requested.").
 *
 * This gate binds BOTH kinds. A transient detector that skipped it would reintroduce the identical
 * false-positive class on the retry path — and a false transient re-RUNS the prompt, which is worse
 * than a false park.
 */
export function isApiErrorEvent(ev: any): boolean {
  return ev?.isApiErrorMessage === true || ev?.message?.model === '<synthetic>'
}

/**
 * A conversation that stopped at a QUOTA wall, in the shape a session row can display.
 *
 * `pending` is the load-bearing half: a session that hit a limit and was later resumed is a
 * historical fact, whereas one still sitting at the wall is work waiting to be finished. The list
 * shows both and says which, because "this got rate limited at some point" and "this is stuck right
 * now" are different questions and only the second one is actionable.
 */
export interface LimitStop {
  /** The CLI's own notice, verbatim and compacted, e.g. "You've hit your weekly limit · resets 3am". */
  notice: string
  /** Nothing real followed the notice — the session is still stopped at it. */
  pending: boolean
  /** When the wall was hit (epoch ms), or null when the event carried no usable timestamp. */
  at: number | null
}

/** Accumulates one verdict from a stream of transcript events. */
export interface LimitStopTracker {
  /** Feed one parsed JSONL record, in file order. Anything irrelevant is ignored. */
  observe(ev: unknown, at?: number | null): void
  /** The verdict so far, or null if no trusted quota notice was ever seen. */
  verdict(): LimitStop | null
}

/**
 * THE quota-stop judgment, as a streaming accumulator — one implementation, two callers.
 *
 * rate-limit-discovery.ts owns the 256 KB-tail path that feeds the auto-resume monitor;
 * sessions.ts folds the same judgment into the whole-transcript parse it already runs for every
 * row, which costs nothing extra because that loop is already JSON.parse-ing every line. Both must
 * agree to the letter — a list that badges a session "stopped by a usage limit" while the monitor
 * declines to resume it is a bug report waiting to happen — so neither of them reimplements this.
 *
 * The rules, unchanged from the tail classifier that shipped first:
 *  - only `user` / `assistant` / `result` records are looked at at all;
 *  - a notice counts only when {@link isApiErrorEvent} vouches for it, or it is an errored terminal
 *    `result` — model prose and tool output are NEVER evidence (see the 2026-07-15 false-positive
 *    class documented above);
 *  - QUOTA only: a transient 529 cleared on its own and is not a stop;
 *  - a later notice supersedes an earlier one and re-opens the stop;
 *  - anything conversational after a notice means work resumed, so the stop stops being pending.
 *    The CLI's own resume bookkeeping counts on purpose: it only ever appears BECAUSE something
 *    resumed.
 */
export function createLimitStopTracker(): LimitStopTracker {
  let notice: string | null = null
  let pending = true
  let at: number | null = null
  return {
    observe(raw: unknown, ts: number | null = null): void {
      const ev = raw as any
      const type = ev?.type
      if (type !== 'user' && type !== 'assistant' && type !== 'result') return
      const trusted = isApiErrorEvent(ev) || (type === 'result' && ev?.is_error === true)
      if (trusted && classifyLimit(limitEventText(ev)) === 'quota') {
        notice = compactNotice(limitEventText(ev))
        pending = true
        at = ts
        return
      }
      if (notice) pending = false
    },
    verdict(): LimitStop | null {
      return notice ? { notice, pending, at } : null
    },
  }
}

/** The text a record carries, for the patterns to be tested against. Shared by both callers so a
 *  record shape that one of them learned to read is never invisible to the other. */
export function limitEventText(ev: any): string {
  const content = ev?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join(' ')
  }
  if (typeof ev?.result === 'string') return ev.result
  return ''
}

/** One line, and short enough to sit in a table cell or a tooltip. */
export function compactNotice(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 200 ? `${t.slice(0, 200)}…` : t
}
