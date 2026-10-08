import { describe, expect, it } from 'bun:test'
import type { FreeUsage } from '@desk/shared/free-instances'
import { freeCheckVerdict, freeUsageSnapshot } from './free-instances'

const reading = (windows: FreeUsage['windows']): FreeUsage => ({
  available: true,
  is_snapshot: false,
  observed_at: '2020-10-06T00:00:00Z',
  note: '',
  windows,
})
const win = (id: string, used: number | null, remaining: number | null) => ({
  id,
  used_percent: used,
  remaining_percent: remaining,
  resets_at: '2020-10-06T05:00:00Z',
  reset_passed: false,
})

const say = (key: string, p: Record<string, unknown> = {}) => `${key} ${JSON.stringify(p)}`

describe('the verdict of a Free check', () => {
  it('is alive with the usage left, dead when signed out, unknown when nothing answered', () => {
    const alive = freeCheckVerdict('Free 2', { ok: true, authenticated: true }, reading([win('five_hour', 30, null)]), '', say)
    expect(alive.state).toBe('alive')
    expect(alive.text).toContain('"left":70')
    const dead = freeCheckVerdict('Free 2', { ok: true, authenticated: false }, null, '', say)
    expect(dead.state).toBe('dead')
    const none = freeCheckVerdict('Free 2', null, null, 'timed out', say)
    expect(none.state).toBe('unknown')
    expect(none.reason).toBe('timed out')
    // A failed answer that never said "not signed in" is not proof the login is dead.
    expect(freeCheckVerdict('Free 2', { ok: false, error: { code: 'x', message: 'busy' } }, null, '', say).state).toBe('unknown')
  })
})

describe('a Free reading in the instance tables', () => {
  it('fills the 5h and Week cells from the harness windows', () => {
    const snap = freeUsageSnapshot(
      reading([win('seven_day_opus', 90, 10), win('seven_day', 40, 60), win('five_hour', null, 75)]),
    )
    expect(snap?.session?.pct).toBe(25)
    expect(snap?.weekAll?.pct).toBe(40)
    expect(snap?.weekAll?.resetsAt).toBe('2020-10-06T05:00:00Z')
    expect(snap?.capturedAt).toBe('2020-10-06T00:00:00Z')
  })

  it('offers a check instead of a number when no window has one', () => {
    expect(freeUsageSnapshot(null)).toBeNull()
    expect(freeUsageSnapshot(reading([win('five_hour', null, null)]))).toBeNull()
  })
})
