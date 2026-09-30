// server/src/core/codex-logout.ts — sign one stored Codex instance out.
//
// WHAT A LOGIN ACTUALLY IS HERE. A Codex login is the single file `<codexHome>/auth.json` (the
// OpenAI tokens Codex CLI and Codex Desktop both read). Remove it and the instance is signed out;
// Codex asks for a login the next time it starts. Our own identity cache is cleared too, so the row
// stops showing the old account.
//
// ⛔ IT REFUSES WHILE THE DESKTOP IS RUNNING, AND WHEN THE PROCESS SCAN FAILS. A running Codex
// refreshes its tokens and re-saves auth.json on its own schedule, so a logout written underneath
// it is silently undone and the button lies. A scan that could not run is not "stopped": the guard
// exists for exactly the case we cannot rule out, so it refuses too.
//
// ⛔ IT IS NOT A DELETE. History, config.toml, sessions and the folder itself all stay; this only
// forgets who was signed in.
//
// KNOWN GAP: only Codex Desktop is checked. A Codex CLI still open on this home can write auth.json
// back on its next token refresh, so quit those too before logging out.
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { deleteCodexCacheEntry } from './codex-account'
import {
  codexDesktopRunState,
  type ScanDesktopProcesses,
  scanCodexDesktopProcesses,
} from './codex-desktop'
import { getCodexInstance } from './codex-instances'
import type { CMActionResult } from './shared'

export interface LogoutCodexInstanceOptions {
  /** Injected for tests; defaults to the real (strict) process scan. */
  scanDesktopProcesses?: ScanDesktopProcesses
}

/** Remove the stored OpenAI login from a stored Codex instance. Never throws. */
export async function logoutCodexInstance(
  id: string,
  options: LogoutCodexInstanceOptions = {},
): Promise<CMActionResult> {
  const instance = getCodexInstance(id)
  if (!instance) {
    return { ok: false, action: 'codex-logout', dir: null, message: 'Codex instance not found.' }
  }
  const { codexHome } = instance
  const dir = codexHome

  // --- Guard: never remove auth.json under a running Codex. See the header. ---
  const run = await codexDesktopRunState(
    instance,
    options.scanDesktopProcesses ?? scanCodexDesktopProcesses,
  )
  if (run.state === 'unknown') {
    return {
      ok: false,
      action: 'codex-logout',
      dir,
      message: `Could not check whether this Codex Desktop instance is running (${run.reason}), and a logout under a running Codex would be undone. Try again in a moment.`,
    }
  }
  if (run.state === 'running') {
    return {
      ok: false,
      action: 'codex-logout',
      dir,
      message:
        'Quit this Codex Desktop instance before logging out. A running Codex refreshes and re-saves its login, so a logout written now would be undone.',
    }
  }

  const authPath = path.join(codexHome, 'auth.json')
  if (!existsSync(authPath)) {
    // Still clear the cached identity: a stale entry would keep the row claiming an account.
    deleteCodexCacheEntry(codexHome)
    return {
      ok: true,
      action: 'codex-logout',
      dir,
      message: 'That instance was already signed out.',
      data: { id, removed: false },
    }
  }

  try {
    rmSync(authPath, { force: true })
  } catch {
    // Reported below by the existence check.
  }
  if (existsSync(authPath)) {
    return {
      ok: false,
      action: 'codex-logout',
      dir,
      message: `Could not remove ${authPath}. Close anything holding it open and try again.`,
      data: { id, removed: false },
    }
  }

  deleteCodexCacheEntry(codexHome)
  return {
    ok: true,
    action: 'codex-logout',
    dir,
    message: 'Signed out. Codex will ask for a login the next time it starts.',
    data: { id, removed: true },
  }
}
