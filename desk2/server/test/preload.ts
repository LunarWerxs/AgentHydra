// Test preload for every desk2 suite (desk2/bunfig.toml): no test can remove the folder the suite runs in, or
// replace process.env (see the end of this file).
//
// Why (2026-10-10): under Bun 1.4.3 on Windows, rmSync('', { recursive: true, force: true }) empties the WORKING
// folder and then throws EBUSY on the folder itself (Node throws ENOENT). A browser test whose beforeAll stopped
// before it made its Chrome profile cleaned up with rmSync(profile) while profile was still '', and every file under
// desk2/ went mid-run: node_modules, the builds and the uncommitted work. A remove whose target is the working folder,
// or a folder that holds it, now throws instead.
//
// The fs objects are patched in place (a default import and require() see that), and the four fs specifiers are
// replaced by modules made of the patched objects: Bun gives a named import of a builtin its own binding, which no
// patch of the object reaches (the root suite's tests/real-home-guard.ts measured it).

import { mock } from 'bun:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type AnyFn = (...args: unknown[]) => unknown

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)

/** The folder a remove would take with it when it holds the working folder ('' and '.' resolve to it); else null. */
function holdsCwd(target: unknown): string | null {
  const p = typeof target === 'string' ? target : target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : null
  if (p === null) return null
  const abs = path.resolve(p)
  const rel = path.relative(norm(abs), norm(process.cwd()))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) ? abs : null
}

function refusal(name: string, target: unknown): Error | null {
  const abs = holdsCwd(target)
  return abs ? new Error(`${name} would remove the folder the tests run in (${abs}): a path left empty by a setup that stopped early?`) : null
}

function guard(owner: Record<string, unknown>, name: string, style: 'sync' | 'callback' | 'promise'): void {
  const orig = owner[name] as AnyFn
  owner[name] = function (this: unknown, ...args: unknown[]) {
    const error = refusal(name, args[0])
    if (!error) return orig.apply(this, args)
    if (style === 'promise') return Promise.reject(error)
    const last = args[args.length - 1]
    if (style === 'callback' && typeof last === 'function') {
      process.nextTick(last as AnyFn, error)
      return undefined
    }
    throw error
  }
}

for (const name of ['rm', 'rmdir']) {
  guard(fs as unknown as Record<string, unknown>, `${name}Sync`, 'sync')
  guard(fs as unknown as Record<string, unknown>, name, 'callback')
  guard(fsp as unknown as Record<string, unknown>, name, 'promise')
}
const fsModule = () => ({ ...fs, default: fs })
const fspModule = () => ({ ...fsp, default: fsp })
for (const id of ['node:fs', 'fs']) mock.module(id, fsModule)
for (const id of ['node:fs/promises', 'fs/promises']) mock.module(id, fspModule)

// process.env cannot be replaced, only its keys set and deleted. A copy assigned back is a plain object: on Windows
// it holds Bun's upper-cased keys, so process.env.ProgramFiles read undefined for every later file. On 2026-10-10
// that is how findChrome found no Chrome mid-suite, and the browser test that then stopped early emptied desk2/.
Object.defineProperty(process, 'env', { value: process.env, writable: false, configurable: false, enumerable: true })
