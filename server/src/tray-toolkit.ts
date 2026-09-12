// server/src/tray-toolkit.ts - make the tray host AVAILABLE to a single-file build.
//
// ⛔ THE DEFECT (owner, 2026-09-11, after running a fresh `bun run dist` build): "if we're not
// including a tray in that compiled executable, that's a [bug] - it needs to be fixed." He is
// right, and the code was treating it as a documented limitation instead: the compiled exe embeds
// every Vite asset but none of misc\, so `misc\lunarwerx-tray.exe` could not exist beside it,
// `startTrayHostIfMissing` skipped with 'no-tray-toolkit' FOREVER, and index.ts fired a toast
// telling the person to go download a different artifact. The app's most visible feature - its
// icon, its Quit, its auto-restart supervisor - was simply absent from the download that most
// people take, and nothing but a toast admitted it.
//
// THE FIX: the host is a 340 KB Win32 binary. Embed it (and its config and icon) in the compiled
// executable the same way the web assets are embedded, then write those three files out on first
// run and start the host from there. A build that ships the daemon now ships its tray.
//
// WHERE THEY GO, AND WHY NOT BESIDE THE EXE: a single-file exe is run from wherever it was
// downloaded - Downloads, a USB stick, Program Files - and those directories are variously
// read-only, synced, or shared with other users. The toolkit goes under the app's own state
// directory instead, in a VERSION-SCOPED folder, so an upgrade writes a fresh copy rather than
// trying to overwrite a running exe (Windows refuses that, and the refusal reads as a permissions
// error). The config is rewritten as it lands: its shipped `appRoot: ".."` is only correct for the
// zip layout, so the absolute directory of the RUNNING exe is stamped in, together with that exe's
// real filename - which is what lets the host's watchdog restart a daemon whose exe someone
// renamed.

import { TRAY_HOST_CONFIG, TRAY_HOST_EXE } from './tray-host.ts'

export const TRAY_ICON_FILE = 'AgentHydra.ico'

/** Every file the tray host needs to run. The build embeds exactly this list (enforced by
 *  scripts/checks/compiled-build-carries-the-tray.mjs, so a rename cannot silently drop one). */
export const TRAY_TOOLKIT_FILES = [TRAY_HOST_EXE, TRAY_HOST_CONFIG, TRAY_ICON_FILE] as const

/** Set by the generated release entrypoint (scripts/build.ts): filename -> embedded file path,
 *  readable with Bun.file(). Absent in every dev and test run, which is why this is a lookup and
 *  not an import. */
export const EMBEDDED_TRAY_GLOBAL = '__AGENTHYDRA_EMBEDDED_TRAY__'

export function embeddedTrayFiles(): Readonly<Record<string, string>> | null {
  const found = (globalThis as Record<string, unknown>)[EMBEDDED_TRAY_GLOBAL]
  if (!found || typeof found !== 'object') return null
  return found as Readonly<Record<string, string>>
}

/** Is this a toolkit, or only part of one? HALF A TOOLKIT IS NOT A TOOLKIT: a host with no config
 *  cannot start and a config with no host is a file. Owned here, in one place, because the map can
 *  arrive from the build's global OR be injected by a caller, and a rule enforced on only one of
 *  those paths is a rule that will be missing on the other (found by its own test, 2026-09-11). */
export function isCompleteTrayToolkit(
  embedded: Readonly<Record<string, string>> | null | undefined,
): embedded is Readonly<Record<string, string>> {
  if (!embedded) return false
  return TRAY_TOOLKIT_FILES.every(
    (name) => typeof embedded[name] === 'string' && embedded[name] !== '',
  )
}

/**
 * The tray config as it must land next to a materialized host: the shipped relative `appRoot`
 * ("..", correct only for the zip layout) replaced by the absolute directory of the running exe,
 * and `compiledExe` set to that exe's actual filename.
 *
 * Unparseable JSON is returned UNCHANGED rather than thrown: a tray that starts with a stale
 * appRoot still shows its icon and its menu, which is far better than a daemon that refuses to
 * boot because a sidecar file was malformed.
 */
export function patchTrayConfig(
  raw: string,
  opts: { appRoot: string; compiledExe: string },
): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    parsed.appRoot = opts.appRoot
    parsed.compiledExe = opts.compiledExe
    return `${JSON.stringify(parsed, null, 2)}\n`
  } catch {
    return raw
  }
}

export type TrayToolkitReason =
  | 'sidecar' // misc\ is there already (a source checkout, or an extracted zip)
  | 'materialized' // written out of the compiled binary just now
  | 'already-materialized' // written by an earlier run of this same version
  | 'not-windows'
  | 'not-compiled'
  | 'nothing-embedded'
  | 'write-failed'

export interface TrayToolkitResult {
  /** The directory holding a runnable tray host, or null when there is none. */
  dir: string | null
  reason: TrayToolkitReason
  /** Files written this run (empty when nothing had to be). */
  wrote: string[]
  /** Present only on 'write-failed': the error, for the log and the toast. */
  error?: string
}

