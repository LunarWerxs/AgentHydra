// The auto-update orchestrator's decision logic, driven through injected hooks so nothing actually
// pulls git / spawns / exits. Gates applying strictly on updateAvailable && canApply, and only
// relaunches after a successful apply that reports restartRequired. Mirrors DevWebUI's
// tests/auto-update.test.ts, adapted for agenthydra's settings-table persistence.

import { afterEach, expect, test } from 'bun:test'
import {
  AUTO_UPDATE_INTERVAL_DEFAULT_S,
  AUTO_UPDATE_INTERVAL_MAX_S,
  AUTO_UPDATE_INTERVAL_MIN_S,
  autoUpdateEnabled,
  clampAutoUpdateInterval,
  getAutoUpdateIntervalSecs,
  lastUpdateCheck,
  recordUpdateCheck,
  runAutoUpdateOnce,
  runUpdateCheckOnce,
  setAutoUpdateEnabled,
  setAutoUpdateHooks,
  setAutoUpdateIntervalSecs,
  startAutoUpdate,
  stopAutoUpdate,
} from '../server/src/auto-update'
import type { UpdateApplyResult, UpdateStatus } from '../server/src/updater-engine.mjs'

// Reset the module's hooks + timer state after each case so they don't bleed across tests.
afterEach(() => {
  setAutoUpdateEnabled(false)
  stopAutoUpdate()
  setAutoUpdateHooks({}) // restore the real hooks
})

// A full UpdateStatus with sensible defaults; overrides tweak the fields under test.
function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    ok: true,
    service: 'agenthydra',
    currentVersion: '0.1.0',
    currentCommit: 'aaaa',
    remoteCommit: 'bbbb',
    branch: 'main',
    upstream: 'origin/main',
    remote: 'origin',
    dirty: false,
    updateAvailable: false,
    canApply: false,
    checkedAt: 0,
    reason: null,
    ...over,
  }
}
function applyResult(over: Partial<UpdateApplyResult> = {}): UpdateApplyResult {
  return {
    ok: true,
    message: 'updated',
    restartRequired: true,
    status: status({}),
    output: [],
    ...over,
  }
}

test('applies + relaunches when an update is available and applicable', async () => {
  let applied = 0
  let relaunched = 0
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++
      return applyResult({ restartRequired: true })
    },
    relaunch: () => {
      relaunched++
    },
  })
  const r = await runAutoUpdateOnce()
  expect(r.applied).toBe(true)
  expect(r.relaunched).toBe(true)
  expect(applied).toBe(1)
  expect(relaunched).toBe(1)
})

test('does nothing when already up to date', async () => {
  let applied = 0
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: false }),
    apply: async () => {
      applied++
      return applyResult({})
    },
    relaunch: () => {},
  })
  const r = await runAutoUpdateOnce()
  expect(r.applied).toBe(false)
  expect(r.reason).toBe('up-to-date')
  expect(applied).toBe(0)
})

test('never applies on a dirty tree (canApply false)', async () => {
  let applied = 0
  let relaunched = 0
  setAutoUpdateHooks({
    check: async () =>
      status({
        updateAvailable: true,
        canApply: false,
        dirty: true,
        reason: 'local changes must be committed or stashed before updating',
      }),
    apply: async () => {
      applied++
      return applyResult({})
    },
    relaunch: () => {
      relaunched++
    },
  })
  const r = await runAutoUpdateOnce()
  expect(r.applied).toBe(false)
  expect(applied).toBe(0)
  expect(relaunched).toBe(0)
})

test('defers (never applies) while dispatch runs are in flight', async () => {
  let applied = 0
  let relaunched = 0
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++
      return applyResult({})
    },
    relaunch: () => {
      relaunched++
    },
    hasActiveRuns: () => true, // a dispatch run is executing — do not relaunch the daemon under it
  })
  const r = await runAutoUpdateOnce()
  expect(r.applied).toBe(false)
  expect(r.reason).toBe('busy-runs')
  expect(applied).toBe(0)
  expect(relaunched).toBe(0)
})

test('does not relaunch when the apply fails', async () => {
  let relaunched = 0
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => applyResult({ ok: false, message: 'build failed' }),
    relaunch: () => {
      relaunched++
    },
  })
  const r = await runAutoUpdateOnce()
  expect(r.applied).toBe(false)
  expect(r.relaunched).toBe(false)
  expect(relaunched).toBe(0)
})

