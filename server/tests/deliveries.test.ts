// server/tests/deliveries.test.ts - the delivery ledger pinned: one pending row per session,
// evidence-settled states (delivered / deaf / expired), and reconcile-before-read.
import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../src/db'
import {
  deliverableDeliveries,
  lastTranscriptMessageAt,
  listDeliveries,
  parseDeliveryState,
  pendingDeliveries,
  pruneDeliveries,
  reconcileDeliveries,
  stageDelivery,
} from '../src/deliveries'

beforeEach(() => {
  db.query('delete from deliveries').run()
})

const T0 = Date.parse('2026-08-30T12:00:00Z')

/** That session's row state, read straight from the ledger. */
const stateOf = (sessionId: string): string | undefined =>
  db
    .query<{ state: string }, [string]>('select state from deliveries where session_id = ?')
    .get(sessionId)?.state

test('staging is one PENDING row per session - the earlier one is SUPERSEDED, never erased', () => {
  stageDelivery({ sessionId: 's1', prompt: 'first', instanceRef: 'desktop:C:/i1', nowMs: T0 })
  stageDelivery({ sessionId: 's1', prompt: 'second', instanceRef: 'desktop:C:/i2', nowMs: T0 + 1 })
  const rows = pendingDeliveries({ nowMs: T0 + 2, lastActivity: () => null, liveSince: () => null })
  expect(rows.length).toBe(1)
  expect(rows[0]?.prompt).toBe('second')
  expect(rows[0]?.instance_ref).toBe('desktop:C:/i2')
  // The first attempt is HISTORY, not a deletion (review-confirmed silent loss otherwise).
  const superseded = listDeliveries('superseded', {
    nowMs: T0 + 3,
    lastActivity: () => null,
    liveSince: () => null,
  })
  expect(superseded.length).toBe(1)
  expect(superseded[0]?.prompt).toBe('first')
  expect(superseded[0]?.evidence).toContain('replaced by a newer staging')
})

test('re-staging never touches RESOLVED history', () => {
  stageDelivery({ sessionId: 's1', prompt: 'first', instanceRef: null, nowMs: T0 })
  reconcileDeliveries({ nowMs: T0 + 10_000, lastActivity: () => T0 + 5_000, liveSince: () => null })
  stageDelivery({ sessionId: 's1', prompt: 'second', instanceRef: null, nowMs: T0 + 20_000 })
  const all = listDeliveries(undefined, {
    nowMs: T0 + 21_000,
    lastActivity: () => null,
    liveSince: () => null,
  })
  expect(all.map((r) => r.state).sort()).toEqual(['delivered', 'pending'])
})

test('a deaf row RE-SETTLES to delivered when the engine starts late', () => {
  stageDelivery({ sessionId: 's1', prompt: 'p', instanceRef: null, nowMs: T0 })
  reconcileDeliveries({
    nowMs: T0 + 60_000,
    lastActivity: () => T0 - 5_000,
    liveSince: () => T0 + 10_000,
  })
  // Later the transcript moves: the deaf label was premature.
  reconcileDeliveries({
    nowMs: T0 + 120_000,
    lastActivity: () => T0 + 90_000,
    liveSince: () => T0 + 10_000,
  })
  const [row] = listDeliveries(undefined, {
    nowMs: T0 + 121_000,
    lastActivity: () => null,
    liveSince: () => null,
  })
  expect(row?.state).toBe('delivered')
  expect(row?.evidence).toContain('deaf label was premature')
})

test('activity at EXACTLY staged_at is not a receipt - strict after, with exact mtimes', () => {
  stageDelivery({ sessionId: 's1', prompt: 'p', instanceRef: null, nowMs: T0 })
  reconcileDeliveries({ nowMs: T0 + 60_000, lastActivity: () => T0, liveSince: () => null })
  expect(
    pendingDeliveries({ nowMs: T0 + 61_000, lastActivity: () => T0, liveSince: () => null }).length,
  ).toBe(1)
})

test('expiry with no receipt says so honestly - null has three causes and none is claimed', () => {
  stageDelivery({ sessionId: 's1', prompt: 'p', instanceRef: null, nowMs: T0 })
  reconcileDeliveries({
    nowMs: T0 + 25 * 3600 * 1000,
    lastActivity: () => null,
    liveSince: () => null,
  })
  const [row] = listDeliveries(undefined, {
    nowMs: T0 + 26 * 3600 * 1000,
    lastActivity: () => null,
    liveSince: () => null,
  })
  expect(row?.evidence).toContain('no timestamped transcript activity found by expiry')
})