export interface TrayToolkitDeps {
  appRoot: string
  compiled: boolean
  /** Where this app keeps its state; the toolkit lands in `<stateDir>/tray/<version>`. */
  stateDir: string
  version: string
  exePath: string
  platform?: string
  embedded?: Readonly<Record<string, string>> | null
  exists?: (path: string) => boolean
  sizeOf?: (path: string) => number | null
  readBytes?: (path: string) => Promise<Uint8Array>
  readText?: (path: string) => Promise<string>
  writeBytes?: (path: string, bytes: Uint8Array) => Promise<void>
  writeText?: (path: string, text: string) => Promise<void>
  mkdir?: (path: string) => void
  joinPath?: (...parts: string[]) => string
  dirOf?: (path: string) => string
  baseOf?: (path: string) => string
}

/**
 * Ensure a runnable tray host exists, and say where it is.
 *
 * Called once at boot, before startTrayHostIfMissing. Never throws - every failure is a reason
 * string, because a tray icon is worth a toast, never a daemon that will not start.
 */
export async function materializeTrayToolkit(deps: TrayToolkitDeps): Promise<TrayToolkitResult> {
  const platform = deps.platform ?? process.platform
  // The host is a Win32 program (Shell_NotifyIconW). Nothing to place anywhere else.
  if (platform !== 'win32') return { dir: null, reason: 'not-windows', wrote: [] }

  const path = await import('node:path')
  const fs = await import('node:fs')
  const join = deps.joinPath ?? path.join
  const dirname = deps.dirOf ?? path.dirname
  const basename = deps.baseOf ?? path.basename
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p))
  const sizeOf =
    deps.sizeOf ??
    ((p: string) => {
      try {
        return fs.statSync(p).size
      } catch {
        return null
      }
    })

  // 1. A real misc\ beside the app wins: that is the source checkout and the extracted zip, where
  //    the files are the ones the build shipped and a rewrite would be meddling.
  const sidecar = join(deps.appRoot, 'misc')
  if (exists(join(sidecar, TRAY_HOST_EXE)) && exists(join(sidecar, TRAY_HOST_CONFIG)))
    return { dir: sidecar, reason: 'sidecar', wrote: [] }

  // 2. Only a compiled build carries embedded copies; a dev run with no misc\ has nothing to place.
  if (!deps.compiled) return { dir: null, reason: 'not-compiled', wrote: [] }
  const embedded = deps.embedded !== undefined ? deps.embedded : embeddedTrayFiles()
  if (!isCompleteTrayToolkit(embedded)) return { dir: null, reason: 'nothing-embedded', wrote: [] }

  const readBytes =
    deps.readBytes ?? (async (p: string) => new Uint8Array(await Bun.file(p).arrayBuffer()))
  const readText = deps.readText ?? ((p: string) => Bun.file(p).text())
  const writeBytes =
    deps.writeBytes ?? (async (p: string, b: Uint8Array) => void (await Bun.write(p, b)))
  const writeText = deps.writeText ?? (async (p: string, t: string) => void (await Bun.write(p, t)))
  const mkdir = deps.mkdir ?? ((p: string) => void fs.mkdirSync(p, { recursive: true }))

  // VERSION-SCOPED: an upgrade writes a new folder instead of overwriting an exe that the previous
  // version's host may still be running - Windows cannot unlink a running image, and the EACCES it
  // raises reads as a permissions problem that isn't one.
  const dir = join(deps.stateDir, 'tray', deps.version)
  const wrote: string[] = []
  try {
    mkdir(dir)
    for (const name of [TRAY_HOST_EXE, TRAY_ICON_FILE]) {
      const from = embedded[name]
      if (!from) continue
      const to = join(dir, name)
      const bytes = await readBytes(from)
      // Same version, same size: already placed by an earlier run. Rewriting it would risk the
      // lock on a host that is running right now for no gain.
      if (exists(to) && sizeOf(to) === bytes.byteLength) continue
      await writeBytes(to, bytes)
      wrote.push(name)
    }
    // The config is rewritten whenever its content would differ, because the exe can MOVE between
    // runs (a single-file download lives wherever it was dropped) and appRoot must follow it.
    const configSource = embedded[TRAY_HOST_CONFIG]
    if (configSource) {
      const to = join(dir, TRAY_HOST_CONFIG)
      const want = patchTrayConfig(await readText(configSource), {
        appRoot: dirname(deps.exePath),
        compiledExe: basename(deps.exePath),
      })
      const have = exists(to) ? await readText(to).catch(() => null) : null
      if (have !== want) {
        await writeText(to, want)
        wrote.push(TRAY_HOST_CONFIG)
      }
    }
  } catch (error) {
    // A write that failed on a file already there is survivable - use what is on disk. Anything
    // else leaves no runnable host, and the caller says so out loud.
    const exe = join(dir, TRAY_HOST_EXE)
    const config = join(dir, TRAY_HOST_CONFIG)
    if (exists(exe) && exists(config))
      return { dir, reason: 'already-materialized', wrote, error: String(error) }
    return { dir: null, reason: 'write-failed', wrote, error: String(error) }
  }
  return { dir, reason: wrote.length > 0 ? 'materialized' : 'already-materialized', wrote }
}
