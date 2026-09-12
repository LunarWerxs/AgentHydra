// server/src/tray-host.ts - AgentHydra's binding to the SHARED tray bootstrap.
//
// THE FIELD FAILURE THIS ANSWERS (owner's PC, 2026-09-03): a release ZIP, extracted, misc\ intact,
// lunarwerx-tray.exe sitting right beside the daemon - and no tray icon, ever. The daemon had been
// started by double-clicking AgentHydra.exe, which is what the release notes say to do and what
// install.ps1's Start Menu shortcut did too. The exe runs the daemon and opens the UI; the tray
// icon, the auto-restart supervisor and Quit all live in the tray HOST, and nothing in that launch
// path started it. So the daemon starts it itself. The host was designed for this direction: with
// `onStrayDaemon: "attach"` (the shipped default) a host that finds a daemon already serving
// attaches to it instead of spawning a second one, and it claims a named mutex first, so even a
// race with a person double-clicking the shortcut cannot produce two icons.
//
// ⛔ AND IT NEVER ONCE FIRED (found 2026-09-11). The "is a host already running?" probe answered
// TRUE precisely when no host existed - see tray-bootstrap.mjs for the PowerShell exit-code trap
// behind that. Both the mechanism and that fix now live in the kit lib, shared by every app that
// ships this host; THIS file is only AgentHydra's names and the one default that is genuinely
// app-specific (below).

export {
  parseTrayHostCount,
  TRAY_HOST_EXE,
  type TrayHostDecision,
  type TrayHostSkipReason,
  trayHostDecision,
  trayHostProcessState,
} from './tray-bootstrap.mjs'

import {
  type StartTrayHostDeps,
  startTrayHostIfMissing as startShared,
  type TrayHostDecision,
  trayHostProcessState,
} from './tray-bootstrap.mjs'

export const TRAY_HOST_CONFIG = 'AgentHydra-Tray.json'

/** The tray-INVARIANT's view of the probe: an unknown reads as RUNNING. That invariant can shut
 *  the daemon down, so every ambiguity there must resolve towards staying alive - the opposite of
 *  the start path, where an unknown means "start it" because a named mutex makes a double start
 *  harmless. Two callers, two defaults, one honest tri-state underneath (tray-invariant.ts). */
export async function trayHostRunning(): Promise<boolean> {
  return (await trayHostProcessState()) ?? true
}

/** Start the tray host if nothing else has. `toolkitDir` is where a materialized copy landed (a
 *  single-file build writes one out of its own binary at boot); without one this looks in
 *  `<appRoot>/misc`, which is the source checkout and the extracted zip. */
export async function startTrayHostIfMissing(
  deps: Omit<StartTrayHostDeps, 'configFile'>,
): Promise<TrayHostDecision & { exe: string }> {
  return startShared({ ...deps, configFile: TRAY_HOST_CONFIG })
}
