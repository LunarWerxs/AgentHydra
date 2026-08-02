// server/src/core/cli-instances.ts — CLI instances as first-class managed objects (§3 of
// CLI_INSTANCES_AND_USAGE_PLAN.md).
//
// The core architectural insight: an account has TWO independent auth stores. A DESKTOP instance is
// isolated with Electron's `--user-data-dir` (managed by core/instances.ts); a CLI instance is
// isolated with `CLAUDE_CONFIG_DIR=<dir>` and logged in once via `claude` → `/login`. They are
// different logins even for the same account. This module models the CLI side: a `CLAUDE_CONFIG_DIR`
// directory, its logged-in state, and the lifecycle verbs (create / launch / associate / delete).
//
// Persistence mirrors the desktop instance-identity split: a plain JSON store under CONFIG_DIR
// (NOT the sqlite db — no schema migration, same as instances-cache.json). Never carries a token;
// login is the USER's step (an OAuth/password flow an AI must never perform), so this module can
// only (a) create the dir, (b) detect logged-in state by the presence of `.credentials.json`, and
// (c) open a real terminal with the env set so the user can `/login` (or just use the session).
//
// Never throws for expected failures (bad name, collision, missing dir, guard refusal) — every
// mutating function returns a status-carrying CMActionResult, same contract as core/lifecycle.ts.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR, resolveClaudeExe } from '../config'
import type { CliInstance, UsageSnapshot } from '../types'
import { CLAUDE_LAUNCH_EFFORTS, type LaunchOptionsInput, launchOptionError } from './launch-options'
import { isPathInside } from './paths'
import type { CMActionResult } from './shared'

export type { CliInstance } from '../types'

/** Where CLI-instance config dirs live: `<CONFIG_DIR>/cli-instances/<id>`. */
const CLI_INSTANCES_ROOT = join(CONFIG_DIR, 'cli-instances')
/** The JSON store (the record list; loggedIn is recomputed, not trusted from disk). */
const STORE_PATH = join(CONFIG_DIR, 'cli-instances.json')

const NAME_MAX = 60

// --- persistence -------------------------------------------------------------

interface Store {
  instances: CliInstance[]
}

function readStore(): Store {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    if (parsed && Array.isArray(parsed.instances)) return { instances: parsed.instances }
  } catch {
    // missing/corrupt store → start empty
  }
  return { instances: [] }
}

function writeStore(store: Store): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2))
}

// --- login detection ---------------------------------------------------------

/** True when the config dir has been `/login`'d once (a `.credentials.json` is present). */
export function isLoggedIn(configDir: string): boolean {
  try {
    return existsSync(join(configDir, '.credentials.json'))
  } catch {
    return false
  }
}

/** A stored record hydrated with its LIVE loggedIn state (the store value is only a hint).
 *  Also backfills fields added after a store was first written (records predating the desktop link
 *  have no `associatedDesktop*` keys at all), so callers never see `undefined` where they expect null. */
function hydrate(rec: CliInstance): CliInstance {
  return {
    ...rec,
    associatedDesktopDir: rec.associatedDesktopDir ?? null,
    associatedDesktopLabel: rec.associatedDesktopLabel ?? null,
    loggedIn: isLoggedIn(rec.configDir),
  }
}

// --- read --------------------------------------------------------------------

/** Every CLI instance, each with its live loggedIn state. */
export function listCliInstances(): CliInstance[] {
  return readStore().instances.map(hydrate)
}

/** One CLI instance by id (live loggedIn state), or null. */
export function getCliInstance(id: string): CliInstance | null {
  const rec = readStore().instances.find((i) => i.id === id)
  return rec ? hydrate(rec) : null
}

// --- create ------------------------------------------------------------------

function validName(name: string): { ok: boolean; reason: string } {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return { ok: false, reason: 'Name cannot be empty.' }
  if (trimmed.length > NAME_MAX) return { ok: false, reason: `Name must be ≤ ${NAME_MAX} chars.` }
  return { ok: true, reason: '' }
}

