// server/src/tray-invariant.ts - AgentHydra must never be running without a tray icon.
//
// OWNER RULE (Michael, 2026-09-07): "AgentHydra can never run unless it shows up in the status
// bar or whatever, AKA how it is right now, not running in the status bar. Not allowed."
//
// index.ts already calls startTrayHostIfMissing() at boot, so the daemon starts WITH an icon.
// The gap is that it was only ever a boot-time act: kill the tray afterwards and the daemon
// carries on headless forever, answering on 7787, accepting migrations and driving windows with
// nothing on screen to say it is alive or to stop it. That is precisely the state the owner found
// (and killed by hand) - a daemon he had already closed the app on, still serving, still able to
// move chats.
//
// So the invariant is CONTINUOUS, not initial. Every tick: if the icon is gone, try once to put
// it back; if it still is not there, the daemon shuts itself down. An invisible daemon is worse
// than no daemon - it acts on the machine with no handle to grab.
//
// ⛔ EVERY AMBIGUITY RESOLVES TOWARDS STAYING ALIVE. A probe that cannot answer reads as
// "running" (trayHostRunning already promises exactly this), a build with no tray toolkit is
// exempt rather than suicidal, and the deliberate hide_tray_icon setting is honoured instead of
// being overridden. Shutting down a daemon that was fine is a far worse failure than leaving one
// headless for another tick, so nothing here fires on a guess - only on two consecutive, positive
// "the icon is not there" answers with a restart attempt in between.

/** What one tick decided, so callers and tests can assert on a value rather than a side effect. */
export type TrayInvariantOutcome =
  | { action: 'ok'; reason: 'tray-running' }
  | { action: 'skip'; reason: 'not-compiled' | 'no-tray-toolkit' | 'tray-hidden-by-setting' }
  | { action: 'restarted'; reason: 'tray-was-missing' }
  | { action: 'shutdown'; reason: 'tray-missing-after-restart' }

export interface TrayInvariantDeps {
  /** Release builds only. A dev or test daemon must never shut itself down under the owner. */
  compiled: boolean
  /** False when this build ships no misc/ sidecar, so no icon could ever exist. Exempt. */
  hasTrayToolkit: boolean
  /** The person deliberately turned the icon off; honour it rather than fighting the feature. */
  hideTray: () => boolean
  /** tray-host.ts's probe. Unavailable reads as running - never shut down on a failed probe. */
  trayRunning: () => Promise<boolean>
  /** One attempt to put the icon back before giving up on this daemon. */
  restartTray: () => Promise<void>
  /** How long to let the tray appear after a restart attempt, before the second, deciding probe. */
  graceMs: number
  wait: (ms: number) => Promise<void>
  /** Tear the daemon down. Separated so a test can assert the decision without dying. */
  shutdown: (reason: string) => void
  log?: (msg: string) => void
}

/** One evaluation of the invariant. Pure apart from the injected effects, so the ordering above -
 *  cheap exemptions first, the process probe only when it could change the answer - is testable. */
export async function checkTrayInvariant(deps: TrayInvariantDeps): Promise<TrayInvariantOutcome> {
  if (!deps.compiled) return { action: 'skip', reason: 'not-compiled' }
  if (!deps.hasTrayToolkit) return { action: 'skip', reason: 'no-tray-toolkit' }
  if (deps.hideTray()) return { action: 'skip', reason: 'tray-hidden-by-setting' }

  if (await deps.trayRunning()) return { action: 'ok', reason: 'tray-running' }

  // Gone. One attempt to put it back before concluding anything - the icon dying is not by itself
  // a reason to kill a working daemon, and startTrayHostIfMissing is the same call boot makes.
  deps.log?.('[agenthydra] tray icon is gone - restarting it (owner rule: no icon, no daemon)')
  try {
    await deps.restartTray()
  } catch (e) {
    deps.log?.(`[agenthydra] tray restart threw: ${e instanceof Error ? e.message : String(e)}`)
  }
  await deps.wait(deps.graceMs)

  if (await deps.trayRunning()) return { action: 'restarted', reason: 'tray-was-missing' }

  deps.log?.(
    '[agenthydra] no tray icon after a restart attempt - shutting the daemon down. ' +
      'AgentHydra is not allowed to run without showing in the status bar (owner rule, 2026-09-07).',
  )
  deps.shutdown('tray-missing-after-restart')
  return { action: 'shutdown', reason: 'tray-missing-after-restart' }
}

/** Run the invariant on a timer until the returned stop() is called. `unref` keeps the interval
 *  from holding the process open on its own - this guard must never be the reason the daemon
 *  cannot exit. */
export function startTrayInvariant(
  deps: TrayInvariantDeps,
  everyMs = 30_000,
): { stop: () => void } {
  let running = false
  const tick = async () => {
    if (running) return // never overlap: the grace wait makes a tick outlast a short interval
    running = true
    try {
      await checkTrayInvariant(deps)
    } catch (e) {
      deps.log?.(`[agenthydra] tray invariant tick failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, everyMs)
  ;(timer as { unref?: () => void }).unref?.()
  return {
    stop: () => clearInterval(timer),
  }
}
