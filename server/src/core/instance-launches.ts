// server/src/core/instance-launches.ts — when each desktop instance was last launched ON THIS PC.
//
// Two sources feed one timestamp per profile, and the later of the two always wins:
//  * AgentHydra's own Open, stamped the moment the process is spawned (openConfiguredInstance);
//  * any running instance the process scan sees, stamped with that process's OWN start time
//    (listInstances). That is what makes a launch from the Start menu, a taskbar pin or Claude's
//    own shortcut count as well: the Open button is not the only way a profile gets started, and a
//    column that only knew about its own clicks would quietly show a week-old date for an account
//    that was opened an hour ago.
//
// "On this PC" is literal. The file sits in AgentHydra's data dir, and its entries are grouped under
// this machine's host name as well, so a data dir carried between machines (a portable install, a
// synced home) never presents another PC's launch as one that happened here.
//
// Best-effort, exactly like instance-meta.ts: a missing or corrupt file reads as "never launched",
// a failed write never fails the list or the launch that triggered it, and the file is only
// rewritten when a timestamp actually moves forward, so the list's refresh timer costs no writes.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { appDataDir, instanceLaunchesFile, normalizeInstancePath } from './paths'

/** host name -> normalized profile dir -> last launch, epoch milliseconds. */
type LaunchFile = Record<string, Record<string, number>>

function thisMachine(): string {
  try {
    return os.hostname().trim().toLowerCase() || 'unknown-host'
  } catch {
    return 'unknown-host'
  }
}

function readFile(): LaunchFile {
  try {
    const file = instanceLaunchesFile()
    if (!existsSync(file)) return {}
    const raw = readFileSync(file, 'utf8')
    if (!raw?.trim()) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: LaunchFile = {}
    for (const [host, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue
      const kept: Record<string, number> = {}
      for (const [dir, at] of Object.entries(entries as Record<string, unknown>)) {
        if (typeof at === 'number' && Number.isFinite(at) && at > 0) kept[dir] = at
      }
      out[host] = kept
    }
    return out
  } catch {
    return {}
  }
}

function writeFile(data: LaunchFile): void {
  try {
    const dir = appDataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = instanceLaunchesFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, file)
  } catch {
    // Best-effort: the column simply shows the previous value until the next successful write.
  }
}

/** Every launch recorded on this machine, keyed by normalized profile dir. Never throws. */
export function readInstanceLaunches(): Record<string, number> {
  return readFile()[thisMachine()] ?? {}
}

/**
 * Record launches, keeping the LATER of what is stored and what is given for each dir. Anything that
 * is not a positive finite time, or not later than what is already recorded, is ignored, and the
 * file is written only if at least one entry moved. Returns this machine's resulting map.
 */
export function recordInstanceLaunches(
  launches: ReadonlyArray<{ dir: string; at: number }>,
): Record<string, number> {
  const data = readFile()
  const host = thisMachine()
  const mine = { ...(data[host] ?? {}) }
  let changed = false
  for (const { dir, at } of launches) {
    if (!dir || !Number.isFinite(at) || at <= 0) continue
    const key = normalizeInstancePath(dir)
    if ((mine[key] ?? 0) >= at) continue
    mine[key] = at
    changed = true
  }
  if (changed) writeFile({ ...data, [host]: mine })
  return mine
}

/** Forget a deleted profile on this machine, so a folder re-created later starts with no history. */
export function deleteInstanceLaunch(dir: string): void {
  const data = readFile()
  const host = thisMachine()
  const key = normalizeInstancePath(dir)
  if (!data[host] || !(key in data[host])) return
  const mine = { ...data[host] }
  delete mine[key]
  writeFile({ ...data, [host]: mine })
}
