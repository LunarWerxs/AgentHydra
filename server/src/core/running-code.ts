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
// small reads and never a process. A compiled build has no checkout and is never "stale" here: it
// updates by replacing itself.
//
// ⛔ ASYNC, AND NEVER ON THE HEALTH PATH (2026-09-27). /api/health reports this, and the tray
// watchdog kills a daemon whose /api/health misses three probes. The reads are small, but they are
// reads of the files git itself is rewriting: during a commit or push the synchronous version took
// 805 ms (profiled), inside the health handler. status() now answers from what it has and re-reads
// in the background.

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const SHA = /^[0-9a-f]{40}$/

/** A file's text, or null when it is not there. */
async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** The .git directory for `root`: a real directory, or the `gitdir:` a worktree's .git file names. */
async function gitDirOf(root: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const dotGit = path.join(root, '.git')
  const st = await stat(dotGit).catch(() => null)
  if (!st) return null
  let gitDir = dotGit
  if (st.isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec((await readText(dotGit)) ?? '')?.[1]?.trim()
    if (!pointer) return null
    gitDir = path.resolve(root, pointer)
  }
  // A linked worktree keeps its own HEAD but shares refs with the main repository.
  const common = await readText(path.join(gitDir, 'commondir'))
  const commonDir = common === null ? gitDir : path.resolve(gitDir, common.trim())
  return { gitDir, commonDir }
}

/** The commit the checkout at `root` names right now, or null when it cannot be read. Never rejects. */
export async function readCheckoutCommit(root: string): Promise<string | null> {
  try {
    const dirs = await gitDirOf(root)
    if (!dirs) return null
    const head = (await readText(path.join(dirs.gitDir, 'HEAD')))?.trim() ?? ''
    if (SHA.test(head)) return head // detached
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim()
    if (!ref) return null
    for (const base of [dirs.gitDir, dirs.commonDir]) {
      const value = (await readText(path.join(base, ...ref.split('/'))))?.trim()
      if (value && SHA.test(value)) return value
    }
    const packed = await readText(path.join(dirs.commonDir, 'packed-refs'))
    for (const line of packed?.split(/\r?\n/) ?? []) {
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
 *
 * status() never reads the disk itself: it returns the last answer and, once that is `ttlMs` old,
 * starts a re-read whose result the next call sees. Until the boot read lands the daemon reports
 * itself current, which a daemon that has just started is.
 */
export function createRunningCodeProbe(opts: {
  root: string
  compiled: boolean
  ttlMs?: number
  readCommit?: (root: string) => Promise<string | null>
  now?: () => number
}): { status: () => RunningCodeStatus } {
  const read = opts.readCommit ?? readCheckoutCommit
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? 10_000
  let bootCommit: string | null = null
  let value: RunningCodeStatus = { bootCommit: null, diskCommit: null, restartNeeded: false }
  let checkedAt = now()
  let reading: Promise<void> | null = null
  const reread = (apply: (commit: string | null) => void): void => {
    checkedAt = now()
    reading = read(opts.root)
      .then(apply, () => {})
      .finally(() => {
        reading = null
      })
  }
  if (!opts.compiled)
    reread((commit) => {
      bootCommit = commit
      if (commit) value = { bootCommit: commit, diskCommit: commit, restartNeeded: false }
    })
  return {
    status() {
      const boot = bootCommit
      // Compiled, unreadable at boot, or not read yet: never reported stale.
      if (!boot) return value
      if (!reading && now() - checkedAt >= ttl)
        reread((diskCommit) => {
          value = {
            bootCommit: boot,
            diskCommit,
            restartNeeded: diskCommit !== null && diskCommit !== boot,
          }
        })
      return value
    },
  }
}

/** The sentence every surface uses, so an agent and a person read the same thing. */
export function restartNeededMessage(status: RunningCodeStatus): string | null {
  if (!status.restartNeeded || !status.bootCommit || !status.diskCommit) return null
  return `This AgentHydra daemon is running older code than its folder (started on ${status.bootCommit.slice(0, 7)}, the folder is now at ${status.diskCommit.slice(0, 7)}). Tools and routes added since it started are missing until it restarts: POST /api/daemon/restart, or use Restart in the app header.`
}
