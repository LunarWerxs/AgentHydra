// tests/session-ending.test.ts — why a conversation stopped writing to a file.
//
// This exists to answer a question a user actually asked: not "which of these duplicate rows is the
// real one" but "why are there several at all?". Every one of them has a cause written in the file
// — the last thing that happened in it — and the list simply had no way to say so. Measured across
// the 30 multi-transcript conversations on a real store, the superseded parts ended 18x on the user
// pressing stop, 6x on a safety filter refusing the message, 3x on an ordinary turn later picked
// back up, and 2x on a server overload. Every notice below is copied from those transcripts.
//
// The gate is the same one the usage-limit detector uses, and it is the load-bearing part: only the
// CLI's own report counts. A conversation that TALKS about being overloaded, or one where the model
// types the words "request interrupted by user" into a code block, has not been interrupted.

import { expect, test } from 'bun:test'
import { classifyEnding, type SessionEnding } from '../server/src/session-ending'

const REAL_529 =
  'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.'
const REAL_REFUSAL =
  "API Error: Opus 4.8's safeguards flagged this message. Our intentionally broad safeguards allow us to deliver more capabilities faster, but can sometimes flag benign requests."
const REAL_WEEKLY_LIMIT = "You've hit your weekly limit · resets 3am (America/Chicago)"

/** The shape the CLI writes when it reports its own failure. */
const cliError = (text: string) => ({
  type: 'assistant',
  isApiErrorMessage: true,
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
})
const said = (role: 'user' | 'assistant', text: string) => ({
  type: role,
  message: { role, content: text },
})
const of = (ev: { message?: { content?: unknown } }, text: string): SessionEnding | null =>
  classifyEnding(ev, text)

test('pressing stop is recorded as an interruption', () => {
  const text = '[Request interrupted by user]'
  expect(of(said('user', text), text)).toBe('interrupted')
})

test('a safety refusal is named as one, not lumped in with errors', () => {
  // 6 of the 30 conversations split for this reason, and "it hit an error" would have told the user
  // nothing about what to do differently.
  expect(of(cliError(REAL_REFUSAL), REAL_REFUSAL)).toBe('refused')
})

test('a 529 is a server overload, not the user running out of quota', () => {
  expect(of(cliError(REAL_529), REAL_529)).toBe('overload')
})

test('a quota wall is a usage limit, and outranks nothing else', () => {
  expect(of(cliError(REAL_WEEKLY_LIMIT), REAL_WEEKLY_LIMIT)).toBe('usage-limit')
})

test('another API error is reported as an error rather than guessed at', () => {
  const text = 'API Error: 500 Internal Server Error'
  expect(of(cliError(text), text)).toBe('error')
})

test('an ordinary last turn means nothing went wrong', () => {
  const text = 'All landed and pushed.'
  expect(of(said('assistant', text), text)).toBe('complete')
})

// --- the gate: only the CLI's own report counts ------------------------------------------------

test('a conversation that merely discusses an overload did not end on one', () => {
  // The 2026-07-15 false-positive class, in a new place. Model prose is never evidence.
  const text = `Yesterday the run died on "${REAL_529}" — worth retrying?`
  expect(of(said('assistant', text), text)).toBe('complete')
})

test('the model typing the interrupt marker is not an interruption', () => {
  // The marker is written by the RUNTIME as a user turn. An assistant repeating the string is
  // quoting it, and a row reading "you stopped it" when the user did not is a small lie that
  // undermines the whole point of showing a reason.
  const text = 'The CLI writes [Request interrupted by user] when you press escape.'
  expect(of(said('assistant', text), text)).toBe('complete')
})

test("the CLI's own resume bookkeeping is not an ending at all", () => {
  // A <synthetic> record with nothing wrong in it is the no-op the CLI writes when resuming. Null
  // means "this record says nothing", so the caller keeps whatever the previous record told it —
  // calling it an error would make every resumed session claim to have failed.
  const text = 'No response requested.'
  const ev = {
    type: 'assistant',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
  }
  expect(classifyEnding(ev, text)).toBeNull()
})

test('records that are not turns say nothing', () => {
  expect(classifyEnding({ type: 'summary' }, 'whatever')).toBeNull()
  expect(classifyEnding({ type: 'queue-operation' }, '')).toBeNull()
  expect(classifyEnding(null, '')).toBeNull()
})

test('an errored terminal result is read the same way as a synthetic turn', () => {
  expect(classifyEnding({ type: 'result', is_error: true, result: REAL_529 }, REAL_529)).toBe(
    'overload',
  )
})
