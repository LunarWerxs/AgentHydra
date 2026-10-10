// server/src/core/owner-claude-dir.ts — where the owner's global CLAUDE.md and skills live.
//
// Its own module so core/cli-instances.ts can read it without importing climayte-core.ts, which
// imports cli-instances.ts. climayte-core.ts re-exports it and keeps the test setter.

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the owner's global CLAUDE.md and skills live (`~/.claude`). Off under tests unless a test
 *  sets it, so a test run never links the real skills into a fixture. */
export let ownerClaudeDir: string | null =
  process.env.NODE_ENV === 'test' ? null : join(homedir(), '.claude')

/** Replaces the owner's Claude directory; null turns the sync off. */
export function setOwnerClaudeDir(dir: string | null): void {
  ownerClaudeDir = dir
}
