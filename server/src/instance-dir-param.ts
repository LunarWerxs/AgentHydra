// server/src/instance-dir-param.ts - the route half of core/instance-dir.ts: read the `:dir`
// param, resolve it to a listed instance, or produce the 404 the route returns in its place.
// Shared by BOTH daemons that serve `/api/instances/:dir/...` (routes/instances.ts +
// routes/usage.ts on the full daemon, and the lightweight instance-mode.ts), since the bug it
// closes was reachable on either port. scripts/checks/instance-dir-route-gate.mjs holds every
// such route to it.

import type { Context } from 'hono'
import { type InstanceLister, resolveInstanceDir } from './core/instance-dir'

/** The body every per-instance route answers for a `:dir` that names no listed instance. */
export const UNKNOWN_INSTANCE = { ok: false, error: 'unknown instance' } as const

/** A `%` that is not a valid escape must not turn a bad reference into a 500. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * The `:dir` of an `/api/instances/:dir/...` route as the LISTED instance's dir (normalized, so
 * cache keys and the meta store see one spelling), or the 404 response to return instead:
 *
 *     const dir = await instanceDirParam(c)
 *     if (dir instanceof Response) return dir
 */
export async function instanceDirParam(
  c: Context,
  list?: InstanceLister,
): Promise<string | Response> {
  const ref = safeDecode(c.req.param('dir') ?? '')
  const inst = await resolveInstanceDir(ref, list)
  if (inst) return inst.dir
  return c.json(UNKNOWN_INSTANCE, 404)
}
