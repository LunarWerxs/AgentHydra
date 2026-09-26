// server/src/move-retire-on-close.ts - a moved chat's old copy that its RUNNING app would not
// archive, retired as soon as that app is closed.
//
// ⛔ A FLAG UNDER A RUNNING APP IS THE BUG THE OWNER REPORTED (2026-09-26: "They're still in the
// old one ... when I try to move them again ... it's like, oh, the chats are no longer there. But
// I'm literally in the account looking at them"). A running app lists its chats from memory, so a
// flag written under it hides nothing, while the store now says "archived" - and the next move from
// that account reads the store and answers "No chats to move". move-source-settle.ts asks the app
// first. When the app has no native control and its own Archive click does not settle the chat,
// the settle no longer writes the flag. It leaves the record as the screen shows it and queues it
// here. This sweep writes the flag once that app is no longer running, because a closed app reads
// its store at its next start. Until then the store and the sidebar agree, and a later move from
// that account still finds the chat.
//
// The queue is a small JSON file in the daemon's data dir, so a daemon restart keeps it. An entry
// is dropped without being acted on when:
//   · the chat lands on that account again, or is unarchived there, or a move finds it already
//     living there (keepChatOn: /migrate, /import-desktop, /desktop-archive, /keep-here),
//   · the record there is already archived (the owner archived it in the app),
//   · every other account was read and none shows the chat unarchived (it is the only visible
//     copy left), or
//   · it is older than RETIRE_MAX_AGE_MS.
// Anything it cannot read is not an answer: the entry waits for the next pass.
//
// ⛔ "CLOSED" IS A FRESH PROCESS SCAN THAT ANSWERED (review, 2026-09-26). listInstances falls back
// to an old snapshot, then to "nothing running", when a scan fails (core/process.ts says that
// fallback is for a listing, never a destructive guard). Read that way, a failed scan on a pinned
// box would flag the chat under the running app - the very write this file exists to avoid. So a
// failed scan skips the pass. The sweep also runs for a profile right before AgentHydra opens it,
// so a close and reopen inside one 60s tick is not missed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from './config'
import { setBeforeLaunchHook } from './core/instances'
import { scanClaudeProcesses } from './core/process'
import { pathKey, samePathKey } from './path-key'
import {
  archiveDesktopChat,
  cancelChatArchiveReassert,
  desktopProfileRoots,
  findChatMetaPath,
  findVisibleChatMetaPath,
} from './session-launch'

export const RETIRE_SWEEP_MS = 60_000
export const RETIRE_MAX_AGE_MS = 30 * 24 * 60 * 60_000

export interface RetireEntry {
  profile: string
  sessionId: string
  queuedAt: string
}

export interface RetireStore {
  load: () => RetireEntry[]
  save: (entries: RetireEntry[]) => void
}

/** The queue file at `path`. An unreadable or malformed file reads as empty, never as a throw. */
export function retireStoreAt(path: string): RetireStore {
  return {
    load: () => {
      try {
        if (!existsSync(path)) return []
        const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown }
        return Array.isArray(raw?.entries)
          ? raw.entries.filter(
              (e): e is RetireEntry =>
                typeof e?.profile === 'string' &&
                typeof e?.sessionId === 'string' &&
                typeof e?.queuedAt === 'string',
            )
          : []
      } catch {
        return []
      }
    },
    save: (entries) => {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify({ entries }, null, 2))
      renameSync(tmp, path)
    },
  }
}

let store: RetireStore = retireStoreAt(join(DATA_DIR, 'move-retire-on-close.json'))

/** Tests point the queue at a temp file. */
export function setRetireStoreForTests(next: RetireStore): void {
  store = next
}

const keyOf = (profile: string, sessionId: string) => `${pathKey(profile, true)}::${sessionId}`

/** Queue one old copy to be archived once its app is closed. A second queueing refreshes it. */
export function queueRetireOnClose(profile: string, sessionId: string, now = Date.now()): void {
  const key = keyOf(profile, sessionId)
  const rest = store.load().filter((e) => keyOf(e.profile, e.sessionId) !== key)
  store.save([...rest, { profile, sessionId, queuedAt: new Date(now).toISOString() }])
}

/** Call it off: the chat is landing on that account again. Says whether one was queued. */
export function dropRetireOnClose(profile: string, sessionId: string): boolean {
  const key = keyOf(profile, sessionId)
  const all = store.load()
  const rest = all.filter((e) => keyOf(e.profile, e.sessionId) !== key)
  if (rest.length === all.length) return false
  store.save(rest)
  return true
}

/**
 * The chat belongs on `profile` now: it is landing there, being unarchived there, or a move found
 * it already there. Everything an earlier move armed to retire it there is called off - the queued
 * flag and any archive watcher still running - or it would hide the copy the owner just chose.
 */
export function keepChatOn(profile: string, sessionId: string): void {
  try {
    dropRetireOnClose(profile, sessionId)
  } catch {
    // an unwritable queue file must not fail the landing; the sweep re-checks before any write
  }
  cancelChatArchiveReassert(profile, sessionId)
}

/**
 * The profile dirs whose desktop app is running, from a FRESH process scan. Throws when the scan
 * fails: a destructive caller must not read "could not tell" as "closed".
 */
export async function runningProfileDirs(): Promise<string[]> {
  const scan = await scanClaudeProcesses({ fresh: true })
  if (!scan.ok) throw new Error(`could not read the Claude processes: ${scan.reason}`)
  return scan.processes.filter((p) => p.isMain && p.dir).map((p) => p.dir as string)
}

