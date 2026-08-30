// tests/instance-health.test.ts — the one law this file must never break again:
// ⛔ CLOSED IS NOT UNUSABLE.
//
// A closed app is this fleet's RESTING STATE. Most of the 18 instances are closed at any moment,
// so the moment a closed instance can be called "unusable" for an ordinary reason, the unusable
// lane fills with accounts nobody was going to touch and the report becomes noise — which is
// precisely how a real orchestration pass came to tell the owner not to route work to closed
// instance #37, an instance that was never a candidate for work in the first place.
//
// The distinction being pinned is NOT "closed instances are invisible". It is:
//
//   DAMAGE persists and predicts a failed boot   -> report it even while closed
//   (signed-out / no-config / profile-unreadable)
//
//   A USAGE WALL is transient and self-healing   -> only meaningful about a RUNNING instance
//
// Get that backwards in either direction and something real breaks: suppress the login faults
// and a boot fails with no warning; report the usage wall and the lane cries wolf forever.

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HealthInput, RespondingMap } from '../server/src/instance-health'
import { healthOf, USAGE_WALL_PCT, unusableInstances } from '../server/src/instance-health'

/** A profile directory that reads as SIGNED IN, so the login branches stay out of the way and
 *  each test isolates the one signal it is actually about. */
function signedInDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-health-'))
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ lastKnownAccountUuid: '00000000-0000-4000-8000-000000000000' }),
  )
  return dir
}

function check(over: Partial<HealthInput>, responding: RespondingMap = new Map()) {
  const dir = signedInDir()
  try {
    const input: HealthInput = {
      ref: 'desktop:test',
      num: 37,
      instanceDir: dir,
      isRunning: false,
      ...over,
    }
    return healthOf(input, responding, over.isRunning ? 4242 : null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a CLOSED instance past the usage wall is not a fault', () => {
  const h = check({ isRunning: false, usagePct: 99 })
  expect(h.running).toBe(false)
  expect(h.unusable).toBeNull()
  // And therefore it never reaches the report's unusable lane.
  expect(unusableInstances([h])).toEqual([])
})

test('an OPEN instance past the usage wall IS a fault', () => {
  const h = check({ isRunning: true, usagePct: 99 })
  expect(h.unusable?.reason).toBe('usage-wall')
  expect(unusableInstances([h])).toHaveLength(1)
})

test('the wall is the threshold, not a rounding of it', () => {
  expect(check({ isRunning: true, usagePct: USAGE_WALL_PCT }).unusable?.reason).toBe('usage-wall')
  expect(check({ isRunning: true, usagePct: USAGE_WALL_PCT - 1 }).unusable).toBeNull()
})

test('unknown usage is never read as a wall', () => {
  expect(check({ isRunning: true, usagePct: null }).unusable).toBeNull()
  expect(check({ isRunning: true }).unusable).toBeNull()
})

test('DAMAGE is still reported while closed — it is why a later boot would fail', () => {
  const empty = mkdtempSync(join(tmpdir(), 'ah-health-nocfg-'))
  try {
    const h = healthOf(
      { ref: 'desktop:test', num: 1, instanceDir: empty, isRunning: false, usagePct: 10 },
      new Map(),
      null,
    )
    expect(h.running).toBe(false)
    expect(h.unusable?.reason).toBe('no-config')
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('a signed-out CLOSED instance is still reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-health-out-'))
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ someOtherKey: true }))
    const h = healthOf(
      { ref: 'desktop:test', num: 2, instanceDir: dir, isRunning: false, usagePct: 99 },
      new Map(),
      null,
    )
    // Signed-out wins over the (suppressed) wall, and survives being closed.
    expect(h.unusable?.reason).toBe('signed-out')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a wedged OPEN app outranks its usage wall — the actionable fault comes first', () => {
  const h = check({ isRunning: true, usagePct: 99 }, new Map([[4242, false]]))
  expect(h.unusable?.reason).toBe('not-responding')
})

test('responding stays NULL for a closed instance — never asked is not healthy', () => {
  expect(check({ isRunning: false, usagePct: 50 }).responding).toBeNull()
})
