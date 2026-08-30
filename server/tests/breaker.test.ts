// server/tests/breaker.test.ts - the circuit breaker pinned: it bounds REPEATED futile
// automation, forgets on success, expires with its window, and is loud about every hold.
import { beforeEach, expect, test } from 'bun:test'
import {
  ATTEMPT_CAP,
  ATTEMPT_WINDOW_MS,
  checkBreaker,
  clearAttempts,
  noteAttempt,
  suppressedChats,
} from '../src/breaker'
import { db } from '../src/db'

beforeEach(() => {
  db.query('delete from action_attempt_log').run()
})

const T0 = Date.parse('2026-08-30T12:00:00Z')

test('the cap is reached, not exceeded - the NEXT attempt after the cap is suppressed', () => {
  for (let i = 0; i < ATTEMPT_CAP; i++) {
    expect(checkBreaker('archive', 's1', T0 + i).suppressed).toBe(false)
    noteAttempt('archive', 's1', T0 + i)
  }
  const v = checkBreaker('archive', 's1', T0 + ATTEMPT_CAP)
  expect(v.suppressed).toBe(true)
  expect(v.attempts).toBe(ATTEMPT_CAP)
})

test('a suppression is LOUD: it says why, how many, and when it frees up', () => {
  for (let i = 0; i < ATTEMPT_CAP; i++) noteAttempt('archive', 's1', T0 + i)
  const v = checkBreaker('archive', 's1', T0 + 1000)
  expect(v.why).toContain('without sticking')
  // The owner must be able to see this is about the machinery, not about him.
  expect(v.why).toContain('A direct request from you is never blocked')
  expect(Date.parse(v.retryAfter as string)).toBe(T0 + ATTEMPT_WINDOW_MS)
})

test('SUCCESS clears the count - the brake is for futility, not for work that lands', () => {
  for (let i = 0; i < ATTEMPT_CAP; i++) noteAttempt('surface', 's1', T0 + i)
  expect(checkBreaker('surface', 's1', T0 + 100).suppressed).toBe(true)
  clearAttempts('surface', 's1')
  expect(checkBreaker('surface', 's1', T0 + 100).suppressed).toBe(false)
})

test('the window expires, so a chat is never punished forever', () => {
  for (let i = 0; i < ATTEMPT_CAP; i++) noteAttempt('archive', 's1', T0 + i)
  expect(checkBreaker('archive', 's1', T0 + 1000).suppressed).toBe(true)
  expect(checkBreaker('archive', 's1', T0 + ATTEMPT_WINDOW_MS + 1).suppressed).toBe(false)
})

test('kinds and sessions are counted separately - one loop cannot brake another chat', () => {
  for (let i = 0; i < ATTEMPT_CAP; i++) noteAttempt('archive', 's1', T0 + i)
  expect(checkBreaker('archive', 's1', T0 + 100).suppressed).toBe(true)
  expect(checkBreaker('surface', 's1', T0 + 100).suppressed).toBe(false)
  expect(checkBreaker('archive', 's2', T0 + 100).suppressed).toBe(false)
})

test('counts survive a restart - they are on disk, because a storm causes restarts', () => {
  for (let i = 0; i < ATTEMPT_CAP; i++) noteAttempt('archive', 's1', T0 + i)
  // A fresh read with no in-process state is exactly what a restarted daemon does.
  const rows = db.query<{ c: number }, []>('select count(*) c from action_attempt_log').get()
  expect(rows?.c).toBe(ATTEMPT_CAP)
  expect(checkBreaker('archive', 's1', T0 + 100).suppressed).toBe(true)
})

test('suppressedChats lists what is being held, for the status surfaces', () => {
  for (let i = 0; i < ATTEMPT_CAP; i++) noteAttempt('archive', 'held', T0 + i)
  noteAttempt('surface', 'fine', T0)
  const held = suppressedChats(T0 + 100)
  expect(held.length).toBe(1)
  expect(held[0]?.sessionId).toBe('held')
  expect(held[0]?.kind).toBe('archive')
})

test('old attempts outside the window are pruned as new ones land', () => {
  noteAttempt('archive', 's1', T0 - ATTEMPT_WINDOW_MS - 10_000)
  noteAttempt('archive', 's1', T0)
  const c = db.query<{ c: number }, []>('select count(*) c from action_attempt_log').get()?.c
  expect(c).toBe(1)
})
