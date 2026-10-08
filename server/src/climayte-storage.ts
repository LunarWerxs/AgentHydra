// server/src/climayte-storage.ts — the storage pass: settled attempt logs packed, and what finished
// workers left (prompts, handoffs, signals, hooks, sealed folders) and old archives removed once
// their keep windows pass (planStorage, storagePass). packOldLogs in climayte.ts runs it. Split
// from climayte.ts on 2026-10-08; nothing here imports it.

import { readdirSync, rmSync, statSync } from 'node:fs'
import { stat as statAsync } from 'node:fs/promises'
import { join } from 'node:path'
import { HANDOFFS, HOOKS, isActive, PROMPTS, ROOT, SEALED, SIGNALS, workers } from './climayte-core'
import type { CliMayteWorker } from './climayte-lib'
import { readRunnerExit, readRunnerPids } from './climayte-runner'
import { runnerIdentity } from './climayte-stops'
import { mapPool } from './core/map-pool'
import { isPidAlive } from './core/process'

/** A settled attempt's log is packed once it is this old (packOldLogs). Measured 2026-10-03: zstd
 *  packs these 7-7.7x in ~21 ms per 9.7 MB, and 641 MB sat plain for a day. */
export const PACK_AFTER_MS = 10 * 60_000

/** One pass packs at most this much (~0.3 s of compression on the daemon's own loop); the first
 *  pass finds every log written so far. The rest follows a minute later. */
export const PACK_PASS_BYTES = 128 * 1024 * 1024

/** The pass runs this often once nothing is left over. */
export const PACK_EVERY_MS = 10 * 60_000

/** Logs packLog packed, or found gone (packed or archived before): a later pass never stats them
 *  again. Before, every pass stat'ed all ~5,900 attempts' logs, almost all long since packed. */
export const doneLogs = new Set<string>()

/** Every attempt log that is no longer there (packed or archived), into doneLogs: the stats run on
 *  the thread pool, so the first pass only meets the logs it has to pack. */
export async function findPackedLogs(): Promise<void> {
  const logs = [...workers.values()].flatMap((w) => w.attempts.map((a) => a.log))
  await mapPool(logs, 32, async (log) => {
    try {
      await statAsync(log)
    } catch {
      doneLogs.add(log)
    }
  })
}

/** The attempt's CLI can no longer append to its log. finish() ends an attempt only once its CLI
 *  has exited. A cancel does not wait: the kill is not confirmed, and killAttempts leaves a runner
 *  it cannot vouch for alone, so a cancelled attempt's log is settled only when its runner wrote
 *  its exit file or is gone. */
export function logSettled(at: CliMayteWorker['attempts'][number]): boolean {
  if (at.endedAt === null) return false
  if (at.outcome !== 'cancelled') return true
  if (!at.runner) return !(at.pid && isPidAlive(at.pid))
  if (readRunnerExit(at.runner.exitFile)) return true
  const pid = at.runner.pid ?? readRunnerPids(at.runner.pidFile)?.runner ?? null
  return pid === null || runnerIdentity(pid) === 'gone'
}

/** A finished worker's prompts, handoffs, signals and hook files are removed this long after its
 *  last attempt ended (the plan's piece 6: they had no cleanup, 35 MB on 2026-10-03). */
const FILES_KEEP_MS = 14 * 86_400_000

/** A removed task's archive folder (climayteRemove) is deleted this long after it was made. */
const ARCHIVE_KEEP_MS = 30 * 86_400_000

export interface StoragePlan {
  /** Plain logs the pass would pack (raw bytes). */
  pack: { path: string; bytes: number }[]
  /** Files and folders the pass would remove. */
  remove: { path: string; bytes: number }[]
}

function sizeOf(path: string): number {
  try {
    const st = statSync(path)
    if (!st.isDirectory()) return st.size
    return readdirSync(path).reduce((sum, n) => sum + sizeOf(join(path, n)), 0)
  } catch {
    return 0
  }
}