/** One record's flag, read strictly: a bad read throws, which leaves the entry for next pass. */
function readArchivedStrict(path: string): boolean {
  return (JSON.parse(readFileSync(path, 'utf8')) as { isArchived?: unknown }).isArchived === true
}

export interface RetireDeps {
  store: RetireStore
  /** Profile dirs whose desktop app is running right now. */
  listRunningDirs: () => Promise<string[]>
  /** The record's flag in that profile's store; null when no record was found. Throws on a bad
   *  read, which leaves the entry for the next pass. */
  archivedIn: (profile: string, sessionId: string) => boolean | null
  /** Some OTHER profile shows this chat unarchived. Throws when one cannot be read. */
  liveElsewhere: (profile: string, sessionId: string) => boolean
  /** Write the archive flag in that one profile; true when it changed the record. */
  flag: (sessionId: string, profile: string) => Promise<boolean>
  now: () => number
  log?: (msg: string) => void
}

const defaultDeps = (): RetireDeps => ({
  store,
  listRunningDirs: runningProfileDirs,
  archivedIn: (profile, id) => {
    const path = findChatMetaPath(profile, id)
    return path ? readArchivedStrict(path) : null
  },
  liveElsewhere: (profile, id) =>
    desktopProfileRoots().some((dir) => {
      if (samePathKey(dir, profile)) return false
      const path = findVisibleChatMetaPath(dir, id)
      return path ? !readArchivedStrict(path) : false
    }),
  flag: async (id, profile) =>
    (await archiveDesktopChat(id, true, [profile])).hits.some((h) => h.changed),
  now: Date.now,
  log: (msg) => console.log(msg),
})

/**
 * One pass over the queue, or over one profile's entries. Per-entry failures are contained and
 * retried next tick. Returns how many old copies it archived.
 */
export async function runRetireOnCloseOnce(
  deps: RetireDeps = defaultDeps(),
  opts: { profile?: string } = {},
): Promise<number> {
  const entries = deps.store
    .load()
    .filter((e) => opts.profile === undefined || samePathKey(e.profile, opts.profile))
  if (entries.length === 0) return 0
  let running: string[]
  try {
    running = await deps.listRunningDirs()
  } catch {
    return 0
  }
  // Settled entries by key AND stamp: an entry re-queued while this pass ran is a new intent.
  const settled = new Set<string>()
  const settle = (e: RetireEntry) => settled.add(`${keyOf(e.profile, e.sessionId)}@${e.queuedAt}`)
  let retired = 0
  for (const e of entries) {
    try {
      const queued = Date.parse(e.queuedAt)
      if (!Number.isFinite(queued) || deps.now() - queued > RETIRE_MAX_AGE_MS) {
        settle(e)
        continue
      }
      if (running.some((dir) => samePathKey(dir, e.profile))) continue
      const archived = deps.archivedIn(e.profile, e.sessionId)
      // No record found is not proof it is gone (a walk can come up empty on a contended store);
      // it waits, and the age cap ends it if it never comes back.
      if (archived === null) continue
      if (archived) {
        settle(e)
        continue
      }
      if (!deps.liveElsewhere(e.profile, e.sessionId)) {
        deps.log?.(
          `[agenthydra] kept ${e.sessionId} on ${e.profile}: no other account shows it, so it is not archived there`,
        )
        settle(e)
        continue
      }
      // A move back onto this account may have dropped the entry since this pass loaded it.
      const key = keyOf(e.profile, e.sessionId)
      if (!deps.store.load().some((x) => keyOf(x.profile, x.sessionId) === key)) continue
      if (await deps.flag(e.sessionId, e.profile)) retired++
      settle(e)
    } catch {
      // a contended store or a half-written record says nothing about the next tick
    }
  }
  if (settled.size)
    deps.store.save(
      deps.store
        .load()
        .filter((e) => !settled.has(`${keyOf(e.profile, e.sessionId)}@${e.queuedAt}`)),
    )
  if (retired > 0)
    deps.log?.(`[agenthydra] archived ${retired} moved chat(s) on accounts that have since closed`)
  return retired
}

/** Longest a launch waits on the pass below; the sweep's next tick finishes anything it cut off. */
const BEFORE_LAUNCH_BUDGET_MS = 5_000

/**
 * The pass for one profile, run right before AgentHydra opens it: the app reads its store at
 * startup, so this is the last moment the flag can land before it is read, and a close and
 * reopen inside one tick would otherwise miss it. Bounded, and never throws into the launch.
 */
export async function retireBeforeLaunch(profile: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    runRetireOnCloseOnce(defaultDeps(), { profile }).catch(() => 0),
    new Promise<void>((r) => {
      timeout = setTimeout(r, BEFORE_LAUNCH_BUDGET_MS)
    }),
  ])
  clearTimeout(timeout)
}

let timer: ReturnType<typeof setInterval> | null = null

export function startRetireOnCloseSweep(): void {
  if (timer) return
  setBeforeLaunchHook(retireBeforeLaunch)
  // Same shape as automation-stamp-sweep.ts's timer: this process exits on an unhandled
  // rejection, so a repeating timer must not be able to let one escape.
  timer = setInterval(() => {
    runRetireOnCloseOnce().catch((err) =>
      console.error('[agenthydra] retire-on-close sweep error:', err),
    )
  }, RETIRE_SWEEP_MS)
}

export function stopRetireOnCloseSweep(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
