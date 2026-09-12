/**
 * Shared "this build HAS a tray, and it is running" primitive for the LunarWerx daemons.
 *
 * ⛔ WHY EVERY KIT APP NEEDS THIS (owner, 2026-09-11, on finding a freshly compiled AgentHydra with
 * no icon): "if we're not including a tray in that compiled executable, that's a [bug] - it needs to
 * be fixed in this and probably a couple of the others." He was right on both counts. Every kit app
 * ships `misc\lunarwerx-tray.exe` (340 KB, src/tray-host-native) and every kit app also builds a
 * SINGLE-FILE exe with `bun build --compile` that embeds the web assets and nothing else. So the
 * download most people take could never show an icon, never offer Quit, and never get the
 * auto-restart supervisor - and each app's README had simply written that down as a limitation.
 * 340 KB is not a reason to ship an app with no visible handle.
 *
 * This module is the whole mechanism, in one place, because it had already been re-derived once and
 * would have been re-derived three more times:
 *
 *   1. MATERIALIZE - write the embedded host, its config and its icon out of the compiled binary
 *      into `<stateDir>/tray/<version>`, rewriting the config's shipped `appRoot: ".."` (correct
 *      only for the extracted zip) to the absolute directory of the RUNNING exe, and `compiledExe`
 *      to that exe's real filename, so a renamed or relocated download still gets a watchdog.
 *      Version-scoped: Windows cannot overwrite a running image, and the EACCES it raises reads as
 *      a permissions problem that isn't one.
 *   2. PROBE - answer "is a host running?" as a TRI-STATE. ⛔ The first version of this asked
 *      `Get-Process -Name lunarwerx-tray -ErrorAction SilentlyContinue | Select -ExpandProperty Id`
 *      and read a non-zero exit as "running". SilentlyContinue suppresses the error TEXT, not the
 *      error RECORD: with no such process powershell.exe exits 1. Measured 2026-09-11: absent ->
 *      exit 1, present -> exit 0. The one case the probe exists for was the one it got backwards,
 *      so the daemon's own "start the tray if nothing else did" could never once have fired.
 *   3. START - launch the host when nothing else has. An UNKNOWN from the probe means START: the
 *      host claims a named mutex, so a double start cannot produce two icons (the loser opens the
 *      UI and exits), while NOT starting leaves the app with no icon at all. A caller that can
 *      SHUT THE DAEMON DOWN on the same signal (AgentHydra's tray invariant) must resolve the
 *      unknown the other way, which is exactly why this returns the unknown instead of choosing.
 *
 * Everything app-specific - the config filename, the icon filename, where the embedded files came
 * from - is a parameter. The host binary's name is not: it is the kit's own artifact.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** The kit's tray host binary, as it is named in every app's misc\ directory. */
export const TRAY_HOST_EXE = 'lunarwerx-tray.exe'

/** Every file a tray host needs to run, for an app that names its config and icon like this. */
export function trayToolkitFiles({ configFile, iconFile }) {
  return [TRAY_HOST_EXE, configFile, iconFile]
}

/**
 * Is this a toolkit, or only part of one? HALF A TOOLKIT IS NOT A TOOLKIT: a host with no config
 * cannot start, and a config with no host is a file. One owner for the rule, because the map can
 * come from the build's global OR be injected by a caller, and a rule enforced on only one of those
 * paths is a rule that is missing on the other.
 */
export function isCompleteTrayToolkit(embedded, files) {
  if (!embedded) return false
  return files.every((name) => typeof embedded[name] === 'string' && embedded[name] !== '')
}

/**
 * The tray config as it must land beside a materialized host: the shipped relative `appRoot`
 * replaced by the absolute directory of the running exe, and `compiledExe` set to that exe's actual
 * filename. Unparseable JSON comes back UNCHANGED rather than throwing - a tray with a stale
 * appRoot still shows its icon, while a daemon that refuses to boot over a malformed sidecar shows
 * nothing at all.
 */
export function patchTrayConfig(raw, { appRoot, compiledExe }) {
  try {
    const parsed = JSON.parse(raw)
    parsed.appRoot = appRoot
    parsed.compiledExe = compiledExe
    return `${JSON.stringify(parsed, null, 2)}\n`
  } catch {
    return raw
  }
}

