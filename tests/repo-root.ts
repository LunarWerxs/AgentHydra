// tests/repo-root.ts -
// The repo root, anchored to a MARKER the root actually carries - never to a hop count.
//
// WHY THIS FILE EXISTS. The suites here used to bind the root with `resolve(import.meta.dir,
// '..')`: a count of how many folders up the root happens to sit from THAT file. The number is
// only correct for as long as nobody moves the file. Move a test one folder deeper and the
// constant silently points at `tests/` instead of the repo - every `join(REPO_ROOT, ...)` path
// stops existing, and a suite that WALKS files then finds nothing, which reads as a pass. Zero
// files scanned is zero failures. That is the whole disease: the check does not go red, it goes
// quiet, and a guard that has stopped checking looks exactly like a guard over a clean repo.
//
// The cure is to stop COUNTING and start RECOGNISING. Walk upward until a directory proves it is
// this repo; if none does, THROW. Refusing to guess is the load-bearing half - a plausible but
// wrong root is precisely what manufactures the fake pass, so returning one "just in case" would
// reintroduce the bug this file exists to remove. Depth stops mattering, so moving a file cannot
// rot it, and there is no number here to get out of date.
//
// Found by the Architect's repo-root-hop-count check (2026-08-31), which flagged
// launcher.test.ts; guardrails.test.ts carried the identical pattern and was fixed with it.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The workspace root's package.json is the ONLY one in the tree with both this name and a
 *  `workspaces` array: `server/` and `web/` publish as `@agenthydra/server` and `@agenthydra/web`.
 *  So a start directory nested inside a workspace cannot stop early on the wrong package. */
const ROOT_PKG_NAME = 'agenthydra'

/** Directories the suites actually reach into. A "root" missing these is not the root whatever
 *  its package.json claims, so a stray fixture or a scratch checkout cannot impersonate it. */
const LANDMARKS = ['misc', 'server', 'web', 'scripts']

/** Does this exact directory prove itself to be the AgentHydra workspace root? */
function isRepoRoot(dir: string): boolean {
  const pkg = join(dir, 'package.json')
  if (!existsSync(pkg)) return false
  try {
    const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string; workspaces?: unknown }
    if (parsed.name !== ROOT_PKG_NAME || !Array.isArray(parsed.workspaces)) return false
  } catch {
    return false // an unreadable package.json proves nothing
  }
  return LANDMARKS.every((d) => existsSync(join(dir, d)))
}

/**
 * The AgentHydra repo root, found by walking up from `startDir` until a directory proves itself.
 *
 * Throws when none does. That is deliberate and must stay: handing back a best guess is what
 * turns a moved file into a suite that scans nothing and reports success.
 */
export function findRepoRoot(startDir: string): string {
  let dir = startDir
  for (;;) {
    if (isRepoRoot(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break // hit the filesystem root without proof
    dir = parent
  }
  throw new Error(
    `findRepoRoot: no AgentHydra repo root at or above ${startDir} - looked for a package.json ` +
      `named '${ROOT_PKG_NAME}' with a workspaces array, beside ${LANDMARKS.join('/')}. ` +
      'Refusing to guess: a wrong root makes a file-walking suite scan nothing and call it a pass.',
  )
}

/** The root for this file's own location. Safe as a module constant precisely because it throws
 *  at import time rather than handing a suite a root that does not exist. */
export const REPO_ROOT: string = findRepoRoot(import.meta.dir)
