// server/tests/instance-health.test.ts - the one answer to "can this instance be used, and if not
// why not?" pinned: closed is never a fault, unknown is never fine, a damaged profile is told
// apart from a signed-out one, and a wedged app is caught at all (it had no signal before).
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLoginState } from '../src/core/instances'
import {
  fleetHealth,
  healthOf,
  type RespondingMap,
  readRespondingMap,
  USAGE_WALL_PCT,
  unusableInstances,
} from '../src/instance-health'

/** An instance dir whose config.json holds exactly the given text (or none at all). */
function dir(config: string | null): string {
  const d = mkdtempSync(join(tmpdir(), 'agenthydra-health-'))
  mkdirSync(d, { recursive: true })
  if (config !== null) writeFileSync(join(d, 'config.json'), config)
  return d
}

const input = (instanceDir: string, over: Record<string, unknown> = {}) => ({
  ref: instanceDir,
  num: 7,
  instanceDir,
  isRunning: true,
  ...over,
})

test('signed in and answering: nothing to report', () => {
  const d = dir(JSON.stringify({ lastKnownAccountUuid: 'uuid-1' }))
  const h = healthOf(input(d), new Map([[42, true]]), 42)
  expect(h.unusable).toBe(null)
  expect(h.responding).toBe(true)
})

test('a DAMAGED profile is not a login problem, and says so', () => {
  // The distinction that did not exist: a half-written config.json read as "signed out", sending
  // the owner to fix a login that was never broken.
  const d = dir('{ this is not json')
  const h = healthOf(input(d), new Map(), null)
  expect(h.unusable?.reason).toBe('profile-unreadable')
  expect(h.unusable?.detail).toContain('signing in again will not fix it')
})

test('no config yet is its own state - a new instance is not a damaged one', () => {
  const h = healthOf(input(dir(null)), new Map(), null)
  expect(h.unusable?.reason).toBe('no-config')
})

test('signed out is still signed out', () => {
  const h = healthOf(input(dir(JSON.stringify({ other: 1 }))), new Map(), null)
  expect(h.unusable?.reason).toBe('signed-out')
})

test('A WEDGED APP IS CAUGHT - alive, signed in, and not answering', () => {
  // Before this module there was no signal at all: isRunning is a pid, and a hung Electron app
  // keeps its pid and its config.json, so it reported identically to a healthy one.
  const d = dir(JSON.stringify({ lastKnownAccountUuid: 'uuid-1' }))
  const h = healthOf(input(d), new Map([[42, false]]), 42)
  expect(h.unusable?.reason).toBe('not-responding')
  expect(h.unusable?.detail).toContain('wedged')
})

test('CLOSED IS NOT A FAULT - the resting state of this fleet is not an error', () => {
  const d = dir(JSON.stringify({ lastKnownAccountUuid: 'uuid-1' }))
  const h = healthOf(input(d, { isRunning: false }), new Map(), null)
  expect(h.unusable).toBe(null)
  expect(h.running).toBe(false)
  expect(h.responding).toBe(null)
})

test('UNKNOWN IS NEVER FINE AND NEVER BROKEN - an unasked probe is null, not false', () => {
  const d = dir(JSON.stringify({ lastKnownAccountUuid: 'uuid-1' }))
  const h = healthOf(input(d), new Map(), 42) // pid running, but the probe said nothing about it
  expect(h.responding).toBe(null)
  expect(h.unusable).toBe(null)
})

test('the usage wall is reported, but only after faults a person can actually fix', () => {
  const d = dir(JSON.stringify({ lastKnownAccountUuid: 'uuid-1' }))
  expect(
    healthOf(input(d, { usagePct: USAGE_WALL_PCT }), new Map([[1, true]]), 1).unusable?.reason,
  ).toBe('usage-wall')
  expect(healthOf(input(d, { usagePct: 80 }), new Map([[1, true]]), 1).unusable).toBe(null)
  // A wedged app that is ALSO near its cap is reported as wedged: restarting it is the act.
  expect(healthOf(input(d, { usagePct: 100 }), new Map([[1, false]]), 1).unusable?.reason).toBe(
    'not-responding',
  )
})

test('the fleet probe runs ONCE, not once per instance', () => {
  const d = dir(JSON.stringify({ lastKnownAccountUuid: 'uuid-1' }))
  let probes = 0
  const responding = (): RespondingMap => {
    probes++
    return new Map([
      [1, true],
      [2, false],
    ])
  }
  const all = fleetHealth(
    [
      { ...input(d), pid: 1 },
      { ...input(d), pid: 2 },
      { ...input(d, { isRunning: false }), pid: null },
    ],
    { responding },
  )
  expect(probes).toBe(1)
  expect(unusableInstances(all).map((h) => h.unusable?.reason)).toEqual(['not-responding'])
})

test('the responding probe parses pid/state pairs, and anything else is UNKNOWN', () => {
  const map = readRespondingMap(() => ({
    code: 0,
    out: '1234 True\r\n5678 False\r\n9999 Sometimes\r\ngarbage\r\n',
  }))
  if (process.platform !== 'win32') {
    expect(map.size).toBe(0) // no such probe off Windows; an empty map reads as "not asked"
    return
  }
  expect(map.get(1234)).toBe(true)
  expect(map.get(5678)).toBe(false)
  expect(map.get(9999)).toBe(null) // NOT false - a misparse must never condemn a healthy app
  expect(map.has(0)).toBe(false)
})

test('a probe that fails yields no opinion at all, rather than a fleet of broken apps', () => {
  expect(readRespondingMap(() => ({ code: 1, out: 'access denied' })).size).toBe(0)
  expect(
    readRespondingMap(() => {
      throw new Error('powershell is missing')
    }).size,
  ).toBe(0)
})

test('readLoginState keeps the uuid for the caller that only wants the uuid', () => {
  expect(readLoginState(dir(JSON.stringify({ lastKnownAccountUuid: 'u' }))).uuid).toBe('u')
  expect(readLoginState(dir('nope')).uuid).toBe(null)
  expect(readLoginState('').reason).toBe('unreadable')
})