test('parseDeliveryState pins the route filter contract', () => {
  expect(parseDeliveryState(undefined)).toEqual({ ok: true, state: undefined })
  expect(parseDeliveryState('deaf')).toEqual({ ok: true, state: 'deaf' })
  expect(parseDeliveryState('superseded')).toEqual({ ok: true, state: 'superseded' })
  expect(parseDeliveryState('bogus').ok).toBe(false)
})

test('transcript movement AFTER staging is the delivery receipt', () => {
  stageDelivery({ sessionId: 's1', prompt: 'p', instanceRef: null, nowMs: T0 })
  reconcileDeliveries({
    nowMs: T0 + 60_000,
    lastActivity: () => T0 + 30_000,
    liveSince: () => null,
  })
  const [row] = listDeliveries(undefined, {
    nowMs: T0 + 61_000,
    lastActivity: () => null,
    liveSince: () => null,
  })
  expect(row?.state).toBe('delivered')
  expect(row?.evidence).toContain('transcript moved')
})

test('activity from BEFORE staging is not a receipt - the row stays pending', () => {
  stageDelivery({ sessionId: 's1', prompt: 'p', instanceRef: null, nowMs: T0 })
  reconcileDeliveries({ nowMs: T0 + 60_000, lastActivity: () => T0 - 5_000, liveSince: () => null })
  expect(
    pendingDeliveries({ nowMs: T0 + 61_000, lastActivity: () => T0 - 5_000, liveSince: () => null })
      .length,
  ).toBe(1)
})

test('a process that started after staging with NO transcript movement is DEAF, not delivered', () => {
  stageDelivery({ sessionId: 's1', prompt: 'p', instanceRef: null, nowMs: T0 })
  reconcileDeliveries({
    nowMs: T0 + 60_000,
    lastActivity: () => T0 - 5_000,
    liveSince: () => T0 + 10_000,
  })
  const [row] = listDeliveries(undefined, {
    nowMs: T0 + 61_000,
    lastActivity: () => null,
    liveSince: () => null,
  })
  expect(row?.state).toBe('deaf')
  expect(row?.evidence).toContain('engine never started')
})

test('24h unclaimed expires with the reason kept', () => {
  stageDelivery({ sessionId: 's1', prompt: 'p', instanceRef: null, nowMs: T0 })
  reconcileDeliveries({
    nowMs: T0 + 25 * 3600 * 1000,
    lastActivity: () => null,
    liveSince: () => null,
  })
  const [row] = listDeliveries(undefined, {
    nowMs: T0 + 26 * 3600 * 1000,
    lastActivity: () => null,
    liveSince: () => null,
  })
  expect(row?.state).toBe('expired')
  expect(row?.evidence).toContain('given up')
})

test('the receipt is MESSAGE TRAFFIC, never file movement - app bookkeeping moves nothing', () => {
  // Measured live 2026-08-30 (drill chat 616ecfe8): the app appended timestamp-free
  // atis-latch/mode records to an imported chat and a bare-mtime receipt read it as
  // delivered. Only timestamped records count.
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-receipt-'))
  const path = join(dir, 'session.jsonl')
  const userAt = '2026-08-30T07:00:00.000Z'
  writeFileSync(
    path,
    [
      JSON.stringify({ type: 'user', timestamp: userAt, message: { role: 'user' } }),
      JSON.stringify({ type: 'atis-latch', atis: '' }),
      JSON.stringify({ type: 'mode', mode: 'normal' }),
    ].join('\n'),
  )
  // The newest TIMESTAMPED record wins; the later bookkeeping appends are invisible.
  expect(lastTranscriptMessageAt(path)).toBe(Date.parse(userAt))
  // A queue-operation enqueue (what a native send writes first) is a receipt on its own.
  const enqueueAt = '2026-08-30T08:30:00.000Z'
  writeFileSync(
    path,
    [
      JSON.stringify({ type: 'user', timestamp: userAt, message: { role: 'user' } }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: enqueueAt }),
      JSON.stringify({ type: 'mode', mode: 'normal' }),
    ].join('\n'),
  )
  expect(lastTranscriptMessageAt(path)).toBe(Date.parse(enqueueAt))
  // No timestamped records at all = no receipt, never a guess.
  writeFileSync(path, `${JSON.stringify({ type: 'atis-latch', atis: '' })}\n`)
  expect(lastTranscriptMessageAt(path)).toBe(null)
  expect(lastTranscriptMessageAt(join(dir, 'missing.jsonl'))).toBe(null)
  // A bookkeeping record that DOES carry a timestamp is still never a receipt (the schema
  // assumption inverting must not fabricate deliveries).
  writeFileSync(
    path,
    `${JSON.stringify({ type: 'mode', mode: 'normal', timestamp: '2026-08-30T09:00:00.000Z' })}\n`,
  )
  expect(lastTranscriptMessageAt(path)).toBe(null)
})

