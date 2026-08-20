// tests/limit-stop-tracker.test.ts — the ONE quota-stop judgment, and the two callers that share it.
//
// WHY THIS FILE EXISTS SEPARATELY FROM rate-limit-signal.test.ts. That file pins which STRINGS mean
// a spent quota. This one pins the streaming accumulator built on top: which records are allowed to
// count as evidence, and whether the stop is still open. Two things read it and they read the same
// bytes from different distances — rate-limit-discovery.ts from a 256 KB tail (feeding the
// auto-resume monitor), sessions.ts from the whole-transcript parse it already runs for every row
// (feeding the "stopped by a usage limit" filter and its badge).
//
// The failure this locks out is not a crash, it is a DISAGREEMENT: a row badged "still at the
// limit" that the monitor then declines to resume, or the reverse. Both used to be possible,
// because the judgment was written out longhand inside classifyRateLimitTail and the list had no
// opinion at all. The tail classifier is now a thin wrapper over the tracker, and the test at the
// bottom of this file asserts exactly that — same events in, same verdict out.

import { expect, test } from 'bun:test'
import { classifyRateLimitTail } from '../server/src/rate-limit-discovery'
import { createLimitStopTracker } from '../server/src/rate-limit-signal'

const REAL_SESSION_LIMIT = "You've hit your session limit · resets 9:10am (America/Chicago)"
const REAL_WEEKLY_LIMIT = "You've hit your weekly limit · resets 3am (America/Chicago)"
const REAL_529 =
  'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.'

/** The shape Claude Code writes when the CLI itself reports a wall. */
const wall = (text: string, timestamp?: string) => ({
  type: 'assistant',
  isApiErrorMessage: true,
  timestamp,
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
})
const said = (role: 'user' | 'assistant', text: string) => ({
  type: role,
  message: { role, content: [{ type: 'text', text }] },
})

function verdictOf(events: unknown[], stamps: (number | null)[] = []) {
  const tracker = createLimitStopTracker()
  events.forEach((ev, i) => {
    tracker.observe(ev, stamps[i] ?? null)
  })
  return tracker.verdict()
}

// --- what counts as evidence -----------------------------------------------------------------

test('a transcript with no wall notice has no stop', () => {
  expect(verdictOf([said('user', 'fix the tests'), said('assistant', 'done')])).toBeNull()
})

test("the CLI's own limit notice is a stop, and it is pending", () => {
  const v = verdictOf([said('user', 'go'), wall(REAL_SESSION_LIMIT)])
  expect(v?.notice).toBe(REAL_SESSION_LIMIT)
  expect(v?.pending).toBe(true)
})

test('a weekly wall counts exactly like a session wall', () => {
  expect(verdictOf([wall(REAL_WEEKLY_LIMIT)])?.pending).toBe(true)
})

test('an errored terminal result counts as the CLI reporting a wall', () => {
  const v = verdictOf([{ type: 'result', is_error: true, result: REAL_WEEKLY_LIMIT }])
  expect(v?.notice).toBe(REAL_WEEKLY_LIMIT)
})

// THE false-positive class this whole detector is shaped around (2026-07-15): a session that merely
// TALKED about rate limits was parked as rate-limited, twice, on runs that exited 0 with the job
// done. Model prose is never evidence, however exactly it quotes the notice.
test('a session that only DISCUSSES a limit is not stopped by one', () => {
  expect(
    verdictOf([
      said('user', `why did it say "${REAL_SESSION_LIMIT}"?`),
      said('assistant', `That means you hit your session limit. Also 429 and quota are involved.`),
    ]),
  ).toBeNull()
})

test('tool output quoting a notice is not evidence either', () => {
  expect(
    verdictOf([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: `grep: ${REAL_WEEKLY_LIMIT}` }],
        },
      },
    ]),
  ).toBeNull()
})

// A 529 is Anthropic's servers being busy, not the user's allowance being spent. It clears in
// seconds, so a session that hit one is not waiting on anything and must never be listed as
// "stopped by a usage limit" — that conflation is the bug rate-limit-signal.ts was split to kill.
test('a transient 529 is not a usage-limit stop', () => {
  expect(verdictOf([wall(REAL_529)])).toBeNull()
})

// --- is it still stopped? --------------------------------------------------------------------

test('anything conversational after the notice means the work resumed', () => {
  const v = verdictOf([wall(REAL_SESSION_LIMIT), said('user', 'carry on'), said('assistant', 'ok')])
  expect(v?.pending).toBe(false)
  // Still reported: "this ran into a wall at some point" is a real fact about the session, and the
  // list shows both kinds. Only `pending` separates the actionable half.
  expect(v?.notice).toBe(REAL_SESSION_LIMIT)
})

test('a second wall after a resume re-opens the stop', () => {
  const v = verdictOf([wall(REAL_SESSION_LIMIT), said('user', 'carry on'), wall(REAL_WEEKLY_LIMIT)])
  expect(v?.pending).toBe(true)
  expect(v?.notice).toBe(REAL_WEEKLY_LIMIT)
})

test('the stop remembers when it happened', () => {
  const at = Date.parse('2026-08-19T04:10:00.000Z')
  expect(verdictOf([wall(REAL_WEEKLY_LIMIT)], [at])?.at).toBe(at)
})

// --- the two callers cannot drift --------------------------------------------------------------

test('the tail classifier and the tracker agree, event for event', () => {
  const events = [
    said('user', 'start the migration'),
    wall(REAL_SESSION_LIMIT),
    said('user', 'resume'),
    wall(REAL_WEEKLY_LIMIT),
  ]
  const jsonl = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
  const fromTail = classifyRateLimitTail(jsonl)
  const fromTracker = verdictOf(events)
  expect(fromTail).toEqual({ notice: fromTracker?.notice, pending: fromTracker?.pending } as never)
})

test('a tail slice beginning mid-line is not evidence of anything', () => {
  // readTail() slices at a byte offset, so the first line is nearly always a fragment. It must be
  // skipped rather than crashing the classifier or being read as a record.
  const jsonl = `{"type":"assistant","mess\n${JSON.stringify(wall(REAL_WEEKLY_LIMIT))}\n`
  expect(classifyRateLimitTail(jsonl)?.pending).toBe(true)
})
