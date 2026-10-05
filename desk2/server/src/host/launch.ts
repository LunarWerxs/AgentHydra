// Starting, finding and ending chat hosts (SPEC "Chat hosts").
//
// A host must not be a child of the server: a server restart, or launcher/stop.ps1's `taskkill /T`, would take
// it and the chat along. On Windows neither `detached` nor `.unref()` takes a child out of the parent's tree, so
// the start is handed to WMI (Win32_Process.Create, driven by a short-lived powershell), as AgentHydra's
// server/src/detached-spawn.mjs does: the host is born outside our tree, gets a hidden console, and inherits
// none of our handles (a child that inherits the server's listening socket keeps its port taken after the
// server is gone). WMI starts it with the user's default environment, so the chat's own environment travels in
// the spec file (the host deletes it once read). Elsewhere a detached spawn is a real detach.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostFile, HostSpec } from './protocol'

/** The host program. */
export const HOST_ENTRY = join(import.meta.dir, 'chat-host.ts')

export function hostsDir(home: string): string {
  return join(home, 'hosts')
}

export function hostFilePath(dir: string, chatId: string): string {
  return join(dir, `${chatId}.json`)
}

/** One argv element as a Windows command-line token (CommandLineToArgvW rules): WMI takes a single string. */
export function quoteWinArg(arg: string): string {
  if (arg.length > 0 && !/[ \t\n\v"]/.test(arg)) return arg
  let out = '"'
  for (let i = 0; i < arg.length; i++) {
    let slashes = 0
    while (i < arg.length && arg[i] === '\\') {
      slashes++
      i++
    }
    if (i === arg.length) {
      out += '\\'.repeat(slashes * 2) // a trailing run doubles, so the closing quote stays a quote
      break
    }
    if (arg[i] === '"') out += `${'\\'.repeat(slashes * 2 + 1)}"`
    else out += '\\'.repeat(slashes) + arg[i]
  }
  return `${out}"`
}

const psLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * The command that starts argv outside our process tree, hidden. Windows: a powershell asking WMI, with
 * Start-Process as the fallback when WMI refuses (a leaked handle beats a chat that never starts). Every
 * argument goes in as data: single-quoted for powershell, then quoted for CommandLineToArgvW.
 */
export function detachedCommand(platform: NodeJS.Platform, argv: string[]): { argv: string[]; detached: boolean } {
  if (platform !== 'win32') return { argv: [...argv], detached: true }
  const commandLine = argv.map(quoteWinArg).join(' ')
  const wmiArguments = `@{ CommandLine = ${psLiteral(commandLine)}; ProcessStartupInformation = (New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [UInt16]0 }) }`
  const rest = argv.slice(1).map((a) => psLiteral(quoteWinArg(a)))
  const startProcess = `Start-Process -FilePath ${psLiteral(argv[0]!)}${rest.length ? ` -ArgumentList @(${rest.join(', ')})` : ''} -WindowStyle Hidden`
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    '$rc = 1',
    `try { $rc = (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments ${wmiArguments}).ReturnValue } catch { $rc = 1 }`,
    `if ($rc -ne 0) { ${startProcess} }`,
    'exit 0',
  ].join('; ')
  return { argv: ['powershell', '-NoProfile', '-NonInteractive', '-Command', ps], detached: false }
}

function validHostFile(file: HostFile | null, chatId: string): HostFile | null {
  return file && file.chatId === chatId && typeof file.port === 'number' && typeof file.token === 'string' ? file : null
}

/** The host file of a chat, when one is there and readable. */
export function readHostFile(dir: string, chatId: string): HostFile | null {
  try {
    return validHostFile(JSON.parse(readFileSync(hostFilePath(dir, chatId), 'utf8')) as HostFile, chatId)
  } catch {
    return null
  }
}

/** readHostFile without blocking the loop: for a poll on a server that serves other requests. */
export async function readHostFileAsync(dir: string, chatId: string): Promise<HostFile | null> {
  try {
    return validHostFile(JSON.parse(await Bun.file(hostFilePath(dir, chatId)).text()) as HostFile, chatId)
  } catch {
    return null
  }
}

/** Writes a host's file whole (temp file + rename): a server never reads half of one. */
export function writeHostFile(dir: string, file: HostFile): void {
  mkdirSync(dir, { recursive: true })
  const path = hostFilePath(dir, file.chatId)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(file))
  renameSync(tmp, path)
}

/** Every host file in dir (live or left behind by a host that died). */
export function listHostFiles(dir: string): HostFile[] {
  if (!existsSync(dir)) return []
  const out: HostFile[] = []
  for (const name of readdirSync(dir)) {
    const m = /^(.+)\.json$/.exec(name)
    if (!m || name.endsWith('.spec.json')) continue
    const file = readHostFile(dir, m[1]!)
    if (file) out.push(file)
  }
  return out
}

/** True while a process with this pid exists. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Ends a host's process tree (the host and the Claude Code under it), when it will not end itself. */
export function killHostTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

export interface LaunchOptions {
  /** The bun that runs the host (default: the one running the server). */
  bun?: string
  timeoutMs?: number
  platform?: NodeJS.Platform
}

/** Writes the spec, starts the host and waits for its host file (the one naming our token). */
export async function launchHost(spec: HostSpec, o: LaunchOptions = {}): Promise<HostFile> {
  mkdirSync(spec.dir, { recursive: true })
  const specPath = join(spec.dir, `${spec.chatId}.spec.json`)
  const tmp = `${specPath}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(spec))
  renameSync(tmp, specPath)
  const plan = detachedCommand(o.platform ?? process.platform, [o.bun ?? process.execPath, HOST_ENTRY, '--spec', specPath])
  try {
    // The powershell itself is a console program: hidden. It exits once WMI has started the host.
    const child = spawn(plan.argv[0]!, plan.argv.slice(1), { stdio: 'ignore', windowsHide: true, detached: plan.detached })
    child.on('error', () => {}) // a failed start shows as no host file in time
    child.unref()
  } catch (err) {
    rmSync(specPath, { force: true })
    throw new Error(`could not start the chat process: ${(err as Error).message}`)
  }
  const deadline = Date.now() + (o.timeoutMs ?? 30_000)
  // Looked at every 50 ms at first, then more slowly: a cold start takes seconds.
  for (let tries = 0; Date.now() < deadline; tries++) {
    const file = await readHostFileAsync(spec.dir, spec.chatId)
    if (file?.token === spec.token) return file
    await Bun.sleep(Math.min(200, 50 + tries * 25))
  }
  // Never leave the chat's environment on disk.
  rmSync(specPath, { force: true })
  throw new Error(`the chat process did not start within ${Math.round((o.timeoutMs ?? 30_000) / 1000)} s (see ${join(spec.dir, `${spec.chatId}.host.log`)})`)
}
