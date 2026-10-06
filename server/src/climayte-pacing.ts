// Machine-wide pacing of CLI launches (climayte-schedule startOn): at most LAUNCH_BURST new worker
// CLIs in any LAUNCH_WINDOW_MS, whichever path starts them (a dispatch, a resume after a restart, a
// move or handoff, a follow-up). A worker that finds no slot stays due and goes on a later tick.

/** Launches allowed per window. Measured 2026-10-06: 17 interrupted workers relaunched in one second
 *  after a PC restart put 18 claude.exe, 27 node and 57 conhost on the machine at once, and the
 *  desktop lagged for minutes; 3 at a time lets each CLI and its MCP servers settle first. */
export const LAUNCH_BURST = 3
/** The window those launches share (a sliding one: any 10 s holds at most LAUNCH_BURST). */
export const LAUNCH_WINDOW_MS = 10_000

let launches: number[] = []
// Off under `bun test` (NODE_ENV=test): suites that dispatch dozens of fake workers expect them to
// start at once. The pacing test turns it on.
let enabled = process.env.NODE_ENV !== 'test'

/** Test seam: pace launches (or not), and forget the ones counted so far. */
export function setLaunchPacing(on: boolean): void {
  enabled = on
  launches = []
}

/** Take a launch slot at `now`: false when LAUNCH_BURST launches already started inside the window. */
export function takeLaunchSlot(now: number): boolean {
  if (!enabled) return true
  launches = launches.filter((t) => t > now - LAUNCH_WINDOW_MS)
  if (launches.length >= LAUNCH_BURST) return false
  launches.push(now)
  return true
}

/** Forget every launch (a test's clean start). */
export function resetLaunchPacing(): void {
  launches = []
}