/**
 * Ensure a runnable tray host exists, and say where it is. Never throws: every failure is a reason
 * string, because a tray icon is worth a toast and never a daemon that will not start.
 */
export async function materializeTrayToolkit(deps) {
  const platform = deps.platform ?? process.platform
  // The host is a Win32 program (Shell_NotifyIconW). There is nothing to place anywhere else.
  if (platform !== 'win32') return { dir: null, reason: 'not-windows', wrote: [] }

  const files = trayToolkitFiles({ configFile: deps.configFile, iconFile: deps.iconFile })
  const joinPath = deps.joinPath ?? join
  const dirOf = deps.dirOf ?? dirname
  const baseOf = deps.baseOf ?? basename
  const exists = deps.exists ?? ((p) => existsSync(p))
  const sizeOf =
    deps.sizeOf ??
    ((p) => {
      try {
        return statSync(p).size
      } catch {
        return null
      }
    })

  // 1. A real misc\ beside the app wins: the source checkout and the extracted zip, where the files
  //    are the ones the build shipped and rewriting them would be meddling.
  const sidecar = joinPath(deps.appRoot, 'misc')
  if (exists(joinPath(sidecar, TRAY_HOST_EXE)) && exists(joinPath(sidecar, deps.configFile)))
    return { dir: sidecar, reason: 'sidecar', wrote: [] }

  // 2. Only a compiled build carries embedded copies; a dev run with no misc\ has nothing to place.
  if (!deps.compiled) return { dir: null, reason: 'not-compiled', wrote: [] }
  if (!isCompleteTrayToolkit(deps.embedded, files))
    return { dir: null, reason: 'nothing-embedded', wrote: [] }

  const embedded = deps.embedded
  const readBytes =
    deps.readBytes ?? (async (p) => new Uint8Array(await Bun.file(p).arrayBuffer()))
  const readText = deps.readText ?? ((p) => Bun.file(p).text())
  const writeBytes = deps.writeBytes ?? (async (p, b) => void (await Bun.write(p, b)))
  const writeText = deps.writeText ?? (async (p, t) => void (await Bun.write(p, t)))
  const mkdir = deps.mkdir ?? ((p) => void mkdirSync(p, { recursive: true }))

  const dir = joinPath(deps.stateDir, 'tray', deps.version)
  const wrote = []
  try {
    mkdir(dir)
    for (const name of [TRAY_HOST_EXE, deps.iconFile]) {
      const from = embedded[name]
      if (!from) continue
      const to = joinPath(dir, name)
      const bytes = await readBytes(from)
      // Same version, same size: already placed by an earlier run. Rewriting risks the lock on a
      // host that is running right now, for no gain.
      if (exists(to) && sizeOf(to) === bytes.byteLength) continue
      await writeBytes(to, bytes)
      wrote.push(name)
    }
    // The config is rewritten whenever its content would differ, because a single-file exe MOVES
    // between runs - it lives wherever it was dropped - and appRoot has to follow it.
    const configSource = embedded[deps.configFile]
    if (configSource) {
      const to = joinPath(dir, deps.configFile)
      const want = patchTrayConfig(await readText(configSource), {
        appRoot: dirOf(deps.exePath),
        compiledExe: baseOf(deps.exePath),
      })
      const have = exists(to) ? await readText(to).catch(() => null) : null
      if (have !== want) {
        await writeText(to, want)
        wrote.push(deps.configFile)
      }
    }
  } catch (error) {
    // A write that failed on a file already there is survivable - use what is on disk. Anything
    // else leaves no runnable host, and the caller says so out loud.
    if (exists(joinPath(dir, TRAY_HOST_EXE)) && exists(joinPath(dir, deps.configFile)))
      return { dir, reason: 'already-materialized', wrote, error: String(error) }
    return { dir: null, reason: 'write-failed', wrote, error: String(error) }
  }
  return { dir, reason: wrote.length > 0 ? 'materialized' : 'already-materialized', wrote }
}

/**
 * The probe's stdout -> true / false / null. Separate and exported because it is the part that
 * rots: a count is a number, and an empty string or a PowerShell banner is NOT a zero.
 */
