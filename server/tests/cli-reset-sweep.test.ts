import { describe, expect, test } from 'bun:test'
import { cliResetChecksDue } from '../src/core/cli-reset-sweep'
import type { CliLimitResetResult, UsageSnapshot } from '../src/types'

const NOW = Date.parse('2020-10-03T12:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN

const snap = (pct: number, ageMs: number): UsageSnapshot =>
  ({
    capturedAt: new Date(NOW - ageMs).toISOString(),
    session: { pct, resets: '', resetsAt: new Date(NOW + HOUR).toISOString() },
  }) as unknown as UsageSnapshot

const checkedAgo = (ms: number): CliLimitResetResult => ({
  ok: false,
  outcome: 'unavailable',
  message: '',
  nextAvailable: null,
  at: NOW - ms,
})

const cases: Array<{
  name: string
  inst?: { loggedIn?: boolean; movedAway?: { at: number; file: string } | null; last?: number }
  reading: UsageSnapshot | null
  due: boolean
}> = [
  { name: 'fresh reading under 90%, never checked', reading: snap(40, 5 * MIN), due: true },
  {
    name: 'fresh reading, last check over 24h ago',
    inst: { last: 25 * HOUR },
    reading: snap(89, 5 * MIN),
    due: true,
  },
  { name: 'at 90%', reading: snap(90, MIN), due: false },
  { name: 'at the limit', reading: snap(100, MIN), due: false },
  { name: 'no reading', reading: null, due: false },
  { name: 'reading older than 30 min', reading: snap(10, 31 * MIN), due: false },
  { name: 'signed out', inst: { loggedIn: false }, reading: snap(10, MIN), due: false },
  {
    name: 'moved away',
    inst: { movedAway: { at: NOW, file: 'x' } },
    reading: snap(10, MIN),
    due: false,
  },
  { name: 'checked under 24h ago', inst: { last: 23 * HOUR }, reading: snap(10, MIN), due: false },
]

describe('cliResetChecksDue', () => {
  test.each(cases)('$name', ({ inst, reading, due }) => {
    const i = {
      id: 'a',
      loggedIn: inst?.loggedIn ?? true,
      movedAway: inst?.movedAway ?? null,
      lastLimitReset: inst?.last === undefined ? null : checkedAgo(inst.last),
    }
    expect(cliResetChecksDue([i], () => reading, NOW)).toEqual(due ? ['a'] : [])
  })
})