/**
 * Create a new CLI instance: mint an id, mkdir its `CLAUDE_CONFIG_DIR`, persist a record with
 * loggedIn=false. Login is deferred to the user (see openCliTerminal). Idempotent per id (a fresh
 * uuid each call), never collides.
 */
export function createCliInstance(name: string): CMActionResult {
  const v = validName(name)
  if (!v.ok) {
    return { ok: false, action: 'cli-create', dir: null, message: v.reason, data: { name } }
  }
  const id = crypto.randomUUID()
  const configDir = join(CLI_INSTANCES_ROOT, id)
  try {
    mkdirSync(configDir, { recursive: true })
  } catch (err) {
    return {
      ok: false,
      action: 'cli-create',
      dir: configDir,
      message: `Failed to create config dir '${configDir}': ${err instanceof Error ? err.message : String(err)}`,
      data: { name },
    }
  }
  const rec: CliInstance = {
    id,
    name: name.trim(),
    configDir,
    associatedAccountId: null,
    associatedAccountLabel: null,
    associatedDesktopDir: null,
    associatedDesktopLabel: null,
    loggedIn: false,
    lastUsageCheck: null,
    createdAt: Date.now(),
  }
  const store = readStore()
  store.instances.push(rec)
  writeStore(store)
  return {
    ok: true,
    action: 'cli-create',
    dir: configDir,
    message: `CLI instance '${rec.name}' created. Use the log-in helper to sign it in.`,
    data: { id, configDir },
  }
}

// --- rename / associate ------------------------------------------------------

/** Rename the display label (never touches the folder/id). */
export function renameCliInstance(id: string, name: string): CMActionResult {
  const v = validName(name)
  if (!v.ok) return { ok: false, action: 'cli-rename', dir: null, message: v.reason, data: { id } }
  const store = readStore()
  const rec = store.instances.find((i) => i.id === id)
  if (!rec)
    return {
      ok: false,
      action: 'cli-rename',
      dir: null,
      message: 'CLI instance not found.',
      data: { id },
    }
  rec.name = name.trim()
  writeStore(store)
  return { ok: true, action: 'cli-rename', dir: rec.configDir, message: 'Renamed.', data: { id } }
}

/** Associate (or clear, with accountId=null) the dispatch account used for this instance's usage. */
export function associateCliInstance(
  id: string,
  accountId: string | null,
  accountLabel: string | null,
): CMActionResult {
  const store = readStore()
  const rec = store.instances.find((i) => i.id === id)
  if (!rec)
    return {
      ok: false,
      action: 'cli-associate',
      dir: null,
      message: 'CLI instance not found.',
      data: { id },
    }
  rec.associatedAccountId = accountId
  rec.associatedAccountLabel = accountLabel
  writeStore(store)
  return {
    ok: true,
    action: 'cli-associate',
    dir: rec.configDir,
    message: accountId ? 'Account associated.' : 'Association cleared.',
    data: { id, accountId },
  }
}

/** Clear the account association on every record matching `match`, in ONE store write.
 *  Returns the ids that were cleared (empty = nothing referenced it, and nothing was written). */
function clearAccountAssociationsWhere(match: (accountId: string) => boolean): string[] {
  const store = readStore()
  const cleared: string[] = []
  for (const rec of store.instances) {
    if (!rec.associatedAccountId || !match(rec.associatedAccountId)) continue
    rec.associatedAccountId = null
    rec.associatedAccountLabel = null
    cleared.push(rec.id)
  }
  if (cleared.length) writeStore(store)
  return cleared
}

/**
 * Detach a deleted dispatch account from every CLI instance that referenced it.
 *
 * The association is a plain id + label copied into the JSON store, NOT a foreign key — sqlite can't
 * cascade into a file it doesn't own, so deleting the account row leaves the reference behind. What
 * the user then sees is a badge naming an account that no longer exists, on an instance whose usage
 * check silently falls through to "check failed" because the id resolves to nothing. Clearing it
 * turns a wrong answer into an honest one: the instance is simply unassociated again.
 */
export function clearCliInstanceAccountAssociations(accountId: string): string[] {
  if (!accountId) return []
  return clearAccountAssociationsWhere((id) => id === accountId)
}