test('a giant trailing record cannot bury the receipt - the scan widens to the whole file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-receipt-tail-'))
  const path = join(dir, 'session.jsonl')
  const userAt = '2026-08-30T07:00:00.000Z'
  const hugeLine = JSON.stringify({ type: 'x-blob', data: 'z'.repeat(4096) })
  writeFileSync(
    path,
    `${JSON.stringify({ type: 'user', timestamp: userAt, message: { role: 'user' } })}\n${hugeLine}\n`,
  )
  // A tail window smaller than the trailing blob sees no timestamped record - the fallback
  // full scan must still find the real one (review-confirmed false 'never delivered').
  expect(lastTranscriptMessageAt(path, 1024)).toBe(Date.parse(userAt))
})

test('listDeliveries reconciles before answering - a stale pending settles on read', () => {
  stageDelivery({ sessionId: 's1', prompt: 'p', instanceRef: null, nowMs: T0 })
  const rows = listDeliveries('delivered', {
    nowMs: T0 + 60_000,
    lastActivity: () => T0 + 30_000,
    liveSince: () => null,
  })
  expect(rows.length).toBe(1)
})

test('deliverableDeliveries carries pending AND deaf - the composer reaches a deaf chat', () => {
  // Deaf was a dead end for send_message (queues into an engine that never started), but the
  // composer drives the APP, which runs the turn regardless - measured repeatedly. And a
  // just-surfaced chat goes deaf within a tick because its own import parks a phantom live
  // process, so delivering only 'pending' would strand the common case.
  stageDelivery({ sessionId: 'deaf-one', prompt: 'p', instanceRef: null, nowMs: T0 })
  reconcileDeliveries({
    nowMs: T0 + 60_000,
    lastActivity: () => T0 - 5_000,
    liveSince: () => T0 + 10_000,
  })
  stageDelivery({ sessionId: 'pending-one', prompt: 'p', instanceRef: null, nowMs: T0 + 70_000 })
  const rows = deliverableDeliveries({
    nowMs: T0 + 80_000,
    lastActivity: () => null,
    liveSince: () => null,
  })
  expect(rows.map((r) => r.session_id).sort()).toEqual(['deaf-one', 'pending-one'])
  expect(rows.find((r) => r.session_id === 'deaf-one')?.state).toBe('deaf')
})

test('deliverableDeliveries never carries a settled row', () => {
  stageDelivery({ sessionId: 'done-one', prompt: 'p', instanceRef: null, nowMs: T0 })
  reconcileDeliveries({ nowMs: T0 + 10_000, lastActivity: () => T0 + 5_000, liveSince: () => null })
  const rows = deliverableDeliveries({
    nowMs: T0 + 20_000,
    lastActivity: () => null,
    liveSince: () => null,
  })
  expect(rows.length).toBe(0)
})

test('settled rows are pruned past the retention window; OPEN rows never are', () => {
  const OLD = T0 - 40 * 24 * 3600 * 1000
  // Settled long ago -> pruned.
  stageDelivery({ sessionId: 'old-done', prompt: 'p', instanceRef: null, nowMs: OLD })
  reconcileDeliveries({
    nowMs: OLD + 10_000,
    lastActivity: () => OLD + 5_000,
    liveSince: () => null,
  })
  // Open and equally ancient -> KEPT, because an open row is work, not history.
  stageDelivery({ sessionId: 'old-open', prompt: 'p', instanceRef: null, nowMs: OLD })
  // Settled recently -> kept.
  stageDelivery({ sessionId: 'new-done', prompt: 'p', instanceRef: null, nowMs: T0 })
  reconcileDeliveries({ nowMs: T0 + 10_000, lastActivity: () => T0 + 5_000, liveSince: () => null })

  const removed = pruneDeliveries(T0)
  expect(removed).toBe(1)
  const left = db
    .query<{ session_id: string }, []>('select session_id from deliveries')
    .all()
    .map((r) => r.session_id)
    .sort()
  expect(left).toEqual(['new-done', 'old-open'])
})

test('a DEAF row ages out at 24h - deaf is a diagnosis, not a life sentence', () => {
  stageDelivery({
    sessionId: 's-deaf',
    prompt: 'resume please',
    instanceRef: 'desktop:C:/i1',
    nowMs: T0,
  })
  // A process started after staging but the transcript never moved: deaf.
  reconcileDeliveries({ nowMs: T0 + 1000, lastActivity: () => null, liveSince: () => T0 + 500 })
  expect(listDeliveries().find((r) => r.session_id === 's-deaf')?.state).toBe('deaf')
  // Still deaf a few hours later - nothing new to say, and nothing to expire yet.
  reconcileDeliveries({ nowMs: T0 + 3600_000, lastActivity: () => null, liveSince: () => null })
  expect(listDeliveries().find((r) => r.session_id === 's-deaf')?.state).toBe('deaf')
  // Past 24h it EXPIRES. Before the fix, reconcile `continue`d on 'deaf' before ever reaching the
  // expiry check, so a deaf row stayed open forever - and open rows are deliberately never pruned
  // AND are selected as deliverable, so the courier re-drove its UI every five minutes for good.
  reconcileDeliveries({
    nowMs: T0 + 25 * 3600_000,
    lastActivity: () => null,
    liveSince: () => null,
  })
  const row = listDeliveries().find((r) => r.session_id === 's-deaf')
  expect(row?.state).toBe('expired')
  expect(row?.evidence).toContain('deaf for 24h')
  expect(deliverableDeliveries().some((r) => r.session_id === 's-deaf')).toBe(false)
})

