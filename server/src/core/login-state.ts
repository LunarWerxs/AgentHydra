// server/src/core/login-state.ts - which account a Claude Desktop profile is signed into RIGHT NOW.
//
// Split out of core/instances.ts (2026-09-18) so the chat-store scan (core/chat-store-scan.ts) can
// ask the same question without importing process enumeration, spawn helpers and the rest of the
// instance module into the per-session MCP stdio process, which must stay import-time
// side-effect-free (see core/self-identity.ts). core/instances.ts re-exports everything here
// unchanged, so its callers and tests are untouched by the split.
//
// WHY THE CHAT STORE NEEDS IT: the desktop app files one metadata record per chat at
// `claude-code-sessions/<accountUuid>/<orgUuid>/local_<id>.json` and SHOWS ONLY the folder whose
// first segment is this uuid. Re-log a profile into a different account and every chat filed
// under the previous one vanishes from the app while its record still sits on disk
// (#12, 2026-09-18: four live chats disappeared that way twenty minutes after being moved in).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Which account an instance is signed into right now: `<dir>/config.json`'s `lastKnownAccountUuid`
 * (null when signed out, unreadable, or malformed).
 *
 * This is the ONLY part of account identity cheap enough to ship with every list response — the
 * rest needs a safeStorage decrypt and a profile call (core/accounts.ts). It exists so the UI can
 * notice that an instance was re-logged into a DIFFERENT account and re-resolve, instead of
 * showing the identity it resolved once forever.
 *
 * Deliberately un-memoized: these files run 3–9 KB, so re-reading one per instance per poll tick
 * is far cheaper than the staleness a stat-keyed cache would risk (an account switch rewrites
 * config.json to the SAME size, since one uuid is exactly as long as another). Identity only —
 * never reads or returns a token. Never throws.
 */
export function readLoginUuid(instanceDir: string): string | null {
  return readLoginState(instanceDir).uuid
}

/**
 * ⛔ 'SIGNED OUT' AND 'I COULD NOT READ THE PROFILE' ARE DIFFERENT PROBLEMS, and `readLoginUuid`
 * answers null to both. That single boolean is what the fleet reports, so a config.json that a
 * crash left half-written is announced to the owner as "instance #N is signed out - sign it in",
 * sending him to fix a login that was never broken while the real fault (a damaged profile) goes
 * unnamed. The uuid is unchanged for every existing caller; this just keeps the reason.
 *
 * `no-config` is separated from `unreadable` on purpose too: a directory with no config.json yet
 * is a NEW instance that has never been signed in, which is ordinary, while a config.json that
 * exists and will not parse is damage.
 */
export type LoginState =
  | { uuid: string; reason: 'signed-in' }
  | { uuid: null; reason: 'signed-out' | 'no-config' | 'unreadable' }

export function readLoginState(instanceDir: string): LoginState {
  if (!instanceDir?.trim()) return { uuid: null, reason: 'unreadable' }
  let raw: string
  try {
    raw = readFileSync(join(instanceDir, 'config.json'), 'utf8')
  } catch (err) {
    // Nothing there yet vs. something there we cannot read - only the second one is damage.
    const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
    return { uuid: null, reason: missing ? 'no-config' : 'unreadable' }
  }
  if (!raw?.trim()) return { uuid: null, reason: 'unreadable' }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return typeof parsed.lastKnownAccountUuid === 'string'
      ? { uuid: parsed.lastKnownAccountUuid, reason: 'signed-in' }
      : { uuid: null, reason: 'signed-out' }
  } catch {
    return { uuid: null, reason: 'unreadable' }
  }
}
