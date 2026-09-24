// server/src/core/running-code.ts — is this daemon running the code that is on disk?
//
// A SOURCE install runs whatever its checkout said when the daemon booted. Agents commit into that
// same checkout, updates get pulled by hand, and nothing restarts the daemon, so it goes on serving
// the old routes: a tool added since boot answers with the web app's catch-all HTML, and nothing
// anywhere says the daemon is simply old (seen 2026-09-20: a daemon up since the 19th, serving a
// checkout that had moved on). This compares the commit the daemon booted on with the one the
// checkout names now, and every surface that can say so does: /api/health, every MCP tool result,
// and the app's header.
//
// Git's own files are read directly (HEAD, the ref it names, packed-refs), so a check costs a few
// small reads and never a process; the answer is cached briefly because /api/health is polled.
// A compiled build has no checkout and is never "stale" here: it updates by replacing itself.

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const SHA = /^[0-9a-f]{40}$/

/** The .git directory for `root`: a real directory, or the `gitdir:` a worktree's .git file names. */
function gitDirOf(root: string): { gitDir: string; commonDir: string } | null {
  const dotGit = path.join(root, '.git')
  if (!existsSync(dotGit)) return null
  let gitDir = dotGit
  if (statSync(dotGit).isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
    if (!pointer) return null
    gitDir = path.resolve(root, pointer)
  }
  // A linked worktree keeps its own HEAD but shares refs with the main repository.
  const commonFile = path.join(gitDir, 'commondir')
  const commonDir = existsSync(commonFile)
    ? path.resolve(gitDir, readFileSync(commonFile, 'utf8').trim())
    : gitDir
  return { gitDir, commonDir }
}

/** The commit the checkout at `root` names right now, or null when it cannot be read. Never throws. */
export function readCheckoutCommit(root: string): string | null {
  try {
    const dirs = gitDirOf(root)
    if (!dirs) return null
    const head = readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf8').trim()
    if (SHA.test(head)) return head // detached
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim()
    if (!ref) return null
    for (const base of [dirs.gitDir, dirs.commonDir]) {
      const loose = path.join(base, ...ref.split('/'))
      if (existsSync(loose)) {
        const value = readFileSync(loose, 'utf8').trim()
        if (SHA.test(value)) return value
      }
    }
    const packed = path.join(dirs.commonDir, 'packed-refs')
    if (!existsSync(packed)) return null
    for (const line of readFileSync(packed, 'utf8').split(/\r?\n/)) {
      const [sha, name] = line.split(' ')
      if (name === ref && SHA.test(sha ?? '')) return sha ?? null
    }
    return null
  } catch {
    return null
  }
}

export interface RunningCodeStatus {
  /** The commit this daemon booted on; null for a compiled build or an unreadable checkout. */
  bootCommit: string | null
  /** The commit the checkout names now (at most `ttlMs` old). */
  diskCommit: string | null
  /** True only when both are known and differ: the daemon is serving older code than is on disk. */
  restartNeeded: boolean
}

/**
 * Record the commit at boot and answer "has the checkout moved since?" on demand. Call it once,
 * at startup. `readCommit` and `now` are injectable for tests.
 */
export function createRunningCodeProbe(opts: {
  root: string
  compiled: boolean
  ttlMs?: number
  readCommit?: (root: string) => string | null
  now?: () => number
}): { status: () => RunningCodeStatus } {
  const read = opts.readCommit ?? readCheckoutCommit
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? 10_000
  const bootCommit = opts.compiled ? null : read(opts.root)
  let cached: { at: number; value: RunningCodeStatus } | null = null
  return {
    status() {
      if (!bootCommit) return { bootCommit: null, diskCommit: null, restartNeeded: false }
      const at = now()
      if (cached && at - cached.at < ttl) return cached.value
      const diskCommit = read(opts.root)
      const value = {
        bootCommit,
        diskCommit,
        restartNeeded: diskCommit !== null && diskCommit !== bootCommit,
      }
      cached = { at, value }
      return value
    },
  }
}

/** The sentence every surface uses, so an agent and a person read the same thing. */
export function restartNeededMessage(status: RunningCodeStatus): string | null {
  if (!status.restartNeeded || !status.bootCommit || !status.diskCommit) return null
  return `This AgentHydra daemon is running older code than its folder (started on ${status.bootCommit.slice(0, 7)}, the folder is now at ${status.diskCommit.slice(0, 7)}). Tools and routes added since it started are missing until it restarts: POST /api/daemon/restart, or use Restart in the app header.`
}