/**
 * Self-heal: drop any association whose account is not in `knownAccountIds`.
 *
 * The eager clear above only covers deletions that happen from now on. Records already dangling
 * (deleted before that existed, or by a hand-edited db) would keep their stale badge forever, so the
 * read path reconciles against the live account list as well. Pass EVERY known account id — an empty
 * set means "no accounts exist", which correctly clears everything.
 */
export function pruneCliInstanceAccountAssociations(knownAccountIds: Iterable<string>): string[] {
  const known = knownAccountIds instanceof Set ? knownAccountIds : new Set(knownAccountIds)
  return clearAccountAssociationsWhere((id) => !known.has(id))
}

/**
 * Link (or unlink, with desktopDir=null) this CLI instance to a DESKTOP instance.
 *
 * A desktop app and a CLI login are two separate auth stores, but they are normally the same
 * Anthropic account used two ways — so this link is what lets the UI present them as one account,
 * and lets either side's credential serve as the other's usage-check fallback (see the desktop
 * usage route: own token → LINKED CLI's token → dispatch account).
 *
 * The link is 1:1 from the CLI side: linking a CLI instance to a desktop dir that another CLI
 * instance already claims steals it, rather than leaving two CLI instances pointing at one desktop
 * (which would make "the linked CLI" ambiguous for the fallback chain).
 */
export function linkCliInstanceToDesktop(
  id: string,
  desktopDir: string | null,
  desktopLabel: string | null,
): CMActionResult {
  const store = readStore()
  const rec = store.instances.find((i) => i.id === id)
  if (!rec)
    return {
      ok: false,
      action: 'cli-link-desktop',
      dir: null,
      message: 'CLI instance not found.',
      data: { id },
    }
  if (desktopDir) {
    for (const other of store.instances) {
      if (other.id !== id && other.associatedDesktopDir === desktopDir) {
        other.associatedDesktopDir = null
        other.associatedDesktopLabel = null
      }
    }
  }
  rec.associatedDesktopDir = desktopDir
  rec.associatedDesktopLabel = desktopDir ? desktopLabel : null
  writeStore(store)
  return {
    ok: true,
    action: 'cli-link-desktop',
    dir: rec.configDir,
    message: desktopDir ? 'Linked to desktop instance.' : 'Desktop link cleared.',
    data: { id, desktopDir },
  }
}

/** The CLI instance linked to this desktop instance dir, or null. The reverse of the link above —
 *  used by the desktop usage route to find a backup credential when the desktop token can't be used. */
export function cliInstanceForDesktop(desktopDir: string): CliInstance | null {
  const rec = readStore().instances.find((i) => i.associatedDesktopDir === desktopDir)
  return rec ? hydrate(rec) : null
}

/** Store the latest usage snapshot on the record (called by the usage route after a check). */
export function setCliInstanceUsage(id: string, snap: UsageSnapshot): void {
  const store = readStore()
  const rec = store.instances.find((i) => i.id === id)
  if (!rec) return
  rec.lastUsageCheck = snap
  writeStore(store)
}

// --- delete (guarded) --------------------------------------------------------

/**
 * Guarded delete: `confirmName` must equal the instance's display name (same discipline as the
 * desktop delete). Removes the record AND its config dir (which holds the login) — irreversible, so
 * the confirm gate matters. The dir is always under CLI_INSTANCES_ROOT (we created it), so there is
 * no "outside the root" escape to guard against as there is for desktop dirs.
 */
export function deleteCliInstance(id: string, confirmName?: string): CMActionResult {
  const store = readStore()
  const idx = store.instances.findIndex((i) => i.id === id)
  if (idx < 0)
    return {
      ok: false,
      action: 'cli-delete',
      dir: null,
      message: 'CLI instance not found.',
      data: { id },
    }
  const rec = store.instances[idx]!
  if (!confirmName || confirmName !== rec.name) {
    return {
      ok: false,
      action: 'cli-delete',
      dir: rec.configDir,
      message: `Refusing to delete: confirmName must exactly match the instance name '${rec.name}'.`,
      data: { id },
    }
  }
  // Defensive: only ever rm a path under our own root.
  if (isPathInside(CLI_INSTANCES_ROOT, rec.configDir)) {
    try {
      rmSync(rec.configDir, { recursive: true, force: true })
    } catch {
      // best-effort; still drop the record so the UI isn't wedged on a locked dir
    }
  }
  store.instances.splice(idx, 1)
  writeStore(store)
  return {
    ok: true,
    action: 'cli-delete',
    dir: rec.configDir,
    message: `CLI instance '${rec.name}' deleted.`,
    data: { id },
  }
}