test('an expired deaf row can still be settled as delivered if the chat answers first', () => {
  stageDelivery({ sessionId: 's-late', prompt: 'resume', instanceRef: 'desktop:C:/i1', nowMs: T0 })
  reconcileDeliveries({ nowMs: T0 + 1000, lastActivity: () => null, liveSince: () => T0 + 500 })
  expect(listDeliveries().find((r) => r.session_id === 's-late')?.state).toBe('deaf')
  // The activity check runs BEFORE the deaf/expiry branch, so a late-starting engine still wins.
  reconcileDeliveries({
    nowMs: T0 + 30 * 3600_000,
    lastActivity: () => T0 + 20 * 3600_000,
    liveSince: () => null,
  })
  expect(listDeliveries().find((r) => r.session_id === 's-late')?.state).toBe('delivered')
})

test('the database waits for a lock instead of throwing - busy_timeout is set, not defaulted', () => {
  // SQLite's default busy_timeout is ZERO: a locked write throws SQLITE_BUSY instantly. Several
  // of this daemon's callers are bare timer ticks whose throw exits the process, and the tray
  // host is a second process on the same file, so the default is a crash waiting for contention.
  const row = db.query<{ timeout: number }, []>('pragma busy_timeout').get()
  expect(row?.timeout).toBeGreaterThanOrEqual(1000)
})

// ⛔ SUCCESS MUST FORGIVE THE BREAKER. The courier clears the failure count when IT delivers,
// but the LEDGER settles a row the moment the transcript moves - however that happened. So a
// delivery that provably worked used to leave the count standing, and the breaker kept refusing
// that chat for the rest of its 6h window. Measured live 2026-08-31: session 8bdb589d settled
// to 'delivered' at 02:21 and was still listed as suppressed until 07:54. The cosmetic harm is
// a suppressed lane full of rows that are not stuck; the real harm is a chat going dormant
// inside that window and the courier refusing to wake it - a chat sitting dead for hours while
// the machinery believes it is handled.
test('settling a row to DELIVERED clears the breaker for that chat', async () => {
  const { checkBreaker, noteAttempt, ATTEMPT_CAP } = await import('../src/breaker')
  const sid = 'sess-breaker-clear'
  db.query('delete from action_attempt_log where session_id = ?').run(sid)
  stageDelivery({ sessionId: sid, prompt: 'wake up', instanceRef: null, nowMs: T0 })
  for (let i = 0; i < ATTEMPT_CAP; i++) noteAttempt('deliver', sid, T0 + i)
  expect(checkBreaker('deliver', sid, T0 + 100).suppressed).toBe(true)

  reconcileDeliveries({
    nowMs: T0 + 1000,
    lastActivity: () => T0 + 500, // the transcript moved after staging: it landed
    liveSince: () => null,
  })
  expect(stateOf(sid)).toBe('delivered')
  expect(checkBreaker('deliver', sid, T0 + 1001).suppressed).toBe(false)
})

// DELIBERATE, NOT INCIDENTAL: only 'delivered' clears it. A DEAF row means a process started and
// the engine never drained the message - that is not evidence the channel works, and clearing on
// it would leave the breaker unable to brake the one thing it exists to brake.
test('settling a row to DEAF does NOT clear the breaker', async () => {
  const { checkBreaker, noteAttempt, ATTEMPT_CAP } = await import('../src/breaker')
  const sid = 'sess-breaker-deaf'
  db.query('delete from action_attempt_log where session_id = ?').run(sid)
  stageDelivery({ sessionId: sid, prompt: 'wake up', instanceRef: null, nowMs: T0 })
  for (let i = 0; i < ATTEMPT_CAP; i++) noteAttempt('deliver', sid, T0 + i)

  reconcileDeliveries({
    nowMs: T0 + 1000,
    lastActivity: () => null, // never moved
    liveSince: () => T0 + 500, // but a process did start
  })
  expect(stateOf(sid)).toBe('deaf')
  expect(checkBreaker('deliver', sid, T0 + 1001).suppressed).toBe(true)
})
