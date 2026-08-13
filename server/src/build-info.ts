// server/src/build-info.ts — what this exact binary is, for scripts and CI.
//
// `--version` prints one line for a human. `--version --json` prints this, for everything else:
// a shell that wants to compare builds, a CI step that records what it tested, a bug report that
// needs to say more than "0.19.3". Auto-update is a `git pull` (docs/RELEASING.md), so two machines
// can sit on the same VERSION and different code — the commit is the field that tells them apart.
//
// WHERE EACH FIELD COMES FROM, and why it is not one mechanism:
//
//  * A RELEASE BINARY is compiled from a generated entrypoint (scripts/build.ts), which stamps the
//    commit and the build time into globals at compile time. That is the only correct source there:
//    a compiled exe can be copied anywhere, and asking git where it happens to be sitting would
//    describe the checkout it was dropped into rather than the build it is.
//  * RUNNING FROM SOURCE has no stamp, and there the checkout IS the build, so git is the honest
//    answer. It is read lazily and best-effort — a checkout with no git, or no git history, reports
//    null rather than failing.
//
// Both paths can answer `null`, and null means "not known", never "unmodified" or "clean". Nothing
// here inspects the working tree, so a build made from uncommitted edits still reports the commit
// it was based on; that is what the flag can honestly promise.
//
// THE FAST PATH IS PRESERVED (server/src/main.ts): no database is opened and no port is bound. The
// only work beyond reading a bundled constant is one `git rev-parse`, and only when running from
// source AND only when --json is asked for.

import { IS_COMPILED, VERSION } from './config'

/** Bumped only for an incompatible change to the shape below, so a script can branch on it rather
 *  than sniffing for fields. Adding a field is not incompatible. */
export const BUILD_INFO_SCHEMA = 1

export interface BuildInfo {
  schema: number
  version: string
  /** Full commit sha the build came from, or null when it could not be determined. */
  commit: string | null
  /** ISO-8601 UTC instant the binary was compiled, or null when running from source. */
  builtAt: string | null
  /** True for a compiled release binary, false when running from a checkout. */
  release: boolean
}

interface StampedBuild {
  commit?: string
  builtAt?: string
}

/** Written by the generated release entrypoint (scripts/build.ts), absent in source mode. */
function stamp(): StampedBuild | null {
  const g = globalThis as { __AGENTHYDRA_BUILD__?: StampedBuild }
  return g.__AGENTHYDRA_BUILD__ ?? null
}

/** The checkout's HEAD, for source mode. Never throws: git may be absent, or this may be a copy of
 *  the tree with no `.git` at all, and neither is an error worth failing `--version` over. */
function gitHead(): string | null {
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (proc.exitCode !== 0) return null
    const sha = proc.stdout.toString().trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

export function buildInfo(): BuildInfo {
  const stamped = stamp()
  return {
    schema: BUILD_INFO_SCHEMA,
    version: VERSION,
    commit: stamped?.commit ?? (IS_COMPILED ? null : gitHead()),
    builtAt: stamped?.builtAt ?? null,
    release: IS_COMPILED,
  }
}