// --- launch / login helper (opens a REAL terminal for the user) --------------

export interface LaunchOpts extends LaunchOptionsInput {
  /** true = a bare `claude` for the user to `/login`; false = a normal session. */
  login?: boolean
}

/**
 * Open a visible terminal with `CLAUDE_CONFIG_DIR=<configDir>` set, running `claude`. Both "Launch"
 * and the "Log-in helper" route here — the only difference is the login variant runs a bare `claude`
 * (so the user types `/login`). The terminal is the USER's surface; the daemon never performs the
 * login itself. Detached (survives a daemon restart) and value-blind (no token ever passes through).
 *
 * Windows: `cmd /c start "" cmd /k <claude …>` opens a persistent console window whose environment
 * (incl. CLAUDE_CONFIG_DIR, injected via the spawn env) the `start` hand-off propagates to the inner
 * shell. macOS/Linux: best-effort via the platform terminal opener.
 */
export function launchCliInstance(id: string, opts: LaunchOpts = {}): CMActionResult {
  const rec = getCliInstance(id)
  if (!rec)
    return {
      ok: false,
      action: 'cli-launch',
      dir: null,
      message: 'CLI instance not found.',
      data: { id },
    }

  const optionError = opts.login ? null : launchOptionError(opts, CLAUDE_LAUNCH_EFFORTS)
  if (optionError)
    return {
      ok: false,
      action: 'cli-launch',
      dir: rec.configDir,
      message: optionError,
      data: { id },
    }

  const exe = resolveClaudeExe()
  const claudeArgs: string[] = []
  if (!opts.login) {
    if (typeof opts.model === 'string') claudeArgs.push('--model', opts.model)
    if (typeof opts.effort === 'string') claudeArgs.push('--effort', opts.effort)
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_CONFIG_DIR: rec.configDir,
  }

  try {
    if (process.platform === 'win32') {
      // Quote the exe (may contain spaces); `/k` keeps the window open after claude exits so the
      // user can read output / see a login prompt. The empty "" is start's mandatory title slot.
      const inner = [`"${exe}"`, ...claudeArgs].join(' ')
      Bun.spawn(['cmd', '/c', 'start', '', 'cmd', '/k', inner], {
        env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })
    } else if (process.platform === 'darwin') {
      // AppleScript to open Terminal.app with the env exported inline.
      const cmdline = `CLAUDE_CONFIG_DIR=${JSON.stringify(rec.configDir)} ${JSON.stringify(exe)} ${claudeArgs.join(' ')}`
      const script = `tell application "Terminal" to do script ${JSON.stringify(cmdline)}`
      Bun.spawn(['osascript', '-e', script], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })
    } else {
      // Linux best-effort: x-terminal-emulator holding a shell with the env set.
      const cmdline = `${JSON.stringify(exe)} ${claudeArgs.join(' ')}; exec bash`
      Bun.spawn(['x-terminal-emulator', '-e', 'bash', '-lc', cmdline], {
        env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })
    }
  } catch (err) {
    return {
      ok: false,
      action: opts.login ? 'cli-login' : 'cli-launch',
      dir: rec.configDir,
      message: `Failed to open a terminal: ${err instanceof Error ? err.message : String(err)}`,
      data: { id },
    }
  }
  return {
    ok: true,
    action: opts.login ? 'cli-login' : 'cli-launch',
    dir: rec.configDir,
    message: opts.login
      ? 'Opened a terminal. Run /login there to sign this instance in.'
      : 'Launched a terminal for this CLI instance.',
    data: { id, configDir: rec.configDir },
  }
}
