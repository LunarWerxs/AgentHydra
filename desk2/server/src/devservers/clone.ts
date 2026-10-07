// Git clone for "Clone a git repository" (ported from DevWebUI's projects/git-clone.ts). git is spawned with an argv
// array, never a shell string, so a URL cannot become a command; `--` keeps it from posing as a flag.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DevServerError } from './contract'
import { fileUrlToLocalPath } from './load'

const GIT_URL_RE = /^(https?:\/\/|git@[^:\s]+:|ssh:\/\/|git:\/\/)/i
const GIT_CLONE_TIMEOUT_MS = 600_000

/** A real scheme or scp-style host is required: a local path ending in .git still loads as a folder. */
export const looksLikeGitUrl = (s: string): boolean => GIT_URL_RE.test((s ?? '').trim())

export function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\.git\/?$/i, '').replace(/[/\\]+$/, '')
  const last = cleaned.split(/[/:\\]/).pop() || 'repo'
  return last.replace(/[^a-zA-Z0-9._-]/g, '-') || 'repo'
}

/** The parent of the most recent project's folder, else <home dir>/dev. `latestDir` is that project's folder. */
export function suggestCloneParent(latestDir: string | null): string {
  return latestDir ? path.dirname(latestDir) : path.join(os.homedir(), 'dev')
}

function execGit(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let err = ''
    let done = false
    let child: ReturnType<typeof spawn> | null = null
    const settle = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(
      () =>
        settle(() => {
          // git's transport helpers are its children: the tree goes, not just git.
          if (child?.pid) {
            try {
              if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
              else child.kill('SIGKILL')
            } catch {
              // already gone
            }
          }
          reject(new Error(`git timed out after ${Math.round(timeoutMs / 1000)}s`))
        }),
      timeoutMs
    )
    try {
      child = spawn('git', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr?.on('data', (d: Buffer) => {
        if (err.length < 1 << 16) err += d.toString()
      })
      child.on('error', (e) => settle(() => reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('git was not found on PATH: install Git to clone repositories.') : e)))
      child.on('close', (code) => settle(() => (code === 0 ? resolve() : reject(new Error(err.trim() || `git exited with code ${code}`)))))
    } catch (e) {
      settle(() => reject(e))
    }
  })
}

// Folders a clone is writing into now: a second clone into the same one would remove the first's work when it failed.
const cloning = new Set<string>()

/** Clones `url` into `destDir` itself (cloneDest's suggestion, `<parent>/<repo>`) and answers that folder. Throws
 * DevServerError 400 with a plain message. */
export async function cloneRepo(url: string, destDir: string, timeoutMs = GIT_CLONE_TIMEOUT_MS): Promise<string> {
  if (!looksLikeGitUrl(url)) throw new DevServerError("That doesn't look like a git URL.", 400)
  const dest = fileUrlToLocalPath((destDir ?? '').trim())
  if (!dest) throw new DevServerError('Choose a destination folder for the clone.', 400)
  const target = path.resolve(dest)
  const key = process.platform === 'win32' ? target.toLowerCase() : target
  if (cloning.has(key)) throw new DevServerError(`A clone into ${target} is already running.`, 400)
  const preexisting = existsSync(target)
  if (preexisting && readdirSync(target).length) throw new DevServerError(`${target} already exists and is not empty: pick another destination.`, 400)
  cloning.add(key)
  let started = false
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    started = true
    await execGit(['clone', '--', url.trim(), target], timeoutMs)
  } catch (e) {
    // A failed clone leaves a partial folder that would block the retry; never remove one that was there before.
    if (started && !preexisting) rmSync(target, { recursive: true, force: true })
    throw new DevServerError((e as Error).message, 400)
  } finally {
    cloning.delete(key)
  }
  return target
}
