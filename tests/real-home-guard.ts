// Real-agent-home write guard for the bun test preload (installed from tests/setup.ts). The idea is
// stablyai/orca's real-home write guard (MIT); this is written fresh for AgentHydra's roots.
//
// Why: setup.ts redirects each state root one at a time, each after a test wrote into the
// developer's real state. Nothing redirected the agent homes themselves (~/.claude and its
// CLAUDE_CONFIG_DIR siblings such as ~/.claude-instances, ~/.codex, ~/.hswarm, ~/.hydra-desk-2),
// so a test that wrote there changed a live account with no error. A write into one of them now throws.
// A remove of the working folder itself, or of a folder that holds it, throws too (see refusal).
//
// Scope: in-process writes only. Reads stay allowed on purpose (instances-crypto.test.ts hashes a real
// account). A child process started WITHOUT this preload is not covered. The shared module objects
// (fs, fs/promises, Bun) are patched in place, which reaches a default import and require(). Bun gives
// a named import of a builtin its own binding that no patch of the object reaches (measured on Bun
// 1.4.3, module.syncBuiltinESMExports included), so the four fs specifiers are also replaced by modules
// made of the patched objects; tests/real-home-guard.test.ts checks that a named import sees the patch.

import { mock } from 'bun:test'
import fs, { existsSync, realpathSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type AnyFn = (...args: any[]) => any
type Style = 'sync' | 'callback' | 'promise'

/** The unpatched rmSync, for a test to clean up a probe the guard would refuse to remove. */
export const unguardedRmSync: typeof fs.rmSync = fs.rmSync

// Each writer and the argument positions that name the file it changes. A rename touches both ends;
// a copy only writes its destination (the source is read, and reads stay allowed).
const WRITERS: Record<string, number[]> = {
  writeFile: [0],
  appendFile: [0],
  mkdir: [0],
  rm: [0],
  rmdir: [0],
  unlink: [0],
  rename: [0, 1],
  copyFile: [1],
}

const MARK = Symbol.for('agenthydra.realHomeGuard')
let realRoots: string[] = []
let allowedRoots: string[] = []

const asRecord = (value: unknown) => value as Record<PropertyKey, unknown>
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)