/** The logs of `w`'s attempts the storage pass would pack at `now`, onto `pack` (planStorage). */
function planPackFor(w: CliMayteWorker, now: number, pack: StoragePlan['pack']): void {
  for (const at of w.attempts) {
    if (!logSettled(at) || now - (at.endedAt as number) < PACK_AFTER_MS) continue
    try {
      const st = statSync(at.log)
      if (st.mtimeMs < now - PACK_AFTER_MS) pack.push({ path: at.log, bytes: st.size })
    } catch {
      // packed already, or archived
    }
  }
}

/** Whether a file last written at `mtimeMs` and named for worker `w` (undefined: no known worker)
 *  is past keeping at `now` (planStorage). */
function workerFilesExpired(w: CliMayteWorker | undefined, mtimeMs: number, now: number): boolean {
  if (!w) return now - mtimeMs > FILES_KEEP_MS
  if (isActive(w) || w.checkRunner || w.staleChecks?.length) return false
  if (w.attempts.some((a) => !logSettled(a) || a.runner?.killOnStart)) return false
  const last = Math.max(0, ...w.attempts.map((a) => a.endedAt ?? 0))
  return now - Math.max(last, mtimeMs) > FILES_KEEP_MS
}

/** The files in `dir` the storage pass would remove at `now`, onto `remove` (planStorage). `kept`
 *  holds, per worker id, whether its files are kept whatever their age, across every dir. */
function planDirRemovals(
  dir: string,
  byId: Map<string, CliMayteWorker>,
  kept: Map<string, boolean>,
  now: number,
  remove: StoragePlan['remove'],
): void {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const id = /^(w-[0-9a-f]+)/.exec(name)?.[1]
    if (!id) continue
    // A known worker that ended inside the keep window keeps its files whatever their age, so
    // they need no stat: ~7,000 a pass were (2026-10-08), nearly all of a live worker's.
    let keep = kept.get(id)
    if (keep === undefined) {
      const w = byId.get(id)
      keep = w !== undefined && !workerFilesExpired(w, 0, now)
      kept.set(id, keep)
    }
    if (keep) continue
    const path = join(dir, name)
    try {
      if (workerFilesExpired(byId.get(id), statSync(path).mtimeMs, now))
        remove.push({ path, bytes: sizeOf(path) })
    } catch {
      // gone meanwhile
    }
  }
}

/** What the storage pass would pack and remove for these workers at `now`; touches nothing. A
 *  worker that is active, being stopped, or has an attempt whose log is not settled keeps every
 *  file; a file named for no known worker goes by its own age. */
export function planStorage(
  list: Iterable<CliMayteWorker>,
  now: number,
  { withPack = true }: { withPack?: boolean } = {},
): StoragePlan {
  const plan: StoragePlan = { pack: [], remove: [] }
  const byId = new Map<string, CliMayteWorker>()
  for (const w of list) {
    byId.set(w.id, w)
    // The pack list is only reported (a dry run): the real pass packs in packOldLogs, so it skips
    // a stat of every attempt's log here.
    if (!withPack) continue
    planPackFor(w, now, plan.pack)
  }
  const kept = new Map<string, boolean>()
  for (const dir of [PROMPTS, HANDOFFS, SIGNALS, HOOKS, SEALED])
    planDirRemovals(dir, byId, kept, now, plan.remove)
  const archive = join(ROOT, 'archive')
  try {
    for (const name of readdirSync(archive)) {
      const path = join(archive, name)
      if (now - statSync(path).mtimeMs > ARCHIVE_KEEP_MS)
        plan.remove.push({ path, bytes: sizeOf(path) })
    }
  } catch {
    // no archive folder
  }
  return plan
}

/** Remove what planStorage lists (packing is packOldLogs's own loop). `dryRun` returns the plan
 *  and deletes nothing. */
export function storagePass(now: number, dryRun: boolean): StoragePlan {
  const plan = planStorage(workers.values(), now, { withPack: dryRun })
  if (!dryRun)
    for (const f of plan.remove)
      try {
        rmSync(f.path, { recursive: true, force: true })
      } catch (err) {
        console.error(`[climayte] could not remove ${f.path}:`, err)
      }
  return plan
}