export function parseTrayHostCount(stdout) {
  const count = Number.parseInt(String(stdout).trim(), 10)
  return Number.isFinite(count) ? count > 0 : null
}

/**
 * Is a tray host process alive right now? `true` / `false` / `null` = could not tell. The count
 * below cannot raise an error record at all, which is the whole point (see this file's header).
 * PowerShell is a console program, hence windowsHide.
 */
export async function trayHostProcessState({ spawnProbe } = {}) {
  try {
    const name = TRAY_HOST_EXE.replace(/\.exe$/i, '')
    const run =
      spawnProbe ??
      (async (argv) => {
        const proc = Bun.spawn(argv, {
          windowsHide: true,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'ignore',
        })
        const out = await new Response(proc.stdout).text()
        await proc.exited
        return out
      })
    return parseTrayHostCount(
      await run([
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `@(Get-Process | Where-Object { $_.ProcessName -eq '${name}' }).Count`,
      ]),
    )
  } catch {
    return null
  }
}

/**
 * Should THIS daemon start the tray host? Order matters only for which reason is reported: the
 * cheapest, most structural facts first, the probe that costs a process spawn last.
 */
export function trayHostDecision(input) {
  if (input.platform !== 'win32') return { start: false, reason: 'not-windows' }
  // A source checkout is launched from its own shortcut, which IS the tray host. Starting it from
  // `bun run dev` would give every developer an icon they did not ask for.
  if (!input.compiled) return { start: false, reason: 'not-compiled' }
  // No runnable host anywhere: neither a misc\ sidecar nor a copy written out of the binary. That
  // is a FAULT to report, not the normal single-file case it used to be.
  if (!input.toolkitPresent) return { start: false, reason: 'no-tray-toolkit' }
  // "Hide tray icon" is the person saying no. Starting a host that immediately hides its icon would
  // still add a process they turned off on purpose.
  if (input.hideTray) return { start: false, reason: 'hidden-by-setting' }
  // The normal case after an auto-update relaunch: the host outlives the daemon it supervises.
  if (input.alreadyRunning) return { start: false, reason: 'already-running' }
  return { start: true }
}

/** Launch the host detached. It is a GUI program, so NO windowsHide here: libuv's hide flag sets
 *  SW_HIDE, which a GUI app obeys, and the host's own windows would never show while the spawn
 *  still reported success. The config argument is resolved by the host against ITS OWN exe
 *  directory, so the bare filename is exactly what a shortcut passes. */
function defaultSpawnHost(exe, cwd, configFile) {
  const child = spawn(exe, [configFile], { cwd, detached: true, stdio: 'ignore' })
  child.unref()
}

/**
 * Start the tray host if nothing else has. `toolkitDir` is where a materialized copy landed; without
 * one this looks in `<appRoot>/misc`, which is the source checkout and the extracted zip.
 */
export async function startTrayHostIfMissing(deps) {
  const toolkitDir = deps.toolkitDir || join(deps.appRoot, 'misc')
  const exe = join(toolkitDir, TRAY_HOST_EXE)
  const exists = deps.exists ?? existsSync
  const platform = deps.platform ?? process.platform
  // Cheap facts first, so the process probe only ever runs when it could change the answer.
  const structural = trayHostDecision({
    platform,
    compiled: deps.compiled,
    toolkitPresent: exists(exe) && exists(join(toolkitDir, deps.configFile)),
    hideTray: deps.hideTray(),
    alreadyRunning: false,
  })
  if (!structural.start) return { ...structural, exe }
  const decision = trayHostDecision({
    platform,
    compiled: deps.compiled,
    toolkitPresent: true,
    hideTray: false,
    // ⛔ An UNKNOWN starts it. See this file's header: a duplicate is impossible (named mutex),
    // while a skip leaves the app with no icon - which is the failure this module exists to prevent.
    alreadyRunning: (await (deps.isRunning ?? trayHostProcessState)()) ?? false,
  })
  if (decision.start) (deps.spawnHost ?? defaultSpawnHost)(exe, toolkitDir, deps.configFile)
  return { ...decision, exe }
}