test('reports the reason when the check itself fails', async () => {
  setAutoUpdateHooks({
    check: async () => status({ ok: false, reason: 'no update remote configured' }),
    apply: async () => applyResult({}),
    relaunch: () => {},
  })
  const r = await runAutoUpdateOnce()
  expect(r.applied).toBe(false)
  expect(r.reason).toBe('no update remote configured')
})

test('a check that throws is reported, not propagated', async () => {
  setAutoUpdateHooks({
    check: async () => {
      throw new Error('network down')
    },
    apply: async () => applyResult({}),
    relaunch: () => {},
  })
  const r = await runAutoUpdateOnce()
  expect(r.checked).toBe(false)
  expect(r.applied).toBe(false)
  expect(r.reason).toBe('check-failed')
})

test('clampAutoUpdateInterval bounds the cadence', () => {
  expect(clampAutoUpdateInterval(10)).toBe(AUTO_UPDATE_INTERVAL_MIN_S)
  expect(clampAutoUpdateInterval(9_999_999)).toBe(AUTO_UPDATE_INTERVAL_MAX_S)
  expect(clampAutoUpdateInterval(Number.NaN)).toBe(AUTO_UPDATE_INTERVAL_DEFAULT_S)
  expect(clampAutoUpdateInterval(3600)).toBe(3600)
})

test('disabled by default, and setAutoUpdateEnabled/Interval persist + clamp live', () => {
  expect(autoUpdateEnabled()).toBe(false)
  setAutoUpdateEnabled(true)
  expect(autoUpdateEnabled()).toBe(true)
  const clamped = setAutoUpdateIntervalSecs(10)
  expect(clamped).toBe(AUTO_UPDATE_INTERVAL_MIN_S)
  expect(getAutoUpdateIntervalSecs()).toBe(AUTO_UPDATE_INTERVAL_MIN_S)
})

test('nothing is checked synchronously by startAutoUpdate', async () => {
  // The first tick is always one interval out, in BOTH modes: a cold boot must never spend a
  // network round trip it was not asked for, and must never be interrupted by an immediate
  // self-restart. (This used to assert "no timer is armed when disabled" — that is no longer true,
  // and was the bug: with auto-apply off, nothing ever checked. See runUpdateCheckOnce.)
  let checked = 0
  setAutoUpdateHooks({
    check: async () => {
      checked++
      return status({ updateAvailable: false })
    },
    apply: async () => applyResult({}),
    relaunch: () => {},
  })
  setAutoUpdateEnabled(false)
  startAutoUpdate()
  expect(checked).toBe(0)
  stopAutoUpdate()
})

test('with auto-apply OFF, a check still runs and records what it found', async () => {
  // The whole point of the notify half: someone ran an old build for weeks and was never told,
  // because `enabled` gated the check as well as the apply.
  let applied = 0
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true, remoteCommit: 'v9.9.9' }),
    apply: async () => {
      applied++
      return applyResult({})
    },
    relaunch: () => {},
  })
  setAutoUpdateEnabled(false)
  const r = await runUpdateCheckOnce()
  expect(r.ok).toBe(true)
  expect(r.updateAvailable).toBe(true)
  // Checking must never apply — applying restarts the daemon and is opt-in.
  expect(applied).toBe(0)
  expect(lastUpdateCheck()?.status.remoteCommit).toBe('v9.9.9')
})

test('a check performed elsewhere still feeds the passive hint', () => {
  // GET /api/update runs a REAL check (the Settings screen does it on open). Without recording it
  // here, Settings could say "an update is available" while the dot beside it stayed dark until the
  // background tick came round hours later — the hint must never be staler than what the app has
  // already been shown.
  recordUpdateCheck(status({ updateAvailable: true, remoteCommit: 'v1.2.3' }), 4242)
  expect(lastUpdateCheck()?.at).toBe(4242)
  expect(lastUpdateCheck()?.status.remoteCommit).toBe('v1.2.3')
})

test('a check-only pass reports a failed check without recording a false "up to date"', async () => {
  setAutoUpdateHooks({
    check: async () => {
      throw new Error('GitHub unreachable')
    },
    apply: async () => applyResult({}),
    relaunch: () => {},
  })
  const r = await runUpdateCheckOnce()
  expect(r.ok).toBe(false)
  expect(r.updateAvailable).toBe(false)
})
