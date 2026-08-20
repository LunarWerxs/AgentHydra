// server/src/session-ending.ts — why did this conversation stop writing to this file?
//
// WHY THIS EXISTS. One chat routinely leaves two or three transcripts behind, and the question a
// person actually has when they see them is not "which is the real one" but "why are there several".
// Answering that needs the LAST thing that happened in each file, because that is the event that
// ended it. Measured across the 30 multi-transcript conversations on a real store, the superseded
// parts ended like this:
//
//   18  the user interrupted it
//    6  a safety filter refused the message
//    3  ended on an ordinary assistant turn, and were picked up again later
//    2  a server overload (529)
//
// So it is never a mystery — every one of them has a cause written in the file. The list just had
// no way to say it.
//
// A LEAF: imports only rate-limit-signal.ts, which is itself import-free, so types.ts can carry
// this type into the web app's typecheck without dragging any Bun runtime along.
import { classifyLimit, isApiErrorEvent } from './rate-limit-signal'

/**
 * What ended a transcript.
 *
 *  · 'interrupted'  — the person stopped it mid-answer. The CLI records this as a user turn reading
 *                     "[Request interrupted by user]".
 *  · 'usage-limit'  — a quota wall. Same judgment as the usage-limit badge; see rate-limit-signal.
 *  · 'overload'     — a 529. Anthropic's servers were saturated, which clears on its own.
 *  · 'refused'      — a safety filter declined the message.
 *  · 'error'        — some other API error the CLI reported.
 *  · 'complete'     — nothing went wrong; the last thing in the file is an ordinary turn.
 */
export type SessionEnding =
  | 'interrupted'
  | 'usage-limit'
  | 'overload'
  | 'refused'
  | 'error'
  | 'complete'

/**
 * The CLI's own words when a person presses stop.
 *
 * ANCHORED, and on a USER turn only. The runtime writes this as the entire content of a user
 * record, so an assistant record that merely contains the phrase is quoting it — and a row saying
 * "you stopped it" when the user did not is a small lie that spends the credibility of every other
 * reason shown beside it. A test pins both directions. The trailing group covers the variants the
 * CLI appends ("...for tool use").
 */
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/

/** "API Error: <model>'s safeguards flagged this message." Matched on the phrase rather than the
 *  model name, because the model in it changes with every release and the sentence does not. */
const REFUSED = /\bsafeguards flagged this message\b/i

/**
 * Classify ONE record — the last meaningful one in a transcript.
 *
 * Callers feed every user/assistant/result record as they stream past and keep the latest answer;
 * that costs nothing on a pass that is already parsing each line. Returns null for a record that
 * says nothing about an ending, so a caller can ignore it and keep whatever it had.
 *
 * The API-error gate is {@link isApiErrorEvent}, exactly as the usage-limit detector uses it, and
 * for the same reason: a run that merely TALKED about being overloaded is not overloaded, and the
 * only trustworthy report is the CLI's own.
 */
export function classifyEnding(ev: unknown, text: string): SessionEnding | null {
  const e = ev as any
  const type = e?.type
  if (type !== 'user' && type !== 'assistant' && type !== 'result') return null
  if (isApiErrorEvent(e) || (type === 'result' && e?.is_error === true)) {
    if (REFUSED.test(text)) return 'refused'
    const limit = classifyLimit(text)
    if (limit === 'quota') return 'usage-limit'
    if (limit === 'transient') return 'overload'
    // A `<synthetic>` record that reports nothing wrong is the CLI's own resume bookkeeping
    // ("No response requested."), not an ending — say nothing rather than calling it an error.
    return /\bAPI Error\b/i.test(text) ? 'error' : null
  }
  if (type === 'user' && INTERRUPTED.test(text.trim())) return 'interrupted'
  return 'complete'
}
