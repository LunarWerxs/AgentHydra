// Usage facts only a signed-in claude.ai session serves, read from the RUNNING desktop app.
//
// claude.ai's own Settings -> Usage page reads
//   GET /api/organizations/<org>/usage?cedar_ember=1
// Beside the 5-hour and weekly percentages AgentHydra already gets from the OAuth usage endpoint,
// that body carries blocks the OAuth endpoint does not serve (asked, it answers
// `ineligible_reason: "surface"`), under Anthropic's internal code names (found in the claude.ai
// bundle, 2026-09-25):
//   cedar_ember.grants[]  banked usage-limit resets, Settings -> Usage -> Resets (the first: "Claude
//                         Opus 5.5 launch: one usage-limit reset for Pro and Max", until 2026-10-22)
//   iguana_necktie        the one-time "Claude Code and Cowork credit" ($250 on Max, until
//                         2026-11-05). Its claim lives at GET /v1/code/promo/cloud_credit, which
//                         says whether it was claimed; unclaimed, it cannot be spent.
//   spend                 usage credits: whether usage past the plan limits is billed, and how much
//   seven_day_breakdown   this week's usage split by product (Claude Code / Chats / Cowork / Other)
// So this asks the running app, through its native inspector, to make those same-origin requests
// itself. No cookie or token ever leaves the app; only the fields below come back.
//
// Read-only. Claiming a reset (POST .../reset_rate_limits) or the credit (POST .../claim) is
// deliberately not implemented here: both spend something of the account's, and that is a person's
// call.

import {
  getClaudeNativeProfileConfig,
  normalizeClaudeNativeProfile,
} from './claude-native-settings'
import { connectClaudeInspector } from './core/claude-native/inspector-client'
import { scanClaudeProcesses } from './core/process'
import type { ClaudeAppUsage, ClaudeCodeCredit, ClaudeUsageCredits } from './types'

export interface ClaudeResetGrants {
  /** Resets still unused across every grant that has not ended. */
  resetsLeft: number
  /** When the soonest-ending grant that still holds a reset expires, or null when none does. */
  expiresAt: string | null
}

export interface ClaudeAppReading {
  /** Null when claude.ai sent no grant list at all (never "none left"). */
  resets: ClaudeResetGrants | null
  app: ClaudeAppUsage
}

/** Runs inside the claude.ai renderer: its own session, same origin. Returns only these fields. */
const rendererExpression = `(async () => {
  const orgs = await (await fetch('/api/organizations')).json();
  if (!Array.isArray(orgs)) return null;
  const org = orgs.find(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat'));
  if (!org) return null;
  const r = await fetch('/api/organizations/' + org.uuid + '/usage?cedar_ember=1');
  if (!r.ok) return null;
  const b = await r.json();
  let promo = null;
  try {
    const p = await fetch('/v1/code/promo/cloud_credit', { headers: { 'anthropic-version': '2023-06-01' } });
    if (p.ok) {
      const j = await p.json();
      promo = { claimed: j.claimed, eligible: j.eligible, expires_at: j.expires_at };
    }
  } catch {}
  const grants = b?.cedar_ember?.grants;
  const credit = b?.iguana_necktie;
  const spend = b?.spend;
  const split = b?.seven_day_breakdown?.rows;
  return {
    grants: Array.isArray(grants)
      ? grants.map(g => ({ resets_left: g.resets_left, ends_at: g.ends_at }))
      : null,
    credit: credit
      ? {
          limit_dollars: credit.limit_dollars,
          remaining_dollars: credit.remaining_dollars,
          resets_at: credit.resets_at,
          locked_reason: credit.locked_reason,
        }
      : null,
    promo,
    spend: spend
      ? { enabled: spend.enabled, disabled_reason: spend.disabled_reason, used: spend.used, limit: spend.limit }
      : null,
    split: Array.isArray(split)
      ? split.map(x => ({ key: x.key, label: x.display_name, pct: x.percent }))
      : null,
  };
})()`

const mainExpression = `(async () => {
  const { webContents } = process.mainModule.require('electron');
  const page = webContents.getAllWebContents().find(w => /^https:\\/\\/claude\\.ai\\//.test(w.getURL()));
  return page ? await page.executeJavaScript(${JSON.stringify(rendererExpression)}) : null;
})()`

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
/** Epoch ms of an ISO string; NaN when missing or unparseable, which never reads as "ended". */
const instant = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : Number.NaN)
const iso = (at: number): string | null => (Number.isNaN(at) ? null : new Date(at).toISOString())

