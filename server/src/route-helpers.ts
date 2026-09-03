import type { Context } from 'hono'

// Dispatch-argv enums, validated SERVER-SIDE (the MCP/web schemas are advisory only). permission_mode
// especially: it flows into `claude --permission-mode <v>` (dispatch.ts buildArgv), and
// `bypassPermissions` runs every tool with no approval — so a garbage/unexpected value must be
// rejected here, never passed through to the CLI. A null/absent value is fine (CLI default).
export const VALID_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
])
export const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** Returns an error string if the field is present-but-invalid, else null. */
export function invalidEnum(value: unknown, valid: Set<string>, field: string): string | null {
  if (value == null) return null
  if (typeof value !== 'string' || !valid.has(value))
    return `${field} must be one of: ${[...valid].join(', ')}`
  return null
}

/** Parse a request JSON body as an object. Anything non-object — malformed JSON OR a valid but
 *  non-object literal (`null`, `42`, `"x"`) — degrades to `{}`, so the downstream `body.x` /
 *  `'x' in body` reads never throw a 500 on a hostile or empty body. This is the leniency every
 *  mutating handler here relies on; use it instead of `(await c.req.json().catch(() => ({})))`,
 *  whose `.catch` only covers malformed JSON and still lets a literal `null` crash the reads. */
export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const parsed = await c.req.json().catch(() => null)
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

/** `min` defaults to 1 because every caller but the paging offset is a count, and a count of zero
 *  is a caller asking for nothing. An offset of zero is page one, so it passes min = 0. */
export function boundedQueryInt(
  raw: string | undefined,
  fallback: number,
  max: number,
  min = 1,
): number {
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}
