// server/src/desktop-tasks.ts — WRITING INTO THE DESKTOP APP'S OWN SCHEDULER.
//
// WHY THIS EXISTS (owner directive, Michael, 2026-08-28, after being told a window needed one
// manual touch: "You WILL figure out how to do it.. Without me having to do ANY work. Lift zero
// fingers."): every delivery rung this system had needed something ALREADY AWAKE in the target
// instance - a reviewer inside it, a live chat to peer-message, or (banned) a working chat as a
// courier. An instance whose app is open but whose chats are all asleep was therefore
// unreachable, and the only fix on record was a human typing one message in it. That is the
// excuse this module deletes.
//
// THE MECHANISM, measured 2026-08-28 by writing a probe task through the app's own MCP tool and
// then finding where it landed on disk. Claude Desktop keeps a per-account scheduler at
//
//     <instanceDir>/claude-code-sessions/<accountUuid>/<orgUuid>/scheduled-tasks.json
//
// whose shape is exactly:
//
//     { "scheduledTasks": [ { id, cronExpression, enabled, filePath, createdAt, cwd } ],
//       "recordedSkips": {}, "sundayAliasBoundaryStamped": true,
//       "dayFieldsOrBoundaryStamped": true }
//
// `filePath` points at an ordinary SKILL.md (frontmatter name/description + the prompt body),
// and the app FIRES IT ITSELF on the cron, in that account, with no human present. Two
// properties make it the right bootstrap primitive rather than a hack: a task whose time passed
// while the app was closed runs on the next launch (so a closed window self-heals rather than
// silently missing its wake), and the run happens inside the app, which is the one place a
// dormant chat in that instance can be booted from.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO. It never edits a task the OWNER created (every
// write is keyed by our own `orch-` id prefix, and removal refuses anything else), it never
// touches a running app's chat metadata (this file is scheduler state, not chat state - a
// different store from the one the app re-saves from memory), and it writes the registry entry
// ONLY after its SKILL.md exists, because a registry row pointing at a missing file is a task
// the app will try to run and fail, forever.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appEnv } from './config'

/** Every id we write starts with this. The removal path refuses anything that does not, so an
 *  owner-authored task can never be deleted by our janitor. */
export const ORCH_TASK_PREFIX = 'orch-'

export interface DesktopTask {
  id: string
  /** ONE-SHOT scheduling: epoch ms. THE shape that works (measured 2026-08-30 against the
   *  app's own main.log): a `fireAt` has NO missed-window expiry, so it fires on the first
   *  60s tick where every gate passes, and the app auto-disables it after the fire. A
   *  single-minute cronExpression does NOT survive - cron slots expire, so a one-shot cron
   *  whose exact tick is deferred by any startup gate is skipped forever (that is why the
   *  first courier drills never fired). Recurring crons still work, which is why the old
   *  fleet-wide probe tasks did fire. */
  fireAt?: number
  /** Recurring only. Left optional so an owner-authored cron row round-trips unharmed. */
  cronExpression?: string
  enabled: boolean
  filePath: string
  createdAt: number
  cwd: string
  lastRunAt?: number
}

interface TaskStore {
  scheduledTasks: DesktopTask[]
  recordedSkips: Record<string, unknown>
  sundayAliasBoundaryStamped: boolean
  dayFieldsOrBoundaryStamped: boolean
}

const EMPTY_STORE: TaskStore = {
  scheduledTasks: [],
  recordedSkips: {},
  sundayAliasBoundaryStamped: true,
  dayFieldsOrBoundaryStamped: true,
}

/**
 * The `<accountUuid>/<orgUuid>` leaf an instance is CURRENTLY signed in as, or null.
 *
 * An instance accumulates one leaf per account it has ever been signed into (see
 * docs/MOVING-CHATS-BETWEEN-ACCOUNTS.md: the account IS the folder), so "which leaf" is a real
 * question with a wrong answer available. The live one is the leaf whose contents were written
 * most recently - the app touches its current account's store constantly and never touches the
 * stale ones. Ties and empty stores return null rather than guessing, because installing a
 * courier into a signed-out account's folder would be a task that never fires and reads as one
 * that did.
 */
export function activeAccountDir(instanceDir: string): string | null {
  const root = join(instanceDir, 'claude-code-sessions')
  if (!existsSync(root)) return null
  let best: { dir: string; at: number } | null = null
  let orgs: string[]
  try {
    orgs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return null
  }
  for (const org of orgs) {
    const orgDir = join(root, org)
    let users: string[]
    try {
      users = readdirSync(orgDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      continue
    }
    for (const user of users) {
      const leaf = join(orgDir, user)
      let newest = 0
      try {
        for (const f of readdirSync(leaf)) {
          const m = statSync(join(leaf, f)).mtimeMs
          if (m > newest) newest = m
        }
      } catch {
        continue
      }
      if (newest > 0 && (!best || newest > best.at)) best = { dir: leaf, at: newest }
    }
  }
  return best?.dir ?? null
}

function readStore(path: string): TaskStore {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TaskStore>
    return {
      ...EMPTY_STORE,
      ...raw,
      scheduledTasks: Array.isArray(raw.scheduledTasks) ? raw.scheduledTasks : [],
    }
  } catch {
    // A missing or corrupt store is replaced, not merged: the app rewrites this file wholesale
    // itself, and a half-parsed one is not a thing to preserve.
    return { ...EMPTY_STORE, scheduledTasks: [] }
  }
}

/** Where a task's prompt lives. The shared ~/.claude tree, one directory per task id, exactly
 *  where the app's own tool puts them (measured) - so a task we write and a task the owner
 *  wrote are indistinguishable to the app, which is the point. Honors AGENTHYDRA_HOME so the
 *  test suite's throwaway-state backstop covers this write too (found live: a unit test had
 *  left a real orch-courier-test SKILL dir in the developer's ~/.claude). */
