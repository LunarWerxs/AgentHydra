// "Open in > File Explorer" (SPEC "REST API" POST /api/folders/reveal): shows a chat's folder in
// Explorer. The path must be an existing absolute folder on this machine and goes to explorer.exe as its
// one argument, never through a shell.

import { spawn } from 'node:child_process'
import { checkCwd, ChatError } from './chat-manager'

export type OpenFolder = (dir: string) => void

/** A UNC or device path (\\host\share, //host/share, \\?\..., \\.\..., \??\...). Merely checking whether one
 *  exists makes Windows open an SMB connection to whatever host it names. */
export function isRemotePath(path: string): boolean {
  return /^[\\/]{2}/.test(path) || /^[\\/]\?\?[\\/]/.test(path)
}

/** Refuses a network or device path with a 400, before anything on disk is touched. */
export function checkLocalPath(path: string, what: string): void {
  if (isRemotePath(path)) throw new ChatError(400, `${what} must be a folder on this machine, not a network or device path`)
}

/**
 * The folder as explorer.exe's command line needs it. Node quotes an argument only when it holds a space,
 * tab or quote, and explorer.exe splits its command line on commas, so C:\a,b would open the wrong
 * folder. Always quoted (a Windows path cannot hold a quote); a trailing backslash (a drive root) is
 * doubled so it does not escape the closing quote.
 */
export function explorerArg(dir: string): string {
  return `"${dir.replace(/\\$/, '\\\\')}"`
}

export function openInExplorer(dir: string): void {
  const child = spawn('explorer.exe', [explorerArg(dir)], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
  // Explorer exits 1 even when it opened the window; only a failed spawn is worth a line.
  child.on('error', (err) => console.warn(`[desk] could not open ${dir} in Explorer: ${err.message}`))
  child.unref()
}

/** The body's `path` as an existing absolute folder on this machine; else a 400 with the reason. */
export function localFolder(body: unknown): string {
  const path = body && typeof body === 'object' && !Array.isArray(body) ? (body as { path?: unknown }).path : undefined
  if (typeof path !== 'string' || !path.trim()) throw new ChatError(400, 'path is required')
  checkLocalPath(path, 'path')
  return checkCwd(path)
}

/** Validates the body's path and opens it; answers the folder opened. */
export function revealFolder(body: unknown, open: OpenFolder = openInExplorer): { path: string } {
  const dir = localFolder(body)
  open(dir)
  return { path: dir }
}
