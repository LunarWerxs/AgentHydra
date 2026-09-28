// server/src/desktop-install-lock.ts - one gate between updating the Claude install and copying it,
// and the line that says which of its builds are finished.
//
// Squirrel writes a new build straight into its final app-<build> folder, and a managed launch
// (claude-native-launch.ts) copies the NEWEST such folder. A launch that ran while AgentHydra's own
// update was writing could copy a half-written build. So the update runs inside
// whileDesktopInstallUpdates, and a managed launch awaits desktopInstallSettled before it picks a
// folder. With no update running, the wait is one already-resolved promise.
//
// The gate cannot cover an update that was killed mid-write (the tray tree-kills an unresponsive
// daemon, and Update.exe with it), which leaves a partial app-<build> folder behind. Squirrel
// rewrites packages\RELEASES only after every file of a build is in place, so a folder newer than
// the newest build RELEASES lists is unfinished: neither launched nor counted as installed. The next
// update finds it, deletes it ("Found partially applied release folder") and writes it again.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let tail: Promise<void> = Promise.resolve()

/** Run `work` once every earlier update has finished; the next one waits for this one. */
export function whileDesktopInstallUpdates<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work)
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Resolves once no AgentHydra-driven update of the Claude install is running. Never rejects. */
export function desktopInstallSettled(): Promise<void> {
  return tail
}

function compareBuild(a: string, b: string): number {
  const av = a.split('.').map(Number)
  const bv = b.split('.').map(Number)
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

/** The newest build the install's packages\RELEASES lists, or null when it cannot be read or lists
 *  none (then nothing is filtered: an install without the file behaves exactly as before). */
export function newestFinishedBuild(installRoot: string): string | null {
  let text: string
  try {
    text = readFileSync(join(installRoot, 'packages', 'RELEASES'), 'utf8')
  } catch {
    return null
  }
  let best: string | null = null
  for (const m of text.matchAll(/-(\d+(?:\.\d+)+)-(?:full|delta)\.nupkg/gi))
    if (best === null || compareBuild(m[1], best) > 0) best = m[1]
  return best
}

/** False for an app-<build> folder newer than the newest finished build: Squirrel is still writing
 *  it, or was killed while it did. */
export function isFinishedBuild(build: string, finished: string | null): boolean {
  return finished === null || compareBuild(build, finished) <= 0
}
