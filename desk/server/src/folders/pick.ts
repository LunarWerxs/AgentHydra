// "Add new folder..." in the folder menu (SPEC "Folder picker"): Windows' own Select Folder dialog. A page
// cannot learn a folder's full path, so the server shows the dialog through pick-folder.cs, compiled on first
// use with the .NET Framework's csc.exe into <home>/bin/pick-folder-<hash of its source>.exe.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Opens the dialog, in `start` while Windows remembers no folder of its own for it; the folder chosen, null when cancelled. */
export type PickFolder = (start: string | null) => Promise<string | null>

/** The dialog could not be shown or failed; the message is the reason. */
export class PickError extends Error {}

const SOURCE = join(import.meta.dir, 'pick-folder.cs')
const MANIFEST = join(import.meta.dir, 'pick-folder.manifest')

/** The .NET Framework 4 C# compiler every Windows 10 and 11 ships with. */
function csc(): string | null {
  const windows = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  for (const framework of ['Framework64', 'Framework']) {
    const exe = join(windows, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe')
    if (existsSync(exe)) return exe
  }
  return null
}

type Proc = ReturnType<typeof Bun.spawn>

function run(cmd: string[], windowsHide: boolean): { proc: Proc; done: Promise<{ code: number; stdout: string; stderr: string }> } {
  let proc: Proc
  try {
    proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide })
  } catch (err) {
    throw new PickError(`could not start ${cmd[0]}: ${(err as Error).message}`)
  }
  const done = Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }))
  return { proc, done }
}

const builds = new Map<string, Promise<string>>()

/** The helper for the current source, compiled when missing; a new build removes the older ones. */
export function helperExe(home: string): Promise<string> {
  const hash = createHash('sha256').update(readFileSync(SOURCE)).update(readFileSync(MANIFEST)).digest('hex').slice(0, 12)
  const dir = join(home, 'bin')
  const exe = join(dir, `pick-folder-${hash}.exe`)
  if (existsSync(exe)) return Promise.resolve(exe)
  let build = builds.get(exe)
  if (!build) {
    build = compile(dir, exe).finally(() => builds.delete(exe))
    builds.set(exe, build)
  }
  return build
}

async function compile(dir: string, exe: string): Promise<string> {
  const compiler = csc()
  if (!compiler) throw new PickError('the folder dialog needs the .NET Framework 4 compiler (csc.exe), which this Windows lacks')
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `pick-folder-${randomUUID()}.tmp.exe`)
  const args = ['/nologo', '/noconfig', '/target:winexe', '/optimize+', `/win32manifest:${MANIFEST}`, `/out:${tmp}`, SOURCE]
  // csc is a console program: hidden, so no console window flashes.
  const { code, stdout, stderr } = await run([compiler, ...args], true).done
  if (code !== 0) {
    rmSync(tmp, { force: true })
    throw new PickError(`could not build the folder dialog: ${(stdout + stderr).trim() || `csc exited ${code}`}`)
  }
  renameSync(tmp, exe)
  for (const name of readdirSync(dir)) {
    if (!/^pick-folder-.+\.exe$/.test(name) || join(dir, name) === exe) continue
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // still open in a dialog: the next build removes it
    }
  }
  return exe
}

/**
 * The real dialog. One at a time: asking again while one is open closes that one (it answers null) and opens
 * a new one in front, so a dialog lost behind a window never blocks the menu.
 */
export function nativeFolderPicker(home: string): PickFolder {
  let open: { proc: Proc; replaced: boolean } | null = null
  return async (start) => {
    if (process.platform !== 'win32') throw new PickError('the folder dialog is only on Windows')
    const exe = await helperExe(home)
    if (open) {
      open.replaced = true
      open.proc.kill()
    }
    // Not hidden: windowsHide would turn the dialog's first ShowWindow into a hide. The helper has no console.
    const { proc, done } = run([exe, ...(start ? ['--start', start] : [])], false)
    const mine = { proc, replaced: false }
    open = mine
    try {
      const { code, stdout, stderr } = await done
      if (mine.replaced || code === 1) return null
      if (code === 0 && stdout) return stdout
      throw new PickError(stderr.trim() || `the folder dialog failed (exit ${code})`)
    } finally {
      if (open === mine) open = null
    }
  }
}
