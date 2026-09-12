// server/src/misc-assets.ts - runtime files from misc\ that a SINGLE-FILE build still needs.
//
// ⛔ THE DEFECT, and it is the tray defect again (proved live 2026-09-12, on a chat that had just
// been migrated between accounts and could not be told to carry on). The compiled exe embeds every
// Vite asset and, since 2026-09-11, the tray toolkit - but nothing else from misc\. APP_ROOT for a
// compiled build is `dirname(process.execPath)`, so the delivery route looked for
// `<dist>\misc\Deliver-DesktopChat.ps1`, which the build never put there, and answered:
//
//     {"ok":false,"error":"delivery actuator missing at ...\\dist\\misc\\Deliver-DesktopChat.ps1"}
//
// That is not a degraded feature, it is a TOTAL one: the composer route IS that script, and the
// peer route is refused by the same endpoint before it ever picks a channel, so on a compiled
// install NO chat can be delivered to by any route - which also silently voids `move_chats
// --resume`, the one thing that makes a migrated chat continue working instead of landing dormant.
//
// The owner's ruling on the tray covers this exactly (2026-09-11): "if we're not including a tray
// in that compiled executable, that's a [bug] - it needs to be fixed in this and probably a couple
// of the others." This is one of the others. The shape is deliberately the tray's: the build
// embeds the named files or FAILS, and at runtime a real path is handed back - from misc\ when
// there is one (a source checkout, or a sidecar install), else written once out of the binary.
//
// ⛔ Do NOT "fix" this by copying misc\ next to the exe in the build. That was tried by hand the
// day this was found and it works, but it re-introduces the sidecar the single-file build exists
// to remove: an exe copied anywhere on its own would break again, silently, exactly as here.

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ROOT, DATA_DIR, IS_COMPILED, VERSION } from './config'

/** The delivery actuator: the PowerShell that drives a desktop chat's own composer. */
export const DELIVERY_ACTUATOR_FILE = 'Deliver-DesktopChat.ps1'

/**
 * Every file under misc\ that the RUNNING daemon opens by path.
 *
 * The build embeds exactly this list and fails when one is missing (scripts/build.ts), so adding a
 * runtime dependency on a misc\ file without adding it here cannot ship quietly - it is the same
 * contract the tray toolkit has, for the same reason.
 *
 * ⛔ misc\Instance-Launch.vbs is deliberately NOT here: instance-mode-shortcut.ts reads it only on
 * the `!IS_COMPILED` branch, so a compiled build never wants it. Embedding it would be weight with
 * no reader. If that guard ever goes, this list is where it belongs.
 */
export const RUNTIME_MISC_FILES = [DELIVERY_ACTUATOR_FILE] as const

/** Set by the generated release entrypoint (scripts/build.ts): filename -> embedded file path,
 *  readable with Bun.file(). Absent in every dev and test run, which is why this is a lookup and
 *  not an import - the same arrangement as EMBEDDED_TRAY_GLOBAL. */
export const EMBEDDED_MISC_GLOBAL = '__AGENTHYDRA_EMBEDDED_MISC__'

export function embeddedMiscFiles(): Readonly<Record<string, string>> | null {
  const found = (globalThis as Record<string, unknown>)[EMBEDDED_MISC_GLOBAL]
  if (!found || typeof found !== 'object') return null
  return found as Readonly<Record<string, string>>
}

/** Why a resolve answered the way it did - reported, never guessed at by the caller. */
export type MiscAssetReason =
  | 'on-disk' // found under APP_ROOT\misc - a source checkout or a sidecar install
  | 'materialized' // written out of the compiled binary just now
  | 'already-materialized' // written out of the binary by an earlier run
  | 'not-embedded' // compiled, but this build carries no copy: a build defect
  | 'missing' // not compiled and not on disk: a broken checkout

export type MiscAssetResult = {
  /** Absolute path to a real file, or null when there is nothing to run. */
  path: string | null
  reason: MiscAssetReason
  /** Present only on a failure, and written for the person who has to act on it. */
  error?: string
}

export type MiscAssetDeps = {
  appRoot?: string
  stateDir?: string
  version?: string
  compiled?: boolean
  embedded?: Readonly<Record<string, string>> | null
  exists?: (path: string) => boolean
  mkdir?: (path: string) => void
  copy?: (from: string, to: string) => Promise<void>
}

/**
 * A usable on-disk path for one misc\ file. Never throws: a caller that cannot deliver should say
 * why, not crash the daemon.
 *
 * Version-scoped like the tray's materialize, and for the same reason: an upgraded binary carrying
 * a changed script must not read the copy the previous version wrote.
 */
export async function resolveMiscAsset(
  name: string,
  deps: MiscAssetDeps = {},
): Promise<MiscAssetResult> {
  const appRoot = deps.appRoot ?? APP_ROOT
  const exists = deps.exists ?? existsSync
  const onDisk = join(appRoot, 'misc', name)
  // misc\ WINS when it is there. A source checkout must keep using its own working copy, and it
  // makes an edit to the script take effect without a rebuild.
  if (exists(onDisk)) return { path: onDisk, reason: 'on-disk' }

  const compiled = deps.compiled ?? IS_COMPILED
  if (!compiled)
    return {
      path: null,
      reason: 'missing',
      error:
        `${onDisk} is missing from this checkout. It is not a compiled build, so there is no ` +
        'embedded copy to fall back to - restore the file (the kit syncs misc\\, see lunarwerx-ui).',
    }

  const embedded = deps.embedded !== undefined ? deps.embedded : embeddedMiscFiles()
  const source = embedded?.[name]
  if (!source)
    return {
      path: null,
      reason: 'not-embedded',
      error:
        `this build carries no embedded copy of misc\\${name}, so it can never be run. That is a ` +
        'BUILD defect, not a configuration one: scripts/build.ts embeds RUNTIME_MISC_FILES and is ' +
        'supposed to fail when one is missing. Rebuild with `bun run dist`.',
    }

  const dir = join(deps.stateDir ?? DATA_DIR, 'misc', deps.version ?? VERSION)
  const to = join(dir, name)
  if (exists(to)) return { path: to, reason: 'already-materialized' }
  try {
    ;(deps.mkdir ?? ((p: string) => void mkdirSync(p, { recursive: true })))(dir)
    await (
      deps.copy ??
      (async (from: string, dest: string) => void (await Bun.write(dest, Bun.file(from))))
    )(source, to)
  } catch (error) {
    // A write that failed on a file already there is survivable - the tray learned this the hard
    // way, and two daemons racing the first delivery after an upgrade is the same shape.
    if (exists(to)) return { path: to, reason: 'already-materialized', error: String(error) }
    return {
      path: null,
      reason: 'not-embedded',
      error: `could not write ${to} out of the binary: ${String(error)}`,
    }
  }
  return { path: to, reason: 'materialized' }
}
