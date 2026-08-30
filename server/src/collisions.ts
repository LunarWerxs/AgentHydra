// server/src/collisions.ts - WHICH LIVE CHATS ARE STANDING ON EACH OTHER'S FEET.
//
// WHY (the owner has been burned by this, 2026-08-25): the machinery places work and delivers
// prompts with no notion of what the OTHER chats are doing, so two threads land in one repo
// and overwrite each other - his own chats reported that "work was overridden by other chats".
// A resume prompt makes it worse by telling chat A to carry on in a tree chat B is halfway
// through editing.
//
// DELIBERATELY THE CHEAP 90% (v1's own words, and they were right): group the live sessions by
// repository root. Same repo means they CAN clobber, which is all a caller needs to route
// around it. A file-level dependency graph would be the expensive 100% and is not worth it.
// It cannot go stale in a harmful direction either - a collision that ended simply stops being
// reported.
//
// REPORT-ONLY, and that is the whole design. This module never blocks a delivery or an
// archive: two chats in one repo is often deliberate (a build watcher beside an editor), and a
// guard that refused on this signal would refuse constantly and get switched off. It is
// surfaced in the pre-start check so the person routing work can SEE it.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { instanceRefForSession } from './instance-sessions'
import { readLiveRegistry } from './live-registry'
import { pathKey } from './path-key'

/** Walk up to the nearest directory containing .git; null when the cwd is not in a repo. */
export function repoRootForCwd(cwd: string): string | null {
  let dir = cwd
  for (let i = 0; i < 40 && dir; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (!up || up === dir) break
    dir = up
  }
  return null
}

export interface Collision {
  /** The shared repository root, or the shared cwd when neither chat is in a repo. */
  where: string
  chats: Array<{ sessionId: string; cwd: string; instance: string | null }>
  why: string
}

export interface CollisionDeps {
  live?: () => Array<{ sessionId: string; cwd: string }>
  repoRoot?: (cwd: string) => string | null
  instanceOf?: (sessionId: string) => string | null
}

/**
 * Live chats sharing a repository right now, most-crowded first. Only groups of 2+ are
 * returned - a chat alone in its repo is not news.
 */
export function liveCollisions(deps: CollisionDeps = {}): Collision[] {
  const live =
    deps.live ??
    (() =>
      readLiveRegistry(join(homedir(), '.claude')).map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd ?? '',
      })))
  const repoRoot = deps.repoRoot ?? repoRootForCwd
  const instanceOf = deps.instanceOf ?? instanceRefForSession

  const groups = new Map<string, Collision>()
  for (const s of live()) {
    if (!s.cwd) continue
    const where = repoRoot(s.cwd) ?? s.cwd
    const key = pathKey(where, true)
    const g = groups.get(key) ?? { where, chats: [], why: '' }
    // One session can appear twice in the registry (a stale file beside a live one); the same
    // id twice is not a collision with itself.
    if (g.chats.some((c) => c.sessionId === s.sessionId)) continue
    g.chats.push({ sessionId: s.sessionId, cwd: s.cwd, instance: instanceOf(s.sessionId) })
    groups.set(key, g)
  }
  return [...groups.values()]
    .filter((g) => g.chats.length > 1)
    .map((g) => ({
      ...g,
      why:
        `${g.chats.length} live chats share this working tree - they can overwrite each ` +
        "other's edits, and a resume prompt to one may tell it to commit what another is " +
        'still writing. Route new work elsewhere, or check before nudging either.',
    }))
    .sort((a, b) => b.chats.length - a.chats.length || a.where.localeCompare(b.where))
}
