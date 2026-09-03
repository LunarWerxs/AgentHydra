// server/src/automation-stamp-sweep.ts - keep every imported chat's bypassPermissions stamp true on
// disk, for as long as the daemon runs, so the app's next boot makes it permanent.
//
// THE BUG THIS CLOSES (owner, 2026-09-03: "migrate chats should open on bypass permission ... it
// just opens all of them on auto and then normal, so I have to go change all of them manually").
// The stamp itself is written correctly on every import (session-launch.ts applyDesktopChatAutomation,
// reached from importSessionToDesktop via stampImportedChat). What loses is TIME. The running app
// holds each chat's mode in memory as 'acceptEdits' and re-saves that over the disk stamp on the
// chat's first wake; the disk copy only enters app memory at the app's own boot. The convergence
// watcher that fights the re-save (reassertChatAutomation) is bounded to 10 minutes and 8 restores
// per import. A chat the owner opens eleven minutes after migrating it wakes, re-saves
// 'acceptEdits', and there is nothing left to correct it - so the file testifies to the wrong mode
// at the app's next restart too, and the chat is 'normal' for life. That is the reported symptom
// exactly, and it is why the 2026-08-28 fix (the stamp) did not make the symptom go away.
//
// The durable answer already existed and was called from nowhere but its own test:
// reassertAutomationStamps(profileDir) walks one instance's store and re-stamps every IMPORT-shaped
// chat (`local_<cliSessionId>.json`, the file shape only an import produces) whose mode has drifted.
// It never touches a chat created in the app, so a person's own deliberate mode choices are safe.
// Run on a timer over every RUNNING instance, it replaces N fire-and-forget watchers with one
// standing pass that survives however long the owner takes to open the chat, costs one directory
// walk per running profile per minute, and needs no registry because the file shape IS the mark.
//
// The short watcher stays: it converges within seconds during the window where a chat is most
// likely to be woken, and this sweep is the floor beneath it.

import { listInstances } from './core/instances'
import { reassertAutomationStamps } from './session-launch'

export const STAMP_SWEEP_MS = 60_000

export interface StampSweepDeps {
  /** Profile dirs whose desktop app is running right now. A closed app cannot re-save anything,
   *  so its store cannot drift; sweeping it would be a walk for nothing. */
  listRunningDirs: () => Promise<string[]>
  reassert: (profileDir: string) => number
  log?: (msg: string) => void
}

const defaultDeps: StampSweepDeps = {
  listRunningDirs: async () => (await listInstances()).filter((i) => i.isRunning).map((i) => i.dir),
  reassert: reassertAutomationStamps,
  log: (msg) => console.log(msg),
}

/** One pass. Per-profile failures are contained: an unreadable store says nothing about the
 *  others, and a tick that fails is a tick skipped, never a daemon down. Returns the total
 *  number of chats re-stamped, which is also what the log line says when it is not zero. */
export async function runAutomationStampSweepOnce(
  deps: StampSweepDeps = defaultDeps,
): Promise<number> {
  let total = 0
  let dirs: string[] = []
  try {
    dirs = await deps.listRunningDirs()
  } catch {
    return 0
  }
  for (const dir of dirs) {
    try {
      total += deps.reassert(dir)
    } catch {
      // this profile's store was contended or half-written; the next tick reads it again
    }
  }
  if (total > 0)
    deps.log?.(
      `[agenthydra] re-asserted bypassPermissions on ${total} imported chat(s) the app had re-saved`,
    )
  return total
}

let timer: ReturnType<typeof setInterval> | null = null

export function startAutomationStampSweep(): void {
  if (timer) return
  // Same shape as monitor.ts's timer, for the same reason: this process exits on an unhandled
  // rejection, so a repeating timer must not be able to let one escape.
  timer = setInterval(() => {
    runAutomationStampSweepOnce().catch((err) =>
      console.error('[agenthydra] automation stamp sweep error:', err),
    )
  }, STAMP_SWEEP_MS)
}

export function stopAutomationStampSweep(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
