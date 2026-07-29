// Atomic cold-start claim for the lightweight instance daemon.
//
// Two Explorer double-clicks can arrive before either process binds or writes runtime.json. An
// exclusive lock file makes exactly one process the starter; contenders wait for its live pointer
// instead of racing Bun.serve and occasionally becoming the invisible loser.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { INSTANCE_MODE_CONFIG_DIR } from './instance-mode-instance'

export const INSTANCE_MODE_STARTUP_LOCK = join(INSTANCE_MODE_CONFIG_DIR, 'startup.lock')

interface LockRecord {
  pid: number
  token: string
  createdAt: number
}

export interface InstanceModeStartupLock {
  release(): void
}

export interface StartupLockOptions {
  lockPath?: string
  now?: () => number
  isProcessAlive?: (pid: number) => boolean
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readRecord(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockRecord>
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.token === 'string' &&
      typeof parsed.createdAt === 'number'
    )
      return parsed as LockRecord
  } catch {
    // Missing/corrupt is handled as a stale lock below.
  }
  return null
}

/** Try once to own quick-mode startup. Returns null while another live starter holds the claim.
 * A dead owner's file is removed immediately; an unreadable record gets a bounded 15-second lease
 * before it is considered stale. */
export function tryAcquireInstanceModeStartupLock(
  options: StartupLockOptions = {},
): InstanceModeStartupLock | null {
  const lockPath = options.lockPath ?? INSTANCE_MODE_STARTUP_LOCK
  const now = options.now ?? Date.now
  const isAlive = options.isProcessAlive ?? processAlive
  mkdirSync(dirname(lockPath), { recursive: true })

  const attempt = (): InstanceModeStartupLock | null => {
    const token = crypto.randomUUID()
    const record: LockRecord = { pid: process.pid, token, createdAt: now() }
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify(record))
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      const owner = readRecord(lockPath)
      let createdAt = owner?.createdAt ?? now()
      if (!owner) {
        try {
          createdAt = statSync(lockPath).mtimeMs
        } catch {
          // The file vanished between EEXIST and stat; reclaim it below.
          createdAt = 0
        }
      }
      const stale = owner === null ? now() - createdAt > 15_000 : !isAlive(owner.pid)
      if (!stale) return null
      try {
        unlinkSync(lockPath)
      } catch {
        return null
      }
      return attempt()
    }

    let released = false
    return {
      release() {
        if (released) return
        released = true
        try {
          const current = readRecord(lockPath)
          if (current?.pid === record.pid && current.token === token) unlinkSync(lockPath)
        } catch {
          // Best-effort. A stale lock is reclaimed on the next launch.
        }
      },
    }
  }

  return attempt()
}
