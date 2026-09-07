// server/tests/tray-invariant.test.ts — AgentHydra must not run without a tray icon.
//
// OWNER RULE (2026-09-07): "AgentHydra can never run unless it shows up in the status bar ...
// Not allowed." startTrayHostIfMissing already ran at boot, but only at boot — kill the tray
// afterwards and the daemon served on happily with nothing on screen. Found in that exact state
// and killed by hand, on an app already closed.
//
// The half that matters most here is the RESTRAINT: a guard that shuts the daemon down must not
// fire on a guess. These pin every exemption and both probes.
import { expect, test } from 'bun:test'
import { checkTrayInvariant, type TrayInvariantDeps } from '../src/tray-invariant'

function deps(over: Partial<TrayInvariantDeps> = {}): TrayInvariantDeps & { killed: string[] } {
  const killed: string[] = []
  return {
    compiled: true,
    hasTrayToolkit: true,
    hideTray: () => false,
    trayRunning: async () => true,
    restartTray: async () => {},
    graceMs: 0,
    wait: async () => {},
    shutdown: (r) => {
      killed.push(r)
    },
    log: () => {},
    killed,
    ...over,
  }
}

test('tray present: nothing happens', async () => {
  const d = deps()
  expect((await checkTrayInvariant(d)).action).toBe('ok')
  expect(d.killed).toEqual([])
})

test('a dev or test daemon is never shut down by this guard', async () => {
  const d = deps({ compiled: false, trayRunning: async () => false })
  const r = await checkTrayInvariant(d)
  expect(r).toEqual({ action: 'skip', reason: 'not-compiled' })
  expect(d.killed).toEqual([])
})

test('a build with no tray toolkit is exempt, not suicidal', async () => {
  // The single-file .exe ships no misc/ sidecar, so no icon can ever exist. Enforcing the rule
  // there would make that build unrunnable rather than compliant.
  const d = deps({ hasTrayToolkit: false, trayRunning: async () => false })
  const r = await checkTrayInvariant(d)
  expect(r).toEqual({ action: 'skip', reason: 'no-tray-toolkit' })
  expect(d.killed).toEqual([])
})

test('hide_tray_icon is honoured, not overridden', async () => {
  // A person who deliberately turned the icon off has not broken the rule; fighting their own
  // setting would be this guard picking an argument with a feature.
  const d = deps({ hideTray: () => true, trayRunning: async () => false })
  const r = await checkTrayInvariant(d)
  expect(r).toEqual({ action: 'skip', reason: 'tray-hidden-by-setting' })
  expect(d.killed).toEqual([])
})

test('tray missing then restored: restarted, daemon lives', async () => {
  let calls = 0
  let restarted = false
  const d = deps({
    trayRunning: async () => ++calls > 1, // absent on the first probe, present after the restart
    restartTray: async () => {
      restarted = true
    },
  })
  const r = await checkTrayInvariant(d)
  expect(r).toEqual({ action: 'restarted', reason: 'tray-was-missing' })
  expect(restarted).toBe(true)
  expect(d.killed).toEqual([])
})

test('tray missing and unrecoverable: the daemon shuts itself down', async () => {
  const d = deps({ trayRunning: async () => false })
  const r = await checkTrayInvariant(d)
  expect(r).toEqual({ action: 'shutdown', reason: 'tray-missing-after-restart' })
  expect(d.killed).toEqual(['tray-missing-after-restart'])
})

test('a restart that throws still gets the second probe, and never crashes the tick', async () => {
  let calls = 0
  const d = deps({
    trayRunning: async () => ++calls > 1,
    restartTray: async () => {
      throw new Error('spawn failed')
    },
  })
  const r = await checkTrayInvariant(d)
  expect(r.action).toBe('restarted')
  expect(d.killed).toEqual([])
})

test('one missing probe is never enough on its own — the restart attempt sits between them', async () => {
  // Pins the ordering, not just the outcome: shutdown requires TWO positive "not there" answers
  // with an attempt to fix it in between. A single flaky probe must not kill a working daemon.
  const seen: string[] = []
  const d = deps({
    trayRunning: async () => {
      seen.push('probe')
      return false
    },
    restartTray: async () => {
      seen.push('restart')
    },
  })
  await checkTrayInvariant(d)
  expect(seen).toEqual(['probe', 'restart', 'probe'])
})