export function taskSkillPath(taskId: string): string {
  const base = appEnv('HOME')?.trim() || homedir()
  return join(base, '.claude', 'scheduled-tasks', taskId, 'SKILL.md')
}

export interface InstallTaskOpts {
  instanceDir: string
  taskId: string
  description: string
  prompt: string
  /** When the one-shot should fire, epoch ms (see DesktopTask.fireAt). */
  fireAt: number
  cwd: string
  /** Seam for tests. */
  accountDir?: string | null
}

/**
 * THE FEATURE FLAG. `checkScheduledTasksInner()` returns immediately unless
 * `preferences.ccdScheduledTasksEnabled` is true in the instance's claude_desktop_config.json
 * (source-read 2026-08-30; the app's own UI toggle is the only thing that normally sets it).
 * Without it a perfectly-formed task is ignored forever, silently.
 *
 * The file also carries the instance's MCP server config, so this is a strict read-merge-write
 * of ONE key - never a replace. A malformed/unreadable config is left ALONE rather than
 * overwritten: clobbering someone's MCP setup to enable a courier is not a trade worth making.
 */
export function ensureScheduledTasksEnabled(
  instanceDir: string,
): { ok: true; changed: boolean } | { ok: false; reason: string } {
  const path = join(instanceDir, 'claude_desktop_config.json')
  let cfg: Record<string, unknown>
  try {
    cfg = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      : {}
  } catch (err) {
    return {
      ok: false,
      reason: `claude_desktop_config.json is unreadable (${err instanceof Error ? err.message : 'parse error'}) - refusing to overwrite it, enable scheduled tasks in the app's settings instead`,
    }
  }
  const prefs =
    cfg.preferences && typeof cfg.preferences === 'object'
      ? (cfg.preferences as Record<string, unknown>)
      : {}
  if (prefs.ccdScheduledTasksEnabled === true) return { ok: true, changed: false }
  cfg.preferences = { ...prefs, ccdScheduledTasksEnabled: true }
  try {
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'config write failed' }
  }
  return { ok: true, changed: true }
}

/**
 * Install (or update) one of OUR scheduled tasks in an instance's app. Idempotent: a second call
 * with the same id rewrites the prompt and leaves exactly one registry row.
 */
export function installDesktopTask(
  opts: InstallTaskOpts,
): { ok: true; accountDir: string; filePath: string } | { ok: false; reason: string } {
  if (!opts.taskId.startsWith(ORCH_TASK_PREFIX))
    return { ok: false, reason: `task id must start with ${ORCH_TASK_PREFIX}` }
  const accountDir =
    opts.accountDir === undefined ? activeAccountDir(opts.instanceDir) : opts.accountDir
  if (!accountDir) return { ok: false, reason: 'no signed-in account folder found for instance' }

  // The SKILL.md FIRST, always: a registry row pointing at a missing file is a task the app
  // retries and fails forever.
  const filePath = taskSkillPath(opts.taskId)
  try {
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(
      filePath,
      `---\nname: ${opts.taskId}\ndescription: ${opts.description}\n---\n\n${opts.prompt}\n`,
    )
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'skill write failed' }
  }

  const storePath = join(accountDir, 'scheduled-tasks.json')
  const store = readStore(storePath)
  const existing = store.scheduledTasks.find((t) => t.id === opts.taskId)
  const row: DesktopTask = {
    id: opts.taskId,
    fireAt: opts.fireAt,
    enabled: true,
    filePath,
    createdAt: existing?.createdAt ?? Date.now(),
    cwd: opts.cwd,
  }
  store.scheduledTasks = [...store.scheduledTasks.filter((t) => t.id !== opts.taskId), row]
  try {
    writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'store write failed' }
  }
  return { ok: true, accountDir, filePath }
}

/** Is one of our tasks installed in this instance right now? */
export function hasDesktopTask(instanceDir: string, taskId: string, accountDir?: string): boolean {
  return getDesktopTask(instanceDir, taskId, accountDir) !== null
}

/** The full registry row for one of our tasks (the courier reads its fireAt/lastRunAt back to
 *  decide re-arm vs leave-alone), or null when absent. A FIRED one-shot is left in the store
 *  by the app with enabled:false (it "auto-disables one-time tasks after fire"), which is
 *  evidence the courier needs - so a disabled row is RETURNED, not hidden. */
export function getDesktopTask(
  instanceDir: string,
  taskId: string,
  accountDir?: string,
): DesktopTask | null {
  const dir = accountDir ?? activeAccountDir(instanceDir)
  if (!dir) return null
  const row = readStore(join(dir, 'scheduled-tasks.json')).scheduledTasks.find(
    (t) => t.id === taskId,
  )
  return row ?? null
}

/** Remove one of OUR tasks. Refuses any id without our prefix, so an owner-authored task cannot
 *  be swept away by automation that only ever meant to tidy its own. */
export function removeDesktopTask(
  instanceDir: string,
  taskId: string,
  accountDir?: string,
): { ok: boolean; reason?: string } {
  if (!taskId.startsWith(ORCH_TASK_PREFIX))
    return { ok: false, reason: 'refusing to remove a task that is not ours' }
  const dir = accountDir ?? activeAccountDir(instanceDir)
  if (!dir) return { ok: false, reason: 'no signed-in account folder found for instance' }
  const storePath = join(dir, 'scheduled-tasks.json')
  const store = readStore(storePath)
  const before = store.scheduledTasks.length
  store.scheduledTasks = store.scheduledTasks.filter((t) => t.id !== taskId)
  if (store.scheduledTasks.length === before) return { ok: true }
  try {
    writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'store write failed' }
  }
  return { ok: true }
}
