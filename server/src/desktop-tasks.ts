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

/** Every id we write starts with this. The removal path refuses anything that does not, so an
 *  owner-authored task can never be deleted by our janitor. */
export const ORCH_TASK_PREFIX = 'orch-'

export interface DesktopTask {
  id: string
  cronExpression: string
  enabled: boolean
  filePath: string
  createdAt: number
  cwd: string
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
 *  wrote are indistinguishable to the app, which is the point. */
export function taskSkillPath(taskId: string): string {
  return join(homedir(), '.claude', 'scheduled-tasks', taskId, 'SKILL.md')
}

export interface InstallTaskOpts {
  instanceDir: string
  taskId: string
  description: string
  prompt: string
  cronExpression: string
  cwd: string
  /** Seam for tests. */
  accountDir?: string | null
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
    cronExpression: opts.cronExpression,
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
  const dir = accountDir ?? activeAccountDir(instanceDir)
  if (!dir) return false
  return readStore(join(dir, 'scheduled-tasks.json')).scheduledTasks.some(
    (t) => t.id === taskId && t.enabled,
  )
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