/** Ended grants and spent ones never count. */
function summarizeResets(raw: unknown, now: number): ClaudeResetGrants | null {
  if (!Array.isArray(raw)) return null
  let resetsLeft = 0
  let soonest = Number.NaN
  for (const grant of raw) {
    const g = obj(grant)
    const left = Math.max(0, Math.floor(num(g?.resets_left) ?? 0))
    const ends = instant(g?.ends_at)
    if (left === 0 || ends <= now) continue
    resetsLeft += left
    if (!Number.isNaN(ends) && !(ends >= soonest)) soonest = ends
  }
  return { resetsLeft, expiresAt: iso(soonest) }
}

/**
 * The credit's state comes from two places: the meter (`iguana_necktie`: amounts, expiry, lock) and
 * the claim (`/v1/code/promo/cloud_credit`). An offered credit nobody claimed is worth nothing until
 * a person claims it, so it must never read as money left. An expired one is gone.
 */
function summarizeCredit(
  meterRaw: unknown,
  promoRaw: unknown,
  now: number,
): ClaudeCodeCredit | null {
  const meter = obj(meterRaw)
  const promo = obj(promoRaw)
  const expires = instant(meter?.resets_at ?? promo?.expires_at)
  if (expires <= now) return null
  const expiresAt = iso(expires)
  const limitUsd = num(meter?.limit_dollars)
  const remainingUsd = num(meter?.remaining_dollars)
  if (promo?.claimed === false && promo.eligible === true) {
    return { state: 'unclaimed', limitUsd, remainingUsd, expiresAt, lockedReason: null }
  }
  if (limitUsd === null || limitUsd <= 0) return null
  const lockedReason = text(meter?.locked_reason)
  return {
    state: lockedReason ? 'locked' : 'active',
    limitUsd,
    remainingUsd,
    expiresAt,
    lockedReason,
  }
}

/** claude.ai sends money as `{ amount_minor, currency, exponent }`. */
function money(v: unknown): { amount: number; currency: string | null } | null {
  const m = obj(v)
  const minor = num(m?.amount_minor)
  if (minor === null) return null
  const exponent = num(m?.exponent) ?? 2
  return { amount: minor / 10 ** exponent, currency: text(m?.currency) }
}

function summarizeUsageCredits(raw: unknown): ClaudeUsageCredits | null {
  const spend = obj(raw)
  if (!spend || typeof spend.enabled !== 'boolean') return null
  const used = money(spend.used)
  const limit = money(spend.limit)
  return {
    enabled: spend.enabled,
    disabledReason: text(spend.disabled_reason),
    used: used?.amount ?? null,
    limit: limit?.amount ?? null,
    currency: used?.currency ?? limit?.currency ?? null,
  }
}

function summarizeSplit(raw: unknown): ClaudeAppUsage['weeklySplit'] {
  if (!Array.isArray(raw)) return null
  const rows = raw.flatMap((row) => {
    const r = obj(row)
    const key = text(r?.key)
    const pct = num(r?.pct)
    return key && pct !== null ? [{ key, label: text(r?.label) ?? key, pct }] : []
  })
  return rows.length ? rows : null
}

/** Pure: fold what the renderer returned into the snapshot's facts. Null means "no reading". */
export function summarizeClaudeAppUsage(raw: unknown, now = Date.now()): ClaudeAppReading | null {
  const r = obj(raw)
  if (!r) return null
  return {
    resets: summarizeResets(r.grants, now),
    app: {
      checkedAt: new Date(now).toISOString(),
      codeCredit: summarizeCredit(r.credit, r.promo, now),
      usageCredits: summarizeUsageCredits(r.spend),
      weeklySplit: summarizeSplit(r.split),
    },
  }
}

/**
 * Ask a running desktop instance for these facts. Null means "could not read right now" (app
 * closed, native control not configured, not signed in, a failed request) - never "none".
 */
export async function readClaudeAppUsage(dir: string): Promise<ClaudeAppReading | null> {
  const config = getClaudeNativeProfileConfig(dir)
  if (!config) return null
  const profile = normalizeClaudeNativeProfile(dir)
  const scan = await scanClaudeProcesses()
  if (!scan.ok) return null
  const owners = scan.processes.filter(
    (p) => p.isMain && p.dir && normalizeClaudeNativeProfile(p.dir) === profile,
  )
  if (owners.length !== 1) return null
  let client: Awaited<ReturnType<typeof connectClaudeInspector>> | undefined
  try {
    client = await connectClaudeInspector({
      pid: owners[0].pid,
      profile,
      port: config.port,
      connectTimeoutMs: 2000,
      callTimeoutMs: 15000,
    })
    return summarizeClaudeAppUsage(await client.evaluate(mainExpression))
  } catch {
    return null
  } finally {
    client?.close()
  }
}
