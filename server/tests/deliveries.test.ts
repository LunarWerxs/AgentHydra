// server/tests/deliveries.test.ts - the delivery ledger pinned: one pending row per session,
// evidence-settled states (delivered / deaf / expired), and reconcile-before-read.
import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../src/db'
import {
  lastTranscriptMessageAt,
  listDeliveries,
  parseDeliveryState,
  pendingDeliveries,
  reconcileDeliveries,
  stageDelivery,
} from '../src/deliveries'

beforeEach(() => {
  db.query('delete from deliveries').run()
})

const T0 = Date.parse('2026-08-30T12:00:00Z')

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
