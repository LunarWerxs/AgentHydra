// server/src/core/cli-logout.ts — sign one Claude CLI instance out.
//
// WHAT A LOGIN IS HERE. A CLI instance is a CLAUDE_CONFIG_DIR, and its login is the single file
// `<configDir>/.credentials.json` (the OAuth tokens `claude` reads and refreshes). Remove it and the
// instance is signed out: `claude` asks for a login the next time it starts, and isLoggedIn reads
// false. The Codex twin is codex-logout.ts; the menus of all three tables offer it the same way
// (owner, 2026-09-30).
//
// ⛔ IT REFUSES WHILE A SESSION RUNS ON IT. A running `claude` refreshes its tokens and re-saves the
// file on its own schedule, so a logout written underneath it is silently undone. The CLI's own
// live registry (`<configDir>/sessions/<pid>.json`, live-registry.ts) says whether one is running.
//
// ⛔ IT IS NOT A DELETE. Transcripts, settings, memory and the folder stay; this only forgets who
// was signed in.
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { readLiveRegistry } from '../live-registry'
import { getCliInstance } from './cli-instances'
import type { CMActionResult } from './shared'

/** Remove the stored login from a CLI instance. Never throws. */
export function logoutCliInstance(id: string): CMActionResult {
  const instance = getCliInstance(id)
  if (!instance)
    return { ok: false, action: 'cli-logout', dir: null, message: 'CLI instance not found.' }
  const dir = instance.configDir
  const running = readLiveRegistry(dir)
  if (running.length) {
    return {
      ok: false,
      action: 'cli-logout',
      dir,
      message: `A Claude session is running on this instance (${running.length}), and it would write its login back. Quit it first, then log out.`,
      data: { running: running.map((s) => s.pid) },
    }
  }
  const credentials = path.join(dir, '.credentials.json')
  if (!existsSync(credentials))
    return {
      ok: true,
      action: 'cli-logout',
      dir,
      message: 'Already signed out.',
      data: { removed: [] },
    }
  try {
    rmSync(credentials, { force: true })
  } catch (error) {
    return {
      ok: false,
      action: 'cli-logout',
      dir,
      message: `Could not remove the login: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return existsSync(credentials)
    ? {
        ok: false,
        action: 'cli-logout',
        dir,
        message: 'The login file is still there after the logout.',
      }
    : {
        ok: true,
        action: 'cli-logout',
        dir,
        message: 'Signed out.',
        data: { removed: [credentials] },
      }
}
