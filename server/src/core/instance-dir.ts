// server/src/core/instance-dir.ts - the `:dir` a per-instance route acts on names a LISTED
// instance, or nothing.
//
// Every `/api/instances/:dir/...` route used to take the param as a path and hand it straight to
// the action. `POST /api/instances/thomas/open` - a bare folder name, the spelling a script or an
// MCP caller reaches for first - was resolved relative to the daemon's working directory, which
// for the installed service is System32's driver store, and launched claude.exe with
// `--user-data-dir=C:\Windows\System32\DriverStore\...\amd64\thomas`: a stray process that had to
// be killed by hand (2026-09-03). Any other folder on the disk could be named the same way. The
// web UI never hit it because it passes the full dir it was listed with. One rule for every
// caller: the param must name an instance `listInstances()` returns, and anything else is refused
// before any action runs.
//
// Pure string matching over the list (path-key.ts's samePathKey), never the filesystem: the list
// already IS the set of dirs this daemon may act on, so existence checks belong to the actions.

import { samePathKey } from '../path-key'
import { listInstances } from './instances'
import type { CMInstance } from './shared'

/** Injected by tests; the routes use the real listing. */
export type InstanceLister = () => Promise<CMInstance[]>

/**
 * Which listed instance does `ref` name? Tried in order:
 *   1. A full dir, in any spelling (either slash, a trailing slash, case on win32), matching one
 *      row - a root folder or an external instance seen running.
 *   2. A bare folder name matching exactly ONE row's `name`. Two rows can share a name (an
 *      external instance's basename can equal a root folder's), and then the name resolves to
 *      nothing rather than to a coin flip - the rule instance-ref.ts already applies to labels.
 * Null otherwise: an unknown name, an ambiguous one, a path outside the list, or an empty ref.
 */
export function matchInstanceDir(ref: string, instances: readonly CMInstance[]): CMInstance | null {
  const wanted = ref.trim()
  if (!wanted) return null
  const byDir = instances.find((inst) => samePathKey(inst.dir, wanted))
  if (byDir) return byDir
  const byName = instances.filter((inst) => samePathKey(inst.name, wanted))
  return byName.length === 1 ? byName[0]! : null
}

/** {@link matchInstanceDir} over the live instance list. */
export async function resolveInstanceDir(
  ref: string,
  list: InstanceLister = () => listInstances(),
): Promise<CMInstance | null> {
  return matchInstanceDir(ref, await list())
}
