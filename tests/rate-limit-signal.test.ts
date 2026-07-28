// tests/rate-limit-signal.test.ts — telling a 529 apart from a spent quota.
//
// The bug this locks out, verbatim from a real run (2026-07-16): a run whose only two events were
// "session started" and "API Error: 529 Overloaded. This is a server-side issue, usually temporary
// — try again in a moment." was finalized status='rate_limited' — parked as though the user's
// 5-hour window were spent. It wasn't; the same message sent from the desktop app went straight
// through, because a 529 clears in seconds. One pattern list covered both, so they were the same
// event as far as the daemon could tell.
//
// Both directions are load-bearing, and they are NOT symmetric:
//   · a quota wall read as transient = a few wasted retries against a wall, then it parks anyway;
//   · a transient read as quota      = today's bug (a run parked for hours over a blip).
// Hence classifyLimit's rule: ambiguous text lands on QUOTA (the already-shipped behavior), and
// only an unmistakable server-side signature is promoted to transient. These tests pin that
// asymmetry, because a careless future edit to the pattern lists would silently undo it.

import { expect, test } from 'bun:test'
import { classifyLimit, isApiErrorEvent } from '../server/src/rate-limit-signal'

// --- the real notices, copied from live transcripts -----------------------------------------

const REAL_529 =
  'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.'
const REAL_SESSION_LIMIT = "You've hit your session limit · resets 9:10am (America/Chicago)"
const REAL_WEEKLY_LIMIT = "You've hit your weekly limit · resets 3am (America/Chicago)"

test('the real 529 notice is transient, not the user hitting a limit', () => {
  expect(classifyLimit(REAL_529)).toBe('transient')
})

test('the real session-limit notice is a quota wall', () => {
  expect(classifyLimit(REAL_SESSION_LIMIT)).toBe('quota')
})

// Regression (2026-07-27): the quota list named only the SESSION wording, so this — the OTHER
// window, same sentence — matched nothing at all. The run finalized as a bare 'failed' with no
// rate-limited badge, and monitor.ts's resume-after-reset never saw it, because it selects on
// status='rate_limited'.
test('the real WEEKLY-limit notice is a quota wall too', () => {
  expect(classifyLimit(REAL_WEEKLY_LIMIT)).toBe('quota')
})

test('ordinary text is neither', () => {
  expect(classifyLimit('wrote 3 files and ran the tests')).toBeNull()
})

// --- quota: YOUR allowance is spent, only time fixes it --------------------------------------

test.each([
  ["You've hit your session limit · resets 5:40am", 'the session-limit notice'],
  ['Your usage limit has been reached', 'usage limit'],
  ['monthly quota exceeded', 'quota'],
  ['429 Too Many Requests', 'a 429'],
  ['too many requests, slow down', 'too many requests'],
  ['you are being rate-limited', 'a generic rate-limit phrasing'],
])('quota: %s (%s)', (text) => {
  expect(classifyLimit(text)).toBe('quota')
})

// --- transient: ANTHROPIC'S servers are saturated, seconds not hours -------------------------

test.each([
  ['API Error: 529 Overloaded', 'a bare 529'],
  ['the service is Overloaded right now', 'overloaded'],
  ['upstream temporarily unavailable', 'temporarily unavailable'],
  ['something broke, try again in a moment', 'try again in a moment'],
])('transient: %s (%s)', (text) => {
  expect(classifyLimit(text)).toBe('transient')
})

// --- the asymmetry: ambiguity must fall to quota ---------------------------------------------

test('text carrying BOTH signals is quota — ambiguity keeps the already-shipped behavior', () => {
  // "try again later" is a transient phrase, but "rate limited" names the user's own wall. Reading
  // this as transient would retry a door that won't open for hours.
  expect(classifyLimit('rate limited — try again later')).toBe('quota')
  expect(classifyLimit('529 Overloaded: you have hit your session limit')).toBe('quota')
})

test('a 429 is the user’s cap, a 529 is the server — they must not collapse together', () => {
  // The exact distinction that makes this file exist. Same "Rate limited" label in the wild;
  // opposite responses.
  expect(classifyLimit('429')).toBe('quota')
  expect(classifyLimit('529')).toBe('transient')
})

// --- the trust gate binds BOTH kinds ---------------------------------------------------------

test('only the CLI’s own report is evidence — prose and tool output are not', () => {
  // A false transient is worse than a false quota: it RE-RUNS the prompt. So the gate that has
  // always protected the quota path has to cover the retry path identically.
  expect(isApiErrorEvent({ message: { model: 'claude-opus-4-8' } })).toBe(false)
  expect(isApiErrorEvent({ type: 'user', message: { content: 'why the 529?' } })).toBe(false)
})

test('the CLI’s synthetic error notice IS evidence', () => {
  expect(isApiErrorEvent({ isApiErrorMessage: true, message: { model: '<synthetic>' } })).toBe(true)
})

test('a <synthetic> no-op is still evidence-shaped, but classifies to nothing', () => {
  // `<synthetic>` alone passes the gate (the CLI wrote it), and the SECOND half of the detector —
  // the patterns — is what rejects it. Both halves are required; neither is sufficient.
  const noop = { message: { model: '<synthetic>' } }
  expect(isApiErrorEvent(noop)).toBe(true)
  expect(classifyLimit('No response requested.')).toBeNull()
})
