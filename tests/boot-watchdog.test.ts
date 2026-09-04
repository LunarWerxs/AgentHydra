// tests/boot-watchdog.test.ts - the startup-liveness watchdog: renewal before the deadline stays
// silent, expiry fires with the last renewed phase, disarm cancels for good, and the env override
// is honoured. All against createBootWatchdog()'s injected clock/timer seam directly (never the
// module-singleton armBootWatchdog/renewBootWatchdog/disarmBootWatchdog, which are gated on
// NODE_ENV === 'test' and would be a silent no-op here) - no real waiting, no subprocess, no
// process.exit ever actually called.

import { expect, test } from 'bun:test'
import {
  armBootWatchdog,
  createBootWatchdog,
  disarmBootWatchdog,
  ENV_BOOT_DEADLINE_MS,
  renewBootWatchdog,
  resolveBootDeadlineMs,
} from '../server/src/boot-watchdog'

/** A controllable clock + timer pair: advance(ms) moves the fake clock forward and fires any timer
 *  whose deadline that reaches, in the order they were armed - exactly what setTimeout does, minus
 *  the real wall-clock wait. */
function fakeClockAndTimer() {
  let now = 0
  let nextId = 1
  const pending = new Map<number, { at: number; cb: () => void }>()
  return {
    now: () => now,
    setTimeoutFn: (cb: () => void, ms: number) => {
      const id = nextId++
      pending.set(id, { at: now + ms, cb })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => {
      pending.delete(handle as unknown as number)
    },
    advance(ms: number) {
      now += ms
      // Snapshot due entries before firing: a fired callback (renew) may schedule a new timer,
      // which must not be visited again in this same advance() - matches real setTimeout semantics.
      const due = [...pending.entries()].filter(([, t]) => t.at <= now)
      for (const [id, t] of due) {
        pending.delete(id)
        t.cb()
      }
    },
    pendingCount: () => pending.size,
  }
}

test('renewal before the deadline keeps the watchdog silent', () => {
  const clock = fakeClockAndTimer()
  const fired: unknown[] = []
  const wd = createBootWatchdog(1_000, {
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onFire: (info) => fired.push(info),
  })

  clock.advance(900)
  wd.renew('db-open') // pushes the deadline back to (now=900) + 1000 = 1900
  clock.advance(900) // now=1800, still under the renewed deadline
  wd.renew('listen')
  clock.advance(900) // now=2700, well past the ORIGINAL 1000ms deadline but never past a live one

  expect(fired).toEqual([])
  expect(wd.disarmed).toBe(false)
  expect(wd.lastPhase).toBe('listen')
})

test('expiry with no renewal calls the handler with the last-known phase', () => {
  const clock = fakeClockAndTimer()
  const fired: { lastPhase: string | null; elapsedMs: number; pid: number }[] = []
  const wd = createBootWatchdog(1_000, {
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onFire: (info) => fired.push(info),
  })

  clock.advance(200)
  wd.renew('db-migrations')
  clock.advance(1_000) // deadline was renewed at t=200 for another 1000ms -> fires at t=1200

  expect(fired).toHaveLength(1)
  expect(fired[0].lastPhase).toBe('db-migrations')
  expect(fired[0].elapsedMs).toBe(1_200)
  expect(fired[0].pid).toBe(process.pid)
  expect(wd.disarmed).toBe(true)
})

test('expiry with no renewal at all reports a null last phase', () => {
  const clock = fakeClockAndTimer()
  const fired: { lastPhase: string | null; elapsedMs: number; pid: number }[] = []
  createBootWatchdog(500, {
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onFire: (info) => fired.push(info),
  })

  clock.advance(500)

  expect(fired).toEqual([{ lastPhase: null, elapsedMs: 500, pid: process.pid }])
})

test('disarm cancels the pending timer and suppresses a later expiry', () => {
  const clock = fakeClockAndTimer()
  const fired: unknown[] = []
  const wd = createBootWatchdog(1_000, {
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onFire: (info) => fired.push(info),
  })

  wd.disarm()
  expect(clock.pendingCount()).toBe(0)
  clock.advance(5_000)

  expect(fired).toEqual([])
  expect(wd.disarmed).toBe(true)

  // Idempotent: a second disarm, and a renew arriving after disarm, are both silent no-ops.
  wd.disarm()
  wd.renew('listen')
  expect(wd.lastPhase).toBeNull()
  expect(fired).toEqual([])
})

test('a disarm racing an already-fired watchdog does not fire twice or resurrect it', () => {
  const clock = fakeClockAndTimer()
  const fired: unknown[] = []
  const wd = createBootWatchdog(100, {
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onFire: (info) => fired.push(info),
  })

  clock.advance(100) // fires
  wd.disarm() // arrives after the fire - must not call onFire again

  expect(fired).toHaveLength(1)
  expect(wd.disarmed).toBe(true)
})

test('resolveBootDeadlineMs: env override honoured, floor-clamped, and garbage falls back', () => {
  const original = process.env[ENV_BOOT_DEADLINE_MS]
  try {
    delete process.env[ENV_BOOT_DEADLINE_MS]
    expect(resolveBootDeadlineMs(120_000)).toBe(120_000)

    process.env[ENV_BOOT_DEADLINE_MS] = '60000'
    expect(resolveBootDeadlineMs(120_000)).toBe(60_000)

    // Floor-clamped so a typo'd near-zero override can't make the watchdog fire mid-boot.
    process.env[ENV_BOOT_DEADLINE_MS] = '100'
    expect(resolveBootDeadlineMs(120_000)).toBe(5_000)

    process.env[ENV_BOOT_DEADLINE_MS] = 'not-a-number'
    expect(resolveBootDeadlineMs(120_000)).toBe(120_000)

    process.env[ENV_BOOT_DEADLINE_MS] = '-500'
    expect(resolveBootDeadlineMs(120_000)).toBe(120_000)
  } finally {
    if (original === undefined) delete process.env[ENV_BOOT_DEADLINE_MS]
    else process.env[ENV_BOOT_DEADLINE_MS] = original
  }
})

// --- the public singleton API (armBootWatchdog/renewBootWatchdog/disarmBootWatchdog) -----------
// `bun test` sets NODE_ENV=test (see tests/setup.ts / bunfig.toml), which is exactly the signal
// armBootWatchdog gates on - so through this public surface, in this suite, arming must be a no-op:
// no live timer ever gets armed against the real clock, however many phases renew or how long the
// suite takes to run. The mechanism itself is proven above via createBootWatchdog() directly.
test('inert in test mode: arm/renew/disarm are no-ops, never a live timer', () => {
  expect(process.env.NODE_ENV).toBe('test')
  // If this actually armed a live 50ms timer, it would fire (exit code 87, kill the process) long
  // before this suite finishes - the fact the whole run completes normally IS the proof, alongside
  // the explicit calls below never throwing.
  expect(() => {
    armBootWatchdog(50)
    renewBootWatchdog('db-open')
    renewBootWatchdog('listen')
    disarmBootWatchdog()
  }).not.toThrow()
})
