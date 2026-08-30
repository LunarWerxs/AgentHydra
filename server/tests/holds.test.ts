// server/tests/holds.test.ts - the per-chat automation opt-out pinned: a hold refuses to exist
// without a reason, survives as an upsert rather than a duplicate, releases cleanly, and is
// honoured by BOTH unattended actuators (the gate sweep and the courier) while staying visible.
import { beforeEach, expect, test } from 'bun:test'
import { clearRecentlySent, deliverPendingRows } from '../src/courier-deliver'
import { db } from '../src/db'
import { type Hold, holdSession, isHeld, listHolds, releaseSession } from '../src/holds'

beforeEach(() => {
  db.query('delete from session_holds').run()
  clearRecentlySent()
})

const T0 = Date.parse('2026-08-30T12:00:00Z')

test('a hold without a reason is REFUSED - an unexplained hold reads as a bug later', () => {
  const r = holdSession('s1', '   ', T0)
  expect(r.ok).toBe(false)
  expect(isHeld('s1')).toBe(null)
})

test('a hold with no session id is refused too', () => {
  expect(holdSession('  ', 'because', T0).ok).toBe(false)
})

test('a held chat reports its reason and when it was held', () => {
  expect(holdSession('s1', 'owner is driving this one by hand', T0).ok).toBe(true)
  const h = isHeld('s1')
  expect(h?.reason).toBe('owner is driving this one by hand')
  expect(Date.parse(h?.heldAt as string)).toBe(T0)
})

test('holding twice UPDATES the reason - one hold per chat, never a pile', () => {
  holdSession('s1', 'first reason', T0)
  holdSession('s1', 'second reason', T0 + 1000)
  const all = listHolds()
  expect(all.length).toBe(1)
  expect(all[0]?.reason).toBe('second reason')
})

test('release hands the chat back, and releasing an unheld chat is not an error', () => {
  holdSession('s1', 'parked mid-experiment', T0)
  expect(releaseSession('s1').wasHeld).toBe(true)
  expect(isHeld('s1')).toBe(null)
  expect(releaseSession('s1').wasHeld).toBe(false)
})

test('listHolds is newest first, so the fleet report leads with the latest decision', () => {
  holdSession('old', 'a', T0)
  holdSession('new', 'b', T0 + 60_000)
  expect(listHolds().map((h) => h.sessionId)).toEqual(['new', 'old'])
})

test('the COURIER refuses to type into a held chat, and says why instead of skipping silently', async () => {
  const held: Hold = { sessionId: 's1', reason: 'owner is mid-thought here', heldAt: 'WHEN' }
  let delivered = 0
  const rows = await deliverPendingRows({
    pending: () => [{ session_id: 's1', prompt: 'resume', instance_ref: null, staged_at: T0 }],
    heldSession: (id) => (id === 's1' ? held : null),
    chatOf: () => ({ title: 'a chat', instance: 'C:\\inst' }),
    transcriptOf: () => 'anything',
    deliver: async () => {
      delivered++
      return { ok: true, outcome: 'delivered', detail: 'x' }
    },
  })
  expect(delivered).toBe(0)
  expect(rows[0]?.outcome).toBe('on-hold')
  expect(rows[0]?.detail).toContain('owner is mid-thought here')
})

test('a hold is checked BEFORE anything else - no transcript work happens for a held chat', async () => {
  let looked = 0
  await deliverPendingRows({
    pending: () => [{ session_id: 's1', prompt: 'resume', instance_ref: null, staged_at: T0 }],
    heldSession: () => ({ sessionId: 's1', reason: 'r', heldAt: 'WHEN' }),
    chatOf: () => {
      looked++
      return null
    },
    transcriptOf: () => {
      looked++
      return null
    },
    deliver: async () => ({ ok: true, outcome: 'delivered', detail: 'x' }),
  })
  expect(looked).toBe(0)
})
