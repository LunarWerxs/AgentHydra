// server/src/tray-toolkit.ts - AgentHydra's binding to the SHARED tray bootstrap.
//
// ⛔ THE DEFECT (owner, 2026-09-11, on a build he had just made): "if we're not including a tray in
// that compiled executable, that's a [bug] - it needs to be fixed in this and probably a couple of
// the others." Both halves were true. The single-file exe embedded every Vite asset and nothing
// from misc\, so misc\lunarwerx-tray.exe could not exist beside it, startTrayHostIfMissing skipped
// with 'no-tray-toolkit' forever, the tray INVARIANT exempted the build entirely, and index.ts
// fired a toast telling the person to download a different artifact. And the same was true of
// RepoYeti, DevWebUI and ReDesign, each of which had written it into its README as a limitation.
//
// So the MECHANISM lives in the kit (lunarwerx-ui/src/server-lib/tray-bootstrap.mjs, vendored here
// as ./tray-bootstrap.mjs) and is shared by all four apps. THIS file is only what is AgentHydra's:
// the names of its config and icon, and the global its own release entrypoint writes.

import {
  isCompleteTrayToolkit as isCompleteToolkit,
  materializeTrayToolkit as materializeToolkit,
  patchTrayConfig as patchConfig,
  type TrayToolkitDeps as SharedToolkitDeps,
  type TrayToolkitReason,
  type TrayToolkitResult,
  trayToolkitFiles,
} from './tray-bootstrap.mjs'
import { TRAY_HOST_CONFIG } from './tray-host.ts'

export const TRAY_ICON_FILE = 'AgentHydra.ico'

/** Every file the tray host needs to run. The build embeds exactly this list (server/tests/
 *  tray-toolkit.test.ts fails if it stops), so a rename cannot silently drop one. */
export const TRAY_TOOLKIT_FILES = trayToolkitFiles({
  configFile: TRAY_HOST_CONFIG,
  iconFile: TRAY_ICON_FILE,
})

/** Set by the generated release entrypoint (scripts/build.ts): filename -> embedded file path,
 *  readable with Bun.file(). Absent in every dev and test run, which is why this is a lookup and
 *  not an import. */
export const EMBEDDED_TRAY_GLOBAL = '__AGENTHYDRA_EMBEDDED_TRAY__'

export function embeddedTrayFiles(): Readonly<Record<string, string>> | null {
  const found = (globalThis as Record<string, unknown>)[EMBEDDED_TRAY_GLOBAL]
  if (!found || typeof found !== 'object') return null
  return found as Readonly<Record<string, string>>
}

/** Half a toolkit is not a toolkit - the shared rule, applied to THIS app's file list. */
export function isCompleteTrayToolkit(
  embedded: Readonly<Record<string, string>> | null | undefined,
): boolean {
  return isCompleteToolkit(embedded, [...TRAY_TOOLKIT_FILES])
}

export const patchTrayConfig = patchConfig
export type { TrayToolkitReason, TrayToolkitResult }

/** What a caller has to supply; everything AgentHydra-specific is filled in below. */
export type TrayToolkitDeps = Omit<SharedToolkitDeps, 'configFile' | 'iconFile'>

/** Ensure a runnable tray host exists, and say where it is. Never throws - every failure is a
 *  reason string, because a tray icon is worth a toast and never a daemon that will not start. */
export async function materializeTrayToolkit(deps: TrayToolkitDeps): Promise<TrayToolkitResult> {
  return materializeToolkit({
    ...deps,
    configFile: TRAY_HOST_CONFIG,
    iconFile: TRAY_ICON_FILE,
    embedded: deps.embedded !== undefined ? deps.embedded : embeddedTrayFiles(),
  })
}
