// Which folders a chat's cwd stands for when the store's workspaces.json is searched: the cwd itself, its git top
// folder, and, for a linked worktree, the main worktree (so a chat in a worktree sees its project's browsers).

import { dirname, isAbsolute, resolve } from 'node:path'

/** Slashes forward, no trailing slash, lower case: 'C:\Users\Me\Proj\' and 'c:/users/me/proj' are one folder. */
export function normalizePath(p: string): string {
  const s = p.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  return (s.length > 1 ? s.replace(/\/$/, '') : s).toLowerCase()
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', windowsHide: true })
    const out = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? out.trim() : null
  } catch {
    return null
  }
}

/** Normalized folders to look for, most specific first. */
export async function workspaceCandidates(cwd: string): Promise<string[]> {
  const out: string[] = [normalizePath(cwd)]
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (top) out.push(normalizePath(top))
  const common = await git(cwd, ['rev-parse', '--git-common-dir'])
  if (common) {
    const abs = isAbsolute(common) ? common : resolve(cwd, common)
    // The common dir of the main worktree is <main>/.git; a linked worktree's points back at it.
    if (/[\\/]\.git$/i.test(abs)) out.push(normalizePath(dirname(abs)))
  }
  return [...new Set(out)]
}
