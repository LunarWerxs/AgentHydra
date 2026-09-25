// Banked Claude usage-limit resets ("Settings -> Usage -> Resets" on claude.ai).
//
// Anthropic hands Pro/Max accounts reset GRANTS (the first: "Claude Opus 5.5 launch: one usage-limit
// reset for Pro and Max", 2026-09-22 .. 2026-10-22). Each grant says how many resets are left and
// when it ends. The claude.ai web app reads them from
//   GET /api/organizations/<org>/usage?cedar_ember=1&skip_spend=1   ->   body.cedar_ember.grants[]
// (`cedar_ember` is Anthropic's internal name for the program; found in the claude.ai bundle,
// 2026-09-25). The OAuth usage endpoint AgentHydra polls for percentages does NOT serve it: asked the
// same question it answers `ineligible_reason: "surface"` with no grants. Only a signed-in claude.ai
// session can read it, so this asks the RUNNING desktop app, through its native inspector, to make
// that same-origin request itself. No cookie or token ever leaves the app; only the grant counts,
// end dates and labels come back.
//
// Read-only. Claiming a reset (POST .../reset_rate_limits) is deliberately not implemented here.

import {
  getClaudeNativeProfileConfig,
  normalizeClaudeNativeProfile,
} from './claude-native-settings'
import { connectClaudeInspector } from './core/claude-native/inspector-client'
import { scanClaudeProcesses } from './core/process'

export interface ClaudeResetGrants {
  /** Resets still unused across every grant that has not ended. */
  resetsLeft: number
  /** When the soonest-ending grant that still holds a reset expires, or null when none does. */
  expiresAt: string | null
  /** The human label of that grant (Anthropic's own wording). */
  label: string | null
}

interface RawGrant {
  resets_left?: unknown
  ends_at?: unknown
  label?: unknown
}

/** Runs inside the claude.ai renderer: its own session, same origin. Returns grants only. */
const rendererExpression = `(async () => {
  const orgs = await (await fetch('/api/organizations')).json();
  if (!Array.isArray(orgs)) return null;
  const org = orgs.find(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat'));
  if (!org) return null;
  const r = await fetch('/api/organizations/' + org.uuid + '/usage?cedar_ember=1&skip_spend=1');
  if (!r.ok) return null;
  const grants = (await r.json())?.cedar_ember?.grants;
  return Array.isArray(grants)
    ? grants.map(g => ({ resets_left: g.resets_left, ends_at: g.ends_at, label: g.label }))
    : null;
})()`

const mainExpression = `(async () => {
  const { webContents } = process.mainModule.require('electron');
  const page = webContents.getAllWebContents().find(w => /^https:\\/\\/claude\\.ai\\//.test(w.getURL()));
  return page ? await page.executeJavaScript(${JSON.stringify(rendererExpression)}) : null;
})()`

/** Pure: fold the raw grant rows into the one summary the UI shows. Ended grants never count. */
export function summarizeResetGrants(raw: unknown, now = Date.now()): ClaudeResetGrants | null {
  if (!Array.isArray(raw)) return null
  let resetsLeft = 0
  let soonest: { at: number; iso: string; label: string | null } | null = null
  for (const grant of raw as RawGrant[]) {
    const left =
      typeof grant?.resets_left === 'number' ? Math.max(0, Math.floor(grant.resets_left)) : 0
    const ends = typeof grant?.ends_at === 'string' ? Date.parse(grant.ends_at) : Number.NaN
    if (left === 0 || (!Number.isNaN(ends) && ends <= now)) continue
    resetsLeft += left
    if (!Number.isNaN(ends) && (!soonest || ends < soonest.at)) {
      soonest = {
        at: ends,
        iso: new Date(ends).toISOString(),
        label: typeof grant.label === 'string' ? grant.label : null,
      }
    }
  }
  return { resetsLeft, expiresAt: soonest?.iso ?? null, label: soonest?.label ?? null }
}

interface ReadDeps {
  scan?: typeof scanClaudeProcesses
  connect?: typeof connectClaudeInspector
}

/**
 * Ask a running desktop instance for its banked resets. Null means "could not read right now"
 * (app closed, native control not configured, not signed in, a failed request) - never "none".
 */
export async function readDesktopResetGrants(
  dir: string,
  deps: ReadDeps = {},
): Promise<ClaudeResetGrants | null> {
  const config = getClaudeNativeProfileConfig(dir)
  if (!config) return null
  const profile = normalizeClaudeNativeProfile(dir)
  const scan = await (deps.scan ?? scanClaudeProcesses)()
  if (!scan.ok) return null
  const owners = scan.processes.filter(
    (p) => p.isMain && p.dir && normalizeClaudeNativeProfile(p.dir) === profile,
  )
  if (owners.length !== 1) return null
  let client: Awaited<ReturnType<typeof connectClaudeInspector>> | undefined
  try {
    client = await (deps.connect ?? connectClaudeInspector)({
      pid: owners[0].pid,
      profile,
      port: config.port,
      connectTimeoutMs: 2000,
      callTimeoutMs: 15000,
    })
    return summarizeResetGrants(await client.evaluate(mainExpression))
  } catch {
    return null
  } finally {
    client?.close()
  }
}
