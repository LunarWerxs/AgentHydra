// server/tests/deliveries.test.ts - the delivery ledger pinned: one pending row per session,
// evidence-settled states (delivered / deaf / expired), and reconcile-before-read.
import { beforeEach, expect, test } from 'bun:test'
import { db } from '../src/db'
import {
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

test('expiry with no transcript found says so - a vanished file is named, not blended in', () => {
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
  expect(row?.evidence).toContain('no transcript found at expiry')
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

test('listDeliveries reconciles before answering - a stale pending settles on read', () => {
  stageDelivery({ sessionId: 's1', prompt: 'p', instanceRef: null, nowMs: T0 })
  const rows = listDeliveries('delivered', {
    nowMs: T0 + 60_000,
    lastActivity: () => T0 + 30_000,
    liveSince: () => null,
  })
  expect(rows.length).toBe(1)
})