/** Resolve through the deepest existing ancestor, so a junction or symlink into a real home is still caught. */
function resolveTarget(p: string): string {
  const abs = path.resolve(p)
  let probe = abs
  const tail: string[] = []
  while (!existsSync(probe)) {
    const up = path.dirname(probe)
    if (up === probe) return abs
    tail.unshift(path.basename(probe))
    probe = up
  }
  try {
    return path.join(realpathSync(probe), ...tail)
  } catch {
    return abs
  }
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(norm(parent), norm(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** The path a write argument names, or null for a file descriptor or anything else that is not a path. */
function pathOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value instanceof URL) return fileURLToPath(value)
  if (Buffer.isBuffer(value)) return value.toString()
  const name = (value as { name?: unknown } | null | undefined)?.name // a Bun.file() handle
  return typeof name === 'string' ? name : null
}

const REMOVERS = /^rm(dir)?(Sync)?$/

function refusal(name: string, values: unknown[]): Error | null {
  for (const value of values) {
    const p = pathOf(value)
    if (p === null) continue
    // Bun 1.4.3 on Windows: rmSync('', { recursive: true, force: true }) empties the WORKING folder, then throws EBUSY
    // on the folder itself (Node throws ENOENT). A cleanup of a path a failed setup left as '' did that to desk2/ on
    // 2026-10-10. A remove that would take the working folder with it ('', '.', a folder holding it) is refused.
    if (REMOVERS.test(name) && within(process.cwd(), path.resolve(p)))
      return new Error(
        `${name} would remove the folder the tests run in (${path.resolve(p)}): a path left empty by a setup that stopped early?`,
      )
    const target = resolveTarget(p)
    if (allowedRoots.some((root) => within(target, root))) continue
    const home = realRoots.find((root) => within(target, root))
    if (home)
      return new Error(
        `${name} would write into a real agent home (${target}, under ${home}). Redirect that root to a scratch folder in tests/setup.ts (CLAUDE_CONFIG_DIR, CODEX_HOME or the AGENTHYDRA_* env), or set AGENTHYDRA_TEST_REAL_HOME_WRITES=1 only for a test that drives a real home on purpose.`,
      )
  }
  return null
}

function wrap(name: string, orig: AnyFn, targets: number[], style: Style): AnyFn {
  const guarded = function (this: unknown, ...args: unknown[]) {
    const error = refusal(
      name,
      targets.map((i) => args[i]),
    )
    if (style === 'promise') return error ? Promise.reject(error) : orig.apply(this, args)
    if (error) {
      // A callback writer reports the refusal through its callback, as fs does for its own errors.
      const last = args[args.length - 1]
      if (style === 'callback' && typeof last === 'function') {
        process.nextTick(last, error)
        return undefined
      }
      throw error
    }
    return orig.apply(this, args)
  }
  asRecord(guarded)[MARK] = true
  return guarded
}

function patch(
  owner: Record<string, unknown>,
  name: string,
  targets: number[],
  style: Style,
): boolean {
  const orig = owner[name]
  if (typeof orig !== 'function' || asRecord(orig)[MARK]) return false
  try {
    owner[name] = wrap(name, orig as AnyFn, targets, style)
    return true
  } catch {
    return false
  }
}

/** The real homes as the developer's environment named them, read BEFORE any redirect in setup.ts. */
function agentHomes(): string[] {
  const home = os.homedir()
  const named = [
    '.claude',
    '.claude-instances',
    '.claude.json',
    '.codex',
    '.hswarm',
    '.hydra-desk-2',
  ].map((name) => path.join(home, name))
  for (const env of [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
    if (env) named.push(path.resolve(env))
  }
  return [...new Set(named.map(resolveTarget))]
}

/**
 * Install the guard. `allowed` are the scratch roots a test may write into; the OS temp dir is always
 * allowed too. Returns the real homes it guards and any writer it could not patch (reported, not fatal).
 */
export function installRealHomeWriteGuard(opts: { allowed: string[] }): {
  roots: string[]
  unpatched: string[]
} {
  // The opt-out for a test that drives a real home on purpose. Set it in that test's env before any
  // spawn: a child that inherits it skips the guard too.
  if (process.env.AGENTHYDRA_TEST_REAL_HOME_WRITES === '1') return { roots: [], unpatched: [] }
  realRoots = agentHomes()
  allowedRoots = [os.tmpdir(), ...opts.allowed].map((p) => resolveTarget(path.resolve(p)))
  const unpatched: string[] = []
  const attempt = (ok: boolean, name: string) => {
    if (!ok) unpatched.push(name)
  }
  for (const [base, targets] of Object.entries(WRITERS)) {
    attempt(patch(asRecord(fs), `${base}Sync`, targets, 'sync'), `fs.${base}Sync`)
    attempt(patch(asRecord(fs), base, targets, 'callback'), `fs.${base}`)
    attempt(patch(asRecord(fsp), base, targets, 'promise'), `fs/promises.${base}`)
  }
  const bun = (globalThis as { Bun?: unknown }).Bun
  if (bun) attempt(patch(asRecord(bun), 'write', [0], 'promise'), 'Bun.write')
  // Every test file loads after this preload, so each of its named, namespace and default imports
  // gets the patched writers.
  const fsModule = () => ({ ...fs, default: fs })
  const fspModule = () => ({ ...fsp, default: fsp })
  for (const id of ['node:fs', 'fs']) mock.module(id, fsModule)
  for (const id of ['node:fs/promises', 'fs/promises']) mock.module(id, fspModule)
  return { roots: realRoots, unpatched }
}
